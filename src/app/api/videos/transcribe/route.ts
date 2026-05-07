import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 900;  // 15 min — supports 10-min audio + Whisper processing time

const SRT_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const SRT_ARROW_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const MIN_GAP_MS = 1;
const MIN_CAPTION_MS = 400;

function stripSrtArtifacts(input: string): string {
  return input
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l === "✕" || l === "···" || l === "..." || l === "…") return false;
      if (SRT_ARROW_RE.test(l) || SRT_TIME_RE.test(l)) return false;
      if (/^\d{1,6}$/.test(l)) return false;
      if (/^(CTA|HOOK|BODY|OUTRO|INTRO)$/i.test(l)) return false;
      return true;
    })
    .join("\n")
    .replace(/\([^\n]{0,80}\n[^\n]{0,80}\)/g, (m) => m.replace(/\n/g, " "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeTranscriptionText(input: string): string {
  if (!input) return "";
  const filtered = stripSrtArtifacts(input);
  return filtered
    .replace(/\r/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^\s*[·•…]{2,}\s*$/gm, "")
    .replace(/^\s*✕\s*$/gm, "")
    .replace(/\"{2,}/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizePhraseText(input: string): string {
  return sanitizeTranscriptionText(input)
    .replace(/^[·•…\.]+\s*/g, "")        // strip leading ellipsis/dots
    .replace(/\s*[·•…\.]+$/g, "")         // strip trailing ellipsis/dots
    .replace(/^\s*✕+\s*$/g, "")
    .replace(/["“”'’]/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/([\u0E00-\u0E7F])\s+([\u0E00-\u0E7F])/g, "$1$2")
    .replace(/\s{2,}/g, " ")
    .replace(/([?!ฯ])\s*([ก-๿])/g, "$1 $2")
    .replace(/\s*([,.:;!?])\s*/g, "$1 ")
    .trim();
}

function normalizeCaptionText(input: string): string {
  const noBOM = input.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return sanitizePhraseText(noBOM);
}

// Remove words that appear at both the END of phrase[i] and START of phrase[i+1].
// This fixes STT/LLM duplication like:
//   phrase[4] = "...ชื่อ Anthropic Anthropic"
//   phrase[5] = "Anthropic ก่อตั้งโดย..."
// → strips trailing "Anthropic" from phrase[4]
function deduplicatePhraseEdges(phrases: string[]): string[] {
  if (phrases.length < 2) return phrases;
  const out = [...phrases];
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i].trim();
    const next = out[i + 1].trim();
    if (!cur || !next) continue;
    const curCompare = normalizeForCompare(cur);
    const nextCompare = normalizeForCompare(next);
    if (curCompare && nextCompare && curCompare === nextCompare) {
      out.splice(i + 1, 1);
      i = Math.max(-1, i - 1);
      continue;
    }

    // Tokenize both phrases into words (split on spaces)
    const curWords = cur.split(/\s+/);
    const nextWords = next.split(/\s+/);

    // Find longest suffix of cur[] that matches a prefix of next[]
    let overlapLen = 0;
    const maxCheck = Math.min(curWords.length, nextWords.length, 5);
    for (let k = maxCheck; k >= 1; k--) {
      const suffix = curWords.slice(-k).join(" ").toLowerCase();
      const prefix = nextWords.slice(0, k).join(" ").toLowerCase();
      if (suffix === prefix && suffix.length >= 2) {
        overlapLen = k;
        break;
      }
    }

    if (overlapLen > 0) {
      // Remove overlap from start of next to avoid duplicated words.
      const trimmedNext = nextWords.slice(overlapLen).join(" ").trim();
      if (!trimmedNext) {
        out.splice(i + 1, 1);
        i = Math.max(-1, i - 1);
        console.log(`[transcribe] dedup edge: removed duplicated phrase[${i + 1}]`);
      } else {
        out[i + 1] = trimmedNext;
        console.log(`[transcribe] dedup edge: removed "${nextWords.slice(0, overlapLen).join(" ")}" from start of phrase[${i + 1}]`);
      }
    }
  }
  // Filter out any phrase that became empty after dedup
  return out.filter(p => p.trim().length > 0);
}

function collapseConsecutiveDuplicateWords(input: string): string {
  const words = sanitizePhraseText(input).split(/\s+/).filter(Boolean);
  if (words.length <= 1) return sanitizePhraseText(input);
  const out: string[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const prev = out[out.length - 1];
    if (w.toLowerCase() !== prev.toLowerCase()) {
      out.push(w);
    }
  }
  return out.join(" ").trim();
}

function limitPhraseCountByDuration(phrases: string[], audioDurSec: number): string[] {
  // Allow ~4s per subtitle, no hard cap — LLM decides phrase boundaries.
  // Only merge if we have drastically more phrases than time allows (< 1s each).
  const minDurPerPhrase = 1.0;
  const maxByDuration = Math.max(8, Math.ceil(audioDurSec / minDurPerPhrase));
  if (phrases.length <= maxByDuration) return phrases;
  const out = [...phrases];
  while (out.length > maxByDuration) {
    let mergeIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i++) {
      const score = `${out[i]} ${out[i + 1]}`.trim().length;
      if (score < bestScore) { bestScore = score; mergeIndex = i; }
    }
    out[mergeIndex] = `${out[mergeIndex]} ${out[mergeIndex + 1]}`.trim();
    out.splice(mergeIndex + 1, 1);
  }
  return out;
}

function splitToSentencePhrases(raw: string): string[] {
  if (!raw.trim()) return [];

  const normalized = raw
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .replace(/\([A-Za-z][^)]*\)/g, "")
    .replace(/\.{3,}/g, "…")
    .trim();

  if (!normalized) return [];

  const sentencePieces = normalized.match(/[^.!?…ฯ]+(?:[.!?…ฯ])?/g);
  const fromPunctuation = (sentencePieces ?? [])
    .map((p) => sanitizeTranscriptionText(p))
    .filter(Boolean);
  if (fromPunctuation.length > 1) return fromPunctuation;

  const breathPieces = normalized
    .split(/(?=\s(?:แต่|และ|เพราะ|จึง|ดังนั้น|เพราะว่า|ในขณะที่|ทั้งนี้|นอกจากนี้)\b)/g)
    .map((p) => sanitizeTranscriptionText(p))
    .filter(Boolean);

  return breathPieces.length > 1 ? breathPieces : fromPunctuation;
}

function splitToPunctuationSentences(raw: string): string[] {
  if (!raw.trim()) return [];

  const normalized = raw
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .replace(/\([A-Za-z][^)]*\)/g, "")
    .replace(/\.{3,}/g, "…")
    .trim();

  if (!normalized) return [];

  const sentencePieces = normalized.match(/[^.!?…ฯ]+(?:[.!?…ฯ])?/g);
  return (sentencePieces ?? [])
    .map((p) => sanitizeTranscriptionText(p))
    .filter(Boolean);
}

function normalizeForCompare(input: string): string {
  return sanitizeTranscriptionText(input)
    .replace(/\s+/g, "")
    .replace(/[.,!?·•…฿"'\-–—()]/g, "");
}

function alignmentCharLen(input: string): number {
  const cleaned = sanitizeTranscriptionText(input)
    .replace(/["""''“”’‘]/g, "")
    .replace(/\.{2,}/g, "");
  if (!cleaned) return 0;
  const thai = cleaned.replace(/[^\u0E00-\u0E7F]/g, "").length;
  return Math.max(1, thai || cleaned.replace(/\s+/g, "").length);
}

function mergeTinyPhrases(phrases: string[], minChars = 8): string[] {
  const out: string[] = [];
  for (const raw of phrases) {
    const p = raw.trim();
    if (!p) continue;
    if (out.length > 0) {
      const last = out[out.length - 1];
      if (p.length < minChars && (last + " " + p).length <= 40) {
        out[out.length - 1] = `${last} ${p}`.trim();
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

const THAI_MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];

function mergeDateAndConnectorBreaks(phrases: string[]): string[] {
  if (!phrases.length) return [];
  const merged: string[] = [];
  const yearStart = (s: string) => /^(ปี\s*\d{2,4}|พ.ศ\.?\s*\d{2,4}|\d{4})\b/.test(s.trim());
  const monthTail = (s: string) => THAI_MONTHS.some((m) => s.trim().endsWith(m));

  for (const raw of phrases) {
    const p = raw.trim();
    if (!p) continue;
    const prev = merged[merged.length - 1];
    if (prev && ((monthTail(prev) && yearStart(p)) || (yearStart(prev) && /^(มี|มีนัก|นัก|ทีมนัก|ที|ทีม)/.test(p)))) {
      merged[merged.length - 1] = `${prev} ${p}`.trim();
      continue;
    }
    merged.push(p);
  }
  return merged;
}

function alignPhrasesToWordTimings(
  phrases: string[],
  words: { word: string; start: number; end: number }[],
): { text: string; startMs: number; endMs: number }[] {
  const validWords = words
    .map((w) => ({ text: w.word, start: w.start, end: w.end, chars: alignmentCharLen(w.word) }))
    .filter((w) => w.chars > 0);

  if (!validWords.length || phrases.length === 0) return [];

  const cumulativeChars: number[] = [];
  let totalChars = 0;
  for (const w of validWords) {
    totalChars += w.chars;
    cumulativeChars.push(totalChars);
  }

  const indexAtChar = (charPos: number): number => {
    if (charPos <= 0) return 0;
    if (charPos >= totalChars) return validWords.length - 1;
    for (let i = 0; i < cumulativeChars.length; i++) {
      if (charPos <= cumulativeChars[i]) return i;
    }
    return validWords.length - 1;
  };

  const phraseLens = phrases.map((p) => alignmentCharLen(p));
  const totalPhraseChars = Math.max(1, phraseLens.reduce((a, b) => a + b, 0));

  const out: { text: string; startMs: number; endMs: number }[] = [];
  let consumedChars = 0;
  for (let i = 0; i < phrases.length; i++) {
    const startChar = Math.round((i === 0 ? 0 : consumedChars));
    consumedChars += phraseLens[i];
    const endChar = Math.min(totalChars, Math.round((consumedChars / totalPhraseChars) * totalChars));
    const startIdx = indexAtChar(startChar);
    const endIdx = Math.max(startIdx, indexAtChar(endChar));

    const startMs = Math.round(validWords[startIdx].start * 1000);
    const endMs = Math.max(
      Math.round(validWords[endIdx].end * 1000),
      Math.round(validWords[startIdx].start * 1000) + 300,
    );

    out.push({
      text: sanitizeTranscriptionText(phrases[i]),
      startMs,
      endMs,
    });
  }

  return out;
}

/**
 * Aligns LLM-split phrases to Gemini segment timestamps.
 *
 * Strategy: match each phrase to the segment whose text overlaps most with it
 * using bare-char overlap. Each phrase gets the real start/end time of its
 * best-matching segment. Within a segment that covers multiple phrases,
 * interpolate linearly so they get distinct timestamps.
 *
 * This is far more accurate than global char-proportion because it anchors
 * each phrase to the actual segment boundary where the speaker said those words.
 */
function alignPhrasesToSegmentTimestamps(
  phrases: string[],
  segments: { text: string; start: number; end: number }[],
): { text: string; startMs: number; endMs: number }[] {
  if (!phrases.length || !segments.length) return [];

  const totalAudioSec = segments[segments.length - 1].end;
  if (totalAudioSec <= 0) return [];

  const bare = (s: string) =>
    s.replace(/\s+/g, "").replace(/[.,!?;:"""''()[\]{}<>«»\/\\–—]/g, "").toLowerCase();

  // Build segment char lengths for proportion fallback
  const segBareLens = segments.map(s => Math.max(1, bare(s.text).length));
  const totalSegChars = segBareLens.reduce((a, b) => a + b, 0);

  // Build cumulative segment char positions → maps global char pos to segment index
  const segCumChars: number[] = [];
  let cum = 0;
  for (const l of segBareLens) { cum += l; segCumChars.push(cum); }

  // For each phrase: find which segment it belongs to by char proportion
  // (phrase's cumulative char midpoint → segment index)
  const phraseBareLens = phrases.map(p => Math.max(1, bare(p).length));
  const totalPhraseChars = phraseBareLens.reduce((a, b) => a + b, 0);

  // Map phrase index → segment index using char midpoint proportion
  const phraseToSeg = (phraseCharMid: number): number => {
    const ratio = phraseCharMid / totalPhraseChars;
    const targetChar = ratio * totalSegChars;
    for (let si = 0; si < segCumChars.length; si++) {
      if (targetChar <= segCumChars[si]) return si;
    }
    return segments.length - 1;
  };

  // Assign each phrase a segment index
  const assignments: number[] = [];
  let cumPhraseChars = 0;
  for (let i = 0; i < phrases.length; i++) {
    const mid = cumPhraseChars + phraseBareLens[i] / 2;
    assignments[i] = phraseToSeg(mid);
    cumPhraseChars += phraseBareLens[i];
  }

  // For each segment, find which phrases map to it and interpolate within the segment
  const out: { text: string; startMs: number; endMs: number }[] = [];

  for (let i = 0; i < phrases.length; i++) {
    const si = assignments[i];
    const seg = segments[si];

    // Count how many phrases share this segment
    const firstInSeg = assignments.indexOf(si);
    const lastInSeg = assignments.lastIndexOf(si);
    const countInSeg = lastInSeg - firstInSeg + 1;
    const posInSeg = i - firstInSeg; // 0-based position within the segment

    const segDur = seg.end - seg.start;

    // Interpolate start/end within the segment based on position
    const sliceStart = seg.start + (posInSeg / countInSeg) * segDur;
    const sliceEnd   = seg.start + ((posInSeg + 1) / countInSeg) * segDur;

    out.push({
      text: sanitizeTranscriptionText(phrases[i]),
      startMs: Math.round(sliceStart * 1000),
      endMs:   Math.round(Math.max(sliceStart + 0.3, sliceEnd) * 1000),
    });
  }

  // Extend every caption to the next one's start — eliminates all gaps
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i + 1].startMs > out[i].endMs) {
      out[i].endMs = out[i + 1].startMs;
    }
  }

  // Last phrase ends at audio end
  if (out.length > 0) {
    out[out.length - 1].endMs = Math.round(totalAudioSec * 1000);
  }

  // Enforce strictly monotonic timestamps
  for (let i = 1; i < out.length; i++) {
    if (out[i].startMs <= out[i - 1].startMs) {
      out[i].startMs = out[i - 1].startMs + 100;
    }
    if (out[i].endMs <= out[i].startMs) {
      out[i].endMs = out[i].startMs + 300;
    }
  }

  return out;
}

function buildFallbackWordsFromSegments(
  segments: { text: string; start: number; end: number }[],
): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const seg of segments) {
    const words = seg.text
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (words.length === 0) continue;
    const start = Math.max(0, seg.start);
    const end = Math.max(start + 0.001, seg.end);
    const width = (end - start) / words.length;
    let cursor = start;
    for (let i = 0; i < words.length; i++) {
      const isLast = i === words.length - 1;
      const wEnd = isLast ? end : cursor + width;
      out.push({ word: words[i], start: cursor, end: wEnd });
      cursor = wEnd;
    }
  }
  return out;
}

/**
 * Re-maps LLM-generated phrases back onto the real script text.
 *
 * The LLM may paraphrase, drop, or reorder words. This function uses the
 * proportional character positions of each LLM phrase (relative to the
 * concatenated LLM output) to cut the SAME proportional slice from sourceText.
 * Result: subtitle text is always verbatim from the script, never from LLM.
 */
function snapPhrasesToScript(llmPhrases: string[], sourceText: string): string[] {
  if (!llmPhrases.length || !sourceText.trim()) return llmPhrases;

  const src = sourceText.trim();
  // Strip to bare chars for proportion calculation (count non-space chars)
  const srcChars = [...src];
  const srcLen = srcChars.filter((c) => c.trim().length > 0).length;
  if (srcLen === 0) return llmPhrases;

  // Total chars in LLM output (no-space stripped for proportion)
  const llmNoSpace = llmPhrases.map(p => p.replace(/\s+/g, ""));
  const llmTotalChars = llmNoSpace.reduce((a, b) => a + b.length, 0);
  if (llmTotalChars === 0) return llmPhrases;

  // Build cumulative char positions in sourceText matching LLM phrase proportions.
  // We advance through src char-by-char counting non-space chars to find split points.
  const snapped: string[] = [];
  let llmCum = 0;
  let srcPos = 0; // position in srcChars (with spaces)
  let srcNonSpaceCounted = 0; // non-space chars consumed so far in src

  for (let i = 0; i < llmPhrases.length; i++) {
    llmCum += llmNoSpace[i].length;
    // Target non-space char count in src at end of this phrase
    const targetNS = Math.round((llmCum / llmTotalChars) * srcLen);

    const startPos = srcPos;
    // Advance srcPos until we've consumed targetNS non-space src chars
    while (srcPos < srcChars.length && srcNonSpaceCounted < targetNS) {
      if (srcChars[srcPos] !== " ") srcNonSpaceCounted++;
      srcPos++;
    }
    // Snap to a space boundary if one exists nearby (within 3 chars).
    // For Thai (no spaces), don't advance — cut at the char proportion point.
    if (srcPos < srcChars.length && srcChars[srcPos] !== " ") {
      const lookAhead = Math.min(srcPos + 3, srcChars.length);
      let found = -1;
      for (let j = srcPos; j < lookAhead; j++) {
        if (srcChars[j] === " ") { found = j + 1; break; }
      }
      if (found !== -1) srcPos = found;
      // else: no space nearby — keep current position (char-boundary is fine for Thai)
    }

    let slice = sanitizePhraseText(srcChars.slice(startPos, srcPos).join(""));
    if (!slice) slice = llmPhrases[i]; // last-resort: keep LLM phrase
    snapped.push(slice);
  }

  // Ensure last phrase covers the rest of the script
  if (snapped.length > 0 && srcPos < srcChars.length) {
    snapped[snapped.length - 1] = (snapped[snapped.length - 1] + " " + srcChars.slice(srcPos).join("")).trim();
  }

  console.log(`[transcribe] snapPhrasesToScript: ${llmPhrases.length} → ${snapped.length} phrases from real script`);
  return snapped;
}

function splitTextByTargetLen(input: string, targetLen: number, minChunk: number): string[] {
  const text = sanitizeTranscriptionText(input);
  if (!text) return [];

  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const maxLen = Math.max(minChunk, Math.floor(targetLen));

  if (tokens.length <= 1) {
    let chunk = "";
    for (const ch of [...text]) {
      chunk += ch;
      if (chunk.replace(/\s+/g, "").length >= maxLen && /\s/.test(ch)) {
        out.push(chunk.trim());
        chunk = "";
      }
    }
    if (chunk.trim()) out.push(chunk.trim());
    if (out.length <= 1 && text.length > maxLen * 1.4) {
      // Split at Thai syllable boundaries (vowel clusters) rather than raw char offset
      // to avoid cutting mid-word. Fall back to space-based split if possible.
      const chars = [...text];
      const fixed: string[] = [];
      let chunk = "";
      for (let i = 0; i < chars.length; i++) {
        chunk += chars[i];
        if (chunk.replace(/\s+/g, "").length >= maxLen) {
          // Try to find a safe break point: look ahead up to 4 chars for a space or Thai vowel boundary
          let broke = false;
          for (let j = i + 1; j < Math.min(i + 5, chars.length); j++) {
            if (/\s/.test(chars[j]) || /[เ-ไ]/.test(chars[j])) {
              chunk += chars.slice(i + 1, j).join("");
              i = j - 1;
              broke = true;
              break;
            }
          }
          if (!broke && /\s/.test(chars[i])) broke = true;
          if (broke || chunk.replace(/\s+/g, "").length >= maxLen * 1.3) {
            fixed.push(chunk.trim());
            chunk = "";
          }
        }
      }
      if (chunk.trim()) fixed.push(chunk.trim());
      return fixed.filter(Boolean);
    }
    return out;
  }

  let line = "";
  for (const tok of tokens) {
    const next = line ? `${line} ${tok}` : tok;
    if (line && next.replace(/\s+/g, "").length > maxLen) {
      out.push(line.trim());
      line = tok;
    } else {
      line = next;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}


function parseSplitPhrasesFromRaw(raw: string): string[] {
  if (!raw) return [];
  const stripped = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return [];

  // Try clean parse first
  try {
    const parsed = JSON.parse(match[0]);
    const arr: unknown[] = Array.isArray(parsed?.phrases) ? parsed.phrases : [];
    if (arr.length > 0) {
      return arr
        .filter((p): p is string => typeof p === "string")
        .map((p) => sanitizePhraseText(p))
        .filter((p) => p.length > 0);
    }
  } catch { /* fall through to repair */ }

  // JSON truncated — extract all complete quoted strings from the phrases array
  // Matches: "any text without unescaped quote"
  const phraseRegex = /"((?:[^"\\]|\\.)*)"/g;
  // Find the phrases array section first
  const phrasesSection = match[0].match(/"phrases"\s*:\s*\[([\s\S]*)/);
  const searchIn = phrasesSection ? phrasesSection[1] : match[0];
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = phraseRegex.exec(searchIn)) !== null) {
    const p = sanitizePhraseText(m[1]);
    // Skip the key name "phrases" itself and empty strings
    if (p && p !== "phrases" && p !== "tags" && p.length > 1) results.push(p);
  }
  console.log(`[transcribe] parseSplitPhrasesFromRaw repaired: ${results.length} phrases from truncated JSON`);
  return results;
}

function getFfmpegPath(): string {
  if (process.platform !== "win32") return "/usr/bin/ffmpeg";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `win32-${process.arch}`, "ffmpeg.exe");
}

function getFfprobePath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const ffmpegDir = path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
  );
  const probe = path.join(ffmpegDir, `ffprobe${ext}`);
  if (fs.existsSync(probe)) return probe;
  return path.join(ffmpegDir, `ffmpeg${ext}`);
}

function extractAudioMp3(ffmpegPath: string, inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      "-y", "-i", inputPath,
      "-vn", "-acodec", "libmp3lame", "-ab", "64k", "-ar", "16000", "-ac", "1",
      outputPath,
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg audio extract failed: ${err.message}\n${stderr?.slice(-300)}`));
      else resolve();
    });
  });
}

function getAudioDurationMs(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = getFfprobePath();
    if (!fs.existsSync(probe)) return reject(new Error("ffprobe/ffmpeg not found"));

    if (probe.toLowerCase().includes("ffprobe")) {
      execFile(probe, [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", audioPath,
      ], (err, stdout) => {
        if (err) return reject(err);
        const sec = parseFloat(stdout.trim());
        if (!Number.isFinite(sec)) return reject(new Error("Could not parse duration"));
        resolve(Math.max(1, Math.round(sec * 1000)));
      });
      return;
    }

    execFile(probe, ["-i", audioPath, "-f", "null", "-"], { maxBuffer: 5 * 1024 * 1024 }, (_err, _stdout, stderr) => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (!m) return reject(new Error("Could not parse duration from ffmpeg"));
      const ms = (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + parseInt(m[4], 10) * 10;
      resolve(Math.max(1, ms));
    });
  });
}

// ── Local Whisper via Python script ──────────────────────────────────────────
// Uses openai-whisper (pip install openai-whisper) with word_timestamps=True.
// Returns null if Python/whisper not available → caller falls back to OpenAI API.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "base";
const WHISPER_SCRIPT = path.join(process.cwd(), "scripts", "whisper_transcribe.py");

function getPythonCmd(): string {
  return process.platform === "win32" ? "python" : "python3";
}

interface LocalWhisperResult {
  text: string;
  words: { word: string; start: number; end: number }[];
  segments: { text: string; start: number; end: number }[];
  language: string;
}

type SubtitleItem = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs?: number;
  confidence?: number;
  tag?: "hook" | "body" | "cta";
};

function sanitizeCaptionsTimeline(raw: SubtitleItem[], audioDurationMs: number, fps = 30): SubtitleItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const minMs = Math.max(1, Math.ceil(1000 / Math.max(1, fps)));
  const totalMs = Math.max(0, Number(audioDurationMs));
  const EPS = 1;
  const minCaptionMs = Math.max(MIN_CAPTION_MS, minMs);
  const clampSegment = (start: number, end: number): { startMs: number; endMs: number } => {
    let startMs = Math.max(0, Math.round(start));
    let endMs = Math.max(startMs, Math.round(end));

    if (endMs <= startMs) {
      endMs = startMs + minCaptionMs;
    }

    if (endMs > totalMs) {
      endMs = totalMs;
      if (endMs - startMs < minCaptionMs) {
        startMs = Math.max(0, endMs - minCaptionMs);
      }
    }

    if (endMs <= startMs) {
      endMs = startMs + Math.max(minCaptionMs, 240);
      if (endMs > totalMs) {
        endMs = totalMs;
        startMs = Math.max(0, endMs - Math.max(minCaptionMs, 240));
      }
    }

    if (endMs <= startMs) {
      endMs = startMs + 1;
      if (endMs > totalMs) endMs = totalMs;
      startMs = Math.max(0, endMs - 1);
    }

    return { startMs, endMs };
  };

  const normalized: SubtitleItem[] = raw
    .map((c) => ({
      ...c,
      text: typeof c?.text === "string" ? c.text.trim() : "",
      startMs: Number.isFinite(Number(c?.startMs)) ? Number(c.startMs) : NaN,
      endMs: Number.isFinite(Number(c?.endMs)) ? Number(c.endMs) : NaN,
    }))
    .filter((c) => c.text.length > 0 && Number.isFinite(c.startMs) && Number.isFinite(c.endMs))
    .sort((a, b) => a.startMs - b.startMs);

  if (!normalized.length) return [];

  const out: SubtitleItem[] = [];
  let cursor = 0;

  for (const cap of normalized) {
    let start = Math.min(Math.max(0, cap.startMs), totalMs);
    let end = cap.endMs;
    if (!Number.isFinite(end)) end = start + minCaptionMs;

    if (start < cursor) {
      start = cursor;
    }

    const clipped = clampSegment(start, Math.max(start, end));
    start = clipped.startMs;
    end = clipped.endMs;

    if (end - start < minCaptionMs) {
      end = Math.min(totalMs, start + Math.max(minCaptionMs, 2 * minMs));
      if (end - start < minCaptionMs) {
        start = Math.max(0, totalMs - Math.max(minCaptionMs, 2 * minMs));
        end = Math.min(totalMs, start + Math.max(minCaptionMs, 2 * minMs));
      }
    }

    if (start >= totalMs) {
      continue;
    }

    out.push({
      ...cap,
      text: cap.text.trim(),
      startMs: Math.round(start),
      endMs: Math.round(end),
      timestampMs: Math.round(start),
    });
    cursor = end;
  }

  // Final pass: ensure strict order and no overlap.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].endMs >= out[i + 1].startMs) {
      const safeEnd = Math.max(out[i].startMs + minCaptionMs, out[i + 1].startMs - EPS);
      out[i].endMs = Math.min(totalMs - MIN_GAP_MS, safeEnd);
      out[i + 1].startMs = Math.min(totalMs, Math.max(out[i].endMs + MIN_GAP_MS, out[i + 1].startMs));
    }
    if (out[i].endMs <= out[i].startMs) {
      const restored = clampSegment(out[i].startMs, out[i].startMs + minCaptionMs);
      out[i].startMs = restored.startMs;
      out[i].endMs = restored.endMs;
    }
  }

  if (out.length > 0) {
    const lastIdx = out.length - 1;
    if (out[lastIdx].endMs <= out[lastIdx].startMs) {
      const restored = clampSegment(out[lastIdx].startMs, out[lastIdx].startMs + minCaptionMs);
      out[lastIdx].startMs = restored.startMs;
      out[lastIdx].endMs = restored.endMs;
    }
  }

  if (out.length > 0 && out[out.length - 1].endMs > totalMs) out[out.length - 1].endMs = totalMs;

  return out;
}

function runLocalWhisper(audioPath: string): Promise<LocalWhisperResult | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(WHISPER_SCRIPT)) { resolve(null); return; }
    const python = getPythonCmd();
    execFile(python, [WHISPER_SCRIPT, audioPath, WHISPER_MODEL], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 600_000,  // 10 min max
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error("[transcribe] local whisper error:", stderr?.slice(-500));
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) { console.error("[transcribe] whisper script error:", parsed.error); resolve(null); return; }
        resolve(parsed as LocalWhisperResult);
      } catch {
        console.error("[transcribe] whisper JSON parse failed:", stdout.slice(0, 200));
        resolve(null);
      }
    });
  });
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { audioUrl, scriptPrompt, script, preferredLLM } = await req.json();
    if (!audioUrl) {
      return NextResponse.json({ error: "audioUrl is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { openaiKey: true, geminiKey: true, ttsProvider: true },
    });

    // LLM selection priority:
    //   1. SERVER_OPENAI_API_KEY (server override) → OpenAI
    //   2. preferredLLM from client ("gemini" | "openai") — user picked in picker
    //   3. fallback: geminiKey first, then openaiKey
    const hasServerKey = !!process.env.SERVER_OPENAI_API_KEY;
    const wantGemini = preferredLLM === "gemini";
    const wantOpenAI = preferredLLM === "openai";

    let useGeminiTranscribe = false;
    let useOpenAITranscribe = false;
    if (hasServerKey) {
      useOpenAITranscribe = true;
    } else if (wantGemini && user?.geminiKey) {
      useGeminiTranscribe = true;
    } else if (wantOpenAI && user?.openaiKey) {
      useOpenAITranscribe = true;
    } else if (user?.geminiKey) {
      useGeminiTranscribe = true;
    } else if (user?.openaiKey) {
      useOpenAITranscribe = true;
    }
    console.log(`[transcribe] preferredLLM=${preferredLLM ?? "auto"} hasOpenAI=${!!user?.openaiKey} hasGemini=${!!user?.geminiKey} → ${useGeminiTranscribe ? "Gemini" : useOpenAITranscribe ? "OpenAI" : "LocalWhisper"}`);

    // Resolve local file path or download remote
    const ts = Date.now();
    const tmpDir = path.join(process.cwd(), "stocks");
    fs.mkdirSync(tmpDir, { recursive: true });
    let inputPath: string;
    let needsCleanup = false;

    if (audioUrl.startsWith("/api/stocks/")) {
      const filename = audioUrl.replace("/api/stocks/", "");
      inputPath = path.join(tmpDir, filename);
      if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
    } else if (audioUrl.startsWith("/")) {
      inputPath = path.join(process.cwd(), "public", audioUrl.replace(/^\/api\/renders\//, "/renders/"));
      if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
    } else {
      // Extract local path from full URL if pointing to our own server, then read from disk
      const localMatch = audioUrl.match(/^https?:\/\/[^/]+(\/.*)/);
      const localPath = localMatch ? path.join(process.cwd(), "public", localMatch[1].replace(/^\/api\/renders\//, "/renders/")) : null;
      if (localPath && fs.existsSync(localPath)) {
        inputPath = localPath;
      } else {
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) return NextResponse.json({ error: `Failed to fetch audio file (${audioRes.status}): ${audioUrl}` }, { status: 400 });
        inputPath = path.join(tmpDir, `transcribe-tmp-${ts}.mp4`);
        fs.writeFileSync(inputPath, Buffer.from(await audioRes.arrayBuffer()));
        needsCleanup = true;
      }
    }

    // Extract audio as mp3 (mono 16kHz) — required for both local Whisper and OpenAI API
    const ffmpeg = getFfmpegPath();
    const mp3Path = path.join(tmpDir, `transcribe-audio-${ts}.mp3`);
    try {
      await extractAudioMp3(ffmpeg, inputPath, mp3Path);
    } catch (e) {
      console.error("[transcribe] ffmpeg extract failed:", e);
      if (needsCleanup) try { fs.unlinkSync(inputPath); } catch {}
      return NextResponse.json({ error: "ไม่สามารถแกะเสียงจากไฟล์ได้" }, { status: 500 });
    }
    let sourceAudioDurationMs = 0;
    try {
      sourceAudioDurationMs = await getAudioDurationMs(mp3Path);
      console.log(`[transcribe] source audio duration ${sourceAudioDurationMs}ms`);
    } catch (e) {
      console.warn("[transcribe] failed to read mp3 duration:", e);
    }
    if (needsCleanup) try { fs.unlinkSync(inputPath); } catch {}

    type WhisperWord = { word: string; start: number; end: number };
    type WhisperSegment = { text: string; start: number; end: number };
    let words: WhisperWord[] = [];
    let segments: WhisperSegment[] = [];
    let fullText = "";

    if (useGeminiTranscribe) {
      // ── Strategy 1: Gemini Audio Transcribe with timestamps ──
      // Ask Gemini to return segments with start/end times so we get real timestamps.
      // Gemini 2.5 Flash supports audio + JSON structured output in a single call.
      console.log("[transcribe] using Gemini transcribe with timestamps...");
      try {
        const geminiKey = Buffer.from(user!.geminiKey!, "base64").toString("utf-8");
        const audioBuffer = fs.readFileSync(mp3Path);
        try { fs.unlinkSync(mp3Path); } catch {}
        const audioBytes = audioBuffer.length;

        // Upload audio to Gemini File API — avoids sending large base64 inline which causes
        // UND_ERR_HEADERS_TIMEOUT on long audio. File API accepts the binary directly.
        console.log(`[transcribe] uploading ${(audioBytes / 1024 / 1024).toFixed(1)}MB to Gemini File API...`);
        const uploadRes = await fetch(
          `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "audio/mp3",
              "X-Goog-Upload-Protocol": "raw",
              "X-Goog-Upload-Command": "upload, finalize",
              "X-Goog-Upload-Header-Content-Length": String(audioBytes),
              "X-Goog-Upload-Header-Content-Type": "audio/mp3",
            },
            signal: AbortSignal.timeout(120_000),
            body: audioBuffer,
          }
        );
        if (!uploadRes.ok) {
          const errBody = await uploadRes.text().catch(() => "");
          throw new Error(`Gemini File API upload failed: ${uploadRes.status} — ${errBody.slice(0, 200)}`);
        }
        const uploadData = await uploadRes.json() as { file?: { uri?: string; name?: string } };
        const fileUri = uploadData?.file?.uri;
        const fileName = uploadData?.file?.name;
        if (!fileUri) throw new Error("Gemini File API did not return file URI");
        console.log(`[transcribe] uploaded to Gemini File API: ${fileName}`);

        const timestampPrompt = `Transcribe this Thai audio into short subtitle segments with timestamps.

Return ONLY valid JSON, no markdown, no explanation:
{"segments":[{"text":"...","start":0.0,"end":2.5},...],"fullText":"..."}

RULES:
- Each segment = one short subtitle line — MAX 15 Thai characters or MAX 4 seconds
- NEVER cut mid-word or mid-syllable — always break at a natural pause or sentence boundary
- Split long sentences into multiple short segments, each with its own start/end time
- start/end = seconds (float, accurate to 0.1s)
- Add a space between Thai words where there is a natural word boundary (do not run all words together)
- fullText = complete transcription joined together
- NEVER fabricate timestamps — only use what you can hear
- If audio has silence/pause, keep that gap between segments${script ? `\n- Reference script (match wording): ${script.trim().slice(0, 2000)}` : ""}`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(600_000),
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: timestampPrompt },
                  { fileData: { mimeType: "audio/mp3", fileUri } },
                ],
              }],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 16384,
                responseMimeType: "application/json",
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
          }
        );

        // Clean up uploaded file from Gemini (best-effort)
        if (fileName) {
          fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${geminiKey}`, { method: "DELETE" }).catch(() => {});
        }

        if (!geminiRes.ok) {
          const errBody = await geminiRes.text().catch(() => "");
          console.error("[transcribe] Gemini error body:", errBody.slice(0, 500));
          if (geminiRes.status === 401 || geminiRes.status === 403) {
            throw { status: geminiRes.status, body: errBody };
          }
          throw new Error(`Gemini transcribe failed: ${geminiRes.status} — ${errBody.slice(0, 200)}`);
        }
        const geminiData = await geminiRes.json() as Record<string, unknown>;
        const candidates = geminiData?.candidates as Array<{content:{parts:Array<{text:string}>}}> | undefined;
        const rawGeminiText = candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
        console.log(`[transcribe] Gemini raw: ${rawGeminiText.slice(0, 300)}`);

        // Try to parse structured JSON response with timestamps
        try {
          // Strip markdown fences and find outermost JSON object
          const stripped = rawGeminiText
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/g, "")
            .trim();

          // Try longest JSON match first (greedy), then fallback to first match
          const allMatches = [...stripped.matchAll(/\{[\s\S]*?\}/g)];
          const match = stripped.match(/\{[\s\S]*\}/) ?? (allMatches.length > 0 ? allMatches[allMatches.length - 1] : null);

          if (match) {
            let parsed: { fullText?: string; segments?: unknown[] } | null = null;
            try {
              parsed = JSON.parse(match[0]);
            } catch {
              // Salvage: extract all complete segment objects before the truncation point
              const completeSegs: string[] = [];
              const segRegex = /\{"text":"((?:[^"\\]|\\.)*)","start":([\d.]+),"end":([\d.]+)\}/g;
              let m2: RegExpExecArray | null;
              while ((m2 = segRegex.exec(match[0])) !== null) {
                completeSegs.push(m2[0]);
              }
              if (completeSegs.length > 0) {
                const repairedJson = `{"segments":[${completeSegs.join(",")}],"fullText":""}`;
                try { parsed = JSON.parse(repairedJson); } catch { /* give up */ }
              } else {
                // Last resort: close the array
                const truncated = match[0].replace(/,\s*\{[^}]*$/, "]}")
                  .replace(/,\s*$/, "").replace(/\]\s*$/, "]}");
                try { parsed = JSON.parse(truncated); } catch { /* give up */ }
              }
            }

            if (parsed) {
              fullText = parsed.fullText?.trim() ||
                (Array.isArray(parsed.segments)
                  ? (parsed.segments as { text?: string }[]).map(s => s.text ?? "").join(" ").trim()
                  : rawGeminiText);
              if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
                segments = (parsed.segments as { text?: string; start?: number; end?: number }[])
                  .filter((s) =>
                    typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number"
                  )
                  .map((s) => ({
                    text: (s.text as string).trim(),
                    start: s.start as number,
                    end: s.end as number,
                  }));
                console.log(`[transcribe] Gemini OK — ${fullText.length} chars, ${segments.length} segments with timestamps`);
              } else {
                console.warn("[transcribe] Gemini returned no segments, falling back to text-only");
                fullText = parsed.fullText?.trim() || stripped;
              }
            } else {
              console.warn("[transcribe] Gemini JSON repair failed, raw:", rawGeminiText.slice(0, 200));
              fullText = stripped;
            }
          } else {
            // No JSON object found — Gemini returned plain text
            console.warn("[transcribe] Gemini no JSON found, raw:", rawGeminiText.slice(0, 200));
            fullText = stripped;
          }
        } catch {
          // JSON parse failed → log raw for debugging
          console.warn("[transcribe] Gemini JSON parse failed, raw:", rawGeminiText.slice(0, 300));
          fullText = rawGeminiText;
        }
      } catch (e: unknown) {
        console.error("[transcribe] Gemini transcribe error:", e);
        const status = (e as { status?: number })?.status;
        if (status === 401) {
          return NextResponse.json({ error: "Gemini API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings", missingKey: "gemini" }, { status: 401 });
        }
        if (status === 403) {
          return NextResponse.json({ error: "Gemini API Key ไม่มีสิทธิ์ใช้งาน กรุณาเปิดใช้งาน Gemini API ใน Google AI Studio", retryable: false }, { status: 403 });
        }
        return NextResponse.json({ error: "Gemini transcribe ไม่สำเร็จ กรุณาลองใหม่", retryable: true }, { status: 503 });
      }
    } else if (useOpenAITranscribe) {
      // ── Strategy 2: OpenAI Whisper API ──
      console.log("[transcribe] using OpenAI Whisper API...");
      const rawKey = process.env.SERVER_OPENAI_API_KEY ?? (user?.openaiKey ? Buffer.from(user.openaiKey, "base64").toString("utf-8") : "");
      const apiKey = rawKey;
      const audioBuffer = fs.readFileSync(mp3Path);
      try { fs.unlinkSync(mp3Path); } catch {}
      const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
      const form = new FormData();
      form.append("file", audioBlob, "audio.mp3");
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (scriptPrompt?.trim()) form.append("prompt", scriptPrompt.trim().slice(0, 224)); // Whisper prompt hard-limit is 224 tokens

      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!whisperRes.ok) {
        const err = await whisperRes.text();
        return NextResponse.json({ error: `OpenAI Whisper ไม่สำเร็จ: ${err.slice(0, 200)}` }, { status: 500 });
      }
      const data = await whisperRes.json();
      words    = data.words    ?? [];
      segments = data.segments ?? [];
      fullText = data.text     ?? "";
      console.log(`[transcribe] OpenAI Whisper OK — ${words.length} words`);
    } else {
      // ── Strategy 3: Local Whisper (fallback) ──
      console.log(`[transcribe] trying local Whisper (model=${WHISPER_MODEL})...`);
      const localResult = await runLocalWhisper(mp3Path);
      if (localResult && (localResult.words.length > 0 || localResult.segments.length > 0)) {
        console.log(`[transcribe] local Whisper OK — ${localResult.words.length} words, ${localResult.segments.length} segs`);
        words    = localResult.words;
        segments = localResult.segments;
        fullText = localResult.text;
        try { fs.unlinkSync(mp3Path); } catch {}
      } else {
        try { fs.unlinkSync(mp3Path); } catch {}
        return NextResponse.json({ error: "Whisper ไม่สำเร็จ กรุณากด Transcribe ใหม่อีกครั้ง", retryable: true }, { status: 503 });
      }
    }

    // ── Get LLM key for subtitle splitting — respects preferredLLM from client ──
    let apiKey = process.env.SERVER_OPENAI_API_KEY ?? null;
    let useGemini = false;
    if (!apiKey) {
      if (wantGemini && user?.geminiKey) { apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
      else if (wantOpenAI && user?.openaiKey) { apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
      else if (user?.geminiKey) { apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
      else if (user?.openaiKey) { apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
    }

    // Detect if Thai — local Whisper large-v3-turbo has word-level for Thai too,
    // but quality varies. Use segment-level grouping for Thai; word-level for Latin scripts.
    const isThai = /[\u0E00-\u0E7F]/.test(fullText);

    let captions: { text: string; startMs: number; endMs: number; timestampMs: number; confidence: number; tag?: "hook" | "body" | "cta" }[] = [];

    if (isThai || words.length === 0) {
      // Always use the real script as source text — STT text may be inaccurate.
      // STT (Whisper/Gemini) is used ONLY for timestamps, never for subtitle text.
      const sourceRaw: string = (typeof script === "string" && script.trim().length > 0)
        ? script.trim() : fullText;
      const sourceText = sanitizeTranscriptionText(sourceRaw);
      console.log(`[transcribe] sourceText from ${typeof script === "string" && script.trim().length > 0 ? "script (real)" : "STT fullText (fallback)"}: ${sourceText.slice(0, 80)}`);
      const fallbackDur = sourceAudioDurationMs > 0 ? sourceAudioDurationMs / 1000 : 30;
      const audioDur = Math.max(
        segments.length > 0 ? segments[segments.length - 1].end : 0,
        words.length > 0 ? words[words.length - 1].end : 0,
        fallbackDur
      );

      captions = [];

      // ── LLM always splits subtitles — Gemini segment timestamps used only for timing alignment ──
      let phrases: string[] = [];
      let llmTags: ("hook" | "body" | "cta")[] = [];
      let minPhrases = 4;
      let maxPhrases = 6;
      const openAiSplitModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
      const scriptSentencesInitial = splitToSentencePhrases(sourceRaw);
      const hasSentencePunctuation = /[.!?…]/.test(sourceText);
      const strictSentences = splitToPunctuationSentences(sourceText);
      const shouldSkipLLMSplit = strictSentences.length === 1 && !hasSentencePunctuation && sourceText.length <= 70;

      if (shouldSkipLLMSplit) {
        phrases = mergeTinyPhrases(mergeDateAndConnectorBreaks(scriptSentencesInitial));
        console.log(`[transcribe] skip LLM split for single-sentence input: ${phrases.length} phrase(s)`);
      } else if (apiKey) {
        try {
          const durationSec = audioDur;
          const sourceLen = sourceText.replace(/\s+/g, "").length;
          // Thai reading: ~20 chars/subtitle, ~3-4s/subtitle — take whichever gives more phrases
          const byChars = Math.round(sourceLen / 20);
          const byDur = Math.round(durationSec / 3.5);
          const targetPhrases = Math.max(byChars, byDur, 3);
          minPhrases = Math.max(3, targetPhrases - 2);
          maxPhrases = targetPhrases + 4;

          // Build speech rhythm hint from Gemini segment pause points
          // LLM uses this to split at real breath boundaries in the audio
          let rhythmHint = "";
          if (segments.length >= 2) {
            const breathPoints: string[] = [];
            for (let si = 0; si < segments.length - 1; si++) {
              const gap = segments[si + 1].start - segments[si].end;
              if (gap >= 0.2) {
                breathPoints.push(`${segments[si].end.toFixed(2)}s — "${segments[si].text.trim().slice(-25)}"`);
              }
            }
            if (breathPoints.length > 0) {
              rhythmHint = `\n\n━━━ SPEECH PAUSE POINTS ━━━
Split subtitles at or near these natural pause points (detected from audio):
${breathPoints.slice(0, 50).map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`;
            }
          }

          // Estimate ~seconds per phrase from pause points to warn LLM about short phrases
          const avgSecPerPhrase = durationSec / Math.max(1, targetPhrases);

          const splitPrompt = `You are a Thai subtitle splitter for TikTok/Reels short videos.

TASK: Split the SCRIPT into subtitle phrases. COPY every word EXACTLY — never drop, rewrite, or summarize.

━━━ HARD RULES ━━━

1. COPY EXACTLY — never drop, rewrite, or summarize any word from the script

2. SPLIT ONLY AT WORD BOUNDARIES — Thai has no spaces between words, so you MUST split only where a logical word ends
   ✗ BAD: "...มึงเรียนมาตั้งแต่เ" + "ด็กท่อง..." ← cut in the MIDDLE of a word (เด็ก)
   ✗ BAD: "...ทำความเข้าใจ" + "ได้แค่นั้น" ← cut mid-compound-word
   ✗ BAD: "...เสือก" + "ไปเปิด..." ← cut mid-sentence with no boundary
   ✓ GOOD: split after a complete word like "บราวน์" before "แม่งเสือกไปเปิด"
   ✓ GOOD: split after punctuation or a natural pause in speech

3. COMPLETE THOUGHT — every phrase must stand alone as a complete idea
   ✗ BAD: "และ OpenAI" / "ของบริษัทชื่อ" ← dangling fragments
   ✓ GOOD: "OpenAI อาจไม่ใช่เบอร์ 1 อีกต่อไป" ← complete

4. NEVER start a phrase with: และ, แต่, ของ, ที่, ว่า, จึง, เพราะ, โดย, ซึ่ง, หรือ, แล้ว, ก็
   → merge with previous phrase instead

5. MINIMUM phrase duration ~${Math.max(1.5, avgSecPerPhrase * 0.5).toFixed(1)}s — too short = unreadable, merge it

6. Max 25 Thai chars per phrase (one screen line) — split long sentences at natural pause points

7. Split at PAUSE POINTS below — real breath boundaries from audio

━━━ GUIDELINES ━━━
• Audio: ${durationSec.toFixed(1)}s → target ${minPhrases}–${maxPhrases} phrases (~${avgSecPerPhrase.toFixed(1)}s each)
• Punchlines / impact: short phrase alone on screen is OK if ≥1.5s
• Date (วันที่+เดือน+ปี) = ONE phrase

━━━ TAGS ━━━
• "hook" = first 1–2 phrases • "body" = main • "cta" = กดติดตาม/like/share

━━━ OUTPUT — valid JSON only, no markdown ━━━
{"phrases":["phrase1","phrase2",...],"tags":["hook","body",...]}${rhythmHint}

━━━ SCRIPT ━━━
${sourceText.trim()}`;

          // Thai phrases use ~60 tokens each (multi-byte chars + JSON overhead); cap at 32k
          const splitMaxTokens = Math.min(32000, Math.max(1024, maxPhrases * 60 + 500));

          let gptRawText = "{}";
          if (useGemini) {
            try {
              const raw = await geminiGenerateText(apiKey, splitPrompt, splitMaxTokens);
              console.log(`[transcribe] Gemini split raw:`, raw.slice(0, 300));
              gptRawText = parseSplitPhrasesFromRaw(raw).length > 0 ? raw : "{}";
            } catch (e) {
              console.warn("[transcribe] Gemini split failed:", e);
            }
          } else {
            const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: openAiSplitModel, messages: [{ role: "user", content: splitPrompt }], max_tokens: splitMaxTokens, temperature: 0, response_format: { type: "json_object" } }),
            });
            if (gptRes.ok) {
              const d = await gptRes.json();
              gptRawText = d.choices?.[0]?.message?.content ?? "{}";
            }
          }

          if (gptRawText !== "{}") {
            try {
              const parsed = JSON.parse(gptRawText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
              const raw: string[] = Array.isArray(parsed.phrases) ? parsed.phrases : parseSplitPhrasesFromRaw(gptRawText);
              if (Array.isArray(parsed.tags) && parsed.tags.length === raw.length) {
                llmTags = parsed.tags as ("hook" | "body" | "cta")[];
              }
              const origStripped = normalizeForCompare(sourceText);
              const outStripped  = normalizeForCompare(raw.join(""));
              const charRatio    = origStripped.length > 0 ? outStripped.length / origStripped.length : 0;
              if (raw.length > 0 && charRatio >= 0.45 && charRatio <= 1.80) {
                // Always slice text from real script using LLM phrase proportions.
                // LLM decides WHERE to split; script is the source of truth for WHAT to show.
                // This prevents LLM from dropping words like "และ", "ของ", etc.
                phrases = mergeTinyPhrases(snapPhrasesToScript(raw, sourceText));
                phrases = deduplicatePhraseEdges(mergeDateAndConnectorBreaks(phrases));
                console.log(`[transcribe] LLM split → ${phrases.length} phrases (ratio=${charRatio.toFixed(3)}) tags=${llmTags.length}`);
              } else {
                console.warn(`[transcribe] LLM ratio mismatch orig=${origStripped.length} out=${outStripped.length} ratio=${charRatio.toFixed(3)}`);
              }
            } catch (e) {
              console.warn("[transcribe] LLM parse failed:", e);
            }
          }
        } catch (e) {
          console.warn("[transcribe] LLM split failed:", e);
        }
      }

      // Guardrail: single long Thai sentence can silently become 1 oversized subtitle.
      // Split it by character density so timing can be mapped naturally on segments/words.
      if (!shouldSkipLLMSplit && phrases.length === 1 && strictSentences.length === 1 && !hasSentencePunctuation) {
        const denseText = sourceText.replace(/\s+/g, "");
        const thaiChars = (denseText.match(/[\u0E00-\u0E7F]/g) ?? []).length;
        const thaiRatio = denseText.length > 0 ? thaiChars / denseText.length : 0;
        if (thaiRatio >= 0.6 && denseText.length >= 70) {
          const fallbackTarget = Math.max(2, Math.min(8, Math.max(2, Math.round(audioDur / 2.2)), 12));
          const splitByTarget = splitTextByTargetLen(sourceText, Math.max(12, Math.floor(denseText.length / fallbackTarget)), 10);
          if (splitByTarget.length > 1) {
            phrases = mergeTinyPhrases(splitByTarget);
            llmTags = phrases.map((_, i) => (i === 0 ? "hook" : "body"));
            console.log(`[transcribe] guardrail split: ${phrases.length} phrases for long monolithic sentence`);
          }
        }
      }

      // Do NOT forcibly expand phrases to minPhrases — expandPhrasesToTargetDensity
      // splits by char count and breaks Thai/English phrases mid-word.

      // ── Fallback: split by sentence punctuation or newlines ─────────────────
      if (phrases.length === 0 && captions.length === 0) {
        const sentenceFallback = splitToSentencePhrases(sourceRaw);
        if (sentenceFallback.length > 1) {
          phrases = mergeTinyPhrases(mergeDateAndConnectorBreaks(sentenceFallback));
        } else {
        const MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
        const isMonth = (s: string) => MONTHS.some(m => s.trim().startsWith(m));
        const isYear  = (s: string) => /^\d{4}$/.test(s.trim());
        const isDateN = (s: string) => /^(วันที่\s*)?\d{1,2}$/.test(s.trim());

        // If single paragraph (no newlines), split by sentence-ending punctuation first
        let rawLines: string[];
        if (!sourceText.includes("\n")) {
          // Split at Thai sentence ends: . ! ? ฯ — keep delimiter
          rawLines = sourceText
            .split(/(?<=[.!?ฯ])\s+/)
            .flatMap(chunk => chunk.split(/(?<=[\u0E00-\u0E7F]{10,})\s+(?=[\u0E00-\u0E7F])/))
            .filter(Boolean);
          if (rawLines.length <= 1) {
            // Last resort: split by spaces every ~15 chars of Thai content
            const chars = [...sourceText];
            const out: string[] = []; let buf = "";
            for (const ch of chars) {
              buf += ch;
              const thaiLen = (buf.match(/[\u0E00-\u0E7F]/g) ?? []).length;
              if (thaiLen >= 15 && /\s/.test(ch)) { out.push(buf.trim()); buf = ""; }
            }
            if (buf.trim()) out.push(buf.trim());
            rawLines = out.length > 1 ? out : [sourceText];
          }
        } else {
          rawLines = sourceText.split("\n");
        }

        for (let i = 0; i < rawLines.length; i++) {
          const cur = rawLines[i].trim();
          if (!cur) continue;
          if (isDateN(cur)) {
            const num = cur.replace(/^วันที่\s*/, "").trim();
            let combined = num; let skip = 0;
            if (i + 1 < rawLines.length && isMonth(rawLines[i + 1])) {
              combined += " " + rawLines[i + 1].trim(); skip++;
              if (i + 2 < rawLines.length && isYear(rawLines[i + 2])) { combined += " " + rawLines[i + 2].trim(); skip++; }
            }
            phrases.push(combined); i += skip; continue;
          }
          if (isMonth(cur) && i + 1 < rawLines.length && isYear(rawLines[i + 1])) {
            phrases.push(cur + " " + rawLines[i + 1].trim()); i++; continue;
          }
          phrases.push(cur);
        }
        phrases = deduplicatePhraseEdges(mergeTinyPhrases(mergeDateAndConnectorBreaks(phrases)));
      }
        console.log(`[transcribe] fallback split → ${phrases.length} phrases`);
        // Do NOT expand here — char-based splitting breaks mixed Thai/English phrases.
      }

      if (captions.length === 0) {
        phrases = phrases
          .map((p) => collapseConsecutiveDuplicateWords(p))
          .map((p) => normalizeCaptionText(p))
          .filter(Boolean);
        phrases = deduplicatePhraseEdges(mergeTinyPhrases(mergeDateAndConnectorBreaks(phrases)));
        phrases = limitPhraseCountByDuration(phrases, audioDur);
        phrases = phrases
          .map((p) => normalizeCaptionText(p))
          .filter(Boolean);
        console.log(`[transcribe] phrase postprocess → ${phrases.length} phrases`);
      }

      // ── Step 2: Align phrases → real timestamps ─────────────────────────────
      // Priority order:
      //   A. 1-to-1: phrases count == segments count → direct map (best accuracy)
      //   B. Segment-anchored: use Gemini/Whisper segment timestamps as anchors,
      //      distribute phrases proportionally within those anchors (main path)
      //   C. Word-level: Whisper word timestamps available → char-proportional word map
      //   D. Char-proportional over total duration (no timestamps at all)

      if (phrases.length > 0) {
        let result: { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" }[] = [];

        // Strategy B: segment-anchored alignment via char proportion
        // Skip if segments are too sparse (< 1 segment per 4 phrases) — char-proportion
        // over sparse segments creates huge gaps where Gemini didn't detect speech.
        const segmentDensityOk = segments.length >= 2 && (phrases.length / segments.length) <= 4;
        if (result.length === 0 && segmentDensityOk) {
          const segAligned = alignPhrasesToSegmentTimestamps(phrases, segments);
          if (segAligned.length === phrases.length) {
            result = segAligned;
            console.log(`[transcribe] Strategy B segment-anchored alignment: ${result.length} phrases over ${segments.length} segs`);
          }
        } else if (segments.length >= 2) {
          console.log(`[transcribe] Strategy B skipped — sparse segments (${segments.length} segs / ${phrases.length} phrases), using char-proportion`);
        }

        // Strategy C: word-level alignment (Whisper word timestamps)
        if (result.length === 0) {
          const alignWords = words.length > 0 ? words : buildFallbackWordsFromSegments(segments);
          const alignedByWord = alignWords.length > 0 ? alignPhrasesToWordTimings(phrases, alignWords) : [];
          if (alignedByWord.length === phrases.length) {
            result = alignedByWord.map((r) => ({ ...r, text: sanitizeTranscriptionText(r.text) }));
            console.log(`[transcribe] Strategy C word-timing alignment: ${result.length} phrases`);
          }
        }

        // Strategy D: no timestamps at all — char proportion over total duration
        if (result.length === 0) {
          const charLengths = phrases.map(alignmentCharLen);
          const totalChars = charLengths.reduce((a, b) => a + b, 0);
          let cumChars = 0;
          for (let i = 0; i < phrases.length; i++) {
            const startSec = (cumChars / totalChars) * audioDur;
            cumChars += charLengths[i];
            const endSec = (cumChars / totalChars) * audioDur;
            result.push({
              text: sanitizePhraseText(phrases[i]),
              startMs: Math.round(startSec * 1000),
              endMs: Math.round(endSec * 1000),
            });
          }
          console.log(`[transcribe] Strategy D char-proportional (no timestamps) ${result.length} captions over ${audioDur.toFixed(1)}s`);
        }

        // Merge captions that are too short to read (< 1200ms) into adjacent
        if (result.length > 1) {
          const MIN_DUR_MS = 1200;
          let merged = true;
          while (merged && result.length > 1) {
            merged = false;
            for (let i = 0; i < result.length; i++) {
              const dur = result[i].endMs - result[i].startMs;
              if (dur < MIN_DUR_MS) {
                // merge into shorter neighbor
                const mergeNext = i < result.length - 1 &&
                  (i === 0 || (result[i + 1].endMs - result[i + 1].startMs) <= (result[i - 1].endMs - result[i - 1].startMs));
                if (mergeNext) {
                  result[i + 1] = { ...result[i + 1], text: `${result[i].text} ${result[i + 1].text}`.trim(), startMs: result[i].startMs };
                  result.splice(i, 1);
                } else {
                  result[i - 1] = { ...result[i - 1], text: `${result[i - 1].text} ${result[i].text}`.trim(), endMs: result[i].endMs };
                  result.splice(i, 1);
                }
                merged = true;
                break;
              }
            }
          }
          console.log(`[transcribe] after short-merge: ${result.length} captions`);
        }

        // Extend every caption's endMs to the next caption's startMs — eliminates all gaps
        for (let i = 0; i < result.length - 1; i++) {
          if (result[i + 1].startMs > result[i].endMs) {
            result[i].endMs = result[i + 1].startMs;
          }
        }

        // Keep mapped caption boundaries from source timings, then clamp and dedupe overlaps.
        if (result.length > 0) {
          const totalAudioMs = Math.max(1, Math.round(audioDur * 1000));
          const safeResult = sanitizeCaptionsTimeline(
            result.map((r) => ({ ...r, timestampMs: r.startMs, confidence: 1, tag: (r as { tag?: "hook" | "body" | "cta" }).tag })),
            totalAudioMs,
            30,
          );
          if (safeResult.length > 0) {
            const safeResultTyped = safeResult as Array<{ text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" }>;
            result = safeResultTyped.map((r) => ({ text: normalizeCaptionText(r.text), startMs: r.startMs, endMs: r.endMs, tag: r.tag }));
          } else {
            console.warn("[transcribe] sanitizeCaptionsTimeline emptied captions; fallback to raw result");
          }
        }

          const safeTags = llmTags.length >= result.length
            ? llmTags
            : [...llmTags, ...Array.from({ length: Math.max(0, result.length - llmTags.length) }, () => "body" as "hook" | "body" | "cta")];

          captions = result.map((g, i) => ({
            text: g.text,
            startMs: g.startMs,
            endMs: g.endMs,
            timestampMs: g.startMs,
            confidence: 1,
            tag: g.tag ?? safeTags[i] ?? "body",
          }));
          captions.forEach((c, i) => console.log(`  [${i}] ${(c.startMs/1000).toFixed(2)}s–${(c.endMs/1000).toFixed(2)}s [${c.tag ?? "body"}] "${c.text.slice(0,30)}"`));
        } // end if (phrases.length > 0) — alignment path

      if (captions.length === 0) {
        // Last resort: split script text evenly by char proportion over total audio duration
        // Never use STT text here — script is always the source of truth
        const fallbackPhrases = splitToSentencePhrases(sourceRaw).length > 0
          ? splitToSentencePhrases(sourceRaw)
          : sourceText.split(/(?<=[.!?ฯ])\s+|(?<=[฀-๿]{8,})\s+(?=[฀-๿])/).filter(Boolean);
        const fp = fallbackPhrases.length > 1 ? fallbackPhrases : [sourceText];
        const charLens = fp.map(p => Math.max(1, p.replace(/\s+/g, "").length));
        const totalC = charLens.reduce((a, b) => a + b, 0);
        let cum = 0;
        captions = fp.map((p, i) => {
          const startSec = (cum / totalC) * audioDur;
          cum += charLens[i];
          const endSec = (cum / totalC) * audioDur;
          return { text: p.trim(), startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000), timestampMs: Math.round(startSec * 1000), confidence: 0.5 };
        });
        console.log(`[transcribe] last-resort char-split: ${captions.length} captions from script text`);
      } // end if (captions.length === 0) last-resort
    } else if (words.length > 0) {
      // Word-level grouping for non-Thai (English, etc.)
      const MAX_WORDS = 4;
      const MAX_DURATION_S = 2.0;

      const groups: { text: string; startMs: number; endMs: number }[] = [];
      let bucket: string[] = [];
      let bucketStart = words[0].start;
      let bucketEnd = words[0].end;

      for (const w of words) {
        const tooLong = (w.end - bucketStart) > MAX_DURATION_S;
        const tooMany = bucket.length >= MAX_WORDS;

        if ((tooLong || tooMany) && bucket.length > 0) {
          groups.push({
            text: bucket.join(" "),
            startMs: Math.round(bucketStart * 1000),
            endMs: Math.round(bucketEnd * 1000),
          });
          bucket = [w.word];
          bucketStart = w.start;
          bucketEnd = w.end;
        } else {
          bucket.push(w.word);
          bucketEnd = w.end;
        }
      }
      if (bucket.length > 0) {
        groups.push({
          text: bucket.join(" "),
          startMs: Math.round(bucketStart * 1000),
          endMs: Math.round(bucketEnd * 1000),
        });
      }

      captions = groups.map((g) => ({
        text: g.text.trim(),
        startMs: g.startMs,
        endMs: g.endMs,
        timestampMs: g.startMs,
        confidence: 1,
      }));
    }

    // Also return raw segment-level timestamps (natural speech boundaries)
    const rawSegments = segments.map((seg) => ({
      text: seg.text.trim(),
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
    }));

    // Raw word timestamps for forced alignment on client
    const wordTimestamps = words.map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
    }));

    const safeFullText = sanitizeTranscriptionText(fullText);
    const resolvedDurationMs = Math.max(
      sourceAudioDurationMs,
      captions.at(-1)?.endMs ?? 0,
      rawSegments.at(-1)?.endMs ?? 0,
      wordTimestamps.at(-1)?.endMs ?? 0,
      1000,
    );
    const timelineFixedCaptions = sanitizeCaptionsTimeline(captions, resolvedDurationMs);

    return NextResponse.json({
      captions: timelineFixedCaptions,
      segments: rawSegments,
      words: wordTimestamps,
      fullText: safeFullText,
      audioDurationMs: resolvedDurationMs,
    });
  } catch (error) {
    return apiError({ route: "videos/transcribe", error, notifyUser: true });
  }
}

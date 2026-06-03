import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
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

  // Greedy text-match: walk segments left-to-right and greedily consume
  // segments whose text appears in the phrase. This is accurate for Thai
  // because Gemini segments and LLM phrases share the same source text.
  const segTexts = segments.map(s => bare(s.text));

  // For each phrase find the first segment index where its text starts,
  // then extend to cover all segments that are fully contained in the phrase.
  const phraseStartSeg: number[] = [];
  const phraseEndSeg: number[] = [];
  let segCursor = 0;

  for (let pi = 0; pi < phrases.length; pi++) {
    const pBare = bare(phrases[pi]);
    // Find first segment whose text appears in this phrase, starting from segCursor
    let firstSi = segCursor;
    for (let si = segCursor; si < segments.length; si++) {
      if (pBare.includes(segTexts[si]) || segTexts[si].includes(pBare.slice(0, 4))) {
        firstSi = si;
        break;
      }
    }
    // Extend: find last segment still contained in this phrase
    let lastSi = firstSi;
    for (let si = firstSi + 1; si < segments.length; si++) {
      if (pBare.includes(segTexts[si])) {
        lastSi = si;
      } else {
        break;
      }
    }
    phraseStartSeg.push(firstSi);
    phraseEndSeg.push(lastSi);
    segCursor = lastSi + 1;
  }

  // Ensure monotonic: each phrase must start at or after previous phrase ended
  for (let pi = 1; pi < phrases.length; pi++) {
    if (phraseStartSeg[pi] <= phraseEndSeg[pi - 1]) {
      phraseStartSeg[pi] = phraseEndSeg[pi - 1] + 1;
    }
    if (phraseEndSeg[pi] < phraseStartSeg[pi]) {
      phraseEndSeg[pi] = phraseStartSeg[pi];
    }
    // Cap at last segment
    phraseStartSeg[pi] = Math.min(phraseStartSeg[pi], segments.length - 1);
    phraseEndSeg[pi] = Math.min(phraseEndSeg[pi], segments.length - 1);
  }

  // For phrases sharing the same segment, subdivide that segment's time range by char-proportion
  const out: { text: string; startMs: number; endMs: number }[] = [];

  let pi = 0;
  while (pi < phrases.length) {
    const si = phraseStartSeg[pi];
    // Collect all phrases mapped to this same segment
    let pEnd = pi;
    while (pEnd + 1 < phrases.length && phraseStartSeg[pEnd + 1] === si) pEnd++;

    const segStartMs = Math.round(segments[si].start * 1000);
    const segEndMs   = Math.round(segments[si].end * 1000);
    const segDurMs   = Math.max(segEndMs - segStartMs, 1);

    if (pEnd === pi) {
      // Single phrase in this segment
      out.push({ text: sanitizeTranscriptionText(phrases[pi]), startMs: segStartMs, endMs: segEndMs });
    } else {
      // Multiple phrases in same segment — subdivide by char-proportion
      const group = phrases.slice(pi, pEnd + 1);
      const charLens = group.map(alignmentCharLen);
      const totalChars = charLens.reduce((a, b) => a + b, 0) || 1;
      let cumChars = 0;
      for (let g = 0; g < group.length; g++) {
        const t0 = segStartMs + Math.round((cumChars / totalChars) * segDurMs);
        cumChars += charLens[g];
        const t1 = segStartMs + Math.round((cumChars / totalChars) * segDurMs);
        out.push({ text: sanitizeTranscriptionText(group[g]), startMs: t0, endMs: t1 });
      }
    }
    pi = pEnd + 1;
  }

  // Bridge gaps between consecutive captions
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].endMs < out[i + 1].startMs) out[i].endMs = out[i + 1].startMs;
    if (out[i].endMs > out[i + 1].startMs) out[i].endMs = out[i + 1].startMs;
  }

  // Last phrase ends at audio end
  if (out.length > 0) out[out.length - 1].endMs = Math.round(totalAudioSec * 1000);

  // Enforce strictly monotonic timestamps
  for (let i = 1; i < out.length; i++) {
    if (out[i].startMs <= out[i - 1].startMs) out[i].startMs = out[i - 1].startMs + 50;
    if (out[i].endMs <= out[i].startMs) out[i].endMs = out[i].startMs + 200;
  }

  return out;
}

/**
 * Align phrases to segment timeline purely by char-proportion.
 * Does NOT do text matching — works correctly when Whisper text ≠ script text.
 * Distributes phrases evenly across the audio timeline using segment boundaries as anchors.
 */
function alignPhrasesCharProportion(
  phrases: string[],
  segments: { start: number; end: number }[],
  audioDur: number,
): { text: string; startMs: number; endMs: number }[] {
  if (!phrases.length) return [];

  const charLengths = phrases.map(alignmentCharLen);
  const totalChars = charLengths.reduce((a, b) => a + b, 0);
  if (totalChars === 0) return [];

  // If no segments, fall back to full audioDur range
  if (!segments.length) {
    const timelineLen = Math.max(audioDur, 1);
    let cumChars = 0;
    return phrases.map((p, i) => {
      const t0 = (cumChars / totalChars) * timelineLen;
      cumChars += charLengths[i];
      const t1 = (cumChars / totalChars) * timelineLen;
      return { text: sanitizePhraseText(p), startMs: Math.round(t0 * 1000), endMs: Math.round(t1 * 1000) };
    });
  }

  // Build timeline from segment boundaries — use segments as anchor points.
  // Phrases are distributed proportionally by char count across the segment timeline.
  // This keeps subtitles in sync with actual speech, not stretched to full audioDur.
  // Segment[0].start may be > 0 (silence at start) — clamp to 0 so first subtitle shows immediately.
  const segStart = 0; // always start at 0
  const segEnd = segments[segments.length - 1].end;

  // Assign each phrase a proportional position within [segStart, segEnd]
  const timelineLen = Math.max(segEnd - segStart, 1);
  let cumChars = 0;
  const out: { text: string; startMs: number; endMs: number }[] = [];
  for (let i = 0; i < phrases.length; i++) {
    const t0 = segStart + (cumChars / totalChars) * timelineLen;
    cumChars += charLengths[i];
    const t1 = segStart + (cumChars / totalChars) * timelineLen;
    out.push({
      text: sanitizePhraseText(phrases[i]),
      startMs: Math.round(t0 * 1000),
      endMs: Math.round(t1 * 1000),
    });
  }

  // Extend last caption to audioDur so screen doesn't go blank early
  if (out.length > 0) {
    out[out.length - 1].endMs = Math.round(audioDur * 1000);
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

  const maxLen = Math.max(minChunk, Math.floor(targetLen));
  const isThai = /[฀-๿]/.test(text);

  // For Thai: use Intl.Segmenter to get proper word tokens (never cuts mid-word)
  if (isThai) {
    let words: string[] = [];
    try {
      const seg = new Intl.Segmenter("th", { granularity: "word" });
      words = [...seg.segment(text)].filter(s => s.isWordLike).map(s => s.segment);
    } catch {
      words = text.split(/\s+/).filter(Boolean);
    }
    if (words.length === 0) return [text];

    const out: string[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    for (const w of words) {
      const thaiMatches = w.match(/[฀-๿]/g);
      const wLen = thaiMatches ? thaiMatches.length : w.replace(/\s/g, "").length;
      if (buf.length > 0 && bufLen + wLen > maxLen) {
        out.push(buf.join(""));
        buf = [w];
        bufLen = wLen;
      } else {
        buf.push(w);
        bufLen += wLen;
      }
    }
    if (buf.length > 0) out.push(buf.join(""));
    return out.filter(Boolean);
  }

  // Non-Thai: split on whitespace tokens
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
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
// Returns null if Python/whisper not available.
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

function sanitizeCaptionsTimeline(raw: SubtitleItem[], audioDurationMs: number, fps = 30, skipCursorPush = false): SubtitleItem[] {
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

  const mapped = raw
    .map((c) => ({
      ...c,
      text: typeof c?.text === "string" ? c.text.trim() : "",
      startMs: Number.isFinite(Number(c?.startMs)) ? Number(c.startMs) : NaN,
      endMs: Number.isFinite(Number(c?.endMs)) ? Number(c.endMs) : NaN,
    }))
    .filter((c) => c.text.length > 0 && Number.isFinite(c.startMs) && Number.isFinite(c.endMs));

  // segment-direct: preserve Gemini order, fix out-of-order timestamps by pushing forward
  // sorting would reorder text content and cause subtitles to appear out of sync
  const normalized: SubtitleItem[] = skipCursorPush
    ? (() => {
        let cursor = 0;
        return mapped.map((c) => {
          const startMs = Math.max(cursor, c.startMs);
          const endMs = Math.max(startMs + 1, c.endMs);
          cursor = endMs;  // next caption must start at or after this one ends
          return { ...c, startMs, endMs };
        });
      })()
    : [...mapped].sort((a, b) => a.startMs - b.startMs);

  if (!normalized.length) return [];

  const out: SubtitleItem[] = [];
  let cursor = 0;

  for (const cap of normalized) {
    let start = Math.min(Math.max(0, cap.startMs), totalMs);
    let end = cap.endMs;
    if (!Number.isFinite(end)) end = start + minCaptionMs;

    if (!skipCursorPush && start < cursor) {
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
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { audioUrl, scriptPrompt, script } = await req.json();
    if (!audioUrl) {
      return NextResponse.json({ error: "audioUrl is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, ttsProvider: true },
    });

    const useGeminiTranscribe = !!user?.geminiKey;
    console.log(`[transcribe] hasGemini=${!!user?.geminiKey} → ${useGeminiTranscribe ? "Gemini" : "LocalWhisper"}`);

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

    // Extract audio as mp3 (mono 16kHz) for local whisper/Gemini processing
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
          `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(geminiKey)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "audio/mp3",
              "x-goog-api-key": geminiKey,
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

        const timestampPrompt = `You are a forced-alignment transcriber for Thai TikTok/Reels videos.
Your ONLY job is to listen to the audio and report when each word is actually heard.
You are NOT a subtitle editor — do NOT pad, smooth, or "make it look nice."

Return ONLY valid JSON, no markdown, no explanation:
{"segments":[{"text":"...","start":0.0,"end":2.5,"words":[{"word":"คำ","start":0.0,"end":0.5},...]},...], "fullText":"..."}

━━━ HONEST TIMING — THIS IS THE WHOLE JOB ━━━
1. word.start = the exact second the speaker BEGINS to articulate that word (vowel onset / consonant attack you can hear)
2. word.end   = the exact second the speaker FINISHES that word (release / mouth closes)
3. If there is silence BEFORE the first word, the first word's start is NOT 0.0 — it is whenever the speaker actually begins. Silence stays as silence.
4. If there is silence BETWEEN two words (breath, pause, dramatic beat), the gap MUST appear in the timestamps:
   prev.end < next.start with a real gap between them. DO NOT close gaps. DO NOT make words touch.
5. If there is silence AFTER the last word, that silence is NOT subtitled.
6. NEVER round end UP. NEVER add padding to make subtitles "linger". A word that ends at 1.83s ends at 1.83s, not 1.95s.
7. NEVER overlap: word[i].end ≤ word[i+1].start, segment[i].end ≤ segment[i+1].start.
8. Use 0.05s precision. When unsure, listen again — do not guess.

━━━ WORDS (the atomic unit) ━━━
9. Thai word = meaningful syllabic unit as a native speaker hears it: คำ, กำลัง, เปลี่ยน, เงียบๆ.
   NOT individual letters. NOT whole phrases. NOT one segment-per-word.
10. English brand names = one word: "GPT-4", "Anthropic", "Claude", "OpenAI", "Enterprise".
11. Every spoken word MUST appear in the words array of exactly one segment.
12. words array MUST be in spoken order with monotonic start times.

━━━ SEGMENT GROUPING (for the subtitle cards) ━━━
13. Start a new segment when the speaker takes a breath / pauses ≥ 0.20s, OR completes a sentence (ครับ, ค่ะ, .).
14. segment.start = first word's start in that segment.
15. segment.end   = last word's end in that segment.  ← copy from the word, do not extend.
16. NEVER cut mid-word.
17. Short standalone punchlines get their own segment (e.g. "...อีกต่อไป" after a dramatic pause).

━━━ TEXT FIDELITY ━━━
18. fullText = all segment texts joined in order with single spaces.
19. Keep English brand names spelled exactly as heard.${script ? `
20. SCRIPT REFERENCE (this is what was actually said — match wording exactly, but get timestamps from the AUDIO):
${script.trim().slice(0, 2000)}` : ""}

━━━ REMINDER ━━━
The downstream system trusts your timestamps as truth. If you guess, subtitles will appear before the speaker talks or linger after they stop. Listen, mark, move on. No editorial padding.`;

        // Transcribe with model fallback chain. Google's gemini-2.5-flash frequently returns
        // 503 "high demand" — fall through to older but stabler models instead of failing the
        // whole pipeline. Each model retries transient 5xx/429 internally with backoff before
        // moving to the next.
        const transcribeBody = JSON.stringify({
          contents: [{
            parts: [
              { text: timestampPrompt },
              { fileData: { mimeType: "audio/mp3", fileUri } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 65536,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });

        const TRANSCRIBE_MODELS = [
          "gemini-3.5-flash",   // production native-audio model (most stable per Google docs)
          "gemini-2.5-flash",   // fallback when 3.5 not available for the user's key/region
          "gemini-1.5-pro",     // classic, almost always available
        ];

        let geminiRes: Response | null = null;
        let lastTranscribeErr = "";
        let usedTranscribeModel = "";
        const MAX_PER_MODEL = 3;  // 3 retries per model × 3 models = 9 total attempts

        outerTranscribe:
        for (const model of TRANSCRIBE_MODELS) {
          for (let attempt = 1; attempt <= MAX_PER_MODEL; attempt++) {
            geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": geminiKey,
                },
                signal: AbortSignal.timeout(600_000),
                body: transcribeBody,
              }
            );
            if (geminiRes.ok) {
              usedTranscribeModel = model;
              console.log(`[transcribe] ok with ${model} (attempt ${attempt})`);
              break outerTranscribe;
            }
            lastTranscribeErr = await geminiRes.text().catch(() => "");

            // Auth / bad request — don't retry, but DO try next model (404 means model doesn't exist for this key)
            if (geminiRes.status === 401 || geminiRes.status === 403 || geminiRes.status === 404 || geminiRes.status === 400) {
              console.warn(`[transcribe] ${model} returned ${geminiRes.status} — trying next model`);
              break;
            }

            // Retryable transient — exponential backoff within same model
            if (attempt < MAX_PER_MODEL) {
              const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000); // 2s, 4s
              console.warn(`[transcribe] ${model} ${geminiRes.status} on attempt ${attempt}/${MAX_PER_MODEL}, retrying in ${delayMs}ms`);
              await new Promise(r => setTimeout(r, delayMs));
            } else {
              console.warn(`[transcribe] ${model} exhausted retries — trying next model`);
            }
          }
        }

        // Clean up uploaded file from Gemini (best-effort)
        if (fileName) {
          fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(geminiKey)}`, {
            method: "DELETE",
            headers: { "x-goog-api-key": geminiKey },
          }).catch(() => {});
        }

        if (!geminiRes || !geminiRes.ok) {
          const status = geminiRes?.status ?? 503;
          console.error("[transcribe] all models failed; last error body:", lastTranscribeErr.slice(0, 500));
          if (status === 401 || status === 403) {
            throw { status, body: lastTranscribeErr };
          }
          throw new Error(`Gemini transcribe failed across all ${TRANSCRIBE_MODELS.length} models: ${status} — ${lastTranscribeErr.slice(0, 200)}`);
        }
        void usedTranscribeModel; // for future telemetry
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
                type GeminiWord = { word?: string; start?: number; end?: number };
                type GeminiSeg = { text?: string; start?: number; end?: number; words?: GeminiWord[] };
                const rawSegs = parsed.segments as GeminiSeg[];
                segments = rawSegs
                  .filter((s) =>
                    typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number"
                  )
                  .map((s) => ({
                    text: (s.text as string).trim(),
                    start: s.start as number,
                    end: s.end as number,
                  }));
                // Extract word-level timestamps from Gemini if provided
                const geminiWords: typeof words = [];
                for (const s of rawSegs) {
                  if (!Array.isArray(s.words)) continue;
                  for (const w of s.words) {
                    if (typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number") {
                      geminiWords.push({ word: w.word, start: w.start, end: w.end });
                    }
                  }
                }
                if (geminiWords.length > 0) {
                  words = geminiWords;
                  console.log(`[transcribe] Gemini OK — ${fullText.length} chars, ${segments.length} segments, ${words.length} words`);
                } else {
                  console.log(`[transcribe] Gemini OK — ${fullText.length} chars, ${segments.length} segments (no word timestamps)`);
                }
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

    // LLM key for subtitle splitting
    const useGemini = true;
    const apiKey = user?.geminiKey ? Buffer.from(user.geminiKey, "base64").toString("utf-8") : null;
    console.log(`[transcribe] LLM split provider: Gemini apiKey=${apiKey ? "ok" : "MISSING"}`);

    // Detect if Thai — local Whisper large-v3-turbo has word-level for Thai too,
    // but quality varies. Use segment-level grouping for Thai; word-level for Latin scripts.
    const isThai = /[\u0E00-\u0E7F]/.test(fullText) || (typeof script === "string" && /[\u0E00-\u0E7F]/.test(script));

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

      // ── Gemini: send segments to LLM to merge/split into proper subtitle cards ──
      // Gemini transcribe gives us segments with accurate timestamps.
      // LLM decides which segments to merge (orphans, tail words) or split (too long).
      // LLM outputs captions with startMs/endMs taken from segment boundaries.
      if (useGeminiTranscribe && segments.length >= 1 && apiKey) {
        const totalAudioMs = Math.max(1, Math.round(audioDur * 1000));

        // Pre-merge segments whose text starts with an orphan Thai syllable fragment.
        // Gemini transcribe sometimes cuts mid-word (e.g. "แม่" / "งอาจจะ...") at breath
        // boundaries. Detect: segment starts with a Thai consonant immediately followed by
        // another consonant with no leading vowel (เ-ไ ‌ แ โ) — that means it's a syllable
        // fragment that should have been attached to the previous segment.
        // Also merge segments that are very short (≤ 3 Thai chars) into the previous.
        const THAI_LEADING_VOWELS = /^[เ-ไแโใไ]/; // เ แ โ ใ ไ
        const THAI_CONSONANT = /^[ก-ฮะ-ฺ]/;
        const isOrphanFragment = (text: string): boolean => {
          const t = text.trim();
          if (!t) return false;
          const thaiLen = (t.match(/[฀-๿]/g) ?? []).length;
          // Very short Thai-only segment (≤ 3 Thai chars, no punctuation) = likely fragment
          if (thaiLen > 0 && thaiLen <= 3 && !/[.!?ฯ]/.test(t)) return true;
          // Starts with Thai consonant but NOT a leading vowel → could be mid-word continuation
          // Heuristic: if previous segment ends with a consonant (no trailing vowel/space) it's a split
          return false;
        };
        const premergedSegments: typeof segments = [];
        for (const seg of segments) {
          const text = seg.text.trim();
          if (premergedSegments.length > 0 && isOrphanFragment(text)) {
            const prev = premergedSegments[premergedSegments.length - 1];
            // Check if previous segment ends mid-word: last Thai char is a consonant with no closing vowel
            const prevText = prev.text.trimEnd();
            const lastChar = prevText[prevText.length - 1];
            const lastIsThai = lastChar && /[฀-๿]/.test(lastChar);
            // Leading vowels in Thai come BEFORE the consonant in visual order but AFTER in Unicode
            // A segment ending in เ/แ/โ/ใ/ไ means it's definitely mid-word
            const endsWithLeadingVowel = lastChar && THAI_LEADING_VOWELS.test(lastChar);
            // Segment starting with ง/น/ม/ว/ย that could be a consonant cluster or suffix
            const startsLikeFragment = THAI_CONSONANT.test(text) && !THAI_LEADING_VOWELS.test(text);
            if (lastIsThai && (endsWithLeadingVowel || (isOrphanFragment(text) && startsLikeFragment))) {
              prev.text = prevText + text;
              prev.end = seg.end;
              continue;
            }
          }
          premergedSegments.push({ ...seg });
        }
        const mergedSegments = premergedSegments;
        console.log(`[transcribe] pre-merge: ${segments.length} → ${mergedSegments.length} segments`);

        // Format segments as numbered list for LLM
        const segList = mergedSegments.map((s, i) =>
          `${i + 1}. [${s.start.toFixed(2)}s–${s.end.toFixed(2)}s] "${s.text.trim()}"`
        ).join("\n");

        // Word-level timestamps — ATOMIC UNITS the LLM must group.
        // Send BOTH start and end so the LLM has a real endMs for the last word
        // of each card. Earlier we only sent start (W1 [0.42s] "วงการ"), which
        // forced the LLM to guess endMs → captions disappeared too early or
        // lingered too long depending on the guess.
        const wordList = words.length > 0
          ? words.map((w, i) =>
              `W${i + 1}[${w.start.toFixed(2)}-${w.end.toFixed(2)}s] "${w.word}"`
            ).join(" ")
          : "(no word-level timestamps available — group SEGMENTS instead)";

        const scriptForPrompt = sourceText.trim().slice(0, 3000);
        const geminiMergePrompt = `You are a Thai subtitle GROUPER for TikTok / Reels / Shorts.

YOUR ROLE: You are NOT a text splitter. You are a CONCATENATOR.
You receive pre-tokenized WORDS (atomic units from STT) and you GROUP consecutive
words into subtitle CARDS that read as natural Thai sentences or phrases.

═══════════════════════════════════════════════════════════
CORE RULE — INDIVISIBLE WORD BLOCKS
═══════════════════════════════════════════════════════════
Each WORD in the WORDS list below is ATOMIC. You MUST:
  ✓ Pick contiguous spans of words (W3..W7, then W8..W12, etc.)
  ✓ Concatenate their text verbatim (no edits, no reorder)
  ✓ Use the FIRST word's start time as startMs, the LAST word's end time as endMs
  ✗ NEVER take a slice INSIDE a word (no "ไม" from "ไม่ทัน")
  ✗ NEVER skip a word, NEVER duplicate, NEVER reorder
  ✗ NEVER edit any word's text

If you follow this one rule, you can never produce mid-word cuts.

═══════════════════════════════════════════════════════════
HOW TO CHOOSE GROUP BOUNDARIES (the real skill)
═══════════════════════════════════════════════════════════
Walk the WORDS list left-to-right. End the current group AT word W[i] when:

  PRIORITY 1 — Natural sentence end after W[i]:
    • Last word is a sentence-ender: ครับ, ค่ะ, นะคะ, แล้ว, เลย, จริงๆ
    • Next word starts a new sentence: คือ, แล้ว, แต่, ดังนั้น, ส่วน, อย่างไรก็ตาม
    • Sentence-ending punctuation in the script (. ? ! ฯ) appears between W[i] and W[i+1]

  PRIORITY 2 — Clear conjunction break BEFORE next word:
    • Next word is: และ, หรือ, แต่, จึง, เพราะ, ถ้า, เพื่อ, ส่วน
    • End BEFORE the conjunction so it leads the next card

  PRIORITY 3 — Long silence between W[i] and W[i+1]:
    • Time gap ≥ 0.35s = natural breath, safe to split there

  PRIORITY 4 — Group has grown big enough:
    • Group reads as a complete clause AND would exceed ~50 Thai chars if extended

NEVER end a group when:
  ✗ Next word is a final-particle of current phrase (นะ, ค่ะ, ครับ, เลย, แล้ว)
  ✗ Next word is a noun completing a preposition (current word is ใน, บน, กับ, ของ, ที่)
  ✗ Next word is a classifier (current word is a noun + number)
  ✗ Current word ends with a connector (เพราะ, ดังนั้น, แล้ว...ก็)

═══════════════════════════════════════════════════════════
LENGTH GUIDANCE (soft — never break the CORE RULE for length)
═══════════════════════════════════════════════════════════
• Sweet spot per card: 2–6 word blocks (≈ 1 spoken phrase)
• OK to go up to 8 blocks if the phrase needs it to feel complete
• OK to be just 1 block if it's a strong standalone (ครับ! / แต่... / OpenAI)
• Don't count characters. Count phrases.

═══════════════════════════════════════════════════════════
WORKED EXAMPLES (study these carefully)
═══════════════════════════════════════════════════════════

EXAMPLE 1 — Good sentence grouping
  WORDS: W1[0.0]"วงการ" W2[0.4]"AI" W3[0.7]"กำลัง" W4[1.0]"เปลี่ยน" W5[1.4]"มือ"
         W6[1.9]"เงียบๆ" W7[2.4]"ครับ" W8[3.0]"และ" W9[3.3]"OpenAI" W10[3.9]"อาจ"
         W11[4.2]"ไม่ใช่" W12[4.6]"เบอร์1" W13[5.0]"ของโลก" W14[5.4]"อีกต่อไป"

  GOOD output:
    Card 1 (W1–W7): "วงการ AI กำลังเปลี่ยนมือเงียบๆ ครับ"
      → ends at ครับ (sentence-ender), W8 "และ" starts new sentence
    Card 2 (W8–W14): "และ OpenAI อาจไม่ใช่เบอร์1 ของโลกอีกต่อไป"
      → conjunction "และ" leads; ends at อีกต่อไป (natural close)

  BAD output (don't do this):
    "วงการ AI กำลัง" + "เปลี่ยนมือเงียบๆ" + "ครับและ OpenAI"
      → splits inside a sentence; "ครับ" stranded with "และ" (different sentences)

EXAMPLE 2 — Conjunction leads new card
  WORDS: W1"เพราะว่า" W2"เรา" W3"ตั้งใจ" W4"ทำ" W5"โปรเจกต์นี้" W6"มากๆ"
         W7"ดังนั้น" W8"ผลลัพธ์" W9"เลย" W10"ออกมา" W11"ดี"

  GOOD: "เพราะว่าเราตั้งใจทำโปรเจกต์นี้มากๆ" (W1–W6) + "ดังนั้นผลลัพธ์เลยออกมาดี" (W7–W11)
  BAD : "เพราะว่าเราตั้งใจทำโปรเจกต์นี้" + "มากๆ ดังนั้นผลลัพธ์เลยออกมาดี"
        (cuts off มากๆ from its verb, and dangles into next sentence)

EXAMPLE 3 — Don't strand particles or prepositional objects
  WORDS: W1"ให้" W2"รางวัล" W3"กับ" W4"ตัวเอง"
  GOOD: "ให้รางวัลกับตัวเอง" (W1–W4, one phrase)
  BAD : "ให้รางวัล" + "กับตัวเอง" (กับ requires its object to be in the same card)

EXAMPLE 4 — Full paragraph showing how cards stack naturally (this is the gold standard)

  SCRIPT: "วงการ AI กำลังเปลี่ยนมือเงียบๆ ครับ และ OpenAI อาจไม่ใช่เบอร์ 1
           ของโลกอีกต่อไป หลายคนอาจไม่ทันสังเกต แต่ในวงการนักพัฒนา enterprise
           ระดับโลก กำลังย้ายจาก GPT ไปใช้ Claude ของบริษัทชื่อ Anthropic"

  GOOD output (5 cards):
    Card 1: "วงการ AI กำลังเปลี่ยนมือเงียบๆ ครับ"
            ↳ ends at ครับ (sentence-ender). Next word "และ" starts new sentence.
    Card 2: "และ OpenAI อาจไม่ใช่เบอร์ 1 ของโลกอีกต่อไป"
            ↳ conjunction และ leads. Ends at "อีกต่อไป" (sentence closer).
    Card 3: "หลายคนอาจไม่ทันสังเกต"
            ↳ complete thought (subject+verb+object). Next word "แต่" starts contrast.
    Card 4: "แต่ในวงการนักพัฒนา enterprise ระดับโลก"
            ↳ conjunction แต่ leads. Ends at "ระดับโลก" — the subject is set up,
              verb comes in next card to keep length readable.
    Card 5: "กำลังย้ายจาก GPT ไปใช้ Claude ของบริษัทชื่อ Anthropic"
            ↳ verb phrase that completes Card 4's subject. Ends the paragraph.

  BAD outputs to avoid:
    ✗ "วงการ AI กำลัง" + "เปลี่ยนมือเงียบๆ ครับและ OpenAI"
      (mid-sentence cut; ครับ+และ glued across sentences)
    ✗ "อาจไม่ใช่เบอร์ 1 ของ" + "โลกอีกต่อไป"
      (cuts off prepositional object "โลก" from "ของ")
    ✗ "หลายคนอาจไม" + "่ทันสังเกต"
      (mid-syllable cut — tone mark ่ stranded; word is "ไม่ทัน")
    ✗ "แต่ในวงการนักพัฒนา enterprise ระดับโลก กำลังย้ายจาก GPT ไปใช้ Claude ของบริษัทชื่อ Anthropic"
      (one mega-card; viewer can't read this in one breath — split at the verb)

═══════════════════════════════════════════════════════════
TIMESTAMPS — copy from WORDS, no math
═══════════════════════════════════════════════════════════
For card grouping W_a..W_b:
  • startMs = W_a.start × 1000
  • endMs   = W_b.end   × 1000  (use SEGMENT end if word.end unavailable)
  • No rounding tricks, no overlap, monotonic increasing

═══════════════════════════════════════════════════════════
SCRIPT FIDELITY (script is source of truth)
═══════════════════════════════════════════════════════════
• Output text MUST equal the concatenated WORDS verbatim
• If WORDS differ from SCRIPT (STT mishear), trust SCRIPT spelling but keep WORD timing
• Parenthetical hints like "(อ่านว่า ...)" in SCRIPT are NOT spoken — skip them

═══════════════════════════════════════════════════════════
TAGS
═══════════════════════════════════════════════════════════
• "hook" = ONLY card index 0
• "cta"  = cards containing: กดติดตาม, ไลค์, แชร์, subscribe, กดระฆัง (max 2)
• "body" = everything else

═══════════════════════════════════════════════════════════
OUTPUT (JSON only — no markdown, no explanation)
═══════════════════════════════════════════════════════════
{"captions":[{"text":"...","startMs":0,"endMs":1200,"tag":"hook"},...]}

━━━ SCRIPT (verbatim source of truth) ━━━
${scriptForPrompt}

━━━ WORDS (atomic units — concatenate, never split inside) ━━━
${wordList}

━━━ SEGMENTS (reference for sentence boundaries — gaps and breath cues) ━━━
${segList}

Total audio: ${audioDur.toFixed(2)}s`;

        let llmCaptions: { text: string; startMs: number; endMs: number; tag?: string }[] = [];
        try {
          const raw = await geminiGenerateText(apiKey, geminiMergePrompt, 16384);
          console.log(`[transcribe] Gemini merge raw (${raw.length} chars): ${raw.slice(0, 300)}`);
          const stripped = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

          // Try full parse first
          let parsed: { captions?: { text?: string; startMs?: number; endMs?: number; tag?: string }[] } | null = null;
          const fullMatch = stripped.match(/\{[\s\S]*\}/);
          if (fullMatch) {
            try { parsed = JSON.parse(fullMatch[0]); } catch { /* fall through to repair */ }
          }

          // Repair: extract every complete caption object regardless of field order
          if (!parsed || !Array.isArray(parsed.captions) || parsed.captions.length === 0) {
            const items: { text: string; startMs: number; endMs: number; tag?: string }[] = [];
            // Match any JSON object with at least text+startMs+endMs fields (order-independent)
            const objRegex = /\{[^{}]*"text"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*"startMs"\s*:\s*(\d+)[^{}]*"endMs"\s*:\s*(\d+)[^{}]*\}/g;
            const objRegex2 = /\{[^{}]*"startMs"\s*:\s*(\d+)[^{}]*"endMs"\s*:\s*(\d+)[^{}]*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            let m2: RegExpExecArray | null;
            const seen = new Set<string>();
            while ((m2 = objRegex.exec(stripped)) !== null) {
              const key = `${m2[2]}-${m2[3]}`;
              if (!seen.has(key)) { seen.add(key); items.push({ text: m2[1], startMs: Number(m2[2]), endMs: Number(m2[3]) }); }
            }
            while ((m2 = objRegex2.exec(stripped)) !== null) {
              const key = `${m2[1]}-${m2[2]}`;
              if (!seen.has(key)) { seen.add(key); items.push({ text: m2[3], startMs: Number(m2[1]), endMs: Number(m2[2]) }); }
            }
            items.sort((a, b) => a.startMs - b.startMs);
            if (items.length > 0) { parsed = { captions: items }; console.log(`[transcribe] Gemini merge repaired: ${items.length} captions`); }
          }

          if (parsed && Array.isArray(parsed.captions)) {
            llmCaptions = parsed.captions
              .filter(c => typeof c.text === "string" && typeof c.startMs === "number" && typeof c.endMs === "number")
              .map(c => ({ text: sanitizePhraseText(c.text!), startMs: c.startMs!, endMs: c.endMs!, tag: (c.tag as string | undefined) }))
              .filter(c => c.text.length > 0) as { text: string; startMs: number; endMs: number; tag?: string }[];

            // Hard clamp: hook = first 1 only, cta = last 2 only
            let hookCount = 0;
            let ctaCount = 0;
            for (let i = llmCaptions.length - 1; i >= 0; i--) {
              if (llmCaptions[i].tag === "cta") ctaCount++;
              if (ctaCount > 2) llmCaptions[i].tag = "body";
            }
            for (let i = 0; i < llmCaptions.length; i++) {
              if (llmCaptions[i].tag === "hook") {
                hookCount++;
                if (hookCount > 1) llmCaptions[i].tag = "body";
              }
            }
          }
        } catch (e) {
          console.warn("[transcribe] Gemini merge LLM failed:", e);
        }

        // Fallback: use pre-merged segments directly if LLM failed
        if (llmCaptions.length === 0) {
          console.warn("[transcribe] Gemini merge fallback: using raw segments");
          llmCaptions = mergedSegments
            .map(s => ({ text: sanitizePhraseText(s.text), startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000) }))
            .filter(c => c.text.length > 0);
        }

        // ── Snap LLM-reported timestamps to real STT timestamps.
        //
        // Why: Gemini sometimes invents/rounds start/end even when we hand it real
        // timestamps in the prompt. Captions then appear before/after the speaker
        // → user report: "เริ่ม/จบไม่พร้อมเสียง", "ซับไม่ตรงเสียง".
        //
        // What we snap TO depends on language:
        //   • Thai → segment timestamps. Gemini's Thai WORD timestamps are unreliable
        //     because Thai has no whitespace and Gemini's tokenization drifts; this
        //     was documented in commit 2385146 ("skip Strategy C for Thai — word
        //     timestamps unreliable without spaces"). SEGMENT timestamps from Gemini
        //     transcribe come from actual silence/breath detection in the audio and
        //     are far more reliable.
        //   • Non-Thai → word timestamps (whitespace tokenization is unambiguous).
        //
        // The match strategy is the same: walk the snap-source (words or segments)
        // left-to-right, find the contiguous span whose concatenated text equals the
        // caption text (whitespace & punctuation ignored), use first.start / last.end.
        type SnapUnit = { text: string; start: number; end: number };
        const snapUnits: SnapUnit[] = isThai
          ? mergedSegments.map((s) => ({ text: s.text, start: s.start, end: s.end }))
          : words.map((w) => ({ text: w.word, start: w.start, end: w.end }));
        const snapSourceLabel = isThai ? "segments" : "words";
        console.log(`[transcribe] snap source: ${snapSourceLabel} (${snapUnits.length} units, isThai=${isThai})`);
        if (snapUnits.length > 0 && llmCaptions.length > 0) {
          const stripForMatch = (s: string) =>
            s.replace(/\s+/g, "").replace(/[.,!?…฿"'`()\[\]{}—–\-]/g, "").toLowerCase();
          const unitChars = snapUnits.map(u => stripForMatch(u.text));
          const unitText = unitChars.join("");
          const cumChars: number[] = [];
          for (let i = 0, sum = 0; i < unitChars.length; i++) {
            sum += unitChars[i].length;
            cumChars.push(sum);
          }
          const charIndexToUnitIndex = (charIndex: number): number => {
            for (let wi = 0; wi < cumChars.length; wi++) {
              if (charIndex < cumChars[wi]) return wi;
            }
            return unitChars.length - 1;
          };

          // snapped[idx] = true if caption idx got real STT timestamps.
          // For unmatched ones we interpolate later from neighbours.
          const snapped: boolean[] = llmCaptions.map(() => false);
          let cursor = 0;
          let snappedCount = 0;

          for (let idx = 0; idx < llmCaptions.length; idx++) {
            const cap = llmCaptions[idx];
            const target = stripForMatch(cap.text);
            if (!target) continue;

            const cursorChar = cursor > 0 ? cumChars[cursor - 1] : 0;

            let foundStart = -1;
            let foundEnd = -1;
            let bestScore = -Infinity;
            let bestRange: { start: number; end: number } | null = null;

            const exactIndex = unitText.indexOf(target, cursorChar);
            if (exactIndex >= 0) {
              const startWi = charIndexToUnitIndex(exactIndex);
              const endWi = charIndexToUnitIndex(exactIndex + target.length - 1);
              if (startWi >= cursor) {
                foundStart = startWi;
                foundEnd = endWi;
              }
            }

            if (foundStart < 0) {
              for (let i = cursor; i < unitChars.length; i++) {
                let acc = "";
                for (let j = i; j < unitChars.length; j++) {
                  acc += unitChars[j];
                  if (acc.length > target.length + 4) break;

                  if (acc === target) {
                    foundStart = i;
                    foundEnd = j;
                    break;
                  }

                  const commonPrefix = (() => {
                    const minLen = Math.min(acc.length, target.length);
                    let len = 0;
                    while (len < minLen && acc[len] === target[len]) len++;
                    return len;
                  })();
                  const score = commonPrefix - Math.abs(acc.length - target.length) * 0.3;
                  if (score > bestScore) {
                    bestScore = score;
                    bestRange = { start: i, end: j };
                  }
                }
                if (foundStart >= 0) break;
              }
              if (foundStart < 0 && bestRange && bestScore >= Math.max(3, target.length * 0.5)) {
                foundStart = bestRange.start;
                foundEnd = bestRange.end;
              }
            }

            if (foundStart >= cursor && foundEnd >= foundStart) {
              cap.startMs = Math.round(snapUnits[foundStart].start * 1000);
              cap.endMs = Math.round(snapUnits[foundEnd].end * 1000);
              cursor = foundEnd + 1;
              snapped[idx] = true;
              snappedCount++;
            }
          }

          // ── Fill unmatched captions by interpolating between snapped neighbours.
          //    Position matters: caption k must sit between caption k-1's end and
          //    caption k+1's start. Earlier impl shoved all unmatched through
          //    alignPhrasesToSegmentTimestamps but lost index info, so timings
          //    drifted to whichever segment matched first.
          if (snappedCount < llmCaptions.length) {
            for (let idx = 0; idx < llmCaptions.length; idx++) {
              if (snapped[idx]) continue;
              // Nearest snapped predecessor / successor
              let prevSnap = -1;
              for (let p = idx - 1; p >= 0; p--) if (snapped[p]) { prevSnap = p; break; }
              let nextSnap = -1;
              for (let n = idx + 1; n < llmCaptions.length; n++) if (snapped[n]) { nextSnap = n; break; }

              const prevEnd = prevSnap >= 0 ? llmCaptions[prevSnap].endMs : 0;
              const nextStart = nextSnap >= 0 ? llmCaptions[nextSnap].startMs : totalAudioMs;

              const gap = Math.max(0, nextStart - prevEnd);
              // Count unmatched run inside [prevSnap+1 .. nextSnap-1] so we can divide
              // the gap proportionally between them.
              const runStart = prevSnap + 1;
              const runEnd = nextSnap >= 0 ? nextSnap - 1 : llmCaptions.length - 1;
              const runLen = runEnd - runStart + 1;
              const slot = idx - runStart;
              const slice = runLen > 0 ? gap / runLen : 0;
              const s = Math.round(prevEnd + slot * slice);
              const e = Math.round(prevEnd + (slot + 1) * slice);
              llmCaptions[idx].startMs = s;
              llmCaptions[idx].endMs   = Math.max(e, s + 1);
            }
            console.warn(`[transcribe] word-snap: interpolated ${llmCaptions.length - snappedCount}/${llmCaptions.length} unmatched captions between snapped neighbours`);
          }
          console.log(`[transcribe] word-snap: ${snappedCount}/${llmCaptions.length} captions snapped to real word timestamps`);

          // ── Respect silence at the start of the audio.
          // If the first spoken unit starts at t=1.2s but Gemini gave caption[0].startMs=0,
          // the subtitle shows up before the speaker is actually heard. Push the first
          // caption to start when the first audible unit begins.
          if (llmCaptions.length > 0 && snapUnits.length > 0 && snapped[0] === false) {
            const firstStartMs = Math.round(snapUnits[0].start * 1000);
            if (llmCaptions[0].startMs < firstStartMs) {
              const oldDur = llmCaptions[0].endMs - llmCaptions[0].startMs;
              llmCaptions[0].startMs = firstStartMs;
              llmCaptions[0].endMs = Math.max(llmCaptions[0].endMs, firstStartMs + Math.max(oldDur, 200));
            }
          }
        }

        // Enforce strict monotonic, non-overlapping timeline.
        //
        // We preserve real spoken timing — do NOT stretch captions across silent
        // gaps. Earlier impl only checked `a.endMs > b.startMs` (back-overlap),
        // but in Direct URL mode the snap+interpolation pass occasionally
        // produces out-of-order timestamps (next caption starts BEFORE current
        // caption) which then renders as visually overlapping pills on the
        // timeline — user report: 'ซับซ้อนกันไปหมด'.
        //
        // Two passes now:
        //   1. If b.startMs < a.endMs (any overlap or out-of-order start), push
        //      b.startMs forward to a.endMs and keep b's duration if possible.
        //   2. If a.endMs > b.startMs (back-overlap), trim a.endMs to b.startMs.
        for (let i = 0; i < llmCaptions.length - 1; i++) {
          const a = llmCaptions[i] as { startMs: number; endMs: number };
          const b = llmCaptions[i + 1] as { startMs: number; endMs: number };
          if (b.startMs < a.endMs) {
            const bDur = Math.max(1, b.endMs - b.startMs);
            b.startMs = a.endMs;
            if (b.endMs <= b.startMs) b.endMs = b.startMs + bDur;
          }
          if (a.endMs > b.startMs) a.endMs = b.startMs;
        }
        if (llmCaptions.length > 0) {
          const last = llmCaptions[llmCaptions.length - 1] as { endMs: number };
          if (last.endMs > totalAudioMs) last.endMs = totalAudioMs;
        }

        // ── Tail recovery: Gemini sometimes drops the very last words of the script
        // (e.g. "...ของบริษัทชื่อ Anthropic" missing) because its segmentation stops short.
        // If the concatenation of all captions doesn't end at the script's tail, append the
        // missing tail to the last caption so the spoken ending is also subtitled.
        if (llmCaptions.length > 0 && sourceText.trim()) {
          const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
          const scriptNorm = normalize(sourceText);
          const concatNorm = normalize(llmCaptions.map(c => c.text).join(""));
          // If captions cover < 92% of script chars, find the tail and append it
          if (concatNorm.length < scriptNorm.length * 0.92) {
            // Find where the last caption ends inside the script and grab what's left
            const last = llmCaptions[llmCaptions.length - 1];
            const lastNorm = normalize(last.text);
            const idx = scriptNorm.lastIndexOf(lastNorm);
            if (idx >= 0 && idx + lastNorm.length < scriptNorm.length) {
              // Build a position map from script source chars to normalized chars
              // so we can recover the original (non-normalized) tail with proper spaces
              let consumed = 0;
              let tailStart = -1;
              for (let i = 0; i < sourceText.length; i++) {
                if (/\s/.test(sourceText[i])) continue;
                if (consumed === idx + lastNorm.length) { tailStart = i; break; }
                consumed++;
              }
              if (tailStart > 0) {
                const tail = sourceText.slice(tailStart).trim();
                if (tail.length > 0) {
                  last.text = `${last.text.trim()} ${tail}`.trim();
                  console.log(`[transcribe] tail-recovery: appended "${tail}" to last caption`);
                }
              }
            }
          }
        }

        const tagged = (llmCaptions as { text: string; startMs: number; endMs: number; tag?: string }[]).map((c, i) => ({
          text: c.text,
          startMs: c.startMs,
          endMs: c.endMs,
          timestampMs: c.startMs,
          confidence: 1 as number,
          tag: (c.tag === "hook" || c.tag === "cta" ? c.tag : i === 0 ? "hook" : "body") as "hook" | "body" | "cta",
        }));
        const sanitized = sanitizeCaptionsTimeline(tagged, totalAudioMs, 30, true);
        if (sanitized.length > 0) {
          captions = sanitized.map(c => ({ text: c.text, startMs: c.startMs, endMs: c.endMs, timestampMs: c.startMs, confidence: 1, tag: (c.tag ?? "body") as "hook" | "body" | "cta" }));
          console.log(`[transcribe] Gemini LLM-merged segments → ${captions.length} captions`);
          captions.forEach((c, i) => console.log(`  [${i}] ${(c.startMs/1000).toFixed(2)}s–${(c.endMs/1000).toFixed(2)}s "${c.text.slice(0,30)}"`));
        }
      }

      let phrases: string[] = [];
      let llmTags: ("hook" | "body" | "cta")[] = [];
      let minPhrases = 4;
      let maxPhrases = 6;
      const scriptSentencesInitial = splitToSentencePhrases(sourceRaw);
      const hasSentencePunctuation = /[.!?…]/.test(sourceText);
      const strictSentences = splitToPunctuationSentences(sourceText);
      const shouldSkipLLMSplit = strictSentences.length === 1 && !hasSentencePunctuation && sourceText.length <= 70;

      if (captions.length > 0) {
        // Gemini already done above — skip LLM split entirely
      } else if (shouldSkipLLMSplit) {
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

          // Build pause-point hint from Whisper/Gemini segment gaps (breath ≥ 0.2s)
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
              rhythmHint = `\n━━━ SPEECH PAUSE POINTS ━━━\nSplit subtitles at or near these natural pause points (detected from audio):\n${breathPoints.slice(0, 20).map((p, i) => `  ${i + 1}. ${p}`).join("\n")}\n`;
            }
          }

          // ══════════════════════════════════════════════════════════════════
          // GEMINI split prompt — proven version (commit a8c9075/6d9da59)
          // bullet style, no json_object constraint
          // ══════════════════════════════════════════════════════════════════
          const geminiSplitPrompt = `You are a Thai subtitle splitter for TikTok/Reels.

TASK: Split this Thai script into subtitle phrases — COPY words EXACTLY, do NOT rewrite or remove any words.

━━━ CRITICAL ━━━
• COPY words EXACTLY from the script. Do NOT paraphrase, summarize, or drop any words.
• Every word in the script must appear in the output — nothing removed.
• Only decide WHERE to split into subtitle lines.

━━━ SPLITTING RULES ━━━
• Audio duration: ${durationSec.toFixed(1)}s → target ${minPhrases}–${maxPhrases} phrases total
• Each phrase = ONE LINE on screen. HARD MAX 26 Thai characters per phrase (count Thai letters only, not spaces/numbers/English). MUST split if over 26 Thai chars.
• Split at sentence-ending punctuation (. ? ! ฯ) or major conjunctions (แต่, และ, เพราะ, จึง) or natural breath points.
• NEVER split mid-Thai-word. Only split at complete word boundaries.
• If phrase still exceeds 26 Thai chars, split at a natural phrase/thought boundary.
• Short punchy lines → keep as ONE phrase.
• NEVER split a date expression (Thai month name + date + year = ONE phrase).
• Max 6s per subtitle — long pauses → split into more phrases.
${rhythmHint}
━━━ TAGGING ━━━
• "hook" = first 1–2 phrases only
• "body" = main content
• "cta"  = กดติดตาม / like / share / subscribe

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON — no markdown, no explanation:
{"phrases":["phrase1","phrase2",...],"tags":["hook","body",...]}

━━━ SCRIPT TO PROCESS ━━━
${sourceText.trim()}`;

          const splitPrompt = geminiSplitPrompt;

          const splitMaxTokens = 4096;

          let gptRawText = "{}";
          try {
            const raw = await geminiGenerateText(apiKey, splitPrompt, splitMaxTokens);
            console.log(`[transcribe] Gemini split raw:`, raw.slice(0, 300));
            gptRawText = parseSplitPhrasesFromRaw(raw).length > 0 ? raw : "{}";
          } catch (e) {
            console.warn("[transcribe] Gemini split failed:", e);
          }

          if (gptRawText !== "{}") {
            try {
              let raw: string[] = [];
              let parsedTags: unknown[] = [];
              try {
                const parsed = JSON.parse(gptRawText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
                raw = Array.isArray(parsed.phrases) ? parsed.phrases : [];
                parsedTags = Array.isArray(parsed.tags) ? parsed.tags : [];
              } catch { /* JSON truncated — fall through to repair */ }
              if (raw.length === 0) {
                raw = parseSplitPhrasesFromRaw(gptRawText);
              }
              console.log(`[transcribe] LLM split parsed ${raw.length} phrases, first: "${raw[0]?.slice(0, 40) ?? ""}"`);
              if (Array.isArray(parsedTags) && parsedTags.length === raw.length) {
                llmTags = parsedTags as ("hook" | "body" | "cta")[];
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
                // Hard-split any phrase the LLM returned over 25 Thai chars — single line guarantee
                const MAX_THAI_CHARS_LLM = 25;
                phrases = phrases.flatMap((p) => {
                  const thaiLen = (p.match(/[฀-๿]/g) ?? []).length;
                  if (thaiLen <= MAX_THAI_CHARS_LLM) return [p];
                  const chunks = splitTextByTargetLen(p, MAX_THAI_CHARS_LLM, 8);
                  return chunks.length > 1 ? chunks : [p];
                });
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

        // Hard-split any phrase still over 25 Thai chars — guarantees single line on screen.
        const MAX_THAI_CHARS = 25;
        phrases = phrases.flatMap((p) => {
          const thaiLen = (p.match(/[฀-๿]/g) ?? []).length;
          if (thaiLen <= MAX_THAI_CHARS) return [p];
          const chunks = splitTextByTargetLen(p, MAX_THAI_CHARS, 8);
          return chunks.length > 1 ? chunks : [p];
        });

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

        // Strategy B: Gemini — use Gemini segments directly as subtitle timing.
        // Gemini already split the audio at breath boundaries with accurate timestamps.
        // We walk phrases and segments in parallel using greedy text matching:
        //   - strip both to bare chars, check if phrase chars appear in accumulated segment chars
        //   - when accumulated segments cover a phrase, lock that segment's timestamp to the phrase
        // Multiple phrases per segment → subdivide that segment's time by char-proportion.
        if (result.length === 0 && useGeminiTranscribe && segments.length >= 2) {
          const bare = (s: string) => s.replace(/\s+/g, "").replace(/[.,!?;:"""''()[\]{}«»\/\\–—]/g, "").toLowerCase();

          // Greedy walk: accumulate segment text until it covers the current phrase
          const phraseToSeg: number[] = new Array(phrases.length).fill(-1);
          let si = 0;
          let accSegText = "";

          for (let pi = 0; pi < phrases.length; pi++) {
            const pBare = bare(phrases[pi]);
            // Accumulate segments until the combined text covers this phrase
            while (si < segments.length) {
              accSegText += bare(segments[si].text);
              // Check if accumulated text now contains or matches the phrase
              if (accSegText.includes(pBare) || accSegText.length >= pBare.length) {
                phraseToSeg[pi] = si;
                // Only advance segment if it's fully consumed (next phrase starts fresh)
                // Otherwise keep si pointing to current segment (multiple phrases per segment)
                const remaining = accSegText.replace(pBare, "");
                if (remaining.length < 3) {
                  // Segment mostly consumed — move to next segment for next phrase
                  accSegText = "";
                  si = Math.min(si + 1, segments.length - 1);
                } else {
                  // Segment still has chars — next phrase may also belong to this segment
                  accSegText = remaining;
                }
                break;
              }
              // Accumulated text not enough yet — consume next segment too
              si = Math.min(si + 1, segments.length - 1);
              if (si === segments.length - 1) {
                accSegText += bare(segments[si].text);
                phraseToSeg[pi] = si;
                accSegText = "";
                break;
              }
            }
            if (phraseToSeg[pi] === -1) phraseToSeg[pi] = segments.length - 1;
          }

          // Enforce monotonic
          for (let pi = 1; pi < phrases.length; pi++) {
            if (phraseToSeg[pi] < phraseToSeg[pi - 1]) phraseToSeg[pi] = phraseToSeg[pi - 1];
          }

          // Group phrases by segment and subdivide each segment's time by char-proportion
          const phraseCharsB = phrases.map(p => Math.max(1, alignmentCharLen(p)));
          const segGroupsB: number[][] = Array.from({ length: segments.length }, () => []);
          for (let pi = 0; pi < phrases.length; pi++) segGroupsB[phraseToSeg[pi]].push(pi);

          const tempResult: { text: string; startMs: number; endMs: number }[] = new Array(phrases.length);
          for (let si2 = 0; si2 < segments.length; si2++) {
            const group = segGroupsB[si2];
            if (group.length === 0) continue;
            const segStartMs = Math.round(segments[si2].start * 1000);
            const segEndMs   = Math.round(segments[si2].end * 1000);
            const segDurMs   = Math.max(segEndMs - segStartMs, 1);
            if (group.length === 1) {
              tempResult[group[0]] = { text: sanitizePhraseText(phrases[group[0]]), startMs: segStartMs, endMs: segEndMs };
            } else {
              const groupChars = group.map(pi => phraseCharsB[pi]);
              const groupTotal = groupChars.reduce((a, b) => a + b, 0) || 1;
              let cumGC = 0;
              for (let g = 0; g < group.length; g++) {
                const t0 = segStartMs + Math.round((cumGC / groupTotal) * segDurMs);
                cumGC += groupChars[g];
                const t1 = segStartMs + Math.round((cumGC / groupTotal) * segDurMs);
                tempResult[group[g]] = { text: sanitizePhraseText(phrases[group[g]]), startMs: t0, endMs: t1 };
              }
            }
          }

          if (tempResult.every(r => r != null)) {
            tempResult[tempResult.length - 1].endMs = Math.round(audioDur * 1000);
            result = tempResult;
            console.log(`[transcribe] Strategy B Gemini text-match: ${result.length} phrases → ${segments.length} segs`);
          }
        }

        // Strategy C: word-level alignment (Whisper-1 word timestamps)
        // Use when word count is very high relative to phrases — Whisper-1 word timestamps are reliable.
        // Thai: allowed when words ≥ phrases × 8 (word boundaries in Thai are syllable-level but timestamps are still accurate).
        // Non-Thai: allowed when words ≥ phrases × 2.
        const enoughWords = isThai ? words.length >= phrases.length * 8 : words.length >= phrases.length * 2;
        if (result.length === 0 && !useGeminiTranscribe && enoughWords) {
          const alignedByWord = alignPhrasesToWordTimings(phrases, words);
          if (alignedByWord.length === phrases.length) {
            result = alignedByWord.map((r) => ({ ...r, text: sanitizeTranscriptionText(r.text) }));
            console.log(`[transcribe] Strategy C word-timing: ${result.length} phrases from ${words.length} words (Thai=${isThai})`);
          }
        } else if (words.length > 0) {
          console.log(`[transcribe] Strategy C skipped — ${words.length} words / ${phrases.length} phrases ratio too low, using segment-anchor`);
        }

        // Strategy D: segment-anchor fallback (same logic as Strategy B for Gemini)
        // Whisper segments have accurate timestamps — use them as anchors, distribute phrases within each segment.
        if (result.length === 0 && !useGeminiTranscribe && segments.length >= 2) {
          const segChars = segments.map(s => Math.max(1, alignmentCharLen(s.text)));
          const totalSegChars = segChars.reduce((a, b) => a + b, 0);
          const segCumChars: number[] = [];
          let sc = 0;
          for (const c of segChars) { sc += c; segCumChars.push(sc); }

          const phraseChars = phrases.map(p => Math.max(1, alignmentCharLen(p)));
          const totalPhraseChars = phraseChars.reduce((a, b) => a + b, 0);

          const phraseToSeg: number[] = [];
          let cumP = 0;
          for (let pi = 0; pi < phrases.length; pi++) {
            const midP = (cumP + phraseChars[pi] / 2) / totalPhraseChars;
            cumP += phraseChars[pi];
            let bestSeg = 0;
            let bestDist = Infinity;
            for (let si = 0; si < segments.length; si++) {
              const segMid = (segCumChars[si] - segChars[si] / 2) / totalSegChars;
              const dist = Math.abs(midP - segMid);
              if (dist < bestDist) { bestDist = dist; bestSeg = si; }
            }
            phraseToSeg.push(bestSeg);
          }
          for (let pi = 1; pi < phrases.length; pi++) {
            if (phraseToSeg[pi] < phraseToSeg[pi - 1]) phraseToSeg[pi] = phraseToSeg[pi - 1];
          }

          const segGroups: number[][] = Array.from({ length: segments.length }, () => []);
          for (let pi = 0; pi < phrases.length; pi++) segGroups[phraseToSeg[pi]].push(pi);

          const tempResult2: { text: string; startMs: number; endMs: number }[] = new Array(phrases.length);
          for (let si = 0; si < segments.length; si++) {
            const group = segGroups[si];
            if (group.length === 0) continue;
            const segStartMs = Math.round(segments[si].start * 1000);
            const segEndMs   = Math.round(segments[si].end * 1000);
            const segDurMs   = Math.max(segEndMs - segStartMs, 1);
            if (group.length === 1) {
              tempResult2[group[0]] = { text: sanitizePhraseText(phrases[group[0]]), startMs: segStartMs, endMs: segEndMs };
            } else {
              const groupChars = group.map(pi => phraseChars[pi]);
              const groupTotal = groupChars.reduce((a, b) => a + b, 0) || 1;
              let cumGC = 0;
              for (let g = 0; g < group.length; g++) {
                const t0 = segStartMs + Math.round((cumGC / groupTotal) * segDurMs);
                cumGC += groupChars[g];
                const t1 = segStartMs + Math.round((cumGC / groupTotal) * segDurMs);
                tempResult2[group[g]] = { text: sanitizePhraseText(phrases[group[g]]), startMs: t0, endMs: t1 };
              }
            }
          }

          if (tempResult2.every(r => r != null)) {
            tempResult2[tempResult2.length - 1].endMs = Math.round(audioDur * 1000);
            result = tempResult2;
            console.log(`[transcribe] Strategy D segment-anchor: ${result.length} phrases → ${segments.length} segs`);
          }
        }

        // Strategy E: pure char-proportion fallback (no segments or only 1 segment)
        if (result.length === 0) {
          const aligned = alignPhrasesCharProportion(phrases, segments, audioDur);
          if (aligned.length === phrases.length) {
            result = aligned;
            console.log(`[transcribe] Strategy E char-proportion fallback: ${result.length} phrases, dur=${audioDur.toFixed(1)}s`);
          }
        }

        // Merge captions that are too short to read into adjacent — only if merged text won't be too long
        if (result.length > 1) {
          const MIN_DUR_MS = 700;   // captions ≥700ms are readable (Thai short phrases)
          const MAX_MERGE_CHARS = 30; // don't merge if combined text exceeds this
          let merged = true;
          while (merged && result.length > 1) {
            merged = false;
            for (let i = 0; i < result.length; i++) {
              const dur = result[i].endMs - result[i].startMs;
              if (dur < MIN_DUR_MS) {
                const mergeNext = i < result.length - 1 &&
                  (i === 0 || (result[i + 1].endMs - result[i + 1].startMs) <= (result[i - 1].endMs - result[i - 1].startMs));
                if (mergeNext) {
                  const combined = `${result[i].text} ${result[i + 1].text}`.trim();
                  if (combined.replace(/\s/g, "").length > MAX_MERGE_CHARS) break; // skip — would be too long
                  result[i + 1] = { ...result[i + 1], text: combined, startMs: result[i].startMs };
                  result.splice(i, 1);
                } else {
                  const combined = `${result[i - 1].text} ${result[i].text}`.trim();
                  if (combined.replace(/\s/g, "").length > MAX_MERGE_CHARS) break;
                  result[i - 1] = { ...result[i - 1], text: combined, endMs: result[i].endMs };
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
    // If Whisper gave us word-level timing, use it directly.
    // If not (e.g. Gemini transcribe), interpolate from segment-level timing.
    let wordTimestamps: { word: string; startMs: number; endMs: number }[];
    if (words.length > 0) {
      wordTimestamps = words
        .map((w) => ({
          word: w.word.trim(),
          startMs: Math.round(w.start * 1000),
          endMs: Math.round(w.end * 1000),
        }))
        .filter((w) => w.word.length > 0);
    } else {
      // Interpolate word timing from segments — much more accurate than interpolating from captions
      // For Thai (no spaces) use Intl.Segmenter to split into actual words.
      wordTimestamps = [];
      const thaiSegmenter = typeof Intl !== "undefined" && (Intl as any).Segmenter
        ? new (Intl as any).Segmenter("th", { granularity: "word" }) as { segment: (s: string) => Iterable<{ segment: string; isWordLike?: boolean }> }
        : null;

      for (const seg of segments) {
        const segText = seg.text.trim();
        if (!segText) continue;

        let segWords: string[];
        // If text has spaces (English-ish), use whitespace split
        if (/\s/.test(segText) && !/[฀-๿]/.test(segText)) {
          segWords = segText.split(/\s+/).filter(Boolean);
        } else if (thaiSegmenter) {
          // Thai or mixed — use Intl.Segmenter to split into word-like tokens
          segWords = Array.from(thaiSegmenter.segment(segText))
            .filter(s => s.isWordLike !== false && s.segment.trim().length > 0)
            .map(s => s.segment);
        } else {
          // Fallback: whitespace
          segWords = segText.split(/\s+/).filter(Boolean);
        }
        if (segWords.length === 0) continue;

        const segStartMs = Math.round(seg.start * 1000);
        const segEndMs = Math.round(seg.end * 1000);
        // Weight duration by character length (Thai chars take roughly equal time)
        const totalChars = segWords.reduce((sum, w) => sum + Math.max(1, w.length), 0);
        let cumChars = 0;
        for (let i = 0; i < segWords.length; i++) {
          const wLen = Math.max(1, segWords[i].length);
          const t0 = segStartMs + Math.round((cumChars / totalChars) * (segEndMs - segStartMs));
          cumChars += wLen;
          const t1 = segStartMs + Math.round((cumChars / totalChars) * (segEndMs - segStartMs));
          wordTimestamps.push({
            word: segWords[i],
            startMs: t0,
            endMs: t1,
          });
        }
      }
      console.log(`[transcribe] interpolated ${wordTimestamps.length} word timestamps from ${segments.length} segments (Thai-aware)`);
    }

    const safeFullText = sanitizeTranscriptionText(fullText);
    const resolvedDurationMs = Math.max(
      sourceAudioDurationMs,
      captions.at(-1)?.endMs ?? 0,
      rawSegments.at(-1)?.endMs ?? 0,
      wordTimestamps.at(-1)?.endMs ?? 0,
      1000,
    );
    // LLM-aligned captions already have segment-anchored timestamps — skip cursor-push.
    const isSegmentDirect = isThai && segments.length >= 3;
    const timelineFixedCaptions = sanitizeCaptionsTimeline(captions, resolvedDurationMs, 30, isSegmentDirect);

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

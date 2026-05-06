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
    .replace(/^[·•…]{2,}$/g, "")
    .replace(/^\s*✕+\s*$/g, "")
    .replace(/["“”'’]/g, "")
    .replace(/\.{2,}/g, "")
    .trim();
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
  // Strip to bare chars for proportion calculation (spaces included so splits land on word boundaries)
  const srcChars = [...src];
  const srcLen = srcChars.length;
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
    // Snap to word boundary: advance past any partial word
    while (srcPos < srcChars.length && srcChars[srcPos] !== " ") srcPos++;

    let slice = srcChars.slice(startPos, srcPos).join("").trim();
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
      const chars = [...text];
      const fixed: string[] = [];
      for (let i = 0; i < chars.length; i += maxLen) {
        fixed.push(chars.slice(i, i + maxLen).join("").trim());
      }
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

function expandPhrasesToTargetDensity(phrases: string[], targetCount: number, fallbackText: string): string[] {
  if (!Array.isArray(phrases) || phrases.length === 0) return [];
  if (phrases.length >= targetCount) return phrases;
  const combined = sanitizeTranscriptionText(phrases.join(" "));
  const source = combined || sanitizeTranscriptionText(fallbackText);
  if (!source) return phrases;
  const targetLen = Math.max(10, Math.floor(source.replace(/\s+/g, "").length / targetCount));
  return splitTextByTargetLen(source, targetLen, 10);
}

function parseSplitPhrasesFromRaw(raw: string): string[] {
  if (!raw) return [];
  try {
    const stripped = raw
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const arr = Array.isArray(parsed?.phrases) ? parsed.phrases : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is string => typeof p === "string")
      .map((p) => sanitizePhraseText(p))
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
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
        const audioB64 = audioBuffer.toString("base64");

        const timestampPrompt = `Transcribe this Thai audio into segments with timestamps.

Return ONLY valid JSON, no markdown, no explanation:
{"segments":[{"text":"...","start":0.0,"end":2.5},...],"fullText":"..."}

RULES:
- Each segment = one natural phrase or sentence (roughly 3–8 words)
- start/end = seconds (float, accurate to 0.1s)
- fullText = complete transcription joined together
- NEVER fabricate timestamps — only use what you can hear
- If audio has silence/pause, reflect that in timing${script ? `\n- Reference script (match wording): ${script.trim().slice(0, 2000)}` : ""}`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: timestampPrompt },
                  { inlineData: { mimeType: "audio/mp3", data: audioB64 } },
                ],
              }],
              generationConfig: { temperature: 0 },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errBody = await geminiRes.text().catch(() => "");
          console.error("[transcribe] Gemini error body:", errBody.slice(0, 500));
          if (geminiRes.status === 401 || geminiRes.status === 403) {
            throw { status: geminiRes.status, body: errBody };
          }
          throw new Error(`Gemini transcribe failed: ${geminiRes.status} — ${errBody.slice(0, 200)}`);
        }
        const geminiData = await geminiRes.json();
        const rawGeminiText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
        console.log(`[transcribe] Gemini raw: ${rawGeminiText.slice(0, 300)}`);

        // Try to parse structured JSON response with timestamps
        try {
          const jsonMatch = rawGeminiText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const match = jsonMatch.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            fullText = parsed.fullText?.trim() ?? rawGeminiText;
            if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
              segments = parsed.segments
                .filter((s: { text?: string; start?: number; end?: number }) =>
                  typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number"
                )
                .map((s: { text: string; start: number; end: number }) => ({
                  text: s.text.trim(),
                  start: s.start,
                  end: s.end,
                }));
              console.log(`[transcribe] Gemini OK — ${fullText.length} chars, ${segments.length} segments with timestamps`);
            } else {
              console.warn("[transcribe] Gemini returned no segments, falling back to text-only");
              fullText = rawGeminiText;
            }
          } else {
            fullText = rawGeminiText;
          }
        } catch {
          // JSON parse failed → use raw text, no timestamps
          fullText = rawGeminiText;
          console.warn("[transcribe] Gemini JSON parse failed, using text-only mode");
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

      // STT is used ONLY for timestamps — never for subtitle text.
      // Always run LLM split on the real script, then map onto STT timestamps.
      // Reset captions so we always go through LLM split regardless of STT output.
      captions = [];

      // ── Step 1: LLM split — always runs, uses real script text ──
      let phrases: string[] = [];
      let llmTags: ("hook" | "body" | "cta")[] = [];
      let minPhrases = 4;
      let maxPhrases = 6;
      const openAiSplitModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
      const scriptSentencesInitial = splitToSentencePhrases(sourceRaw);
      const hasScriptSource = typeof script === "string" && script.trim().length > 0;
      const hasSentencePunctuation = /[.!?…]/.test(sourceText);
      const strictSentences = splitToPunctuationSentences(sourceText);
      const shouldSkipLLMSplit = strictSentences.length === 1 && !hasSentencePunctuation && sourceText.length <= 70;
      const shouldUseSegmentSplit = !hasScriptSource && !hasSentencePunctuation && segments.length >= 2;

      if (shouldUseSegmentSplit) {
        const segmentTexts = segments
          .map((s) => sanitizeTranscriptionText(s.text))
          .filter(Boolean);
        if (segmentTexts.length > 1) {
          phrases = segmentTexts;
          llmTags = phrases.map((_, i) => (i === 0 ? "hook" : "body"));
          console.log(`[transcribe] fallback segment-based split from Whisper timestamps: ${phrases.length} phrases`);
        } else if (shouldSkipLLMSplit) {
          phrases = mergeTinyPhrases(mergeDateAndConnectorBreaks(scriptSentencesInitial));
          console.log(`[transcribe] skip LLM split for single-sentence input: ${phrases.length} phrase(s)`);
        }
      } else if (shouldSkipLLMSplit) {
        phrases = mergeTinyPhrases(mergeDateAndConnectorBreaks(scriptSentencesInitial));
        console.log(`[transcribe] skip LLM split for single-sentence input: ${phrases.length} phrase(s)`);
      } else if (apiKey) {
        try {
          const durationSec = audioDur;
          const sourceLen = sourceText.replace(/\s+/g, "").length;
          // Target ~20-30 Thai chars per subtitle phrase (comfortable reading speed)
          const byChars = Math.round(sourceLen / 25);
          // Target ~3-4s per phrase based on duration
          const byDur = Math.round(durationSec / 3.5);
          const targetPhrases = Math.max(byChars, byDur, 3);
          minPhrases = Math.max(3, targetPhrases - 1);
          maxPhrases = targetPhrases + 2;

          const splitPrompt = `You are a Thai subtitle splitter for TikTok/Reels.

TASK: Split this Thai script into subtitle phrases — COPY words EXACTLY, do NOT rewrite or remove any words.

━━━ CRITICAL ━━━
• COPY words EXACTLY from the script. Do NOT paraphrase, summarize, or drop any words.
• Every word in the script must appear in the output — nothing removed.
• Only decide WHERE to split into subtitle lines.

━━━ SPLITTING RULES ━━━
• Audio duration: ${durationSec.toFixed(1)}s → target ${minPhrases}–${maxPhrases} phrases total
• Each phrase = one complete thought unit.
• Prefer balanced line lengths: aim each phrase around similar length (roughly 18–45 Thai chars for Thai text, 12–24 words for English/mixed text).
• Avoid single-word/very short phrases (<10 chars) unless it is a standalone name, number, date, or key term.
• Keep total phrase count in a consistent density: no jumps of +1 then -1 between neighboring lines unless punctuation forces it.
• Split at sentence-ending punctuation (. ? ! ฯ) or major conjunctions (แต่, และ, เพราะ, จึง) or natural breath points.
• NEVER split mid-sentence just to hit a char limit.
• Short punchy lines → keep as ONE phrase.
• NEVER split a date expression (Thai month name + date + year = ONE phrase).

━━━ TAGGING RULES ━━━
• "hook" = opening attention-grabbing line(s) — FIRST 1–2 phrases only.
• "body" = main content — the majority of phrases.
• "cta"  = explicit action words only: กดติดตาม, กด like, กดแชร์, สมัครเลย, subscribe, follow.

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON — no markdown, no explanation:
{"phrases":["phrase1","phrase2"],"tags":["hook","body","cta"]}

━━━ SCRIPT TO PROCESS ━━━
${sourceText.trim()}`;

          // max_tokens: each phrase ~30 tokens × maxPhrases, plus JSON overhead; cap at 16k for long scripts
          const splitMaxTokens = Math.min(16000, Math.max(1024, maxPhrases * 30 + 300));

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
              const scriptSentences = splitToSentencePhrases(sourceRaw);
              const shouldUseSentenceSplit = scriptSentences.length > 1 &&
                scriptSentences.length <= Math.max(3, raw.length + 3) &&
                scriptSentences.length <= 20;
              const origStripped = normalizeForCompare(sourceText);
              const outStripped = normalizeForCompare(raw.join(""));
              const charRatio = origStripped.length > 0 ? outStripped.length / origStripped.length : 0;
          if (raw.length > 0 && charRatio >= 0.45 && charRatio <= 1.80) {
                // Use LLM phrases directly — prompt instructs COPY EXACT.
                // Do NOT call expandPhrasesToTargetDensity: it re-splits by char count
                // and breaks mixed Thai/English phrases (e.g. "enterprise product" → two lines).
                const sentenceLenOk = scriptSentences.every((s) => alignmentCharLen(s) >= 10) && scriptSentences.length <= 20;
                if ((shouldUseSentenceSplit || scriptSentences.length === 2) && sentenceLenOk) {
                  phrases = mergeTinyPhrases(scriptSentences);
                  if (llmTags.length > phrases.length) llmTags = llmTags.slice(0, phrases.length);
                  console.log(`[transcribe] sentence-anchored split override -> ${phrases.length} phrases`);
                } else {
                  phrases = mergeTinyPhrases(snapPhrasesToScript(raw, sourceText));
                }
                phrases = mergeDateAndConnectorBreaks(phrases);
                console.log(`[transcribe] LLM split → ${phrases.length} phrases (ratio=${charRatio.toFixed(3)}) tags=${llmTags.length}`);
              } else {
                console.warn(`[transcribe] LLM mismatch — orig:${origStripped.length} out:${outStripped.length} ratio=${charRatio.toFixed(3)}, using fallback`);
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
      if (phrases.length === 0) {
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
        phrases = mergeTinyPhrases(mergeDateAndConnectorBreaks(phrases));
      }
        console.log(`[transcribe] fallback split → ${phrases.length} phrases`);
        // Do NOT expand here — char-based splitting breaks mixed Thai/English phrases.
      }

      // ── Step 2: Align phrases → Whisper timestamps ──────────────────────────
      // Strategy A (preferred): word-level forced alignment
      //   Strip each phrase and each whisper word to bare Thai chars,
      //   greedily consume words until phrase chars are covered → use word start/end.
      // Strategy B (fallback): segment-level char-weighted mapping
      //   Use Whisper segment start/end times, weighted by phrase char length.

      if (phrases.length > 0) {
        let result: { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" }[] = [];

        const canDirectSegmentAlign = phrases.length === segments.length && phrases.length >= 2;
        if (canDirectSegmentAlign) {
          for (let i = 0; i < phrases.length; i++) {
            result.push({
              text: sanitizeTranscriptionText(phrases[i]),
              startMs: Math.round(segments[i].start * 1000),
              endMs: Math.round(segments[i].end * 1000),
            });
          }
          console.log(`[transcribe] direct segment alignment: ${result.length} phrases`);
        } else {
          const alignedByWord = alignPhrasesToWordTimings(phrases, words);
          if (alignedByWord.length === phrases.length) {
            result.push(...alignedByWord.map((r) => ({ ...r, text: sanitizeTranscriptionText(r.text) })));
            console.log(`[transcribe] word-timing alignment: ${result.length} phrases`);
          }
        }

        if (result.length === 0 && segments.length > 0) {
          const charLen = alignmentCharLen;
          const cleanText = (s: string) => sanitizeTranscriptionText(s);
          const segsWithBounds = [...segments];
          // Ensure coverage: clamp first start to 0, last end to audioDur
          if (segsWithBounds[0].start > 0.05) segsWithBounds[0] = { ...segsWithBounds[0], start: 0 };
          if (segsWithBounds[segsWithBounds.length - 1].end < audioDur - 0.1) {
            segsWithBounds[segsWithBounds.length - 1] = { ...segsWithBounds[segsWithBounds.length - 1], end: audioDur };
          }

          const phraseLens = phrases.map((p) => charLen(p));
          const totalPhraseChars = phraseLens.reduce((a, b) => a + b, 0);
          const segBoundaries = Array.from(new Set(
            segsWithBounds.flatMap((s) => [s.start, s.end])
          )).sort((a, b) => a - b);

          const snapToSegBoundary = (sec: number): number => {
            let best = segBoundaries[0];
            let bestDist = Math.abs(sec - best);
            for (const b of segBoundaries) {
              const d = Math.abs(sec - b);
              if (d < bestDist) { bestDist = d; best = b; }
            }
            return best;
          };

          let cumCharsA = 0;
          for (let i = 0; i < phrases.length; i++) {
            const f0 = cumCharsA / totalPhraseChars;
            cumCharsA += phraseLens[i];
            const f1 = cumCharsA / totalPhraseChars;
            const rawStart = f0 * audioDur;
            const rawEnd = f1 * audioDur;
            const snapStart = Math.abs(snapToSegBoundary(rawStart) - rawStart) < 1.5
              ? snapToSegBoundary(rawStart)
              : rawStart;
            const snapEnd = Math.abs(snapToSegBoundary(rawEnd) - rawEnd) < 1.5
              ? snapToSegBoundary(rawEnd)
              : rawEnd;
            result.push({
              text: cleanText(phrases[i]),
              startMs: Math.round(snapStart * 1000),
              endMs: Math.round(Math.max(snapEnd, rawStart + 0.3) * 1000),
            });
          }
          console.log(`[transcribe] segment-snapped alignment: ${result.length} phrases snapped to ${segBoundaries.length} boundaries`);
        }

        if (result.length === 0 && words.length > 0) {
          // Strategy B fallback: word-level proportional
          const wordTimeline = words.map((w) => w.start);
          wordTimeline.push(words[words.length - 1].end);
          const charLensB = phrases.map((p) => alignmentCharLen(p));
          const totalCharsB = charLensB.reduce((a, b) => a + b, 0);
          let cumB = 0;
          for (let i = 0; i < phrases.length; i++) {
            const f0 = cumB / totalCharsB;
            cumB += charLensB[i];
            const f1 = cumB / totalCharsB;
            const idxStart = Math.floor(f0 * (wordTimeline.length - 1));
            const idxEnd = Math.min(Math.floor(f1 * (wordTimeline.length - 1)), wordTimeline.length - 1);
            result.push({
              text: sanitizeTranscriptionText(phrases[i]),
              startMs: Math.round(wordTimeline[idxStart] * 1000),
              endMs: Math.round(wordTimeline[idxEnd] * 1000),
            });
          }
          console.log(`[transcribe] word-proportional fallback alignment: ${result.length} phrases over ${words.length} words`);
        }

        if (result.length === 0) {
          // Strategy C: no timestamps — distribute by char count over total audio duration
          const charLengths = phrases.map(alignmentCharLen);
          const totalChars = charLengths.reduce((a, b) => a + b, 0);
          let cumChars = 0;
          for (let i = 0; i < phrases.length; i++) {
            const startSec = (cumChars / totalChars) * audioDur;
            cumChars += charLengths[i];
            const endSec = (cumChars / totalChars) * audioDur;
            result.push({
              text: sanitizeTranscriptionText(phrases[i]),
              startMs: Math.round(startSec * 1000),
              endMs: Math.round(endSec * 1000),
            });
          }
          console.log(`[transcribe] char-proportional (no timestamps) ${result.length} captions over ${audioDur.toFixed(1)}s`);
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
            result = safeResult.map((r) => ({ text: r.text, startMs: r.startMs, endMs: r.endMs, tag: r.tag }));
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


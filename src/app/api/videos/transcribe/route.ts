import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";
import { getGeminiErrorInfo } from "@/lib/gemini-errors";

export const maxDuration = 900;  // 15 min — supports 10-min audio + Whisper processing time

const SRT_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const SRT_ARROW_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const MIN_GAP_MS = 1;
const MIN_CAPTION_MS = 400;
const INCOMPLETE_TRANSCRIBE_GAP_MS = 5000;

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
    .replace(/[​-‍﻿]/g, "")
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
    .replace(/["""'']/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/([฀-๿])\s+([฀-๿])/g, "$1$2")
    .replace(/\s{2,}/g, " ")
    .replace(/([?!ฯ])\s*([ก-๿])/g, "$1 $2")
    .replace(/\s*([,.:;!?])\s*/g, "$1 ")
    .trim();
}

function normalizeCaptionText(input: string): string {
  const noBOM = input.replace(/[​-‍﻿]/g, "");
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

function normalizeForCompare(input: string): string {
  return sanitizeTranscriptionText(input)
    .replace(/\s+/g, "")
    .replace(/[.,!?·•…฿"'\-–—()]/g, "");
}

function alignmentCharLen(input: string): number {
  const cleaned = sanitizeTranscriptionText(input)
    .replace(/["""''""'']/g, "")
    .replace(/\.{2,}/g, "");
  if (!cleaned) return 0;
  const thai = cleaned.replace(/[^฀-๿]/g, "").length;
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

type SubtitleItem = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs?: number;
  confidence?: number;
  tag?: "hook" | "body" | "cta";
};

// Thai leading vowels render BEFORE their consonant. A caption that STARTS with one
// means the previous caption was cut mid-word → merge it back. Also catches tiny
// syllable fragments (≤3 Thai chars, no terminal punctuation).
const THAI_LEADING_VOWEL_RE = /^[เแโใไ]/;
function isThaiSyllableFragment(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const thaiLen = (t.match(/[฀-๿]/g) ?? []).length;
  return thaiLen > 0 && thaiLen <= 3 && !/[.!?ฯ]/.test(t);
}

// Merge captions that were split mid-word (leading-vowel start / tiny fragment).
// Keeps the earlier caption's start and the later caption's end so timing stays
// anchored to real audio boundaries.
function mergeFragmentCaptions<T extends { text: string; startMs: number; endMs: number }>(
  caps: T[],
  maxMergeChars = 48,
): T[] {
  if (caps.length < 2) return caps;
  const out: T[] = [];
  for (const cap of caps) {
    const text = cap.text.trim();
    if (out.length > 0) {
      const prev = out[out.length - 1];
      const startsMidWord = THAI_LEADING_VOWEL_RE.test(text);
      const isFragment = isThaiSyllableFragment(text);
      const prevIsFragment = isThaiSyllableFragment(prev.text);
      const combinedLen = prev.text.trim().length + text.length;
      if ((startsMidWord || isFragment || prevIsFragment) && combinedLen <= maxMergeChars) {
        prev.text = (prev.text.trim() + text).trim();
        prev.endMs = cap.endMs;
        continue;
      }
    }
    out.push({ ...cap, text });
  }
  return out;
}

// Hard guarantee for principle #2: the last subtitle must END close to the real
// audio length. Gemini is told this in the prompt but doesn't always obey, so we
// clamp here. Only stretches the tail when the gap is meaningful (> 250ms) and not
// absurd (< 8s, which would signal a transcription that genuinely stopped early).
function clampLastCaptionToAudioEnd<T extends { startMs: number; endMs: number }>(
  caps: T[],
  audioDurationMs: number,
): T[] {
  if (caps.length === 0 || audioDurationMs <= 0) return caps;
  const last = caps[caps.length - 1];
  const gap = audioDurationMs - last.endMs;
  if (gap > 250 && gap < 8000) {
    last.endMs = audioDurationMs;
  } else if (last.endMs > audioDurationMs) {
    last.endMs = Math.max(last.startMs + 1, audioDurationMs);
  }
  return caps;
}

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

  // ถ้า caption สุดท้ายจบก่อน audio duration เกิน 3s — extend ให้ครบ
  // (Gemini บางครั้งตัด caption ก่อนเสียงจบ โดยเฉพาะช่วงท้ายที่เงียบหรือพูดช้า)
  if (out.length > 0 && totalMs > 0) {
    const last = out[out.length - 1];
    if (totalMs - last.endMs > 3000) {
      out[out.length - 1] = { ...last, endMs: totalMs };
    }
  }

  return out;
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

// ── Long-audio chunking ──
// Gemini loses timestamp sync on long audio (returns a bogus duration that
// overshoots reality), so we split long clips at silence into ~2.5-min chunks,
// transcribe each on the accurate-timestamp 2.5-flash baseline, then offset+merge.
const CHUNK_THRESHOLD_MS = 240_000; // >4 min ⇒ chunk
const CHUNK_TARGET_MS = 150_000;    // ~2.5 min target chunk
const CHUNK_MAX_MS = 210_000;       // 3.5 min hard cap per chunk

// Run silencedetect over the mp3 and return silence-end timestamps (ms), sorted.
// These are used as candidate cut points (cut at the end of each silence).
function detectSilences(ffmpegPath: string, mp3Path: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(ffmpegPath, [
      "-i", mp3Path,
      "-af", "silencedetect=noise=-30dB:d=0.3",
      "-f", "null", "-",
    ], { maxBuffer: 20 * 1024 * 1024 }, (_err, _stdout, stderr) => {
      const out: number[] = [];
      const re = /silence_end:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr || "")) !== null) {
        const sec = parseFloat(m[1]);
        if (Number.isFinite(sec)) out.push(Math.round(sec * 1000));
      }
      out.sort((a, b) => a - b);
      resolve(out);
    });
  });
}

// Pick internal cut points so each chunk lands near CHUNK_TARGET_MS, preferring a
// real silence within [lastCut+60s, lastCut+CHUNK_MAX_MS]; hard-cut if none in range.
// Returns the internal cut points only (excludes 0 and totalMs).
function planChunkBoundaries(totalMs: number, silences: number[]): number[] {
  const cuts: number[] = [];
  let lastCut = 0;
  while (totalMs - lastCut > CHUNK_MAX_MS) {
    const target = lastCut + CHUNK_TARGET_MS;
    const lo = lastCut + 60_000;
    const hi = lastCut + CHUNK_MAX_MS;
    let best = -1;
    let bestDist = Infinity;
    for (const s of silences) {
      if (s < lo || s > hi) continue;
      const dist = Math.abs(s - target);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    const cut = best >= 0 ? best : hi; // hard-cut when no silence in range
    cuts.push(cut);
    lastCut = cut;
  }
  return cuts;
}

// Slice [startMs,endMs) out of the mp3 (stream copy), return its bytes, unlink the slice.
function sliceAudio(
  ffmpegPath: string,
  mp3Path: string,
  startMs: number,
  endMs: number,
  outPath: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const startSec = (startMs / 1000).toFixed(3);
    const durSec = ((endMs - startMs) / 1000).toFixed(3);
    execFile(ffmpegPath, [
      // -ss/-t BEFORE -i = input seeking. With -c copy, output seeking (-ss AFTER
      // -i) does NOT actually seek and copies from 0, so every chunk got the clip's
      // opening — later chunks then showed the first chunk's subtitles.
      "-y", "-ss", startSec, "-t", durSec, "-i", mp3Path,
      "-c", "copy", outPath,
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg slice failed: ${err.message}\n${stderr?.slice(-300)}`));
      try {
        const buf = fs.readFileSync(outPath);
        try { fs.unlinkSync(outPath); } catch {}
        resolve(buf);
      } catch (readErr) {
        reject(readErr instanceof Error ? readErr : new Error(String(readErr)));
      }
    });
  });
}

// Transcribe ONE audio buffer through Gemini and return raw words/segments/captions
// (timestamps are relative to the START of this buffer — caller offsets them).
// This is the verbatim body of the former inline Gemini block; the caller handles
// the mp3 file lifecycle and (for long audio) offset+merge of the results.
async function geminiTranscribeChunk(
  audioBuffer: Buffer,
  geminiKey: string,
  script: string,
  chunkDurationMs: number,
): Promise<{
  words: { word: string; start: number; end: number }[];
  segments: { text: string; start: number; end: number }[];
  geminiDirectCaptions: { text: string; startMs: number; endMs: number; timestampMs: number; confidence: number; tag?: "hook" | "body" | "cta" }[];
  fullText: string;
}> {
  type WhisperWord = { word: string; start: number; end: number };
  type WhisperSegment = { text: string; start: number; end: number };
  type CaptionItem = { text: string; startMs: number; endMs: number; timestampMs: number; confidence: number; tag?: "hook" | "body" | "cta" };
  let words: WhisperWord[] = [];
  let segments: WhisperSegment[] = [];
  let fullText = "";
  let geminiDirectCaptions: CaptionItem[] = [];

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
      // new Uint8Array view (byte-identical) — the helper's `audioBuffer: Buffer`
      // param widens to Buffer<ArrayBufferLike>, which isn't directly a BodyInit;
      // a Uint8Array always is. (Inline readFileSync was Buffer<ArrayBuffer>.)
      body: new Uint8Array(audioBuffer),
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

  const audioLenSec = chunkDurationMs > 0 ? (chunkDurationMs / 1000).toFixed(1) : null;
  const timestampPrompt = `คุณคือผู้ตัดซับไตเติ้ลภาษาไทยสำหรับ TikTok/Reels มืออาชีพ

ฟัง audio แล้วแบ่งเป็นซับการ์ดสั้นๆ พร้อม timestamp จาก audio โดยตรง${audioLenSec ? `

⚠️ audio นี้ยาว ${audioLenSec} วินาที — ต้องถอดเสียงให้ครบจนถึงวินาทีสุดท้าย
caption สุดท้าย endMs ต้องอยู่ใกล้ ${audioLenSec}s (ห่างได้ไม่เกิน 3s)
ถ้าถอดไม่ถึงท้าย = ผิด ต้องฟังต่อจนจบไฟล์` : ""}

━━━ กฎ 1 — ตัดที่จุดหายใจ ไม่ตัดกลางวลี ━━━
ตัดหลังจุลภาค จุด หรือช่วงหยุดเสียง ≥ 0.25s
ห้ามตัดกลางประโยคที่ความหมายยังค้างอยู่
✗ ผิด: "มึงเคยคิดปะ ว่า" | "ความรู้ที่เรียนมา"
✓ ถูก: "มึงเคยคิดปะ..." | "ว่าความรู้ที่เรียนมา"

━━━ กฎ 2 — 1 ซับ = 1 ความคิด ━━━
ถ้าประโยคมี 2 ไอเดีย ให้แยกเป็น 2 ซับ แม้จะสั้น
✗ ผิด: "อิเล็กตรอนหนีออก ทิ้งหลุมว่าง เรียกว่าโฮล จับคู่กลายเป็นเอ็กซิตอน"
✓ ถูก: "อิเล็กตรอนหนี" | "ทิ้งหลุมว่าง โฮล" | "จับคู่กัน" | "กลายเป็นเอ็กซิตอน"

━━━ กฎ 3 — ซับช็อก ให้สั้นพิเศษ ━━━
twist / punchline / คำเด็ด → 3-8 คำ การ์ดเดี่ยว เช่น "แม่งแหกทุกกฎที่เคยมีมา"

━━━ กฎ 4 — ห้ามซับค้างนานเกิน 5 วินาที ━━━
ถ้า segment ยาว ให้แบ่งซับเพิ่มตามจังหวะพูด

━━━ กฎ 5 — gap ระหว่างซับ ━━━
endMs ของซับ[i] ต้องน้อยกว่า startMs ของซับ[i+1] เสมอ (≥ 40ms)

━━━ กฎ 6 — ต้องครอบคลุมเสียงพูดทั้งหมด ห้ามข้าม ━━━
ถอดเสียงให้ครบตั้งแต่วินาทีแรกจนวินาทีสุดท้ายของ audio
ห้ามข้ามช่วงใดช่วงหนึ่งที่มีคนพูด — แม้พูดเร็วหรือเสียงเบา
ถ้ามีคนพูดต่อเนื่อง ซับต้องต่อเนื่อง ห้ามเว้นช่องว่าง > 2 วินาที ระหว่างซับที่มีเสียงพูดคั่น
ตรวจสอบ: caption สุดท้ายต้องจบใกล้ความยาว audio จริง

━━━ กฎ timestamp ━━━
- startMs = เวลาเริ่มพูดคำแรก × 1000 (ms) — ฟังจาก audio เท่านั้น อย่าเดา
- endMs = เวลาจบคำสุดท้าย × 1000 — ห้าม pad
- ห้าม overlap

━━━ tags ━━━
"hook"=การ์ดแรก (ดึงดูด), "cta"=กดติดตาม/ไลค์/แชร์ (max 2), "body"=ทั้งหมดที่เหลือ${script ? `

━━━ SCRIPT (spelling reference — timestamps ต้องมาจาก audio) ━━━
${script.trim().slice(0, 2000)}` : ""}

━━━ OUTPUT — JSON เท่านั้น ไม่มี markdown ━━━
{"captions":[{"text":"...","startMs":0,"endMs":2300,"tag":"hook"},...],"words":[{"word":"...","start":0.0,"end":0.35},...], "fullText":"..."}

ใส่ words array ด้วยเพื่อให้ระบบ verify timestamps`;

  const transcribeBody = JSON.stringify({
    contents: [{
      parts: [
        { text: timestampPrompt },
        { fileData: { mimeType: "audio/mp3", fileUri } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 131072,
      // Small thinking budget (not 0): lets the model sanity-check its own
      // timestamps — e.g. that captions stay in order and the last one ends
      // near the real audio length — which improves "ซับตรงเสียง". The JSON
      // parser below already extracts the {...} object from any surrounding
      // text, so a thought preamble doesn't break output.
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  // Model order is chosen for TIMESTAMP accuracy, not text quality.
  // Gen-3 models (gemini-3.x-flash / 3.1-pro) have a confirmed progressive
  // timestamp-drift bug in audio transcription (Google AI Dev forum, May 2026):
  // a ~12-min clip drifts up to -157s by the end, so subtitles end well before
  // the audio does ("ซับไม่จบพร้อมเสียง"). gemini-2.5-flash is Google's own
  // accurate-timestamp baseline — keep it FIRST. Gen-3 is intentionally NOT used
  // for transcription here; its better text quality doesn't matter because we
  // take subtitle TEXT from the user's script, only TIMESTAMPS from the audio.
  // Fallbacks are 2.5-family on purpose: gemini-2.5-flash can transiently 503
  // (Google-side overload), and the old gemini-1.5-* fallbacks now hard-404
  // (Google retired the 1.5 family on v1beta) — which turned a *recoverable* 503
  // into a total transcribe failure (subtitles never generated). Same-family 2.5
  // fallbacks keep timestamps accurate (no Gen-3 drift) while giving a real escape
  // hatch when flash is overloaded: 2.5-pro sits in a separate capacity pool.
  const TRANSCRIBE_MODELS = [
    "gemini-2.5-flash",       // accurate-timestamp baseline (Google ref) — primary
    "gemini-2.5-pro",         // fallback when 2.5-flash is 503-overloaded — separate capacity, accurate timing
    "gemini-2.5-flash-lite",  // lightweight last-resort fallback (further overload / restricted keys)
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
      type GeminiWord = { word?: string; start?: number; end?: number };
      type GeminiCap = { text?: string; startMs?: number; endMs?: number; tag?: string };
      type GeminiSeg = { text?: string; start?: number; end?: number; words?: GeminiWord[] };
      let parsed: { fullText?: string; captions?: GeminiCap[]; segments?: GeminiSeg[]; words?: GeminiWord[] } | null = null;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        // Step 1: close incomplete last object in array, then close arrays/object
        let repaired = match[0]
          .replace(/,\s*\{[^}]*$/, "")   // drop incomplete trailing object
          .replace(/,\s*$/, "")            // drop trailing comma
          .trimEnd();
        // Step 2: count unclosed brackets and close them
        let open = 0;
        for (const ch of repaired) { if (ch === "[" || ch === "{") open++; else if (ch === "]" || ch === "}") open--; }
        // close with matching brackets (best-effort order: arrays before objects)
        const closing = repaired.endsWith("}") ? "" : (repaired.includes('"captions"') ? "]}" : "}");
        repaired = repaired + closing;
        try { parsed = JSON.parse(repaired); } catch { /* give up */ }
      }

      if (parsed) {
        // Extract word timestamps (top-level or nested in segments)
        const geminiWords: typeof words = [];
        if (Array.isArray(parsed.words)) {
          for (const w of parsed.words) {
            if (typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number")
              geminiWords.push({ word: w.word, start: w.start, end: w.end });
          }
        }
        if (geminiWords.length === 0 && Array.isArray(parsed.segments)) {
          for (const s of parsed.segments) {
            for (const w of (s.words ?? [])) {
              if (typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number")
                geminiWords.push({ word: w.word, start: w.start, end: w.end });
            }
          }
        }
        if (geminiWords.length > 0) words = geminiWords;

        // Try new combined captions format first
        if (Array.isArray(parsed.captions) && parsed.captions.length > 0) {
          const validCaps = parsed.captions.filter(c =>
            typeof c.text === "string" && typeof c.startMs === "number" && typeof c.endMs === "number"
          );
          if (validCaps.length > 0) {
            geminiDirectCaptions = validCaps.map((c, i) => ({
              text: sanitizePhraseText(c.text!),
              startMs: c.startMs!,
              endMs: c.endMs!,
              timestampMs: c.startMs!,
              confidence: 1 as number,
              tag: (c.tag === "hook" || c.tag === "cta" ? c.tag : i === 0 ? "hook" : "body") as "hook" | "body" | "cta",
            })).filter(c => c.text.length > 0);
            fullText = parsed.fullText?.trim() || geminiDirectCaptions.map(c => c.text).join(" ");
            segments = geminiDirectCaptions.map(c => ({ text: c.text, start: c.startMs / 1000, end: c.endMs / 1000 }));
            console.log(`[transcribe] Gemini OK (combined) — ${geminiDirectCaptions.length} captions, ${words.length} words`);
          }
        }

        // Fallback: old segments-only format
        if (geminiDirectCaptions.length === 0 && Array.isArray(parsed.segments) && parsed.segments.length > 0) {
          segments = parsed.segments
            .filter(s => typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number")
            .map(s => ({ text: (s.text as string).trim(), start: s.start as number, end: s.end as number }));
          fullText = parsed.fullText?.trim() || segments.map(s => s.text).join(" ").trim();
          console.log(`[transcribe] Gemini OK (segments) — ${segments.length} segments, ${words.length} words`);
        }

        if (geminiDirectCaptions.length === 0 && segments.length === 0) {
          console.warn("[transcribe] Gemini returned no captions/segments");
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

  return { words, segments, geminiDirectCaptions, fullText };
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

    // Extract audio as mp3 (mono 16kHz) for Gemini processing
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
    type CaptionItem = { text: string; startMs: number; endMs: number; timestampMs: number; confidence: number; tag?: "hook" | "body" | "cta" };
    let words: WhisperWord[] = [];
    let segments: WhisperSegment[] = [];
    let fullText = "";
    let geminiDirectCaptions: CaptionItem[] = []; // captions from combined Gemini response

    if (useGeminiTranscribe) {
      // ── Gemini Audio Transcribe with timestamps ──
      console.log("[transcribe] using Gemini transcribe with timestamps...");
      try {
        const geminiKey = Buffer.from(user!.geminiKey!, "base64").toString("utf-8");
        const audioBuffer = fs.readFileSync(mp3Path);
        const ffmpeg = getFfmpegPath();
        let chunkPlan: { buffer: Buffer; startMs: number; durationMs: number }[] = [];
        if (sourceAudioDurationMs > CHUNK_THRESHOLD_MS) {
          const silences = await detectSilences(ffmpeg, mp3Path).catch(() => []);
          const cuts = planChunkBoundaries(sourceAudioDurationMs, silences);
          if (cuts.length >= 1) {
            const bounds = [0, ...cuts, sourceAudioDurationMs];
            for (let i = 0; i < bounds.length - 1; i++) {
              const startMs = bounds[i], endMs = bounds[i + 1];
              const buf = await sliceAudio(ffmpeg, mp3Path, startMs, endMs, `${mp3Path}.chunk${i}.mp3`);
              chunkPlan.push({ buffer: buf, startMs, durationMs: endMs - startMs });
            }
            console.log(`[transcribe] chunked ${(sourceAudioDurationMs/1000).toFixed(1)}s audio into ${chunkPlan.length} chunks at silence`);
          }
        }
        try { fs.unlinkSync(mp3Path); } catch {}

        if (chunkPlan.length >= 2) {
          // long audio: transcribe each chunk SEQUENTIALLY, offset + merge
          for (const ch of chunkPlan) {
            const r = await geminiTranscribeChunk(ch.buffer, geminiKey, script, ch.durationMs);
            const offSec = ch.startMs / 1000;
            for (const w of r.words) words.push({ word: w.word, start: w.start + offSec, end: w.end + offSec });
            for (const s of r.segments) segments.push({ text: s.text, start: s.start + offSec, end: s.end + offSec });
            for (const c of r.geminiDirectCaptions) geminiDirectCaptions.push({ ...c, startMs: c.startMs + ch.startMs, endMs: c.endMs + ch.startMs, timestampMs: c.timestampMs + ch.startMs });
            fullText += (fullText ? " " : "") + r.fullText;
          }
          console.log(`[transcribe] merged ${chunkPlan.length} chunks → ${geminiDirectCaptions.length} captions, ${words.length} words`);
        } else {
          // short audio (or no usable silence split): single call = unchanged behavior
          const r = await geminiTranscribeChunk(audioBuffer, geminiKey, script, sourceAudioDurationMs);
          words = r.words; segments = r.segments; geminiDirectCaptions = r.geminiDirectCaptions; fullText = r.fullText;
        }
      } catch (e: unknown) {
        console.error("[transcribe] Gemini transcribe error:", e);
        const status = (e as { status?: number })?.status;
        const body = (e as { body?: string })?.body;
        if (status === 401) {
          return NextResponse.json({ error: "Gemini API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings", missingKey: "gemini" }, { status: 401 });
        }
        const info = getGeminiErrorInfo(body ?? e, status ?? 503);
        return NextResponse.json({
          error: info.userMessage,
          retryable: info.retryable,
          provider: "gemini",
          reason: info.kind,
        }, { status: info.status });
      }
    } else {
      try { fs.unlinkSync(mp3Path); } catch {}
      return NextResponse.json({ error: "Gemini API Key is required for transcription. Please add your Gemini key in Settings.", missingKey: "gemini" }, { status: 401 });
    }

    // LLM key for subtitle splitting
    const apiKey = user?.geminiKey ? Buffer.from(user.geminiKey, "base64").toString("utf-8") : null;
    console.log(`[transcribe] LLM split provider: Gemini apiKey=${apiKey ? "ok" : "MISSING"}`);

    const isThai = /[฀-๿]/.test(fullText) || (typeof script === "string" && /[฀-๿]/.test(script));

    let captions: { text: string; startMs: number; endMs: number; timestampMs: number; confidence: number; tag?: "hook" | "body" | "cta" }[] = [];

    // Use captions from combined Gemini response directly — but still run the
    // fragment-merge + tail-clamp guards so principles #1/#2 hold even on this path.
    if (geminiDirectCaptions.length > 0) {
      const merged = mergeFragmentCaptions(geminiDirectCaptions);
      captions = clampLastCaptionToAudioEnd(merged, sourceAudioDurationMs);
      console.log(`[transcribe] combined Gemini captions: ${geminiDirectCaptions.length} → ${captions.length} after fragment-merge + tail-clamp`);
    }

    if ((isThai || words.length === 0) && captions.length === 0) {
      // Always use the real script as source text — STT text may be inaccurate.
      // STT (Gemini) is used ONLY for timestamps, never for subtitle text.
      const sourceRaw: string = (typeof script === "string" && script.trim().length > 0)
        ? script.trim() : fullText;
      // Strip any subtitle metadata headers that users may accidentally paste in
      // e.g. "ซับไตเติลขนาด 9:16 (แบ่งตามจังหวะคำพูด)\n#1 · hook\n\nก่อนที่..."
      const stripSubtitleMetadata = (s: string): string => {
        return s
          .replace(/ซับไตเติล[^\n]*/g, "")
          .replace(/^#\d+\s*·\s*(hook|body|cta)[^\n]*/gim, "")
          .replace(/^\d+:\d+–\d+:\d+\s*/gm, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      };
      const sourceText = sanitizeTranscriptionText(stripSubtitleMetadata(sourceRaw));
      console.log(`[transcribe] sourceText from ${typeof script === "string" && script.trim().length > 0 ? "script (real)" : "STT fullText (fallback)"}: ${sourceText.slice(0, 80)}`);
      const fallbackDur = sourceAudioDurationMs > 0 ? sourceAudioDurationMs / 1000 : 30;
      const audioDur = Math.max(
        segments.length > 0 ? segments[segments.length - 1].end : 0,
        words.length > 0 ? words[words.length - 1].end : 0,
        fallbackDur
      );

      captions = [];

      // ── Gemini: send segments to LLM to merge/split into proper subtitle cards ──
      if (segments.length >= 1 && apiKey) {
        const totalAudioMs = Math.max(1, Math.round(audioDur * 1000));

        // Pre-merge segments whose text starts with an orphan Thai syllable fragment.
        const THAI_LEADING_VOWELS = /^[เ-ไแโใไ]/; // เ แ โ ใ ไ
        const THAI_CONSONANT = /^[ก-ฮะ-ฺ]/;
        const isOrphanFragment = (text: string): boolean => {
          const t = text.trim();
          if (!t) return false;
          const thaiLen = (t.match(/[฀-๿]/g) ?? []).length;
          // Very short Thai-only segment (≤ 3 Thai chars, no punctuation) = likely fragment
          if (thaiLen > 0 && thaiLen <= 3 && !/[.!?ฯ]/.test(t)) return true;
          return false;
        };
        const premergedSegments: typeof segments = [];
        for (const seg of segments) {
          const text = seg.text.trim();
          if (premergedSegments.length > 0 && isOrphanFragment(text)) {
            const prev = premergedSegments[premergedSegments.length - 1];
            const prevText = prev.text.trimEnd();
            const lastChar = prevText[prevText.length - 1];
            const lastIsThai = lastChar && /[฀-๿]/.test(lastChar);
            const endsWithLeadingVowel = lastChar && THAI_LEADING_VOWELS.test(lastChar);
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

        // ── Use Gemini segments directly as captions ──
        // For long segments (>3.5s) subdivide using word timestamps so each
        // caption is short enough to read in one glance (~2s sweet spot).
        const MAX_SEG_SEC = 3.5;
        const segmentCaptions: { text: string; startMs: number; endMs: number; tag: "hook"|"body"|"cta" }[] = [];
        for (let si2 = 0; si2 < mergedSegments.length; si2++) {
          const seg = mergedSegments[si2];
          const dur = seg.end - seg.start;
          const tag: "hook"|"body"|"cta" = si2 === 0 ? "hook" : "body";
          if (dur <= MAX_SEG_SEC || words.length === 0) {
            segmentCaptions.push({ text: seg.text.trim(), startMs: Math.round(seg.start * 1000), endMs: Math.round(seg.end * 1000), tag });
            continue;
          }
          // Get words within this segment
          const segWords = words.filter(w => w.start >= seg.start - 0.05 && w.end <= seg.end + 0.05);
          if (segWords.length <= 1) {
            segmentCaptions.push({ text: seg.text.trim(), startMs: Math.round(seg.start * 1000), endMs: Math.round(seg.end * 1000), tag });
            continue;
          }
          // Split into ~2s chunks using word boundaries
          let chunk: typeof segWords = [];
          let chunkStart = seg.start;
          for (let wi = 0; wi < segWords.length; wi++) {
            chunk.push(segWords[wi]);
            const chunkDur = segWords[wi].end - chunkStart;
            const isLast = wi === segWords.length - 1;
            const nextGap = !isLast ? segWords[wi + 1].start - segWords[wi].end : 1;
            if (isLast || chunkDur >= MAX_SEG_SEC || nextGap >= 0.35) {
              segmentCaptions.push({
                text: chunk.map(w => w.word).join("").trim(),
                startMs: Math.round(chunkStart * 1000),
                endMs: Math.round(segWords[wi].end * 1000),
                tag,
              });
              if (!isLast) { chunk = []; chunkStart = segWords[wi + 1].start; }
            }
          }
        }
        console.log(`[transcribe] segments → ${segmentCaptions.length} captions (split long segments with word timestamps)`);
        captions = segmentCaptions.map(c => ({
          text: c.text,
          startMs: c.startMs,
          endMs: c.endMs,
          timestampMs: c.startMs,
          confidence: 1,
          tag: c.tag as "hook" | "body" | "cta",
        }));

        const segList = mergedSegments.map((s, i) =>
          `${i + 1}. [${s.start.toFixed(2)}s–${s.end.toFixed(2)}s] "${s.text.trim()}"`
        ).join("\n");

        const wordList = words.length > 0
          ? words.map((w, i) =>
              `W${i + 1}[${w.start.toFixed(2)}-${w.end.toFixed(2)}s] "${w.word}"`
            ).join(" ")
          : "(no word-level timestamps available — group SEGMENTS instead)";

        const scriptForPrompt = sourceText.trim().slice(0, 3000);
        const geminiMergePrompt = `แบ่งสคริปต์ภาษาไทยนี้เป็นซับไตเติ้ลสำหรับ TikTok/Reels/Shorts

กฎหลัก:
1. ห้ามตัดกลางคำ — คำในรายการ WORDS คือหน่วยที่แบ่งไม่ได้
2. ซับแต่ละการ์ดต้อง อ่านได้ใน 1 วินาที — ไม่เกิน 15-20 ตัวอักษรไทย
3. ตัดที่ช่วงเงียบ (gap ≥ 0.3s), คำเชื่อม (แต่/เพราะ/ถ้า/และ), หรือจบประโยค
4. คำเชื่อมขึ้นต้นการ์ดใหม่เสมอ: แต่, เพราะ, ถ้า, และ, หรือ, จึง, ดังนั้น
5. ห้ามข้ามคำ ห้ามสลับ ห้ามแก้ข้อความ
6. startMs = เวลาเริ่มของคำแรก × 1000, endMs = เวลาจบของคำสุดท้าย × 1000

สไตล์ที่ต้องการ:
- ซับสั้น กระชับ อ่านฉับ เหมือน TikTok มืออาชีพ
- คำเด็ดๆ เป็นการ์ดเดี่ยวได้: "ทำมันพัง" / "จริงๆ" / "ทันที"
- การ์ดแรก (hook) ต้องดึงดูด ชวนติดตาม
- แบ่งตาม rhythm การพูด ไม่ใช่ประโยคไวยากรณ์

tags: "hook"=การ์ดแรกเท่านั้น, "cta"=กดติดตาม/ไลค์/แชร์, "body"=ทั้งหมดที่เหลือ

ตัวอย่างที่ดี (script: "ก่อนที่ Claude รุ่นใหม่จะถึงมือคุณ มีทีมเล็กๆ ที่ได้ลองก่อน"):
  Card 1: "ก่อนที่ Claude รุ่นใหม่จะถึงมือคุณ" → hook
  Card 2: "มีทีมเล็กๆ" → body
  Card 3: "ที่ได้ลองก่อนทุกคน" → body

ตัวอย่างที่ผิด: "ก่อนที่Claudeรุ่นใหม่จะถึงมือคุณมีทีมเล็กๆที่ได้ลองก่อนทุกคน" (ยาวเกินไป)

OUTPUT: JSON เท่านั้น ไม่มี markdown
{"captions":[{"text":"...","startMs":0,"endMs":2300,"tag":"hook"},{"text":"...","startMs":2500,"endMs":4000,"tag":"body"},...]}

━━━ SCRIPT (ต้นฉบับ) ━━━
${scriptForPrompt}

━━━ WORDS (คำ+timestamp — ห้ามตัดกลาง) ━━━
${wordList}

━━━ SEGMENTS (ขอบเขตประโยค อ้างอิงเท่านั้น) ━━━
${segList}

Total audio: ${audioDur.toFixed(2)}s`;

        let llmCaptions: { text: string; startMs: number; endMs: number; tag?: string }[] = segmentCaptions;
        const skipLlmMerge = false;
        if (!skipLlmMerge) {
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
          llmCaptions = segmentCaptions; // fallback to segments
        }
        } // end if (!skipLlmMerge)

        // ── Snap LLM-reported timestamps to real STT timestamps ──
        type SnapUnit = { text: string; start: number; end: number };
        // Thai: always snap to segments. Segment timestamps come from silence/breath
        // detection in the audio and are reliable.
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

          // Fill unmatched captions: trust LLM timestamps directly where valid,
          // fall back to linear interpolation otherwise.
          if (snappedCount < llmCaptions.length) {
            for (let idx = 0; idx < llmCaptions.length; idx++) {
              if (snapped[idx]) continue;
              let prevSnap = -1;
              for (let p = idx - 1; p >= 0; p--) if (snapped[p]) { prevSnap = p; break; }
              let nextSnap = -1;
              for (let n = idx + 1; n < llmCaptions.length; n++) if (snapped[n]) { nextSnap = n; break; }

              const prevEnd = prevSnap >= 0 ? llmCaptions[prevSnap].endMs : 0;
              const nextStart = nextSnap >= 0 ? llmCaptions[nextSnap].startMs : totalAudioMs;

              const llmStart = llmCaptions[idx].startMs;
              const llmEnd   = llmCaptions[idx].endMs;
              if (llmStart >= prevEnd && llmEnd <= nextStart && llmEnd > llmStart) {
                // LLM timestamps are valid — use them as-is
              } else {
                // LLM timestamps out of range — linear interpolation as fallback
                const gap = Math.max(0, nextStart - prevEnd);
                const runStart = prevSnap + 1;
                const runEnd = nextSnap >= 0 ? nextSnap - 1 : llmCaptions.length - 1;
                const runLen = runEnd - runStart + 1;
                const slot = idx - runStart;
                const slice = runLen > 0 ? gap / runLen : 0;
                llmCaptions[idx].startMs = Math.round(prevEnd + slot * slice);
                llmCaptions[idx].endMs   = Math.max(Math.round(prevEnd + (slot + 1) * slice), llmCaptions[idx].startMs + 1);
              }
            }
            console.warn(`[transcribe] word-snap: interpolated ${llmCaptions.length - snappedCount}/${llmCaptions.length} unmatched captions (LLM timestamps used where valid)`);
          }
          console.log(`[transcribe] word-snap: ${snappedCount}/${llmCaptions.length} captions snapped to real word timestamps`);

          // Respect silence at the start of the audio.
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

        // Tail recovery: Gemini sometimes drops the very last words of the script.
        if (llmCaptions.length > 0 && sourceText.trim()) {
          const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
          const scriptNorm = normalize(sourceText);
          const concatNorm = normalize(llmCaptions.map(c => c.text).join(""));
          if (concatNorm.length < scriptNorm.length * 0.92) {
            const last = llmCaptions[llmCaptions.length - 1];
            const lastNorm = normalize(last.text);
            const idx = scriptNorm.lastIndexOf(lastNorm);
            if (idx >= 0 && idx + lastNorm.length < scriptNorm.length) {
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
    }

    // Also return raw segment-level timestamps (natural speech boundaries)
    const rawSegments = segments.map((seg) => ({
      text: seg.text.trim(),
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
    }));

    // Raw word timestamps for forced alignment on client
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
      // Interpolate word timing from segments — much more accurate than interpolating from captions.
      // For Thai (no spaces) use Intl.Segmenter to split into actual words.
      wordTimestamps = [];
      const thaiSegmenter = typeof Intl !== "undefined" && (Intl as any).Segmenter
        ? new (Intl as any).Segmenter("th", { granularity: "word" }) as { segment: (s: string) => Iterable<{ segment: string; isWordLike?: boolean }> }
        : null;

      for (const seg of segments) {
        const segText = seg.text.trim();
        if (!segText) continue;

        let segWords: string[];
        if (/\s/.test(segText) && !/[฀-๿]/.test(segText)) {
          segWords = segText.split(/\s+/).filter(Boolean);
        } else if (thaiSegmenter) {
          segWords = Array.from(thaiSegmenter.segment(segText))
            .filter(s => s.isWordLike !== false && s.segment.trim().length > 0)
            .map(s => s.segment);
        } else {
          segWords = segText.split(/\s+/).filter(Boolean);
        }
        if (segWords.length === 0) continue;

        const segStartMs = Math.round(seg.start * 1000);
        const segEndMs = Math.round(seg.end * 1000);
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
    // GUARD: ffprobe duration is authoritative when available. Gemini can return
    // timestamps that are too long (wrong units / JSON glitches) or too short
    // (incomplete transcription). Too long is clamped to ffprobe; too short is a
    // retryable error so we don't render a video that cuts audio/subtitles early.
    const TAIL_MS = 2000;
    // When Gemini's whole reported timeline runs well PAST the real audio, it lost
    // timestamp sync — every caption is mistimed (and big gaps drop captions), not
    // just the tail. Clamping would silently ship drifted/gappy subs. So past a
    // threshold, fail retryable (like the too-short case below): Gemini is
    // non-deterministic so a retry often re-syncs, and a shorter clip always works.
    // This is a safety net only — the real long-clip fix is audio chunking.
    const BOGUS_DURATION_MAX_RATIO = 1.10; // >10% overshoot ⇒ unreliable, reject
    const rawMaxMs = Math.max(
      captions.at(-1)?.endMs ?? 0,
      rawSegments.at(-1)?.endMs ?? 0,
      wordTimestamps.at(-1)?.endMs ?? 0,
      1000,
    );
    if (sourceAudioDurationMs > 0 && rawMaxMs > sourceAudioDurationMs + TAIL_MS) {
      console.warn(`[transcribe] clamped bogus duration ${rawMaxMs}ms → ${sourceAudioDurationMs}ms (ffprobe audio=${sourceAudioDurationMs}ms)`);
      if (rawMaxMs > sourceAudioDurationMs * BOGUS_DURATION_MAX_RATIO) {
        const pct = Math.round((rawMaxMs / sourceAudioDurationMs - 1) * 100);
        console.warn(`[transcribe] desynced transcript: ${pct}% overshoot > ${Math.round((BOGUS_DURATION_MAX_RATIO - 1) * 100)}% threshold — rejecting (retryable)`);
        return NextResponse.json({
          error: `ถอดซับไม่ตรงจังหวะ (ระบบถอดเสียงคลาดเคลื่อน ~${pct}%) — มักเกิดกับคลิปยาว กรุณากด Transcribe อีกครั้ง หรือใช้คลิปสั้นลง`,
          provider: "gemini",
          reason: "transcribe_desynced",
          retryable: true,
          sourceAudioDurationMs,
          reportedDurationMs: rawMaxMs,
        }, { status: 422 });
      }
    }
    if (sourceAudioDurationMs > 0) {
      const missingTailMs = sourceAudioDurationMs - rawMaxMs;
      if (missingTailMs > INCOMPLETE_TRANSCRIBE_GAP_MS) {
        console.warn(`[transcribe] incomplete transcript: captions end at ${rawMaxMs}ms but audio is ${sourceAudioDurationMs}ms`);
        return NextResponse.json({
          error: `ถอดซับไม่ครบ เสียงยาว ${(sourceAudioDurationMs / 1000).toFixed(1)}s แต่ซับจบที่ ${(rawMaxMs / 1000).toFixed(1)}s กรุณากด Transcribe ใหม่`,
          provider: "gemini",
          reason: "transcribe_incomplete",
          retryable: true,
          sourceAudioDurationMs,
          captionDurationMs: rawMaxMs,
        }, { status: 422 });
      }
    }
    const resolvedDurationMs = sourceAudioDurationMs > 0 ? sourceAudioDurationMs : rawMaxMs;
    // LLM-aligned captions already have segment-anchored timestamps — skip cursor-push.
    const isSegmentDirect = (isThai || words.length === 0) && segments.length >= 3;
    // Stretch small safe tails to the real ffprobe duration so config/render do not
    // stop a few frames before the audio ends.
    const timelineFixedCaptions = clampLastCaptionToAudioEnd(
      sanitizeCaptionsTimeline(captions, resolvedDurationMs, 30, isSegmentDirect),
      sourceAudioDurationMs,
    );

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

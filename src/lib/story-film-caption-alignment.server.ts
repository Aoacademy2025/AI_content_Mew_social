import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  buildCanonicalCaptionsFromAlignedWords,
  resolveUploadTranscriptWords,
} from "@/lib/mcp/subtitle-quality";
import { normalizeGeminiWords } from "@/lib/transcribe-timeline";
import type { StoryFilmCaptionTrack } from "@/lib/story-film-editorial";

const execFileAsync = promisify(execFile);
const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"] as const;

type RawWord = {
  word?: string;
  start?: number;
  end?: number;
  startMs?: number;
  endMs?: number;
};

function parseWords(raw: string): RawWord[] {
  const stripped = raw.replace(/```json\s*/giu, "").replace(/```/gu, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/u);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { words?: RawWord[] };
    return Array.isArray(parsed.words) ? parsed.words : [];
  } catch {
    return [];
  }
}

async function extractPresenterAudio(videoPath: string, outputPath: string) {
  await execFileAsync(getFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
    outputPath,
  ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

async function uploadGeminiAudio(audio: Buffer, apiKey: string) {
  const response = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "Content-Type": "audio/mp3",
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "raw",
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Header-Content-Length": String(audio.byteLength),
      "X-Goog-Upload-Header-Content-Type": "audio/mp3",
    },
    signal: AbortSignal.timeout(120_000),
    body: new Uint8Array(audio),
  });
  if (!response.ok) throw new Error(`story_film_alignment_upload_failed:${response.status}`);
  const data = await response.json() as { file?: { uri?: string; name?: string } };
  if (!data.file?.uri) throw new Error("story_film_alignment_upload_missing_uri");
  return { uri: data.file.uri, name: data.file.name ?? null };
}

async function transcribeWords(input: {
  fileUri: string;
  apiKey: string;
  script: string;
  durationMs: number;
}) {
  const prompt = `ฟังเสียงนี้และคืน word timestamps ตามเสียงจริง เพื่อทำ forced alignment กับสคริปต์ภาษาไทย

กฎ:
- ถอดทุกคำตั้งแต่ต้นจนจบ ห้ามสรุป ห้ามแปล
- startMs/endMs เป็น millisecond จากเสียงจริง ห้ามเดาจากความยาวข้อความ
- words ต้องเรียงตามเวลา ไม่ overlap
- ใช้สคริปต์ด้านล่างเป็น spelling reference เท่านั้น
- ตอบ JSON เท่านั้น: {"words":[{"word":"...","startMs":0,"endMs":320},...]}

ความยาวเสียง: ${(input.durationMs / 1_000).toFixed(1)} วินาที
SCRIPT:
${input.script.slice(0, 12_000)}`;
  let lastError = "";
  for (const model of MODELS) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { fileData: { mimeType: "audio/mp3", fileUri: input.fileUri } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 65_536, thinkingConfig: { thinkingBudget: 2_048 } },
      }),
    });
    if (!response.ok) {
      lastError = `${model}:${response.status}:${(await response.text().catch(() => "")).slice(0, 160)}`;
      continue;
    }
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    const words = parseWords(raw);
    if (words.length > 0) return words;
    lastError = `${model}:invalid_json`;
  }
  throw new Error(`story_film_alignment_transcribe_failed:${lastError}`);
}

export async function alignStoryFilmPresenterCaptions(input: {
  videoPath: string;
  script: string;
  durationMs: number;
  apiKey: string;
}): Promise<{ track: StoryFilmCaptionTrack | null; reason: string | null }> {
  const script = input.script.normalize("NFC").trim();
  if (!script || !(input.durationMs > 0) || input.durationMs > 180_000 || !input.apiKey.trim()) {
    return { track: null, reason: "alignment_input_invalid" };
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hero-story-film-align-"));
  const audioPath = path.join(temporaryDirectory, "presenter.mp3");
  let remoteName: string | null = null;
  try {
    await extractPresenterAudio(input.videoPath, audioPath);
    const audio = await fs.readFile(audioPath);
    const uploaded = await uploadGeminiAudio(audio, input.apiKey);
    remoteName = uploaded.name;
    const rawWords = await transcribeWords({
      fileUri: uploaded.uri,
      apiKey: input.apiKey,
      script,
      durationMs: input.durationMs,
    });
    const normalized = normalizeGeminiWords(rawWords, input.durationMs).words.map((word) => ({
      word: word.word,
      startMs: Math.round(word.start * 1_000),
      endMs: Math.round(word.end * 1_000),
    }));
    const resolution = resolveUploadTranscriptWords(script, normalized);
    if (!resolution.regroupingAvailable || resolution.words.length === 0) {
      return { track: null, reason: resolution.failureCode ?? "alignment_text_mismatch" };
    }
    const cards = buildCanonicalCaptionsFromAlignedWords(script, resolution.words, 27);
    if (!cards || cards.length === 0) return { track: null, reason: "alignment_caption_build_failed" };
    return {
      track: {
        version: 1,
        source: "forced_alignment",
        fullText: script,
        words: resolution.words,
        captions: cards.map((caption, index) => ({
          text: caption.text,
          startMs: caption.startMs,
          endMs: caption.endMs,
          tag: index === 0 ? "hook" : index === cards.length - 1 ? "cta" : "body",
        })),
      },
      reason: null,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    if (remoteName) {
      await fetch(`https://generativelanguage.googleapis.com/v1beta/${remoteName}`, {
        method: "DELETE",
        headers: { "x-goog-api-key": input.apiKey },
      }).catch(() => {});
    }
  }
}

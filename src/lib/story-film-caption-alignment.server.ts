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
import {
  chunkTranscriptionReferenceDurationMs,
  normalizeGeminiWords,
  offsetChunkWordsToSourceTimeline,
  parseTranscriptionSilenceAnalysis,
} from "@/lib/transcribe-timeline";
import {
  planStoryFilmAlignmentChunks,
  storyFilmAlignmentHasSpeechTailCoverage,
  storyFilmAlignmentScriptSlice,
  type StoryFilmAlignmentWord,
} from "@/lib/story-film-caption-alignment";
import {
  STORY_FILM_SENTENCE_MAX_CARD_CHARS,
  STORY_FILM_SENTENCE_MIN_CARD_MS,
  storyFilmSentenceCards,
  type StoryFilmCaptionTrack,
} from "@/lib/story-film-editorial";

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
  models?: readonly (typeof MODELS)[number][];
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
  for (const model of input.models ?? MODELS) {
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

async function detectPresenterSilence(audioPath: string, durationMs: number) {
  const { stderr } = await execFileAsync(getFfmpegPath(), [
    "-hide_banner", "-i", audioPath,
    "-af", "silencedetect=noise=-30dB:d=0.3",
    "-f", "null", "-",
  ], { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
  return parseTranscriptionSilenceAnalysis(stderr || "", durationMs);
}

async function slicePresenterAudio(input: {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  durationMs: number;
}) {
  await execFileAsync(getFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", (input.startMs / 1_000).toFixed(3),
    "-t", (input.durationMs / 1_000).toFixed(3),
    "-i", input.sourcePath,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
    input.outputPath,
  ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

function millisecondWords(words: ReturnType<typeof normalizeGeminiWords>["words"]): StoryFilmAlignmentWord[] {
  return words.map((word) => ({
    word: word.word,
    startMs: Math.round(word.start * 1_000),
    endMs: Math.round(word.end * 1_000),
  }));
}

async function transcribeAlignedChunk(input: {
  audio: Buffer;
  apiKey: string;
  script: string;
  durationMs: number;
  spokenEndMs: number;
  remoteNames: string[];
}): Promise<StoryFilmAlignmentWord[] | null> {
  const uploaded = await uploadGeminiAudio(input.audio, input.apiKey);
  if (uploaded.name) input.remoteNames.push(uploaded.name);
  let best: StoryFilmAlignmentWord[] | null = null;
  let bestTailDistance = Number.POSITIVE_INFINITY;
  for (const model of MODELS) {
    try {
      const rawWords = await transcribeWords({
        fileUri: uploaded.uri,
        apiKey: input.apiKey,
        script: input.script,
        durationMs: input.durationMs,
        models: [model],
      });
      const candidate = millisecondWords(normalizeGeminiWords(rawWords, input.durationMs).words);
      const lastEndMs = candidate.reduce((latest, word) => Math.max(latest, word.endMs), 0);
      const distance = Math.abs(input.spokenEndMs - lastEndMs);
      if (distance < bestTailDistance) {
        best = candidate;
        bestTailDistance = distance;
      }
      if (storyFilmAlignmentHasSpeechTailCoverage(candidate, input.spokenEndMs)) return candidate;
    } catch {
      // Try the next configured model. JSON validity alone is not sufficient:
      // the acoustic tail must be present before this chunk can drive captions.
    }
  }
  return best && storyFilmAlignmentHasSpeechTailCoverage(best, input.spokenEndMs) ? best : null;
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
  const remoteNames: string[] = [];
  try {
    await extractPresenterAudio(input.videoPath, audioPath);
    const silence = await detectPresenterSilence(audioPath, input.durationMs)
      .catch(() => ({ cutPointsMs: [], trailingSilenceStartMs: null }));
    const chunks = planStoryFilmAlignmentChunks(input.durationMs, silence.cutPointsMs);
    const normalized: StoryFilmAlignmentWord[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = chunks.length === 1
        ? audioPath
        : path.join(temporaryDirectory, `presenter-${index + 1}.mp3`);
      if (chunks.length > 1) {
        await slicePresenterAudio({
          sourcePath: audioPath,
          outputPath: chunkPath,
          startMs: chunk.startMs,
          durationMs: chunk.durationMs,
        });
      }
      const referenceDurationMs = chunkTranscriptionReferenceDurationMs({
        chunkStartMs: chunk.startMs,
        chunkDurationMs: chunk.durationMs,
        totalDurationMs: input.durationMs,
        trailingSilenceStartMs: silence.trailingSilenceStartMs,
      });
      const localWords = await transcribeAlignedChunk({
        audio: await fs.readFile(chunkPath),
        apiKey: input.apiKey,
        script: storyFilmAlignmentScriptSlice({
          script,
          startMs: chunk.startMs,
          durationMs: chunk.durationMs,
          totalDurationMs: input.durationMs,
        }),
        durationMs: chunk.durationMs,
        spokenEndMs: referenceDurationMs,
        remoteNames,
      });
      if (!localWords) {
        return { track: null, reason: `alignment_speech_tail_incomplete:chunk_${index + 1}` };
      }
      normalized.push(...offsetChunkWordsToSourceTimeline({
        words: localWords.map((word) => ({
          word: word.word,
          start: word.startMs / 1_000,
          end: word.endMs / 1_000,
        })),
        offsetMs: chunk.startMs,
        chunkDurationMs: chunk.durationMs,
      }).map((word) => ({
        word: word.word,
        startMs: Math.round(word.start * 1_000),
        endMs: Math.round(word.end * 1_000),
      })));
    }
    const resolution = resolveUploadTranscriptWords(script, normalized);
    if (!resolution.regroupingAvailable || resolution.words.length === 0) {
      return { track: null, reason: resolution.failureCode ?? "alignment_text_mismatch" };
    }
    const spokenEndMs = silence.trailingSilenceStartMs ?? input.durationMs;
    if (!storyFilmAlignmentHasSpeechTailCoverage(resolution.words, spokenEndMs)) {
      return { track: null, reason: "alignment_speech_tail_incomplete" };
    }
    const cards = buildCanonicalCaptionsFromAlignedWords(
      script,
      resolution.words,
      STORY_FILM_SENTENCE_MAX_CARD_CHARS,
      storyFilmSentenceCards(script),
      STORY_FILM_SENTENCE_MIN_CARD_MS,
    );
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
    for (const remoteName of remoteNames) {
      await fetch(`https://generativelanguage.googleapis.com/v1beta/${remoteName}`, {
        method: "DELETE",
        headers: { "x-goog-api-key": input.apiKey },
      }).catch(() => {});
    }
  }
}

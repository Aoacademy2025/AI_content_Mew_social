import { resolveGeminiKey } from "@/lib/gemini-key";
import { normalizeGeminiWords } from "@/lib/transcribe-timeline";
import {
  collectRawWords,
  deleteGeminiFile,
  uploadGeminiAudioFile,
  wordsToSegments,
} from "./gemini-file";
import type { DesktopSttOptions, DesktopSttProvider, DesktopSttResult } from "./types";

const MODEL = "gemini-3.5-transcribe";

export function createGeminiTranscribeProvider(
  user: { geminiKey: string | null; plan: string },
): DesktopSttProvider {
  return {
    name: "gemini-transcribe",
    async transcribe(buffer, options) {
      const { key } = resolveGeminiKey(user);
      return transcribeGemini35(key, buffer, options);
    },
  };
}

async function transcribeGemini35(
  geminiKey: string,
  buffer: Buffer,
  options: DesktopSttOptions,
): Promise<DesktopSttResult> {
  const mimeType = options.mimeType || "audio/mp4";
  const { fileUri, fileName } = await uploadGeminiAudioFile(geminiKey, buffer, mimeType);
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey,
      },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: "audio", uri: fileUri, mime_type: mimeType },
        ],
        generation_config: {
          transcription_config: {
            mode: {
              type: "verbatim",
              timestamp_granularities: ["word"],
            },
          },
        },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`gemini-3.5-transcribe failed: ${res.status} — ${errBody.slice(0, 200)}`);
    }
    const payload = await res.json() as Record<string, unknown>;
    const durationMs = (options.durationSec ?? 0) * 1000;
    const normalized = normalizeGeminiWords(collectRawWords(payload), durationMs);
    const outputText = typeof payload.output_text === "string" ? payload.output_text.trim() : "";
    const segments = wordsToSegments(normalized.words);
    if (segments.length === 0 && outputText) {
      segments.push({ text: outputText, start: 0, end: options.durationSec ?? 0 });
    }
    return {
      words: normalized.words.map((word) => ({ w: word.word, start: word.start, end: word.end })),
      segments,
      language: options.language || "th-TH",
      provider: "gemini-transcribe",
    };
  } finally {
    await deleteGeminiFile(geminiKey, fileName);
  }
}

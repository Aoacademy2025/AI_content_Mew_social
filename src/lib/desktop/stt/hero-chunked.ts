// Wraps the Gemini File API + generateContent call used by
// src/app/api/videos/transcribe/route.ts `geminiTranscribeChunk`
// (same model order, upload headers, JSON extract). Source commit:
// c75493f95123764226279c4223fc7076bb3c94b9

import { resolveGeminiKey } from "@/lib/gemini-key";
import { normalizeGeminiWords } from "@/lib/transcribe-timeline";
import {
  deleteGeminiFile,
  uploadGeminiAudioFile,
  wordsToSegments,
} from "./gemini-file";
import type { DesktopSttOptions, DesktopSttProvider, DesktopSttResult } from "./types";

const TRANSCRIBE_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
];

const TIMESTAMP_PROMPT = `คุณคือผู้ถอดเสียงภาษาไทย

ฟัง audio แล้วคืน JSON เท่านั้น ไม่มี markdown
{"words":[{"word":"...","startMs":0,"endMs":350},...],"segments":[{"text":"...","start":0,"end":2.3},...],"fullText":"..."}

กฎ timestamp: startMs/endMs จากเสียงจริง ห้ามเดา ห้าม overlap
ถอดให้ครบจนจบไฟล์ language=th-TH`;

export function createHeroChunkedProvider(
  user: { geminiKey: string | null; plan: string },
): DesktopSttProvider {
  return {
    name: "hero-chunked",
    async transcribe(buffer, options) {
      const { key } = resolveGeminiKey(user);
      return transcribeHeroChunk(key, buffer, options);
    },
  };
}

async function transcribeHeroChunk(
  geminiKey: string,
  buffer: Buffer,
  options: DesktopSttOptions,
): Promise<DesktopSttResult> {
  const mimeType = options.mimeType || "audio/mp3";
  const { fileUri, fileName } = await uploadGeminiAudioFile(geminiKey, buffer, mimeType);
  const transcribeBody = JSON.stringify({
    contents: [{
      parts: [
        { text: TIMESTAMP_PROMPT },
        { fileData: { mimeType, fileUri } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 131072,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  let geminiRes: Response | null = null;
  let lastErr = "";
  try {
    outer:
    for (const model of TRANSCRIBE_MODELS) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": geminiKey,
            },
            signal: AbortSignal.timeout(600_000),
            body: transcribeBody,
          },
        );
        if (geminiRes.ok) break outer;
        lastErr = await geminiRes.text().catch(() => "");
        if (geminiRes.status === 401 || geminiRes.status === 403 || geminiRes.status === 404 || geminiRes.status === 400) {
          break;
        }
        if (attempt < 3) {
          const delayMs = 2000 * (2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    if (!geminiRes || !geminiRes.ok) {
      throw new Error(`hero-chunked Gemini failed: ${geminiRes?.status ?? 503} — ${lastErr.slice(0, 200)}`);
    }
    const geminiData = await geminiRes.json() as Record<string, unknown>;
    const candidates = geminiData?.candidates as Array<{ content: { parts: Array<{ text: string }> } }> | undefined;
    const rawText = candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    const stripped = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("hero-chunked Gemini returned no JSON");
    const parsed = JSON.parse(match[0]) as {
      words?: Array<{ word?: string; start?: number; end?: number; startMs?: number; endMs?: number }>;
      segments?: Array<{ text?: string; start?: number; end?: number }>;
      fullText?: string;
    };
    const durationMs = (options.durationSec ?? 0) * 1000;
    const normalized = normalizeGeminiWords(parsed.words ?? [], durationMs);
    const segments = (parsed.segments ?? [])
      .filter((segment) => typeof segment.text === "string" && typeof segment.start === "number" && typeof segment.end === "number")
      .map((segment) => ({ text: (segment.text as string).trim(), start: segment.start as number, end: segment.end as number }))
      .filter((segment) => segment.text.length > 0);
    const resolvedSegments = segments.length > 0
      ? segments
      : wordsToSegments(normalized.words);
    if (resolvedSegments.length === 0 && parsed.fullText?.trim()) {
      resolvedSegments.push({ text: parsed.fullText.trim(), start: 0, end: options.durationSec ?? 0 });
    }
    return {
      words: normalized.words.map((word) => ({ w: word.word, start: word.start, end: word.end })),
      segments: resolvedSegments,
      language: options.language || "th-TH",
      provider: "hero-chunked",
    };
  } finally {
    await deleteGeminiFile(geminiKey, fileName);
  }
}

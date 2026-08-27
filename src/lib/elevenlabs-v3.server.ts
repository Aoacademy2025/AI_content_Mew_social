import "server-only";

import { fetchWithBudget } from "@/lib/fetch-budget";
import { shouldStopProviderFallback } from "@/lib/provider-errors";

export const ELEVENLABS_V3_MODEL_ID = "eleven_v3";
export const ELEVENLABS_V3_MAX_CHARS = 5_000;

export interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export type ElevenLabsV3Result =
  | { ok: true; mp3: Buffer; alignment: ElevenLabsAlignment | null }
  | { ok: false; status: number; errBody: string };

export function clampElevenLabsSpeed(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1.2, Math.max(0.7, parsed));
}

export function elevenLabsV3RequestBody(input: {
  text: string;
  languageCode?: string;
  speed?: number;
}) {
  return {
    text: input.text,
    model_id: ELEVENLABS_V3_MODEL_ID,
    ...(input.languageCode ? { language_code: input.languageCode } : {}),
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.5,
      use_speaker_boost: true,
      speed: clampElevenLabsSpeed(input.speed),
    },
  };
}

/**
 * One paid ElevenLabs v3 synthesis call with the same compatibility ladder as
 * the editor TTS route. HTTP retries stay disabled because a timed-out POST may
 * already have consumed the account's character quota.
 */
export async function synthesizeElevenLabsV3(input: {
  apiKey: string;
  voiceId: string;
  text: string;
  languageCode?: string;
  speed?: number;
  label: string;
}): Promise<ElevenLabsV3Result> {
  const text = input.text.trim();
  if (!text || text.length > ELEVENLABS_V3_MAX_CHARS) {
    throw new Error(`ElevenLabs v3 text must contain 1-${ELEVENLABS_V3_MAX_CHARS} characters`);
  }
  const voiceId = input.voiceId.trim();
  if (!voiceId || voiceId.length > 160) throw new Error("invalid ElevenLabs voice id");

  const variants: { withTimestamps: boolean; lang: boolean }[] = [
    { withTimestamps: true, lang: Boolean(input.languageCode) },
    ...(input.languageCode ? [{ withTimestamps: true, lang: false }] : []),
    { withTimestamps: false, lang: Boolean(input.languageCode) },
    ...(input.languageCode ? [{ withTimestamps: false, lang: false }] : []),
  ];
  let lastStatus = 500;
  let lastErrBody = "";

  for (const variant of variants) {
    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}${variant.withTimestamps ? "/with-timestamps" : ""}`;
    const response = await fetchWithBudget(endpoint, {
      method: "POST",
      headers: { "xi-api-key": input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(elevenLabsV3RequestBody({
        text,
        languageCode: variant.lang ? input.languageCode : undefined,
        speed: input.speed,
      })),
    }, {
      provider: "elevenlabs",
      timeoutMs: 300_000,
      retries: 0,
      wallClockMs: 320_000,
      returnHttpErrors: true,
    });

    if (response.ok) {
      if (variant.withTimestamps) {
        const data = await response.json() as {
          audio_base64: string;
          alignment?: ElevenLabsAlignment | null;
        };
        return {
          ok: true,
          mp3: Buffer.from(data.audio_base64, "base64"),
          alignment: data.alignment ?? null,
        };
      }
      console.warn(`[elevenlabs-v3] ${input.label}: timestamps unavailable; using audio-only response`);
      return { ok: true, mp3: Buffer.from(await response.arrayBuffer()), alignment: null };
    }

    lastStatus = response.status;
    lastErrBody = await response.text();
    console.error(`[elevenlabs-v3] ${input.label} failed: ${response.status} ${lastErrBody.slice(0, 150)}`);
    if (shouldStopProviderFallback(response.status, lastErrBody)) break;
  }

  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

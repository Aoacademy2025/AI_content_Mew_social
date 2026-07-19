export type TtsProvider = "gemini" | "elevenlabs" | "omnivoice";

export interface OmniVoiceInfo {
  voice_id: string;
  desc: string;
  instruct: string;
  preview_url: string;
}

/** Build-time UI kill switch. Server routes have a separate runtime switch. */
export const OMNIVOICE_UI_ENABLED = process.env.NEXT_PUBLIC_OMNIVOICE_ENABLED === "1";

export function parseTtsProvider(value: unknown, fallback: TtsProvider = "gemini"): TtsProvider {
  return value === "gemini" || value === "elevenlabs" || value === "omnivoice" ? value : fallback;
}

export function visibleTtsProvider(value: unknown, fallback: TtsProvider = "gemini"): TtsProvider {
  if (value === "gemini" || value === "elevenlabs") return value;
  if (value === "omnivoice" && OMNIVOICE_UI_ENABLED) return value;
  return fallback;
}

/**
 * Saved account defaults predate OmniVoice and historically treated every unknown
 * value as Gemini. Only an explicit job selection may opt into the canary provider;
 * this preserves flags-off and rollback behavior for old/default-driven jobs.
 */
export function resolveJobTtsProvider(explicit: unknown, savedDefault: unknown): TtsProvider {
  if (explicit === "gemini" || explicit === "elevenlabs" || explicit === "omnivoice") return explicit;
  return savedDefault === "elevenlabs" ? "elevenlabs" : "gemini";
}

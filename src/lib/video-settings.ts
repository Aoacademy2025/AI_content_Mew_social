import { GEMINI_VOICES } from "@/lib/gemini-voices";
import type { TtsProvider } from "@/lib/tts-providers";

const VIDEO_SETTING_ID_MAX_CHARS = 256;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/;
const GEMINI_VOICE_IDS = new Set<string>(GEMINI_VOICES.map((voice) => voice.id));

export type ValidVideoSettingsPatch = {
  heygenAvatarId?: string;
  elevenlabsVoiceId?: string;
  ttsProvider?: TtsProvider;
  geminiVoiceName?: string;
};

export type VideoSettingsPatchValidation =
  | { ok: true; data: ValidVideoSettingsPatch }
  | { ok: false; message: string };

function normalizedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > VIDEO_SETTING_ID_MAX_CHARS || CONTROL_CHARACTER_RE.test(trimmed)) return null;
  return trimmed;
}

/** Validate the user-owned defaults before they can become every new project's seed. */
export function validateVideoSettingsPatch(body: unknown): VideoSettingsPatchValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "ข้อมูลค่าเริ่มต้นไม่ถูกต้อง" };
  }
  const input = body as Record<string, unknown>;
  const data: ValidVideoSettingsPatch = {};
  let recognized = 0;

  if (Object.prototype.hasOwnProperty.call(input, "heygenAvatarId")) {
    recognized += 1;
    const value = normalizedId(input.heygenAvatarId);
    if (value === null) return { ok: false, message: "HeyGen Avatar ID ไม่ถูกต้อง" };
    data.heygenAvatarId = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "elevenlabsVoiceId")) {
    recognized += 1;
    const value = normalizedId(input.elevenlabsVoiceId);
    if (value === null) return { ok: false, message: "ElevenLabs Voice ID ไม่ถูกต้อง" };
    data.elevenlabsVoiceId = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "ttsProvider")) {
    recognized += 1;
    const value = input.ttsProvider;
    if (value !== "gemini" && value !== "elevenlabs" && value !== "omnivoice") {
      return { ok: false, message: "ผู้ให้บริการเสียงไม่ถูกต้อง" };
    }
    data.ttsProvider = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "geminiVoiceName")) {
    recognized += 1;
    const value = normalizedId(input.geminiVoiceName);
    if (value === null || (value !== "" && !GEMINI_VOICE_IDS.has(value))) {
      return { ok: false, message: "เสียง Gemini ไม่ถูกต้อง" };
    }
    data.geminiVoiceName = value;
  }

  if (recognized === 0) return { ok: false, message: "ไม่พบค่าเริ่มต้นที่รองรับ" };
  return { ok: true, data };
}

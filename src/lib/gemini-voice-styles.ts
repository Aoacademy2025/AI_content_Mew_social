// Gemini voice style presets (speaking emotion).
//
// Applied as an inline direction prefix ("Speak cheerfully: ...") — the same
// steerable-prompt pattern Gemini TTS documents. Each render segment is an
// independent API call, so the prefix must travel on EVERY segment call, not
// just the first one. Timing math always uses the ORIGINAL text; the prefix
// never enters subtitle arithmetic.
//
// Gating lives with the callers (tts-gemini route / orchestrator) behind the
// internal beta cohort — this module is pure and dependency-free so policy
// verifiers can import it without server code.

export const GEMINI_VOICE_STYLES = [
  { id: "neutral",  label: "ปกติ",   direction: "" },
  { id: "cheerful", label: "ร่าเริง", direction: "Speak cheerfully with high energy: " },
  { id: "serious",  label: "จริงจัง", direction: "Speak in a serious, authoritative tone: " },
  { id: "warm",     label: "อบอุ่น",  direction: "Speak warmly and gently: " },
  { id: "excited",  label: "ตื่นเต้น", direction: "Speak with excitement and fast pace: " },
] as const;

export type GeminiVoiceStyleId = typeof GEMINI_VOICE_STYLES[number]["id"];

export const GEMINI_VOICE_STYLE_IDS = GEMINI_VOICE_STYLES.map((s) => s.id);

/** Unknown/empty style resolves to neutral (fail-open: today's behavior). */
export function resolveGeminiVoiceStyle(style: unknown): typeof GEMINI_VOICE_STYLES[number] {
  const found = GEMINI_VOICE_STYLES.find((s) => s.id === style);
  return found ?? GEMINI_VOICE_STYLES[0];
}

/** Prefix the direction for the TTS call. Neutral returns text unchanged. */
export function applyVoiceStyle(text: string, style: unknown): string {
  const direction = resolveGeminiVoiceStyle(style).direction;
  return direction ? `${direction}${text}` : text;
}

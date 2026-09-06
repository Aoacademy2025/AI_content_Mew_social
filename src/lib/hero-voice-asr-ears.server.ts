/**
 * Machine ears for the Hero Voice ASR content gate.
 *
 * Two independent listeners transcribe one generated part so the gate
 * (`hero-voice-asr-gate.ts`) can check that every intended word was read:
 *  - `gemini-3.5-transcribe`: the dedicated speech-to-text model, audio only,
 *    polished text. Good at noticing dropped words.
 *  - `gemini-3.8-flash` with a blind verbatim prompt: writes what it hears in
 *    Thai script, foreign words included, so ASR spelling variance does not
 *    fail a correct reading. It is never shown the intended script, because a
 *    model that sees the script copies it and hears nothing (calibrated
 *    2026-09-06, spec §11.5).
 *
 * Only the generated audio is sent. The reference recording, its transcript
 * and the user identity never leave the server through this path.
 */

export const HERO_VOICE_ASR_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const HERO_VOICE_ASR_VERBATIM_MODEL = "gemini-3.8-flash";
export const HERO_VOICE_ASR_EAR_TIMEOUT_MS = 20_000;

const VERBATIM_PROMPT = `ฟังไฟล์เสียงนี้แล้วถอดเสียงตามที่ได้ยินจริงทุกพยางค์ (verbatim) เป็นภาษาไทย
- คำอังกฤษหรือคำที่ฟังเหมือนภาษาต่างประเทศ ให้เขียนเป็นอักษรไทยตามเสียงที่ได้ยิน ห้ามเดาเป็นคำสะกดอังกฤษ
- ถ้าช่วงไหนฟังไม่ชัด ให้เขียนเท่าที่ได้ยิน ห้ามเว้นว่าง
- ห้ามแก้คำให้ถูกไวยากรณ์ ห้ามเติมคำที่ไม่ได้ยิน ห้ามสรุป ห้ามอธิบาย
ตอบเป็นข้อความถอดเสียงล้วน ๆ บรรทัดเดียว ไม่มีหัวข้อ ไม่มี JSON`;

export type HeroVoiceEarName = "transcribe" | "verbatim";

export type HeroVoiceEarsResult = {
  /** Transcripts from the ears that answered, in ear order. */
  transcripts: string[];
  /** Number of ears that produced a transcript. */
  ears: number;
  /** Non-sensitive failure labels (`transcribe:503`, `verbatim:timeout`). */
  failures: string[];
};

export function heroVoiceAsrGateEnabled(): boolean {
  return process.env.HERO_VOICE_ASR_GATE === "1";
}

type GeminiPart = { text?: string; audioTranscription?: { text?: string } };
type GeminiResponse = { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };

async function askEar(input: {
  ear: HeroVoiceEarName;
  model: string;
  apiKey: string;
  wavBase64: string;
  prompt?: string;
  timeoutMs: number;
}): Promise<{ transcript: string } | { failure: string }> {
  const parts: Array<Record<string, unknown>> = [];
  if (input.prompt) parts.push({ text: input.prompt });
  parts.push({ inline_data: { mime_type: "audio/wav", data: input.wavBase64 } });
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
        signal: AbortSignal.timeout(input.timeoutMs),
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          ...(input.prompt ? { generationConfig: { temperature: 0 } } : {}),
        }),
      },
    );
    if (!response.ok) return { failure: `${input.ear}:${response.status}` };
    const data = await response.json() as GeminiResponse;
    const transcript = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.audioTranscription?.text ?? part.text ?? "")
      .join(" ")
      .trim();
    if (!transcript) return { failure: `${input.ear}:empty` };
    return { transcript };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { failure: `${input.ear}:${timedOut ? "timeout" : "transport"}` };
  }
}

/**
 * Listen to one generated part with both ears in parallel. Never throws: an
 * unreachable ear is reported in `failures` so the caller can decide whether
 * an outage should block the clip (it does not; see the gate wiring).
 */
export async function listenToHeroVoicePart(
  audioWav: Buffer,
  options: { apiKey?: string; timeoutMs?: number } = {},
): Promise<HeroVoiceEarsResult> {
  const apiKey = options.apiKey ?? process.env.GEMINI_SERVER_KEY ?? "";
  if (!apiKey) return { transcripts: [], ears: 0, failures: ["transcribe:no_key", "verbatim:no_key"] };
  const timeoutMs = options.timeoutMs ?? HERO_VOICE_ASR_EAR_TIMEOUT_MS;
  const wavBase64 = audioWav.toString("base64");
  const answers = await Promise.all([
    askEar({ ear: "transcribe", model: HERO_VOICE_ASR_TRANSCRIBE_MODEL, apiKey, wavBase64, timeoutMs }),
    askEar({ ear: "verbatim", model: HERO_VOICE_ASR_VERBATIM_MODEL, apiKey, wavBase64, prompt: VERBATIM_PROMPT, timeoutMs }),
  ]);
  const transcripts: string[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if ("transcript" in answer) transcripts.push(answer.transcript);
    else failures.push(answer.failure);
  }
  return { transcripts, ears: transcripts.length, failures };
}

// JaiTTS (JaiTTS-F5TTS) — second voice-cloning engine ("Hero Cloning"),
// a separate server from OmniVoice (multipart API, X-API-Key auth).
// Research prototype on CPU: ~120-180s PER SHORT SENTENCE — admin/experimental
// use only; scripts are capped short and requests run synchronously.

export class JaiTtsConfigError extends Error {}

export type JaiTtsConfig = {
  baseUrl: string;
  apiKey: string;
  maxScriptChars: number;
  requestBudgetMs: number;
};

export function isJaiTtsEnabled(): boolean {
  return process.env.JAITTS_ENABLED === "1" && Boolean((process.env.JAITTS_URL ?? "").trim());
}

export function jaittsConfig(): JaiTtsConfig {
  if (process.env.JAITTS_ENABLED !== "1") throw new JaiTtsConfigError("JaiTTS is disabled");
  const baseUrl = (process.env.JAITTS_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new JaiTtsConfigError("JAITTS_URL is missing");
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    throw new JaiTtsConfigError("JaiTTS must use HTTPS in production");
  }
  const maxScriptChars = Math.max(50, Math.min(2_000, Number(process.env.JAITTS_MAX_SCRIPT_CHARS) || 500));
  const requestBudgetMs = Math.max(60_000, Math.min(840_000, Number(process.env.JAITTS_REQUEST_BUDGET_MS) || 600_000));
  return { baseUrl, apiKey: (process.env.JAITTS_API_KEY ?? "").trim(), maxScriptChars, requestBudgetMs };
}

export type JaiTtsResult =
  | { ok: true; wav: Buffer; sampleRate: number; durationMs: number; generationTimeMs: number }
  | { ok: false; status: number; reason: string };

export async function callJaiTtsClone(
  config: JaiTtsConfig,
  input: { refWav: Buffer; refText: string; text: string; speed: number },
): Promise<JaiTtsResult> {
  const form = new FormData();
  form.set("ref_audio", new Blob([new Uint8Array(input.refWav)], { type: "audio/wav" }), "ref.wav");
  form.set("ref_text", input.refText);
  form.set("text", input.text);
  form.set("speed", String(Math.min(3, Math.max(0.3, input.speed))));
  try {
    const response = await fetch(`${config.baseUrl}/jaitts/clone`, {
      method: "POST",
      headers: config.apiKey ? { "X-API-Key": config.apiKey } : {},
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(config.requestBudgetMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      return { ok: false, status: response.status, reason: detail || `JaiTTS failed (${response.status})` };
    }
    const data = await response.json() as {
      audio_base64?: string;
      sample_rate?: number;
      duration?: number;
      generation_time?: number;
    };
    if (!data.audio_base64 || typeof data.sample_rate !== "number") {
      return { ok: false, status: 502, reason: "invalid audio payload" };
    }
    return {
      ok: true,
      wav: Buffer.from(data.audio_base64, "base64"),
      sampleRate: data.sample_rate,
      durationMs: Math.round((data.duration ?? 0) * 1000),
      generationTimeMs: Math.round((data.generation_time ?? 0) * 1000),
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      status: timedOut ? 504 : 503,
      reason: error instanceof Error ? error.message : "request failed",
    };
  }
}

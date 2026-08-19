import { Agent, fetch as undiciFetch } from "undici";
import { parseRetryDelayMs } from "@/lib/gemini-errors";

// Long scripts (5-6 min) produce large base64 audio responses. Keep the long
// timeout scoped to Gemini TTS rather than changing the process-wide fetch
// dispatcher.
const geminiTtsDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

const MODEL_CHAIN = [
  "gemini-2.5-flash-preview-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-preview-tts",
];
const MAX_ATTEMPTS = 3;

export const GEMINI_TTS_NO_AUDIO = "__NO_AUDIO__";

export type GeminiTtsCallResult =
  | { ok: true; pcm: Buffer; sampleRate: number; model: string }
  | { ok: false; status: number; errBody: string };

type GeminiTtsDependencies = {
  fetch?: typeof undiciFetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

// modelLock pins all segments of a clip to the model that served segment 0;
// mixing models mid-clip would change the voice at a chunk seam.
export async function callGeminiTts(
  apiKey: string,
  text: string,
  voiceName: string,
  modelLock?: string,
  deadline?: number,
  dependencies: GeminiTtsDependencies = {},
): Promise<GeminiTtsCallResult> {
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const fetch = dependencies.fetch ?? undiciFetch;
  const sleep = dependencies.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const models = modelLock ? [modelLock] : MODEL_CHAIN;
  let lastErrBody = "";
  let lastStatus = 500;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (deadline && now() >= deadline) {
        return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: requestBody,
        dispatcher: geminiTtsDispatcher,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
        };
        const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const audioB64: string | undefined = part?.data;
        if (!audioB64) {
          // Gemini can occasionally acknowledge a TTS request with HTTP 200 but
          // omit the audio part. Treat that as the same bounded transient class
          // as a provider 5xx instead of failing the customer on the first empty
          // preview response.
          lastErrBody = GEMINI_TTS_NO_AUDIO;
          lastStatus = 503;
          if (attempt < MAX_ATTEMPTS) {
            const delayMs = 1500 * Math.pow(2, attempt - 1) + Math.floor(random() * 500);
            if (deadline && now() + delayMs >= deadline) {
              return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
            }
            console.warn(`[tts-gemini] ${model} returned no audio (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delayMs}ms`);
            await sleep(delayMs);
          } else {
            console.warn(`[tts-gemini] ${model} returned no audio after ${MAX_ATTEMPTS} attempts — trying next model`);
          }
          continue;
        }
        const mimeType: string = part?.mimeType ?? "audio/L16;rate=24000";
        const rateMatch = mimeType.match(/rate=(\d+)/);
        console.log(`[tts-gemini] ok with ${model} (attempt ${attempt})`);
        return {
          ok: true,
          pcm: Buffer.from(audioB64, "base64"),
          sampleRate: rateMatch ? parseInt(rateMatch[1]) : 24000,
          model,
        };
      }

      lastErrBody = await res.text();
      lastStatus = res.status;

      if (res.status === 401 || res.status === 403 || res.status === 404) {
        console.warn(`[tts-gemini] ${model} returned ${res.status} — trying next model`);
        break;
      }

      if (res.status === 400) {
        console.error(`[tts-gemini] bad request (400) for ${model}:`, lastErrBody.slice(0, 200));
        return { ok: false, status: 400, errBody: lastErrBody };
      }

      if (attempt < MAX_ATTEMPTS) {
        const hinted = res.status === 429 ? parseRetryDelayMs(lastErrBody) : null;
        const delayMs = hinted ?? 1500 * Math.pow(2, attempt - 1) + Math.floor(random() * 500);
        if (deadline && now() + delayMs >= deadline) {
          return { ok: false, status: 408, errBody: "segmented time budget exhausted" };
        }
        console.warn(`[tts-gemini] ${model} transient ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delayMs}ms${hinted ? " (server hint)" : ""}`);
        await sleep(delayMs);
      } else {
        console.warn(`[tts-gemini] ${model} exhausted retries — trying next model`);
      }
    }
  }

  return { ok: false, status: lastStatus, errBody: lastErrBody };
}

export function geminiNoAudioFailure(managed: boolean): {
  body: { error: string; retryable?: boolean; provider?: string; reason?: string };
  status: number;
} {
  return {
    body: {
      error: managed
        ? "ระบบ TTS ขัดข้องชั่วคราว — ผู้ให้บริการไม่ส่งข้อมูลเสียงกลับมา กรุณาลองใหม่อีกครั้ง"
        : "Gemini ไม่ส่งข้อมูลเสียงกลับมา — กรุณาลองใหม่อีกครั้ง",
      retryable: true,
      provider: "gemini",
      reason: "no_audio",
    },
    status: 503,
  };
}

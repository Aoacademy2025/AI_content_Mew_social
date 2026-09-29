import { Agent, fetch as undiciFetch } from "undici";
import { parseRetryDelayMs } from "@/lib/gemini-errors";

// Long scripts (5-6 min) produce large base64 audio responses. Keep the long
// timeout scoped to Gemini TTS rather than changing the process-wide fetch
// dispatcher.
const geminiTtsDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

export const GEMINI_TTS_38_MODEL = "gemini-3.8-flash-tts";

const MODEL_CHAIN = [
  "gemini-2.5-flash-preview-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-preview-tts",
];
// NOTE (price): 3.8-flash-tts audio is $9/1M tokens through 2026-12-31, then
// $18/1M from 2027-01-01 — above 2.5-flash ($10/1M). Revisit chain order
// before the promo ends. Callers select 3.8 via `preferFirst`, never by
// editing this chain, so the default stays byte-identical for everyone else.
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

// Normalize the provider boundary once: every caller receives mono s16le samples.
// RIFF lengths/chunks are untrusted; metadata (including C2PA) is never audio.
// Latin-1 preserves every identifier byte; ASCII would alias high-bit bytes.
function decodeGeminiAudio(bytes: Buffer, mimeType: string): { pcm: Buffer; sampleRate: number } {
  const invalid = () => new Error("Invalid or unsupported Gemini TTS audio");
  const signature = bytes.toString("latin1", 0, 4);
  const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (signature === "RIFF" || ["audio/wav", "audio/wave", "audio/x-wav"].includes(mediaType)) {
    if (bytes.length < 12 || signature !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") throw invalid();
    const end = bytes.readUInt32LE(4) + 8;
    if (end !== bytes.length) throw invalid();
    let sampleRate: number | undefined;
    let pcm: Buffer | undefined;
    for (let offset = 12; offset < end;) {
      if (end - offset < 8) throw invalid();
      const id = bytes.toString("latin1", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      const next = start + size + (size % 2); // RIFF chunks are word-aligned.
      if (next > end) throw invalid();
      if (id === "fmt ") {
        if (sampleRate !== undefined || size < 16) throw invalid();
        sampleRate = bytes.readUInt32LE(start + 4);
        // Only the format our downstream PCM pipeline supports. Reject compressed,
        // float, extensible, stereo and other sample widths rather than guessing.
        if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
          || bytes.readUInt16LE(start + 14) !== 16 || bytes.readUInt16LE(start + 12) !== 2
          || sampleRate < 1 || sampleRate > 384000
          || bytes.readUInt32LE(start + 8) !== sampleRate * 2) throw invalid();
        if (size !== 16 && (size < 18 || bytes.readUInt16LE(start + 16) !== size - 18)) throw invalid();
      } else if (id === "data") {
        if (pcm !== undefined || size === 0 || size % 2 !== 0) throw invalid();
        pcm = bytes.subarray(start, start + size);
      }
      offset = next;
    }
    if (sampleRate === undefined || pcm === undefined) throw invalid();
    return { pcm, sampleRate };
  }
  // Gemini's legacy L16 response uses little-endian PCM; preserve those bytes.
  if (mediaType !== "audio/l16" || signature === "RIFX" || signature === "RF64"
    || bytes.length === 0 || bytes.length % 2 !== 0) throw invalid();
  const params = new Map(mimeType.split(";").slice(1).map(param => {
    const [name, value] = param.trim().split("=");
    return [name.toLowerCase(), value?.trim()];
  }));
  const rate = params.get("rate") ?? "24000";
  const sampleRate = Number(rate);
  if (!/^\d+$/.test(rate) || !Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 384000
    || (params.has("channels") && params.get("channels") !== "1")
    || (params.has("codec") && params.get("codec")?.toLowerCase() !== "pcm")) throw invalid();
  return { pcm: bytes, sampleRate };
}

// modelLock pins all segments of a clip to the model that served segment 0;
// mixing models mid-clip would change the voice at a chunk seam.
export async function callGeminiTts(
  apiKey: string,
  text: string,
  voiceName: string,
  modelLock?: string,
  deadline?: number,
  dependencies: GeminiTtsDependencies = {},
  preferFirst?: string,
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
  // Beta rollout (e.g. 3.8): try the preferred model first, then the standard
  // chain without duplicating it. modelLock still pins the whole clip when set.
  const baseChain = preferFirst
    ? [preferFirst, ...MODEL_CHAIN.filter((m) => m !== preferFirst)]
    : MODEL_CHAIN;
  const models = modelLock ? [modelLock] : baseChain;
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
        let audio: { pcm: Buffer; sampleRate: number };
        try {
          audio = decodeGeminiAudio(Buffer.from(audioB64, "base64"), mimeType);
        } catch {
          // A malformed successful response is not a reason to spend on retries.
          // Keep the existing route's failure/refund/fail-open handling in control.
          return { ok: false, status: 502, errBody: "Invalid or unsupported Gemini TTS audio" };
        }
        console.log(`[tts-gemini] ok with ${model} (attempt ${attempt})`);
        return { ok: true, ...audio, model };
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

import "server-only";

import { isOmniVoiceServerEnabled } from "@/lib/omnivoice-policy";

export type { OmniVoiceInfo } from "@/lib/tts-providers";
export {
  isOmniVoiceInfo,
  isValidOmniVoiceId,
  pcmFromWav,
} from "@/lib/omnivoice-core";
export {
  isOmniVoiceServerEnabled,
  isOmniVoiceUserAllowed,
} from "@/lib/omnivoice-policy";

export interface OmniTtsResponse {
  voice_id: string;
  text: string;
  audio_base64: string;
  format: string;
  sample_rate: number;
  duration: number;
  generation_time: number;
}

export class OmniVoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmniVoiceConfigError";
  }
}

export function omnivoiceConfig(): {
  baseUrl: string;
  apiKey: string;
  numStep: number;
  maxScriptChars: number;
  requestBudgetMs: number;
} {
  if (!isOmniVoiceServerEnabled()) {
    throw new OmniVoiceConfigError("OmniVoice is disabled");
  }
  const baseUrl = (process.env.OMNIVOICE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.OMNIVOICE_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) {
    throw new OmniVoiceConfigError("OmniVoice URL or API key is missing");
  }
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    throw new OmniVoiceConfigError("OmniVoice must use HTTPS in production");
  }
  return {
    baseUrl,
    apiKey,
    // KVM2 benchmark: step=4 is ~3.8x realtime; higher defaults miss the 300s route budget.
    numStep: clampInteger(process.env.OMNIVOICE_NUM_STEP, 4, 8, 4),
    maxScriptChars: clampInteger(process.env.OMNIVOICE_MAX_SCRIPT_CHARS, 50, 1000, 500),
    // Leave at least 50s inside the 300s route for decode, disk/quota work and
    // silence detection (which has its own 30s cap).
    requestBudgetMs: clampInteger(process.env.OMNIVOICE_REQUEST_BUDGET_MS, 30_000, 250_000, 240_000),
  };
}

export function omnivoiceAuthHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey };
}

export async function checkOmniVoiceReady(
  config: ReturnType<typeof omnivoiceConfig>,
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    const response = await fetch(`${config.baseUrl}/ready`, {
      headers: omnivoiceAuthHeaders(config.apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

import { isOmniVoiceServerEnabled } from "@/lib/omnivoice-policy";
import { isValidOmniVoiceId } from "@/lib/omnivoice-core";

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

export type OmniVoiceBackend = "hostinger" | "runpod";

export interface OmniTtsResponse {
  contract_version?: number;
  mode?: "tts" | "clone";
  voice_id: string;
  text?: string;
  audio_base64: string;
  format: string;
  sample_rate: number;
  duration: number;
  generation_time: number;
  worker_version?: string;
  catalog_version?: string;
  language?: string;
  num_step?: number;
  similarity_score?: number;
}

type OmniVoiceCommonConfig = {
  backend: OmniVoiceBackend;
  numStep: number;
  maxChunkChars: number;
  requestBudgetMs: number;
  queueWaitBudgetMs: number;
};

export type OmniVoiceConfig = OmniVoiceCommonConfig & (
  | { backend: "hostinger"; baseUrl: string; apiKey: string }
  | { backend: "runpod"; endpointId: string; apiKey: string }
);

export type OmniVoiceCallResult =
  | {
      ok: true;
      response: OmniTtsResponse;
      providerJobId?: string;
      delayTimeMs: number;
      executionTimeMs: number;
    }
  | {
      ok: false;
      status: number;
      reason: string;
      retryAfter?: string;
      providerJobId?: string;
      cancelled?: boolean;
      code?: "RUNPOD_QUEUE_TIMEOUT";
    };

type RunpodTtsJob = {
  id?: string;
  status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  output?: Partial<OmniTtsResponse> & { error?: string };
  error?: string;
  delayTime?: number;
  executionTime?: number;
};

export type RunpodOmniVoiceSnapshot =
  | {
      status: "IN_QUEUE" | "IN_PROGRESS";
      providerJobId: string;
      delayTimeMs: number;
      executionTimeMs: number;
    }
  | {
      status: "COMPLETED";
      providerJobId: string;
      response: OmniTtsResponse;
      delayTimeMs: number;
      executionTimeMs: number;
    }
  | {
      status: "FAILED" | "TIMED_OUT" | "CANCELLED";
      providerJobId: string;
      reason: string;
      delayTimeMs: number;
      executionTimeMs: number;
    };

const RUNPOD_QUEUE_API = "https://api.runpod.ai/v2";
const RUNPOD_REST_API = "https://rest.runpod.io/v1";
const OMNIVOICE_QUALITY_NUM_STEP = 32;
const HERO_VOICE_RUNPOD_CONTRACT_VERSION = 2;

export class OmniVoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmniVoiceConfigError";
  }
}

export class OmniVoiceProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "OmniVoiceProviderError";
  }
}

function parseBackend(value: string | undefined): OmniVoiceBackend {
  return value?.trim().toLowerCase() === "runpod" ? "runpod" : "hostinger";
}

/** Resolve one immutable backend configuration. A VideoJob records this backend
 * when it is accepted, so a later rollout switch cannot move that job between
 * providers halfway through its pipeline. */
export function omnivoiceConfig(pinnedBackend?: OmniVoiceBackend): OmniVoiceConfig {
  if (!isOmniVoiceServerEnabled()) {
    throw new OmniVoiceConfigError("OmniVoice is disabled");
  }
  const backend = pinnedBackend ?? parseBackend(process.env.OMNIVOICE_BACKEND);
  const common = {
    // Keep every production voice on the upstream quality default. This is
    // intentionally not environment-configurable: the old 8-step override
    // produced unstable pronunciation in real customer scripts.
    numStep: OMNIVOICE_QUALITY_NUM_STEP,
    // Upstream chunk size, not the subscription output ceiling. The RunPod
    // worker enforces an 800-character hard maximum.
    maxChunkChars: clampInteger(
      process.env.OMNIVOICE_MAX_CHUNK_CHARS ?? process.env.OMNIVOICE_MAX_SCRIPT_CHARS,
      100,
      800,
      backend === "runpod" ? 700 : 450,
    ),
    requestBudgetMs: clampInteger(
      process.env.OMNIVOICE_REQUEST_BUDGET_MS,
      30_000,
      840_000,
      540_000,
    ),
    // Cost/latency guard for the legacy synchronous route. Durable Hero Voice
    // jobs use requestBudgetMs and park between polls, so they are not canceled
    // merely because a scale-to-zero worker takes more than two minutes.
    queueWaitBudgetMs: clampInteger(
      process.env.OMNIVOICE_QUEUE_WAIT_BUDGET_MS,
      30_000,
      300_000,
      300_000,
    ),
  };

  if (backend === "runpod") {
    const endpointId = (process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID ?? "").trim();
    const apiKey = (process.env.RUNPOD_API_KEY ?? "").trim();
    if (!endpointId || !apiKey) {
      throw new OmniVoiceConfigError("RunPod OmniVoice endpoint or API key is missing");
    }
    return { backend, endpointId, apiKey, ...common };
  }

  const baseUrl = (process.env.OMNIVOICE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.OMNIVOICE_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) {
    throw new OmniVoiceConfigError("OmniVoice URL or API key is missing");
  }
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    throw new OmniVoiceConfigError("OmniVoice must use HTTPS in production");
  }
  return { backend, baseUrl, apiKey, ...common };
}

export function omnivoiceAuthHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey };
}

function runpodHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

export async function checkOmniVoiceReady(
  config: OmniVoiceConfig,
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    if (config.backend === "runpod") {
      // Read-only control-plane check: it verifies endpoint + credential without
      // cold-starting a paid worker or injecting a synthetic queue item.
      const response = await fetch(`${RUNPOD_REST_API}/endpoints/${encodeURIComponent(config.endpointId)}`, {
        headers: runpodHeaders(config.apiKey),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    }
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

function validTtsPayload(value: unknown): value is OmniTtsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Partial<OmniTtsResponse>;
  return typeof output.voice_id === "string"
    && typeof output.audio_base64 === "string"
    && output.audio_base64.length > 0
    && output.audio_base64.length <= 30_000_000
    && typeof output.sample_rate === "number"
    && Number.isFinite(output.sample_rate)
    && output.sample_rate >= 8_000
    && output.sample_rate <= 96_000;
}

function validRunpodTtsPayload(value: unknown): value is OmniTtsResponse {
  if (!validTtsPayload(value)) return false;
  return value.contract_version === HERO_VOICE_RUNPOD_CONTRACT_VERSION
    && value.mode === "tts"
    && isValidOmniVoiceId(value.voice_id)
    && value.format === "wav"
    && typeof value.duration === "number"
    && Number.isFinite(value.duration)
    && value.duration > 0
    && typeof value.generation_time === "number"
    && Number.isFinite(value.generation_time)
    && value.generation_time >= 0
    && typeof value.worker_version === "string"
    && value.worker_version.trim().length > 0
    && typeof value.catalog_version === "string"
    && value.catalog_version.trim().length > 0;
}

async function parseRunpodResponse(response: Response): Promise<RunpodTtsJob> {
  const text = await response.text();
  try {
    return JSON.parse(text) as RunpodTtsJob;
  } catch {
    throw new Error(`RunPod returned non-JSON status ${response.status}`);
  }
}

async function runpodRequest(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  operation: string,
  init: RequestInit,
  deadline: number,
): Promise<{ response: Response; body: RunpodTtsJob }> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1_000) throw new DOMException("request budget exhausted", "TimeoutError");
  const response = await fetch(
    `${RUNPOD_QUEUE_API}/${encodeURIComponent(config.endpointId)}/${operation}`,
    {
      ...init,
      headers: { ...runpodHeaders(config.apiKey), ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(Math.min(20_000, remainingMs)),
    },
  );
  const body = await parseRunpodResponse(response);
  return { response, body };
}

function runpodTtsInput(config: Extract<OmniVoiceConfig, { backend: "runpod" }>, voiceId: string, text: string, speed: number) {
  return {
    contract_version: HERO_VOICE_RUNPOD_CONTRACT_VERSION,
    mode: "tts" as const,
    voice_id: voiceId,
    text,
    speed,
    num_step: config.numStep,
    mixed_language: true,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cancelRunpodOmniVoiceJob(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  providerJobId: string,
): Promise<boolean> {
  try {
    // Cancellation must have its own short budget. Reusing the synthesis
    // deadline could leave a paid job orphaned precisely when that deadline
    // has expired.
    const response = await fetch(
      `${RUNPOD_QUEUE_API}/${encodeURIComponent(config.endpointId)}/cancel/${encodeURIComponent(providerJobId)}`,
      {
        method: "POST",
        headers: runpodHeaders(config.apiKey),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await parseRunpodResponse(response);
    return response.ok && body.status === "CANCELLED";
  } catch (error) {
    console.warn(
      `[omnivoice] RunPod cancel failed for ${providerJobId}:`,
      error instanceof Error ? error.message : "request failed",
    );
    return false;
  }
}

/**
 * Submit exactly one RunPod synthesis job. This operation is intentionally
 * single-attempt: a lost response has an unknown provider outcome and must not
 * be replayed automatically.
 */
export async function submitRunpodOmniVoiceJob(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  voiceId: string,
  text: string,
  speed: number,
): Promise<{ providerJobId: string; status: "IN_QUEUE" | "IN_PROGRESS" }> {
  const submitted = await runpodRequest(config, "run", {
    method: "POST",
    body: JSON.stringify({
      input: runpodTtsInput(config, voiceId, text, speed),
    }),
  }, Date.now() + 20_000);
  if (!submitted.response.ok || !submitted.body.id) {
    throw new OmniVoiceProviderError(
      submitted.body.error || `RunPod submit failed (${submitted.response.status})`,
      submitted.response.status === 429 ? 429 : 503,
      submitted.response.headers.get("retry-after") ?? undefined,
    );
  }
  return {
    providerJobId: submitted.body.id,
    status: submitted.body.status === "IN_PROGRESS" ? "IN_PROGRESS" : "IN_QUEUE",
  };
}

/** Poll one durable RunPod synthesis job without occupying a worker slot. */
export async function pollRunpodOmniVoiceJob(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  providerJobId: string,
): Promise<RunpodOmniVoiceSnapshot> {
  const polled = await runpodRequest(
    config,
    `status/${encodeURIComponent(providerJobId)}`,
    { method: "GET" },
    Date.now() + 20_000,
  );
  if (!polled.response.ok) {
    throw new OmniVoiceProviderError(
      polled.body.error || `RunPod status failed (${polled.response.status})`,
      polled.response.status,
      polled.response.headers.get("retry-after") ?? undefined,
    );
  }

  const delayTimeMs = typeof polled.body.delayTime === "number" ? Math.round(polled.body.delayTime) : 0;
  const executionTimeMs = typeof polled.body.executionTime === "number" ? Math.round(polled.body.executionTime) : 0;
  if (polled.body.status === "COMPLETED") {
    if (!validRunpodTtsPayload(polled.body.output)) {
      throw new OmniVoiceProviderError("RunPod completed with an invalid audio payload", 502);
    }
    return {
      status: "COMPLETED",
      providerJobId,
      response: polled.body.output,
      delayTimeMs,
      executionTimeMs,
    };
  }
  if (polled.body.status === "FAILED"
    || polled.body.status === "TIMED_OUT"
    || polled.body.status === "CANCELLED") {
    return {
      status: polled.body.status,
      providerJobId,
      reason: polled.body.error || polled.body.output?.error || `RunPod job ${polled.body.status.toLowerCase()}`,
      delayTimeMs,
      executionTimeMs,
    };
  }
  return {
    status: polled.body.status === "IN_PROGRESS" ? "IN_PROGRESS" : "IN_QUEUE",
    providerJobId,
    delayTimeMs,
    executionTimeMs,
  };
}

async function cancelRunpodFailure(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  providerJobId: string,
  status: number,
  reason: string,
  code?: "RUNPOD_QUEUE_TIMEOUT",
): Promise<Extract<OmniVoiceCallResult, { ok: false }>> {
  const cancelled = await cancelRunpodOmniVoiceJob(config, providerJobId);
  return { ok: false, status, reason, providerJobId, cancelled, ...(code ? { code } : {}) };
}

async function callRunpodOmniVoice(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  voiceId: string,
  text: string,
  speed: number,
  deadline: number,
): Promise<OmniVoiceCallResult> {
  let submitted: { response: Response; body: RunpodTtsJob };
  try {
    // Never automatically retry this POST: a lost response could otherwise
    // submit duplicate paid GPU work.
    submitted = await runpodRequest(config, "run", {
      method: "POST",
      body: JSON.stringify({
        input: runpodTtsInput(config, voiceId, text, speed),
      }),
    }, deadline);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, status: timedOut ? 504 : 503, reason: error instanceof Error ? error.message : "request failed" };
  }
  if (!submitted.response.ok || !submitted.body.id) {
    return {
      ok: false,
      status: submitted.response.status === 429 ? 429 : 503,
      reason: submitted.body.error || `RunPod submit failed (${submitted.response.status})`,
      retryAfter: submitted.response.headers.get("retry-after") ?? undefined,
    };
  }

  const providerJobId = submitted.body.id;
  const queueWaitDeadline = Math.min(deadline, Date.now() + config.queueWaitBudgetMs);
  let transientPollFailures = 0;
  while (Date.now() < deadline - 1_000) {
    await wait(1_250);
    try {
      const polled = await runpodRequest(
        config,
        `status/${encodeURIComponent(providerJobId)}`,
        { method: "GET" },
        deadline,
      );
      if (!polled.response.ok) {
        transientPollFailures += 1;
        if (transientPollFailures < 4 && polled.response.status >= 500) continue;
        return cancelRunpodFailure(
          config,
          providerJobId,
          503,
          polled.body.error || `RunPod status failed (${polled.response.status})`,
        );
      }
      transientPollFailures = 0;
      const snapshot = polled.body;
      if (snapshot.status === "COMPLETED") {
        if (!validRunpodTtsPayload(snapshot.output)) {
          return { ok: false, status: 502, reason: "invalid audio payload" };
        }
        return {
          ok: true,
          response: snapshot.output,
          providerJobId,
          delayTimeMs: typeof snapshot.delayTime === "number" ? Math.round(snapshot.delayTime) : 0,
          executionTimeMs: typeof snapshot.executionTime === "number" ? Math.round(snapshot.executionTime) : 0,
        };
      }
      if (snapshot.status === "IN_QUEUE" && Date.now() >= queueWaitDeadline) {
        return cancelRunpodFailure(
          config,
          providerJobId,
          504,
          "RunPod queue wait budget exhausted",
          "RUNPOD_QUEUE_TIMEOUT",
        );
      }
      if (snapshot.status === "FAILED" || snapshot.status === "TIMED_OUT" || snapshot.status === "CANCELLED") {
        const reason = snapshot.error || snapshot.output?.error || `RunPod job ${snapshot.status.toLowerCase()}`;
        const status = /VOICE_NOT_SERVED/i.test(reason) ? 404 : /INPUT_|VALIDATION|TEXT_/i.test(reason) ? 422 : 503;
        return { ok: false, status, reason };
      }
    } catch (error) {
      transientPollFailures += 1;
      if (transientPollFailures >= 4) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return cancelRunpodFailure(
          config,
          providerJobId,
          timedOut ? 504 : 503,
          error instanceof Error ? error.message : "status request failed",
        );
      }
    }
  }
  return cancelRunpodFailure(config, providerJobId, 504, "request budget exhausted");
}

async function callHostingerOmniVoice(
  config: Extract<OmniVoiceConfig, { backend: "hostinger" }>,
  voiceId: string,
  text: string,
  speed: number,
  deadline: number,
): Promise<OmniVoiceCallResult> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1_000) return { ok: false, status: 504, reason: "request budget exhausted" };
  try {
    const response = await fetch(`${config.baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...omnivoiceAuthHeaders(config.apiKey) },
      body: JSON.stringify({ voice_id: voiceId, text, speed, num_step: config.numStep }),
      cache: "no-store",
      signal: AbortSignal.timeout(remainingMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: (await response.text().catch(() => "")).slice(0, 200),
        retryAfter: response.headers.get("retry-after") ?? undefined,
      };
    }
    const data = await response.json() as unknown;
    if (!validTtsPayload(data)) return { ok: false, status: 502, reason: "invalid audio payload" };
    return {
      ok: true,
      response: data,
      delayTimeMs: 0,
      executionTimeMs: Math.round((data.generation_time || 0) * 1_000),
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, status: timedOut ? 504 : 503, reason: error instanceof Error ? error.message : "request failed" };
  }
}

export function callOmniVoice(
  config: OmniVoiceConfig,
  voiceId: string,
  text: string,
  speed: number,
  deadline: number,
): Promise<OmniVoiceCallResult> {
  return config.backend === "runpod"
    ? callRunpodOmniVoice(config, voiceId, text, speed, deadline)
    : callHostingerOmniVoice(config, voiceId, text, speed, deadline);
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

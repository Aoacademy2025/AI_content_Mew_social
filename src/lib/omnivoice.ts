import { randomUUID } from "crypto";
import { isOmniVoiceServerEnabled } from "@/lib/omnivoice-policy";
import { isValidOmniVoiceId } from "@/lib/omnivoice-core";

export type { OmniVoiceInfo } from "@/lib/tts-providers";
export {
  isOmniVoiceInfo,
  isValidOmniVoiceId,
  normalizeNumbersForTts,
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
/** placeholder voice_id สำหรับผลลัพธ์โหมด clone (worker ไม่คืน voice_id มา) */
const CLONED_VOICE_OUTPUT_ID = "__cloned__";

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

/** Current rollout backend name, without requiring a full (throwing) config. */
export function omnivoiceBackendName(): OmniVoiceBackend {
  return parseBackend(process.env.OMNIVOICE_BACKEND);
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
    if (response.ok) return true;
    // Newer/local FastAPI servers expose /health (no /ready). Accept a healthy
    // status there too so the editor doesn't lock Hero Voice behind a 404.
    const health = await fetch(`${config.baseUrl}/health`, {
      headers: omnivoiceAuthHeaders(config.apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!health.ok) return false;
    const body = await health.json().catch(() => null) as { status?: string } | null;
    return body?.status === "ok";
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

/** โหมด clone ของ worker ไม่คืน voice_id (มันไม่รู้จัก id ฝั่งเรา) — เติมให้ก่อน
 *  validate เพื่อให้ผ่าน validTtsPayload ที่บังคับ voice_id เป็น string */
function normalizeRunpodOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const output = value as Partial<OmniTtsResponse>;
  if (output.mode === "clone" && typeof output.voice_id !== "string") {
    return { ...output, voice_id: CLONED_VOICE_OUTPUT_ID };
  }
  return value;
}

function validRunpodTtsPayload(value: unknown): value is OmniTtsResponse {
  if (!validTtsPayload(value)) return false;
  // โหมด clone อ้างอิงเสียงจาก ref audio ที่ส่งไป ไม่ใช่ id ในแคตตาล็อก
  const voiceIdOk = value.mode === "clone"
    ? value.voice_id === CLONED_VOICE_OUTPUT_ID
    : isValidOmniVoiceId(value.voice_id);
  return value.contract_version === HERO_VOICE_RUNPOD_CONTRACT_VERSION
    && (value.mode === "tts" || value.mode === "clone")
    && voiceIdOk
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

function runpodTtsInput(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  voiceId: string,
  text: string,
  speed: number,
  voiceRef?: OmniVoiceCustomRef,
) {
  const common = {
    contract_version: HERO_VOICE_RUNPOD_CONTRACT_VERSION,
    text,
    speed,
    num_step: config.numStep,
    mixed_language: true,
    // Worker defaults both to true when omitted (contract.py) — sent explicitly so a
    // future change to that default can't silently change app behavior.
    transliterate_english: true,
    normalize_numbers: true,
  };
  // เสียงโคลนของผู้ใช้ไม่มีอยู่ใน manifest ของ worker — ต้องส่ง reference ไปด้วย
  // ผ่านโหมด clone (contract v2) ไม่ใช่โหมด tts ที่อ้าง voice_id ของเสียง stock
  if (voiceRef) {
    return {
      ...common,
      mode: "clone" as const,
      ref_audio_b64: voiceRef.audioBase64,
      ref_text: voiceRef.refText,
    };
  }
  return { ...common, mode: "tts" as const, voice_id: voiceId };
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

/** Custom voice-clone reference forwarded to the worker per request. */
export type OmniVoiceCustomRef = { audioBase64: string; refText: string };

function omniVoiceTtsInput(
  config: OmniVoiceConfig,
  voiceId: string,
  text: string,
  speed: number,
  voiceRef?: OmniVoiceCustomRef,
) {
  return {
    voice_id: voiceId,
    text,
    speed,
    num_step: config.numStep,
    ...(voiceRef ? { ref_audio_base64: voiceRef.audioBase64, ref_text: voiceRef.refText } : {}),
  };
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
  voiceRef?: OmniVoiceCustomRef,
): Promise<{ providerJobId: string; status: "IN_QUEUE" | "IN_PROGRESS" }> {
  const submitted = await runpodRequest(config, "run", {
    method: "POST",
    body: JSON.stringify({
      input: runpodTtsInput(config, voiceId, text, speed, voiceRef),
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
    const output = normalizeRunpodOutput(polled.body.output);
    if (!validRunpodTtsPayload(output)) {
      throw new OmniVoiceProviderError("RunPod completed with an invalid audio payload", 502);
    }
    return {
      status: "COMPLETED",
      providerJobId,
      response: output,
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
  voiceRef?: OmniVoiceCustomRef,
): Promise<OmniVoiceCallResult> {
  let submitted: { response: Response; body: RunpodTtsJob };
  try {
    // Never automatically retry this POST: a lost response could otherwise
    // submit duplicate paid GPU work.
    submitted = await runpodRequest(config, "run", {
      method: "POST",
      body: JSON.stringify({
        input: runpodTtsInput(config, voiceId, text, speed, voiceRef),
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
        const output = normalizeRunpodOutput(snapshot.output);
        if (!validRunpodTtsPayload(output)) {
          return { ok: false, status: 502, reason: "invalid audio payload" };
        }
        return {
          ok: true,
          response: output,
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
  voiceRef?: OmniVoiceCustomRef,
  language?: string,
): Promise<OmniVoiceCallResult> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1_000) return { ok: false, status: 504, reason: "request budget exhausted" };
  try {
    // เสียงโคลนของผู้ใช้: backend นี้เปิด voice cloning ที่ /clone (multipart) —
    // /tts รับเฉพาะ stock voice ตาม voice_id และเมิน ref_audio_base64 เงียบ ๆ
    // (เคยทำให้เสียงโคลนล้มด้วย VOICE_NOT_SERVED โดยไม่มีสาเหตุชัด)
    const response = voiceRef
      ? await (async () => {
          // ประกอบ multipart เองเป็น Buffer แทน FormData/Blob — ควบคุมไบต์ที่ส่ง
          // ได้แน่นอน (ref_audio เป็น WAV ดิบหลักแสนไบต์) และไม่ต้องพึ่งพฤติกรรม
          // ของ FormData ใน runtime ที่ต่างกัน
          const boundary = `----heroai${randomUUID().replace(/-/g, "")}`;
          const enc = (s: string) => Buffer.from(s, "utf8");
          const field = (name: string, value: string) =>
            enc(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
          const body = Buffer.concat([
            field("ref_text", voiceRef.refText),
            field("text", text),
            field("num_step", String(config.numStep)),
            field("speed", String(speed)),
            // ภาษาต้องส่งให้ /clone ด้วย ไม่งั้นโมเดล auto-detect เอง แล้วสคริปต์
            // อักษรลาวจะถูกอ่านสำเนียงไทย — เสียงโคลนไม่มีทางพูดลาวได้เลย
            ...(language ? [field("language", language)] : []),
            enc(`--${boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
            Buffer.from(voiceRef.audioBase64, "base64"),
            enc("\r\n"),
            enc(`--${boundary}--\r\n`),
          ]);
          return fetch(`${config.baseUrl}/clone`, {
            method: "POST",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              ...omnivoiceAuthHeaders(config.apiKey),
            },
            body: new Uint8Array(body),
            cache: "no-store",
            signal: AbortSignal.timeout(remainingMs),
          });
        })()
      : await fetch(`${config.baseUrl}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...omnivoiceAuthHeaders(config.apiKey) },
          body: JSON.stringify({
            ...omniVoiceTtsInput(config, voiceId, text, speed),
            ...(language ? { language } : {}),
          }),
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
    const raw = await response.json() as unknown;
    // /clone ไม่ส่ง voice_id กลับมา (มันไม่รู้จัก id ฝั่งเรา) — เติมจาก request
    // ให้ payload ผ่าน validTtsPayload เหมือน /tts
    const data = voiceRef && raw && typeof raw === "object" && !Array.isArray(raw)
      ? { voice_id: voiceId, ...(raw as Record<string, unknown>) }
      : raw;
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
  voiceRef?: OmniVoiceCustomRef,
  // ชื่อภาษาแบบที่ server เข้าใจ ("Thai" | "English" | "Lao") — รองรับเฉพาะ
  // backend hostinger (worker RunPod ของ prod ล็อกภาษาไว้ฝั่ง image); ไม่ส่ง = auto
  language?: string,
): Promise<OmniVoiceCallResult> {
  return config.backend === "runpod"
    ? callRunpodOmniVoice(config, voiceId, text, speed, deadline, voiceRef)
    : callHostingerOmniVoice(config, voiceId, text, speed, deadline, voiceRef, language);
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

import { isOmniVoiceServerEnabled } from "@/lib/omnivoice-policy";
import { isValidOmniVoiceId, pcmFromWav as parsePcmFromWav } from "@/lib/omnivoice-core";
import {
  HeroVoiceCloneConfigError,
  resolveHeroVoiceCloneConfig,
  resolveHeroVoiceCloneHumanDataGate,
  type HeroVoiceCloneConfig,
  type HeroVoiceCloneHumanDataGate,
} from "@/lib/hero-voice-clone-config";
import {
  heroVoiceCloneRequestCommitment,
  jcsBytes,
  parseCandidateAiStudioV3Snapshot,
  type CandidateAiStudioV3Snapshot,
} from "@/lib/hero-voice-clone-snapshot";
import {
  sha256Hex,
  validateCandidateV3Response,
  type CandidateV3Success,
} from "@/lib/hero-voice-clone-runners";

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

export { HeroVoiceCloneConfigError } from "@/lib/hero-voice-clone-config";
export type { HeroVoiceCloneConfig, HeroVoiceCloneHumanDataGate } from "@/lib/hero-voice-clone-config";

export interface OmniTtsResponse {
  contract_version?: number;
  mode?: "tts" | "clone";
  voice_id?: string;
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

export type RunpodOmniVoiceRequest =
  | { mode: "tts"; voiceId: string; text: string; speed: number }
  | {
      mode: "clone";
      text: string;
      speed: number;
      refAudioBase64: string;
      refText: string;
    };

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
const CLONE_SUBMIT_RESPONSE_MAX_BYTES = 64 * 1024;
const CLONE_CANCEL_RESPONSE_MAX_BYTES = 64 * 1024;
const CLONE_STATUS_RESPONSE_MAX_BYTES = 10_000_000;
const SAFE_RUNPOD_ID = /^[A-Za-z0-9_-]{1,160}$/;

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

export class HeroVoiceCloneProviderError extends Error {
  constructor(
    public readonly kind:
      | "submit_rejected"
      | "submit_unknown"
      | "poll_transport"
      | "provider_missing"
      | "provider_status"
      | "identity"
      | "output",
  ) {
    super(`Hero Voice clone provider ${kind.replaceAll("_", " ")}`);
    this.name = "HeroVoiceCloneProviderError";
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

/** The only application clone endpoint resolver. It deliberately reads exactly
 * the five dedicated deployment inputs and never consults the stock endpoint,
 * OMNIVOICE_BACKEND, a baseline endpoint, or a profile override. */
export function heroVoiceCloneConfig(): HeroVoiceCloneConfig {
  return resolveHeroVoiceCloneConfig({
    RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID: process.env.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID,
    RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST: process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST,
    RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION: process.env.RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION,
    RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256: process.env.RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256,
    RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
  });
}

/** No caller can turn this into a browser-controlled flag. Task 6 must leave a
 * private evidence digest out of band and the local process must be explicitly
 * in canary execution mode. Production always fails closed. */
export function heroVoiceCloneHumanDataGate(): HeroVoiceCloneHumanDataGate {
  return resolveHeroVoiceCloneHumanDataGate({
    nodeEnv: process.env.NODE_ENV,
    executionMode: process.env.HERO_VOICE_CANARY_EXECUTION_MODE,
    task6GateSha256: process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256,
  });
}

/** Resume/poll obtains only the current credential from process state. Every
 * routable or response identity value comes from the persisted snapshot. */
export function heroVoiceCloneTransportConfigFromSnapshot(
  snapshot: CandidateAiStudioV3Snapshot,
): Pick<HeroVoiceCloneConfig, "backend" | "endpointId" | "apiKey"> {
  const parsed = parseCandidateAiStudioV3Snapshot(snapshot);
  const apiKey = (process.env.RUNPOD_API_KEY ?? "").trim();
  if (!parsed || !apiKey) throw new HeroVoiceCloneConfigError();
  return { backend: "runpod", endpointId: parsed.endpointId, apiKey };
}

export function omnivoiceAuthHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey };
}

function runpodHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

type HeroVoiceCloneRunpodJob = {
  id?: unknown;
  status?: unknown;
  output?: unknown;
  delayTime?: unknown;
  executionTime?: unknown;
};

export type HeroVoiceCloneProviderSnapshot =
  | { status: "IN_QUEUE" | "IN_PROGRESS"; providerJobId: string; delayTimeMs: number; executionTimeMs: number }
  | { status: "COMPLETED"; providerJobId: string; response: CandidateV3Success; audio: Buffer; delayTimeMs: number; executionTimeMs: number }
  | { status: "FAILED" | "TIMED_OUT" | "CANCELLED"; providerJobId: string; delayTimeMs: number; executionTimeMs: number };

function finiteMilliseconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

class HeroVoiceCloneResponseReadError extends Error {}

async function cloneResponseJson(
  response: Response,
  maximumBytes: number,
): Promise<HeroVoiceCloneRunpodJob | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new HeroVoiceCloneResponseReadError();
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new HeroVoiceCloneResponseReadError();
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof HeroVoiceCloneResponseReadError) throw error;
    throw new HeroVoiceCloneResponseReadError();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as HeroVoiceCloneRunpodJob
      : null;
  } catch {
    return null;
  }
}

function safeCloneEndpointId(value: string): string | null {
  const endpointId = value.trim();
  return SAFE_RUNPOD_ID.test(endpointId) ? endpointId : null;
}

function currentRunpodApiKey(): string | null {
  const apiKey = (process.env.RUNPOD_API_KEY ?? "").trim();
  return apiKey || null;
}

export async function cancelRunpodHeroVoiceCloneJobAtEndpoint(
  endpointValue: string,
  providerJobId: string,
): Promise<boolean> {
  const endpointId = safeCloneEndpointId(endpointValue);
  const apiKey = currentRunpodApiKey();
  if (!endpointId || !SAFE_RUNPOD_ID.test(providerJobId) || !apiKey) return false;
  let response: Response;
  try {
    response = await fetch(
      `${RUNPOD_QUEUE_API}/${encodeURIComponent(endpointId)}/cancel/${encodeURIComponent(providerJobId)}`,
      { method: "POST", headers: runpodHeaders(apiKey), cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return false;
  }
  let body: HeroVoiceCloneRunpodJob | null;
  try {
    body = await cloneResponseJson(response, CLONE_CANCEL_RESPONSE_MAX_BYTES);
  } catch {
    return false;
  }
  return response.ok && body?.id === providerJobId && body.status === "CANCELLED";
}

function validCloneProviderJobId(value: unknown): value is string {
  return typeof value === "string" && SAFE_RUNPOD_ID.test(value);
}

function cloneInputFromSnapshot(
  snapshot: CandidateAiStudioV3Snapshot,
  sensitive: { text: string; refAudioBase64: string; refText: string },
) {
  const decodedRef = Buffer.from(sensitive.refAudioBase64, "base64");
  let referenceDurationSamples24000 = 0;
  try {
    const parsedReference = parsePcmFromWav(decodedRef);
    referenceDurationSamples24000 = Math.round(
      (parsedReference.pcm.length / 2) * 24_000 / parsedReference.sampleRate,
    );
  } catch {
    throw new HeroVoiceCloneProviderError("identity");
  }
  if (!sensitive.refAudioBase64 || decodedRef.toString("base64") !== sensitive.refAudioBase64
    || sha256Hex(decodedRef) !== snapshot.referenceSha256
    || referenceDurationSamples24000 !== snapshot.referenceDurationSamples24000
    || sha256Hex(sensitive.text) !== snapshot.synthesis.textSha256
    || heroVoiceCloneRequestCommitment({
      refAudioSha256: sha256Hex(decodedRef),
      refText: sensitive.refText,
      text: sensitive.text,
      speed: snapshot.synthesis.speed,
      numStep: snapshot.synthesis.numStep,
      seed: snapshot.synthesis.seed,
      experimentProfile: snapshot.experimentProfile,
      normalizerVersion: snapshot.normalizerVersion,
    }) !== snapshot.synthesis.requestCommitmentSha256) {
    throw new HeroVoiceCloneProviderError("identity");
  }
  return {
    contract_version: snapshot.contractVersion,
    mode: "clone" as const,
    ref_audio_b64: sensitive.refAudioBase64,
    ref_text: sensitive.refText,
    text: sensitive.text,
    speed: snapshot.synthesis.speed,
    num_step: snapshot.synthesis.numStep,
    mixed_language: snapshot.synthesis.mixedLanguage,
    seed: snapshot.synthesis.seed,
    experiment_profile: snapshot.experimentProfile,
    normalizer_version: snapshot.normalizerVersion,
    request_commitment_sha256: snapshot.synthesis.requestCommitmentSha256,
    matched_settings_sha256: snapshot.synthesis.matchedSettingsSha256,
  };
}

export type PreparedRunpodHeroVoiceCloneRequest = Readonly<{
  bytes: Buffer;
  sha256: string;
  endpointId: string;
  attemptId: string;
}>;

/** Builds and locally verifies the complete JCS request before any durable
 * dispatch intent is committed. The returned Buffer is the network body. */
export function prepareRunpodHeroVoiceCloneJob(input: {
  snapshot: CandidateAiStudioV3Snapshot;
  gate: HeroVoiceCloneHumanDataGate;
  text: string;
  refAudioBase64: string;
  refText: string;
}): PreparedRunpodHeroVoiceCloneRequest {
  if (input.gate.kind !== "task6-human-data-gate") throw new HeroVoiceCloneConfigError();
  const snapshot = parseCandidateAiStudioV3Snapshot(input.snapshot);
  if (!snapshot) throw new HeroVoiceCloneProviderError("identity");
  const config = heroVoiceCloneTransportConfigFromSnapshot(snapshot);
  const bytes = jcsBytes({
    input: cloneInputFromSnapshot(snapshot, input),
    policy: snapshot.policy,
  });
  return Object.freeze({
    bytes,
    sha256: sha256Hex(bytes),
    endpointId: config.endpointId,
    attemptId: snapshot.attemptId,
  });
}

/** One and only one application contract-v3 submission attempt. The mandatory
 * callback is the durability boundary: it must commit/confirm the intent before
 * fetch. The exact prepared Buffer is reverified after the callback and handed
 * unchanged to fetch. A transport exception or malformed 2xx is ambiguous and
 * is never replayed. */
export async function submitRunpodHeroVoiceCloneJob(input: {
  snapshot: CandidateAiStudioV3Snapshot;
  gate: HeroVoiceCloneHumanDataGate;
  text: string;
  refAudioBase64: string;
  refText: string;
  prepared: PreparedRunpodHeroVoiceCloneRequest;
  beforeDispatch: (prepared: PreparedRunpodHeroVoiceCloneRequest) => Promise<void>;
}): Promise<{ providerJobId: string; status: "IN_QUEUE" | "IN_PROGRESS" }> {
  const expected = prepareRunpodHeroVoiceCloneJob(input);
  if (input.prepared.attemptId !== expected.attemptId
    || input.prepared.endpointId !== expected.endpointId
    || input.prepared.sha256 !== expected.sha256
    || !input.prepared.bytes.equals(expected.bytes)) {
    throw new HeroVoiceCloneProviderError("identity");
  }
  await input.beforeDispatch(input.prepared);
  const reverified = prepareRunpodHeroVoiceCloneJob(input);
  if (input.prepared.sha256 !== sha256Hex(input.prepared.bytes)
    || input.prepared.sha256 !== reverified.sha256
    || !input.prepared.bytes.equals(reverified.bytes)) {
    throw new HeroVoiceCloneProviderError("submit_unknown");
  }
  const config = heroVoiceCloneTransportConfigFromSnapshot(input.snapshot);
  let response: Response;
  try {
    response = await fetch(`${RUNPOD_QUEUE_API}/${encodeURIComponent(config.endpointId)}/run`, {
      method: "POST",
      headers: runpodHeaders(config.apiKey),
      body: input.prepared.bytes as unknown as BodyInit,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HeroVoiceCloneProviderError("submit_unknown");
  }
  let body: HeroVoiceCloneRunpodJob | null;
  try {
    body = await cloneResponseJson(response, CLONE_SUBMIT_RESPONSE_MAX_BYTES);
  } catch {
    throw new HeroVoiceCloneProviderError("submit_unknown");
  }
  if (!response.ok) throw new HeroVoiceCloneProviderError("submit_rejected");
  if (!body || !validCloneProviderJobId(body.id)
    || (body.status !== "IN_QUEUE" && body.status !== "IN_PROGRESS")) {
    throw new HeroVoiceCloneProviderError("submit_unknown");
  }
  return { providerJobId: body.id, status: body.status };
}

export async function pollRunpodHeroVoiceCloneJob(
  snapshot: CandidateAiStudioV3Snapshot,
  providerJobId: string,
): Promise<HeroVoiceCloneProviderSnapshot> {
  const parsedSnapshot = parseCandidateAiStudioV3Snapshot(snapshot);
  if (!parsedSnapshot) throw new HeroVoiceCloneProviderError("identity");
  const config = heroVoiceCloneTransportConfigFromSnapshot(parsedSnapshot);
  let response: Response;
  try {
    response = await fetch(
      `${RUNPOD_QUEUE_API}/${encodeURIComponent(config.endpointId)}/status/${encodeURIComponent(providerJobId)}`,
      { headers: runpodHeaders(config.apiKey), cache: "no-store", signal: AbortSignal.timeout(20_000) },
    );
  } catch {
    throw new HeroVoiceCloneProviderError("poll_transport");
  }
  if (response.status === 404) throw new HeroVoiceCloneProviderError("provider_missing");
  let body: HeroVoiceCloneRunpodJob | null;
  try {
    body = await cloneResponseJson(response, CLONE_STATUS_RESPONSE_MAX_BYTES);
  } catch {
    throw new HeroVoiceCloneProviderError("poll_transport");
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) throw new HeroVoiceCloneProviderError("poll_transport");
    throw new HeroVoiceCloneProviderError("provider_status");
  }
  if (!body || typeof body.id !== "string" || body.id !== providerJobId
    || typeof body.status !== "string"
    || !["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(body.status)) {
    throw new HeroVoiceCloneProviderError("provider_status");
  }
  const common = {
    providerJobId,
    delayTimeMs: finiteMilliseconds(body.delayTime),
    executionTimeMs: finiteMilliseconds(body.executionTime),
  };
  if (body.status === "IN_QUEUE" || body.status === "IN_PROGRESS") return { ...common, status: body.status };
  if (body.status === "FAILED" || body.status === "TIMED_OUT" || body.status === "CANCELLED") {
    return { ...common, status: body.status };
  }
  const validated = validateCandidateV3Response(body.output, {
    workerVersion: parsedSnapshot.workerVersion,
    imageDigest: parsedSnapshot.imageDigest,
    sourceRevision: parsedSnapshot.sourceRevision,
    modelManifestSha256: parsedSnapshot.modelManifestSha256,
    experimentProfile: parsedSnapshot.experimentProfile,
    normalizerVersion: parsedSnapshot.normalizerVersion,
    requestCommitmentSha256: parsedSnapshot.synthesis.requestCommitmentSha256,
    matchedSettingsSha256: parsedSnapshot.synthesis.matchedSettingsSha256,
    referenceSha256: parsedSnapshot.referenceSha256,
    referenceDurationSamples24000: parsedSnapshot.referenceDurationSamples24000,
  });
  if (!validated.ok) throw new HeroVoiceCloneProviderError(validated.failure);
  return { ...common, status: "COMPLETED", response: validated.response, audio: validated.audio };
}

export async function cancelRunpodHeroVoiceCloneJob(
  snapshot: CandidateAiStudioV3Snapshot,
  providerJobId: string,
): Promise<boolean> {
  const parsedSnapshot = parseCandidateAiStudioV3Snapshot(snapshot);
  if (!parsedSnapshot) return false;
  return cancelRunpodHeroVoiceCloneJobAtEndpoint(parsedSnapshot.endpointId, providerJobId);
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

function validAudioPayload(value: unknown): value is OmniTtsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Partial<OmniTtsResponse>;
  return typeof output.audio_base64 === "string"
    && output.audio_base64.length > 0
    && output.audio_base64.length <= 30_000_000
    && typeof output.sample_rate === "number"
    && Number.isFinite(output.sample_rate)
    && output.sample_rate >= 8_000
    && output.sample_rate <= 96_000;
}

function validTtsPayload(value: unknown): value is OmniTtsResponse {
  if (!validAudioPayload(value)) return false;
  return typeof value.voice_id === "string";
}

function validRunpodPayload(
  value: unknown,
  expectedMode: RunpodOmniVoiceRequest["mode"],
): value is OmniTtsResponse {
  if (!validAudioPayload(value)) return false;
  return value.contract_version === HERO_VOICE_RUNPOD_CONTRACT_VERSION
    && value.mode === expectedMode
    && (expectedMode === "tts"
      ? typeof value.voice_id === "string" && isValidOmniVoiceId(value.voice_id)
      : typeof value.similarity_score === "number"
        && Number.isFinite(value.similarity_score)
        && value.similarity_score >= -1
        && value.similarity_score <= 1)
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

function runpodSynthesisInput(
  config: Extract<OmniVoiceConfig, { backend: "runpod" }>,
  request: RunpodOmniVoiceRequest,
) {
  if (request.mode === "tts") {
    return runpodTtsInput(config, request.voiceId, request.text, request.speed);
  }
  return {
    contract_version: HERO_VOICE_RUNPOD_CONTRACT_VERSION,
    mode: "clone" as const,
    text: request.text,
    speed: request.speed,
    ref_audio_b64: request.refAudioBase64,
    ref_text: request.refText,
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
  request: RunpodOmniVoiceRequest,
): Promise<{ providerJobId: string; status: "IN_QUEUE" | "IN_PROGRESS" }> {
  const submitted = await runpodRequest(config, "run", {
    method: "POST",
    body: JSON.stringify({
      input: runpodSynthesisInput(config, request),
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
  expectedMode: RunpodOmniVoiceRequest["mode"] = "tts",
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
    if (!validRunpodPayload(polled.body.output, expectedMode)) {
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
        if (!validRunpodPayload(snapshot.output, "tts")) {
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

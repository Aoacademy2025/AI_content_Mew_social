import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AiGenerationAttempt, AiGenerationJob, Plan } from "@prisma/client";
import { promisify } from "node:util";

import { aiAudioCeilingFor, estimateTtsAudioMinutes } from "@/lib/ai-spend-limits";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { evaluateHeroVoiceTranscripts } from "@/lib/hero-voice-asr-gate";
import { heroVoiceAsrGateEnabled, listenToHeroVoicePart } from "@/lib/hero-voice-asr-ears.server";
import {
  heroVoiceCloneAudioFilePath,
  heroVoiceClonePartFilePath,
} from "@/lib/hero-voice-clone-audio.server";
import {
  HERO_VOICE_SPEECH_NORMALIZER_VERSION,
  splitHeroVoiceScriptForTts,
} from "@/lib/hero-voice-speech";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import {
  cancelRunpodHeroVoiceCloneJobAtEndpoint,
  cancelRunpodOmniVoiceJob,
  HeroVoiceCloneConfigError,
  HeroVoiceCloneProviderError,
  heroVoiceCloneConfig,
  heroVoiceCloneHumanDataGate,
  OmniVoiceProviderError,
  omnivoiceConfig,
  pcmFromWav,
  pollRunpodHeroVoiceCloneJob,
  pollRunpodOmniVoiceJob,
  prepareRunpodHeroVoiceCloneJob,
  submitRunpodHeroVoiceCloneJob,
  submitRunpodOmniVoiceJob,
  type OmniVoiceConfig,
  type RunpodOmniVoiceRequest,
} from "@/lib/omnivoice";
import {
  consumeHeroVoiceCanaryAdmissionInTransaction,
  inspectHeroVoiceCanaryAdmission,
} from "@/lib/hero-voice-canary-admission.server";
import {
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import {
  abortHeroVoiceCanaryRunWithinSerializedMutation,
  commitHeroVoiceCanaryDispatchIntentWithinSerializedMutation,
  recordHeroVoiceCanarySubmissionWithinSerializedMutation,
  verifyHeroVoiceCanaryLedger,
} from "@/lib/hero-voice-canary-ledger.server";
import {
  HERO_VOICE_CANARY_SCRIPTS,
  parseHeroVoiceCanaryManifest,
  speechTextForHeroVoiceCanarySlot,
  type HeroVoiceCanarySlot,
} from "@/lib/hero-voice-canary-manifest";
import {
  prepareHeroVoiceCanaryWireRequest,
  type PreparedHeroVoiceCanaryWireRequest,
} from "@/lib/hero-voice-canary-wire";
import {
  createCandidateAiStudioV3Snapshot,
  parseCandidateAiStudioV3Snapshot,
  snapshotContainsForbiddenReferenceData,
  type CandidateAiStudioV3Snapshot,
} from "@/lib/hero-voice-clone-snapshot";
import {
  isHeroVoiceCloneDurableRecord,
  isHeroVoiceCloneTerminalStatus,
  type HeroVoiceCloneFailureStatus,
} from "@/lib/hero-voice-clone-state";
import { sha256Hex, validatePcm16MonoWav } from "@/lib/hero-voice-clone-runners";
import {
  assertHeroVoiceCanaryMutationReady,
  assertNoCanaryAccountDeletionInTransaction,
  runHeroVoiceCanarySerializedMutation,
} from "@/lib/hero-voice-deletion-coordinator.server";
import { heroVoiceCanaryDeletionConfigured } from "@/lib/hero-voice-canary-storage.server";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { mergeSegmentTiming, pcmDurationMs } from "@/lib/tts-timing";
import { syncMinuteWindow } from "@/lib/minute-limits";
import { videoExpiryFor } from "@/lib/plan-limits";
import { isUserVoiceId, loadUserVoiceRef } from "@/lib/user-voices.server";
import {
  isHeroVoiceCloneCanaryUser,
  isHeroVoiceCloneGenerationJob,
} from "@/lib/omnivoice-policy";

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1 as const;
const SUBMISSION_UNKNOWN_AFTER_MS = 2 * 60_000;
const CLONE_POLL_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
const CLONE_DISPATCH_LEASE_MS = 25_000;
const CLONE_POLL_LEASE_MS = 25_000;
const ACTIVE_CLONE_JOB_STATUSES = ["queued", "in_progress"] as const;
const ACTIVE_CLONE_ATTEMPT_STATUSES = ["submitted", "queued", "in_progress"] as const;
const CLONE_STATE_KEYS = [
  "version", "mode", "cloneCanarySurface", "voiceId", "speed", "backend", "providerDeadlineAt",
  "aiReservedMin", "studioReservedMin", "speechNormalizerVersion", "speechRiskCategories", "chunks",
  "cloneSnapshots",
] as const;
// ASR content gate (spec §11.5): a chunk whose transcript misses a run of letters is
// regenerated with the next seed at most this many times before the job fails.
const ASR_GATE_MAX_RETRIES = 2;
// Listening to a part takes seconds; the poll lease is extended by this much first.
const ASR_GATE_LEASE_EXTENSION_MS = 45_000;
const ASR_GATE_STATE_KEYS = ["version", "chunks"] as const;
const ASR_GATE_CHUNK_KEYS = ["sequence", "attempts", "droppedRun", "ears", "rejected"] as const;
const ASR_GATE_REJECTION_KEYS = ["attemptId", "providerJobId", "seed", "droppedRun"] as const;
const CLONE_CHUNK_KEYS = new Set([
  "text", "speechText", "providerJobId", "partFilename", "durationMs", "sampleRate", "generationTimeMs",
  "delayTimeMs", "executionTimeMs", "workerVersion", "catalogVersion", "language", "numStep",
  "responseEnvelopeSha256", "outputAudioSha256",
]);

type HeroVoiceChunkState = {
  text: string;
  speechText: string;
  providerJobId?: string;
  partFilename?: string;
  durationMs?: number;
  sampleRate?: number;
  generationTimeMs?: number;
  delayTimeMs?: number;
  executionTimeMs?: number;
  workerVersion?: string;
  catalogVersion?: string;
  language?: string;
  numStep?: number;
  responseEnvelopeSha256?: string;
  outputAudioSha256?: string;
};

type HeroVoiceAsrGateRejection = {
  attemptId: string;
  providerJobId: string;
  seed: number;
  droppedRun: number;
};

type HeroVoiceAsrGateChunkState = {
  sequence: number;
  /** Generations consumed for this chunk, the in-flight or accepted one included. */
  attempts: number;
  /** Best dropped run of the accepted audio; null while pending or when no ear answered. */
  droppedRun: number | null;
  /** Ears that produced a transcript for the accepted audio. */
  ears: number;
  rejected: HeroVoiceAsrGateRejection[];
};

type HeroVoiceAsrGateState = {
  version: 1;
  chunks: HeroVoiceAsrGateChunkState[];
};

type HeroVoiceGenerationStateV1 = {
  version: typeof STATE_VERSION;
  // Optional for backward compatibility with durable TTS jobs accepted before
  // clone mode shipped. Missing means stock TTS.
  mode?: "tts" | "clone";
  cloneCanarySurface?: "ai-studio";
  voiceId: string;
  speed: number;
  backend: "runpod";
  providerDeadlineAt: string;
  aiReservedMin: number;
  studioReservedMin: number;
  speechNormalizerVersion: string;
  speechRiskCategories: string[];
  chunks: HeroVoiceChunkState[];
  cloneSnapshots?: CandidateAiStudioV3Snapshot[];
  /** Present only after the ASR gate has judged at least one chunk (clone mode). */
  asrGate?: HeroVoiceAsrGateState;
  result?: HeroVoiceGenerationResult;
};

function generationMode(state: HeroVoiceGenerationStateV1): "tts" | "clone" {
  return state.mode ?? "tts";
}

export type HeroVoiceGenerationResult = {
  voiceUrl: string;
  audioDurationMs: number;
  timing: {
    provider: "omnivoice";
    segments: ReturnType<typeof mergeSegmentTiming>;
    chars: null;
    silences: number[];
    silenceIntervals: Array<{ startMs: number; endMs: number }>;
  };
};

export class HeroVoiceGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "HeroVoiceGenerationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && [...expected].sort().every((key, index) => actual[index] === key);
}

function validOptionalFinite(value: unknown): boolean {
  return value === undefined || isFiniteNonNegative(value);
}

function isCountAtLeast(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validAsrGateState(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasExactKeys(value, ASR_GATE_STATE_KEYS) || value.version !== 1
    || !Array.isArray(value.chunks)) return false;
  return value.chunks.every((chunk) => isRecord(chunk) && hasExactKeys(chunk, ASR_GATE_CHUNK_KEYS)
    && isCountAtLeast(chunk.sequence, 1) && isCountAtLeast(chunk.attempts, 1)
    && (chunk.droppedRun === null || isFiniteNonNegative(chunk.droppedRun))
    && isCountAtLeast(chunk.ears, 0)
    && Array.isArray(chunk.rejected)
    && chunk.rejected.every((rejection) => isRecord(rejection) && hasExactKeys(rejection, ASR_GATE_REJECTION_KEYS)
      && typeof rejection.attemptId === "string" && typeof rejection.providerJobId === "string"
      && isCountAtLeast(rejection.seed, 0) && isFiniteNonNegative(rejection.droppedRun)));
}

function mergeAsrGateChunk(
  current: HeroVoiceAsrGateState | undefined,
  chunk: HeroVoiceAsrGateChunkState,
): HeroVoiceAsrGateState {
  const chunks = (current?.chunks ?? []).filter((item) => item.sequence !== chunk.sequence);
  chunks.push(chunk);
  chunks.sort((a, b) => a.sequence - b.sequence);
  return { version: 1, chunks };
}

function parseState(value: string | null): HeroVoiceGenerationStateV1 | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)
    || parsed.version !== STATE_VERSION
    || parsed.backend !== "runpod"
    || (parsed.mode !== undefined && parsed.mode !== "tts" && parsed.mode !== "clone")
    || (parsed.cloneCanarySurface !== undefined && parsed.cloneCanarySurface !== "ai-studio")
    || (parsed.mode === "clone" && parsed.cloneCanarySurface !== "ai-studio")
    || (parsed.mode !== "clone" && parsed.cloneCanarySurface !== undefined)
    || typeof parsed.voiceId !== "string"
    || typeof parsed.speed !== "number"
    || !Number.isFinite(parsed.speed)
    || typeof parsed.providerDeadlineAt !== "string"
    || !Number.isFinite(Date.parse(parsed.providerDeadlineAt))
    || !isFiniteNonNegative(parsed.aiReservedMin)
    || !isFiniteNonNegative(parsed.studioReservedMin)
    || typeof parsed.speechNormalizerVersion !== "string"
    || !Array.isArray(parsed.speechRiskCategories)
    || !parsed.speechRiskCategories.every((item) => typeof item === "string")
    || !Array.isArray(parsed.chunks)
    || parsed.chunks.length === 0) {
    return null;
  }
  for (const chunk of parsed.chunks) {
    if (!isRecord(chunk) || typeof chunk.text !== "string" || typeof chunk.speechText !== "string") return null;
    if (chunk.partFilename !== undefined
      && (typeof chunk.partFilename !== "string" || !/^(?:tts-omni-part|clone-part)-[A-Za-z0-9_-]+-\d+\.wav$/.test(chunk.partFilename))) {
      return null;
    }
  }
  if (parsed.mode === "clone") {
    const expectedStateKeys = [
      ...CLONE_STATE_KEYS,
      ...(parsed.result === undefined ? [] : ["result"]),
      ...(parsed.asrGate === undefined ? [] : ["asrGate"]),
    ];
    if (!hasExactKeys(parsed, expectedStateKeys)
      || !validAsrGateState(parsed.asrGate)
      || parsed.voiceId.length === 0
      || !parsed.voiceId.startsWith("user_")
      || parsed.speed < 0.3 || parsed.speed > 3
      || parsed.speechNormalizerVersion.length === 0
      || !parsed.chunks.every((chunk) => {
        if (!isRecord(chunk) || Object.keys(chunk).some((key) => !CLONE_CHUNK_KEYS.has(key))) return false;
        return (chunk.providerJobId === undefined || typeof chunk.providerJobId === "string")
          && validOptionalFinite(chunk.durationMs) && validOptionalFinite(chunk.sampleRate)
          && validOptionalFinite(chunk.generationTimeMs) && validOptionalFinite(chunk.delayTimeMs)
          && validOptionalFinite(chunk.executionTimeMs)
          && (chunk.workerVersion === undefined || typeof chunk.workerVersion === "string")
          && (chunk.catalogVersion === undefined || typeof chunk.catalogVersion === "string")
          && (chunk.language === undefined || typeof chunk.language === "string")
          && (chunk.numStep === undefined || Number.isSafeInteger(chunk.numStep))
          && (chunk.responseEnvelopeSha256 === undefined || /^[0-9a-f]{64}$/u.test(String(chunk.responseEnvelopeSha256)))
          && (chunk.outputAudioSha256 === undefined || /^[0-9a-f]{64}$/u.test(String(chunk.outputAudioSha256)));
      })
      || !Array.isArray(parsed.cloneSnapshots)
      || parsed.cloneSnapshots.length !== parsed.chunks.length
      || parsed.cloneSnapshots.some((snapshot, index) => {
        const candidate = parseCandidateAiStudioV3Snapshot(snapshot);
        return !candidate || candidate.sequence !== index + 1;
      })) return null;
  } else if (parsed.cloneSnapshots !== undefined || parsed.asrGate !== undefined) {
    return null;
  }
  return parsed as unknown as HeroVoiceGenerationStateV1;
}

function cloneReservationMatchesTrustedColumns(
  job: Pick<AiGenerationJob, "reservedAiAudioMinutes" | "reservedStudioMinutes">,
  state: HeroVoiceGenerationStateV1,
): boolean {
  return Number.isFinite(job.reservedAiAudioMinutes) && job.reservedAiAudioMinutes >= 0
    && Number.isFinite(job.reservedStudioMinutes) && job.reservedStudioMinutes >= 0
    && state.aiReservedMin === job.reservedAiAudioMinutes
    && state.studioReservedMin === job.reservedStudioMinutes;
}

function safeCloneProviderIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(normalized) ? normalized : null;
}

function cloneCancelTarget(
  job: Pick<AiGenerationJob, "providerEndpoint" | "providerJobId">,
  attempt: Pick<AiGenerationAttempt, "providerEndpoint" | "providerJobId"> | null,
): { endpointId: string; providerJobId: string } | null {
  const jobEndpoint = safeCloneProviderIdentity(job.providerEndpoint);
  const jobProviderJobId = safeCloneProviderIdentity(job.providerJobId);
  const attemptEndpoint = safeCloneProviderIdentity(attempt?.providerEndpoint);
  const attemptProviderJobId = safeCloneProviderIdentity(attempt?.providerJobId);
  if ((job.providerEndpoint !== null && !jobEndpoint)
    || (job.providerJobId !== null && !jobProviderJobId)
    || (attempt?.providerEndpoint !== null && attempt?.providerEndpoint !== undefined && !attemptEndpoint)
    || (attempt?.providerJobId !== null && attempt?.providerJobId !== undefined && !attemptProviderJobId)
    || (jobEndpoint && attemptEndpoint && jobEndpoint !== attemptEndpoint)
    || (jobProviderJobId && attemptProviderJobId && jobProviderJobId !== attemptProviderJobId)) {
    return null;
  }
  const endpointId = jobEndpoint ?? attemptEndpoint;
  const providerJobId = jobProviderJobId ?? attemptProviderJobId;
  return endpointId && providerJobId ? { endpointId, providerJobId } : null;
}

function validateCloneDurableIdentity(
  job: AiGenerationJob,
  state: HeroVoiceGenerationStateV1,
  attempts: readonly AiGenerationAttempt[],
): boolean {
  const activeJob = ACTIVE_CLONE_JOB_STATUSES.includes(
    job.status as typeof ACTIVE_CLONE_JOB_STATUSES[number],
  );
  if (generationMode(state) !== "clone" || !isHeroVoiceCloneGenerationJob(job)
    || job.provider !== "runpod" || job.providerRoute !== "runpod-custom"
    || job.providerModel !== "omnivoice-clone" || job.productSurface !== "ai_studio"
    || job.model !== state.voiceId || job.providerEndpoint === null
    || !cloneReservationMatchesTrustedColumns(job, state)
    || (activeJob && (job.chargeState !== "reserved" || job.reservedAiAudioMinutes <= 0
      || job.cancelDisposition !== "not_requested" || job.cancelAttemptedAt !== null
      || job.externalRunDisposition !== "not_required"))
    || attempts.length < 1 || attempts.length > state.chunks.length) return false;
  for (const [index, attempt] of attempts.entries()) {
    const sequence = index + 1;
    let value: unknown = null;
    try { value = attempt.inputJson ? JSON.parse(attempt.inputJson) : null; } catch {}
    const attemptSnapshot = parseCandidateAiStudioV3Snapshot(value);
    const jobSnapshot = parseCandidateAiStudioV3Snapshot(state.cloneSnapshots?.[index]);
    if (!attemptSnapshot || !jobSnapshot || JSON.stringify(attemptSnapshot) !== JSON.stringify(jobSnapshot)
      || attempt.sequence !== sequence || attempt.id !== attemptSnapshot.attemptId
      || attemptSnapshot.sequence !== sequence || attempt.provider !== "runpod"
      || attempt.providerModel !== "omnivoice-clone" || attempt.providerRoute !== "runpod-custom"
      || attempt.providerEndpoint !== attemptSnapshot.endpointId || job.providerEndpoint !== attemptSnapshot.endpointId) {
      return false;
    }
  }
  const current = attempts.at(-1)!;
  if (activeJob) {
    for (const [index, candidate] of attempts.entries()) {
      const isCurrent = index === attempts.length - 1;
      const chunk = state.chunks[index];
      if (candidate.cancelDisposition !== "not_requested" || candidate.cancelAttemptedAt !== null) return false;
      if (!isCurrent || candidate.status === "completed") {
        if (candidate.status !== "completed" || candidate.submissionDisposition !== "provider_accepted"
          || !candidate.providerJobId || chunk.providerJobId !== candidate.providerJobId || !chunk.partFilename) return false;
        continue;
      }
      if (candidate.status === "planned") {
        if (candidate.providerJobId !== null || job.providerJobId !== null
          || candidate.submissionDisposition !== "not_dispatched" || candidate.dispatchIntentAt !== null
          || candidate.providerResponseAt !== null || candidate.dispatchLeaseExpiresAt !== null) return false;
        continue;
      }
      if (candidate.status === "submitting") {
        if (candidate.providerJobId !== null || job.providerJobId !== null
          || candidate.submissionDisposition !== "intent_committed" || candidate.dispatchIntentAt === null
          || candidate.providerResponseAt !== null || candidate.dispatchLeaseExpiresAt === null) return false;
        continue;
      }
      if (!ACTIVE_CLONE_ATTEMPT_STATUSES.includes(
        candidate.status as typeof ACTIVE_CLONE_ATTEMPT_STATUSES[number],
      ) || candidate.submissionDisposition !== "provider_accepted" || !candidate.providerJobId
        || candidate.providerResponseAt === null || candidate.dispatchLeaseExpiresAt !== null
        || candidate.providerJobId !== job.providerJobId) return false;
    }
  } else if (ACTIVE_CLONE_ATTEMPT_STATUSES.includes(
    current.status as typeof ACTIVE_CLONE_ATTEMPT_STATUSES[number],
  ) && current.providerJobId !== job.providerJobId) return false;
  return true;
}

function serializeState(value: HeroVoiceGenerationStateV1): string {
  return JSON.stringify(value);
}

function requireExistingHeroVoiceGenerationInvariant(
  job: AiGenerationJob,
  expected: { mode: "tts" | "clone"; voiceId: string },
): AiGenerationJob {
  const state = parseState(job.inputJson);
  const expectedProviderModel = expected.mode === "clone" ? "omnivoice-clone" : "omnivoice";
  const expectedProductSurface = expected.mode === "clone" ? "ai_studio" : null;
  const matches = job.kind === "voice"
    && job.model === expected.voiceId
    && job.provider === "runpod"
    && job.providerModel === expectedProviderModel
    && job.providerRoute === "runpod-custom"
    && job.productSurface === expectedProductSurface
    && state !== null
    && generationMode(state) === expected.mode
    && state.voiceId === expected.voiceId
    && (expected.mode !== "clone" || isHeroVoiceCloneGenerationJob(job));
  if (matches) return job;

  if (expected.mode === "clone") {
    throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
  }
  throw new HeroVoiceGenerationError(
    "idempotencyKey ถูกใช้กับงาน Hero Voice คนละรูปแบบแล้ว",
    "OMNIVOICE_IDEMPOTENCY_CONFLICT",
    409,
  );
}

function rendersDir(): string {
  return path.join(process.cwd(), "public", "renders");
}

function ensureRendersDir(): string {
  const directory = rendersDir();
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function wavFromPcm(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function detectSilences(wavPath: string): Promise<{
  midpoints: number[];
  intervals: Array<{ startMs: number; endMs: number }>;
}> {
  try {
    const { stderr } = await execFileAsync(getFfmpegPath(), [
      "-i", wavPath,
      "-af", "silencedetect=noise=-30dB:d=0.25",
      "-f", "null", "-",
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 });
    const midpoints: number[] = [];
    const intervals: Array<{ startMs: number; endMs: number }> = [];
    const pattern = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stderr || "")) !== null) {
      const start = Number.parseFloat(match[1]);
      const end = Number.parseFloat(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const startMs = Math.round(start * 1000);
        const endMs = Math.round(end * 1000);
        intervals.push({ startMs, endMs });
        midpoints.push(Math.round((startMs + endMs) / 2));
      }
    }
    return { midpoints, intervals };
  } catch {
    return { midpoints: [], intervals: [] };
  }
}

function pinnedStockRunpodConfig(job: AiGenerationJob, state: HeroVoiceGenerationStateV1): Extract<OmniVoiceConfig, { backend: "runpod" }> {
  const current = omnivoiceConfig(state.backend);
  if (current.backend !== "runpod") {
    throw new HeroVoiceGenerationError("Hero Voice backend ไม่ตรงกับงานที่บันทึกไว้", "OMNIVOICE_BACKEND_MISMATCH", 409);
  }
  const endpointId = job.providerEndpoint?.trim();
  if (!endpointId) {
    throw new HeroVoiceGenerationError("Hero Voice job ไม่มี provider endpoint", "OMNIVOICE_ENDPOINT_MISSING", 503, true);
  }
  return { ...current, endpointId };
}

function cloneSnapshotForAttempt(
  job: AiGenerationJob,
  state: HeroVoiceGenerationStateV1,
  attempt: { id: string; sequence: number; inputJson: string | null; providerEndpoint: string | null },
): CandidateAiStudioV3Snapshot {
  if (generationMode(state) !== "clone") {
    throw new HeroVoiceGenerationError("ข้อมูล Hero Voice clone ไม่ถูกต้อง", "CLONE_SNAPSHOT_INVALID", 500);
  }
  let attemptValue: unknown = null;
  try { attemptValue = attempt.inputJson ? JSON.parse(attempt.inputJson) : null; } catch {}
  const attemptSnapshot = parseCandidateAiStudioV3Snapshot(attemptValue);
  const jobSnapshot = state.cloneSnapshots?.[attempt.sequence - 1];
  const parsedJobSnapshot = parseCandidateAiStudioV3Snapshot(jobSnapshot);
  if (!attemptSnapshot || !parsedJobSnapshot
    || JSON.stringify(attemptSnapshot) !== JSON.stringify(parsedJobSnapshot)
    || attemptSnapshot.attemptId !== attempt.id || attemptSnapshot.sequence !== attempt.sequence
    || attempt.providerEndpoint !== attemptSnapshot.endpointId || job.providerEndpoint !== attemptSnapshot.endpointId) {
    throw new HeroVoiceGenerationError("ข้อมูล Hero Voice clone ไม่ถูกต้อง", "CLONE_SNAPSHOT_INVALID", 500);
  }
  return attemptSnapshot;
}

function partFilename(jobId: string, sequence: number): string {
  return `tts-omni-part-${jobId}-${sequence}.wav`;
}

function finalFilename(jobId: string): string {
  return `tts-omni-${jobId}.wav`;
}

function generationPartFilePath(
  jobId: string,
  sequence: number,
  state: HeroVoiceGenerationStateV1,
): string {
  if (generationMode(state) === "clone") {
    const filename = heroVoiceClonePartFilePath(jobId, sequence);
    if (!filename) throw new HeroVoiceGenerationError("Hero Voice job id ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
    return filename;
  }
  return path.join(ensureRendersDir(), partFilename(jobId, sequence));
}

function removeParts(jobId: string, state: HeroVoiceGenerationStateV1): void {
  for (const [index, chunk] of state.chunks.entries()) {
    if (!chunk.partFilename) continue;
    const target = generationPartFilePath(jobId, index + 1, state);
    if (path.basename(target) !== chunk.partFilename) continue;
    try { fs.unlinkSync(target); } catch {}
  }
}

async function requireHeroVoiceCloneCanaryActor(userId: string): Promise<void> {
  const actor = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, suspended: true },
  });
  if (!isHeroVoiceCloneCanaryUser(actor)) {
    throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
  }
}

async function recordVoiceEvent(
  userId: string,
  name: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await recordTelemetryEvent(userId, {
    name,
    category: name.endsWith("_failed") || name.endsWith("_timeout") ? "error" : "pipeline",
    source: "server",
    properties,
  }).catch(() => {});
}

async function failAndRefundVoiceJob(
  job: AiGenerationJob,
  state: HeroVoiceGenerationStateV1 | null,
  code: string,
  message: string,
  terminalStatus: HeroVoiceCloneFailureStatus = "failed",
): Promise<AiGenerationJob> {
  const cloneMode = isHeroVoiceCloneDurableRecord(job) || (state !== null && generationMode(state) === "clone");
  const durableStatus = cloneMode ? terminalStatus : "failed";
  const failed = await prisma.$transaction(async (tx) => {
    const owned = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId: job.userId } });
    if (!owned) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
    if (cloneMode ? isHeroVoiceCloneTerminalStatus(owned.status) : ["completed", "failed", "canceled"].includes(owned.status)) {
      return owned;
    }
    const aiReservedMin = cloneMode ? owned.reservedAiAudioMinutes : (owned.reservedAiAudioMinutes || state?.aiReservedMin || 0);
    const studioReservedMin = cloneMode ? owned.reservedStudioMinutes : (owned.reservedStudioMinutes || state?.studioReservedMin || 0);
    if (owned.chargeState === "reserved") {
      await tx.user.update({
        where: { id: job.userId },
        data: {
          aiAudioMinutesUsed: { increment: -aiReservedMin },
          ...(studioReservedMin !== 0 ? { minutesUsed: { increment: -studioReservedMin } } : {}),
        },
      });
    }
    const now = new Date();
    const attemptFailure = {
      status: durableStatus,
      errorCode: code,
      errorMessage: message.slice(0, 500),
      finishedAt: now,
      pollLeaseToken: null,
      pollLeaseExpiresAt: null,
    };
    if (cloneMode) {
      const latestAttempt = await tx.aiGenerationAttempt.findFirst({
        where: { jobId: job.id },
        orderBy: { sequence: "desc" },
      });
      if (latestAttempt) {
        await tx.aiGenerationAttempt.update({ where: { id: latestAttempt.id }, data: attemptFailure });
      }
    } else {
      await tx.aiGenerationAttempt.updateMany({
        where: { jobId: job.id, status: { in: ["planned", "submitting", "submitted", "queued", "in_progress", "completed"] } },
        data: attemptFailure,
      });
    }
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: durableStatus,
        chargeState: owned.chargeState === "reserved" ? "refunded" : owned.chargeState,
        ...(cloneMode ? { externalRunDisposition: "abort_required" } : {}),
        errorCode: code,
        errorMessage: message.slice(0, 500),
        finishedAt: now,
      },
    });
  });
  if (state) removeParts(job.id, state);
  await recordVoiceEvent(job.userId, "omnivoice_provider_failed", {
    aiGenerationJobId: job.id,
    providerJobId: job.providerJobId ?? "",
    endpointId: job.providerEndpoint ?? "",
    code,
  });
  return failed;
}

async function recordCloneCancelOnce(
  job: AiGenerationJob,
): Promise<AiGenerationJob> {
  const claimedAt = new Date();
  const claimed = await prisma.$transaction(async (tx) => {
    const currentJob = await tx.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
    const currentAttempt = await tx.aiGenerationAttempt.findFirst({
      where: { jobId: job.id },
      orderBy: { sequence: "desc" },
    });
    if (currentJob.cancelAttemptedAt !== null || currentAttempt?.cancelAttemptedAt) {
      const previousClaim = currentJob.cancelAttemptedAt ?? currentAttempt!.cancelAttemptedAt!;
      await tx.aiGenerationJob.updateMany({
        where: { id: job.id, cancelDisposition: "not_requested" },
        data: { cancelAttemptedAt: previousClaim, cancelDisposition: "rejected_or_unknown" },
      });
      if (currentAttempt) {
        await tx.aiGenerationAttempt.updateMany({
          where: { id: currentAttempt.id, cancelDisposition: "not_requested" },
          data: { cancelAttemptedAt: previousClaim, cancelDisposition: "rejected_or_unknown" },
        });
      }
      return null;
    }
    const jobClaimed = await tx.aiGenerationJob.updateMany({
      where: { id: job.id, cancelAttemptedAt: null },
      data: { cancelAttemptedAt: claimedAt },
    });
    if (jobClaimed.count !== 1) return null;
    if (currentAttempt) {
      await tx.aiGenerationAttempt.updateMany({
        where: { id: currentAttempt.id, cancelAttemptedAt: null },
        data: { cancelAttemptedAt: claimedAt },
      });
    }
    return {
      attemptId: currentAttempt?.id ?? null,
      target: cloneCancelTarget(currentJob, currentAttempt),
    };
  });
  if (!claimed) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });

  const confirmed = claimed.target
    ? await cancelRunpodHeroVoiceCloneJobAtEndpoint(claimed.target.endpointId, claimed.target.providerJobId)
    : false;
  const disposition = confirmed ? "confirmed" : "rejected_or_unknown";
  await prisma.$transaction(async (tx) => {
    if (claimed.attemptId) {
      await tx.aiGenerationAttempt.updateMany({
        where: { id: claimed.attemptId, cancelAttemptedAt: claimedAt, cancelDisposition: "not_requested" },
        data: { cancelDisposition: disposition },
      });
    }
    await tx.aiGenerationJob.updateMany({
      where: { id: job.id, cancelAttemptedAt: claimedAt, cancelDisposition: "not_requested" },
      data: { cancelDisposition: disposition },
    });
  });
  return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function failCloneAndCancelKnownJob(
  job: AiGenerationJob,
  state: HeroVoiceGenerationStateV1,
  status: HeroVoiceCloneFailureStatus,
  code: string,
  message: string,
): Promise<AiGenerationJob> {
  const failed = await failAndRefundVoiceJob(job, state, code, message, status);
  return recordCloneCancelOnce(failed);
}

async function failCorruptCloneJob(
  job: AiGenerationJob,
): Promise<AiGenerationJob> {
  const failed = await failAndRefundVoiceJob(
    job,
    null,
    "CLONE_SNAPSHOT_INVALID",
    "Hero Voice clone durable identity is invalid",
    "failed_identity",
  );
  if (failed.status === "completed") return failed;
  return recordCloneCancelOnce(failed);
}

async function reconcileExistingHeroVoiceGeneration(
  job: AiGenerationJob,
  expected: { mode: "tts" | "clone"; voiceId: string },
): Promise<AiGenerationJob> {
  if (isHeroVoiceCloneDurableRecord(job)) {
    const state = parseState(job.inputJson);
    const attempts = await prisma.aiGenerationAttempt.findMany({
      where: { jobId: job.id },
      orderBy: { sequence: "asc" },
    });
    if (!state || !validateCloneDurableIdentity(job, state, attempts)) {
      return failCorruptCloneJob(job);
    }
  }
  return requireExistingHeroVoiceGenerationInvariant(job, expected);
}

async function prepareTask5CanaryRequest(input: {
  job: AiGenerationJob;
  attempt: AiGenerationAttempt;
  referenceWav: Buffer;
  refText: string;
}): Promise<PreparedHeroVoiceCanaryWireRequest | null> {
  if (input.job.canaryRunId === null && input.job.canarySlotId === null) return null;
  if (!input.job.canaryRunId || !input.job.canarySlotId) {
    throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  const run = await prisma.reviewRun.findUnique({ where: { id: input.job.canaryRunId } });
  if (!run?.slotManifestJson || !run.slotManifestSha256 || run.referenceVoiceId !== input.job.model
    || heroVoiceCanarySha256(run.slotManifestJson) !== run.slotManifestSha256) {
    throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  let manifest;
  try {
    manifest = parseHeroVoiceCanaryManifest(
      parseHeroVoiceCanaryStrictJson(Buffer.from(run.slotManifestJson, "utf8")),
    );
  } catch {
    throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  const slot = manifest.slots.find((candidate) => candidate.slotId === input.job.canarySlotId);
  if (!slot || slot.runnerKind !== "CandidateAiStudioV3" || slot.phase !== "candidate") {
    throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  const snapshot = parseCandidateAiStudioV3Snapshot(
    input.attempt.inputJson ? JSON.parse(input.attempt.inputJson) : null,
  );
  if (!snapshot || snapshot.endpointId !== slot.endpointId || snapshot.synthesis.seed !== slot.arm.seed) {
    throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  try {
    return prepareHeroVoiceCanaryWireRequest({ slot, referenceWav: input.referenceWav, refText: input.refText });
  } catch {
    throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
}

async function submitPendingAttempt(job: AiGenerationJob): Promise<AiGenerationJob> {
  const state = parseState(job.inputJson);
  const cloneMode = isHeroVoiceCloneDurableRecord(job) || (state !== null && generationMode(state) === "clone");
  const attempts = await prisma.aiGenerationAttempt.findMany({
    where: { jobId: job.id },
    orderBy: { sequence: "asc" },
  });
  if (!state) {
    if (cloneMode) return failCorruptCloneJob(job);
    throw new HeroVoiceGenerationError("ข้อมูล durable Hero Voice ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  }
  if (cloneMode && !validateCloneDurableIdentity(job, state, attempts)) {
    return failCorruptCloneJob(job);
  }
  if (cloneMode) {
    try {
      await requireHeroVoiceCloneCanaryActor(job.userId);
    } catch {
      return failAndRefundVoiceJob(job, state, "CLONE_POLICY_REVOKED", "Hero Voice clone policy is no longer valid", "failed_identity");
    }
  }
  const attempt = attempts.at(-1);
  if (!attempt) throw new HeroVoiceGenerationError("ไม่พบ Hero Voice provider attempt", "OMNIVOICE_ATTEMPT_MISSING", 500);
  if (attempt.status !== "planned") return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  let cloneSnapshot: CandidateAiStudioV3Snapshot | null = null;
  if (cloneMode) {
    try {
      cloneSnapshot = cloneSnapshotForAttempt(job, state, attempt);
      heroVoiceCloneHumanDataGate();
    } catch (error) {
      const code = error instanceof HeroVoiceCloneConfigError ? "CLONE_CONFIG_UNAVAILABLE" : "CLONE_SNAPSHOT_INVALID";
      return failAndRefundVoiceJob(job, state, code, "Hero Voice clone cannot be dispatched", "failed_identity");
    }
  }
  const chunk = state.chunks[attempt.sequence - 1];
  if (!chunk) {
    return failAndRefundVoiceJob(job, state, "OMNIVOICE_CHUNK_MISSING", "ไม่พบข้อความส่วนที่ต้องสร้างเสียง");
  }
  let cloneRef: Awaited<ReturnType<typeof loadUserVoiceRef>> = null;
  if (cloneMode) {
    cloneRef = await loadUserVoiceRef(job.userId, state.voiceId);
    if (!cloneRef) {
      return failAndRefundVoiceJob(
        job,
        state,
        "USER_VOICE_REFERENCE_MISSING",
        "ไม่พบไฟล์อ้างอิงของเสียงโคลนนี้",
        "failed_identity",
      );
    }
    if (!cloneSnapshot || snapshotContainsForbiddenReferenceData(cloneSnapshot)) {
      return failAndRefundVoiceJob(
        job,
        state,
        "CLONE_SNAPSHOT_PRIVACY_INVALID",
        "Hero Voice clone snapshot failed privacy validation",
        "failed_identity",
      );
    }
  }
  let preparedCloneRequest: ReturnType<typeof prepareRunpodHeroVoiceCloneJob> | null = null;
  let preparedTask5Request: PreparedHeroVoiceCanaryWireRequest | null = null;
  if (cloneMode) {
    try {
      const gate = heroVoiceCloneHumanDataGate();
      preparedCloneRequest = prepareRunpodHeroVoiceCloneJob({
        snapshot: cloneSnapshot!,
        gate,
        text: chunk.speechText,
        refAudioBase64: cloneRef!.audioBase64,
        refText: cloneRef!.refText,
      });
      preparedTask5Request = await prepareTask5CanaryRequest({
        job,
        attempt,
        referenceWav: Buffer.from(cloneRef!.audioBase64, "base64"),
        refText: cloneRef!.refText,
      });
      if (preparedTask5Request) {
        if (!preparedTask5Request.bytes.equals(preparedCloneRequest.bytes)
          || preparedTask5Request.wireRequestSha256 !== preparedCloneRequest.sha256) {
          throw new HeroVoiceGenerationError("Hero Voice canary identity is invalid", "CLONE_IDENTITY_INVALID", 500);
        }
        // Preserve the verified Task 5 Buffer object through the durability
        // callback and fetch, rather than serializing an equivalent copy.
        preparedCloneRequest = Object.freeze({
          ...preparedCloneRequest,
          bytes: preparedTask5Request.bytes,
          sha256: preparedTask5Request.wireRequestSha256,
        });
      }
    } catch (error) {
      if (job.canaryRunId) {
        const run = await prisma.reviewRun.findUnique({ where: { id: job.canaryRunId } });
        if (run && !["aborted_no_go", "completed_no_go", "reviewable"].includes(run.runState)) {
          await abortHeroVoiceCanaryRunWithinSerializedMutation({
            runId: run.id,
            ownerHmac: run.ownerHmac,
            reason: "application_request_preparation_failed",
          });
        }
      }
      const code = error instanceof HeroVoiceCloneConfigError ? "CLONE_CONFIG_UNAVAILABLE" : "CLONE_IDENTITY_INVALID";
      return failAndRefundVoiceJob(job, state, code, "Hero Voice clone cannot be prepared", "failed_identity");
    }
  }
  const dispatchIntentAt = new Date();
  const dispatchLeaseExpiresAt = new Date(dispatchIntentAt.getTime() + CLONE_DISPATCH_LEASE_MS);
  const claimed = await prisma.$transaction(async (tx) => {
    const currentJob = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId: job.userId } });
    const currentAttempts = await tx.aiGenerationAttempt.findMany({
      where: { jobId: job.id },
      orderBy: { sequence: "asc" },
    });
    const currentState = parseState(currentJob?.inputJson ?? null);
    if (!currentJob || currentJob.chargeState !== "reserved"
      || !ACTIVE_CLONE_JOB_STATUSES.includes(currentJob.status as typeof ACTIVE_CLONE_JOB_STATUSES[number])
      || (cloneMode && (!currentState || !validateCloneDurableIdentity(currentJob, currentState, currentAttempts)))) {
      return false;
    }
    const update = await tx.aiGenerationAttempt.updateMany({
      where: {
        id: attempt.id,
        status: "planned",
        dispatchIntentAt: null,
        submissionDisposition: "not_dispatched",
      },
      data: {
        status: "submitting",
        ...(cloneMode ? {
          dispatchIntentAt,
          dispatchLeaseExpiresAt,
          submissionDisposition: "intent_committed",
        } : {}),
      },
    });
    return update.count === 1;
  });
  if (!claimed) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });

  try {
    const mode = generationMode(state);
    let submitted: { providerJobId: string; status: "IN_QUEUE" | "IN_PROGRESS" };
    let canaryProviderAcceptanceCommitted = false;
    if (mode === "clone") {
      submitted = await submitRunpodHeroVoiceCloneJob({
        snapshot: cloneSnapshot!,
        gate: heroVoiceCloneHumanDataGate(),
        text: chunk.speechText,
        refAudioBase64: cloneRef!.audioBase64,
        refText: cloneRef!.refText,
        prepared: preparedCloneRequest!,
        beforeDispatch: async (prepared) => {
          if (preparedTask5Request && job.canaryRunId && job.canarySlotId) {
            await commitHeroVoiceCanaryDispatchIntentWithinSerializedMutation({
              runId: job.canaryRunId,
              ownerHmac: (await prisma.reviewRun.findUniqueOrThrow({ where: { id: job.canaryRunId } })).ownerHmac,
              slotId: job.canarySlotId,
              prepared: preparedTask5Request,
              nowMs: dispatchIntentAt.getTime(),
            });
            return;
          }
          const durable = await prisma.aiGenerationAttempt.findUnique({ where: { id: attempt.id } });
          if (!durable || durable.status !== "submitting" || durable.submissionDisposition !== "intent_committed"
            || durable.dispatchIntentAt === null || prepared.attemptId !== durable.id) {
            throw new HeroVoiceGenerationError("Hero Voice dispatch intent is unavailable", "CLONE_DISPATCH_INTENT_INVALID", 500);
          }
        },
      });
      if (preparedTask5Request && job.canaryRunId && job.canarySlotId) {
        const run = await prisma.reviewRun.findUniqueOrThrow({ where: { id: job.canaryRunId } });
        await recordHeroVoiceCanarySubmissionWithinSerializedMutation({
          runId: job.canaryRunId,
          ownerHmac: run.ownerHmac,
          slotId: job.canarySlotId,
          disposition: "provider_accepted",
          providerJobId: submitted.providerJobId,
          observedAtMs: Date.now(),
          acceptedGeneration: {
            jobId: job.id,
            attemptId: attempt.id,
            providerStatus: submitted.status,
          },
        });
        canaryProviderAcceptanceCommitted = true;
      }
    } else {
      const config = pinnedStockRunpodConfig(job, state);
      const request: RunpodOmniVoiceRequest = {
        mode: "tts",
        voiceId: state.voiceId,
        text: chunk.speechText,
        speed: state.speed,
      };
      submitted = await submitRunpodOmniVoiceJob(config, request);
    }
    const now = new Date();
    const updated = canaryProviderAcceptanceCommitted
      ? {
          job: await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } }),
          primaryStillActive: true,
        }
      : await prisma.$transaction(async (tx) => {
      const currentAttempt = await tx.aiGenerationAttempt.findUnique({ where: { id: attempt.id } });
      const currentJob = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId: job.userId } });
      if (!currentAttempt || !currentJob) {
        throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
      }
      const primaryStillActive = currentAttempt.status === "submitting"
        && ACTIVE_CLONE_JOB_STATUSES.includes(currentJob.status as typeof ACTIVE_CLONE_JOB_STATUSES[number])
        && currentJob.chargeState === "reserved";
      const recorded = await tx.aiGenerationAttempt.updateMany({
        where: {
          id: attempt.id,
          providerJobId: null,
          ...(cloneMode
            ? { submissionDisposition: { in: ["intent_committed", "transport_unknown"] } }
            : { status: "submitting" }),
        },
        data: {
          providerJobId: submitted.providerJobId,
          status: primaryStillActive
            ? submitted.status === "IN_PROGRESS" ? "in_progress" : "queued"
            : currentAttempt.status,
          ...(cloneMode ? {
            submissionDisposition: "provider_accepted",
            providerResponseAt: now,
            dispatchLeaseExpiresAt: null,
          } : {}),
          submittedAt: now,
        },
      });
      if (recorded.count !== 1) throw new Error("Hero Voice attempt changed before provider id was recorded");
      await tx.aiGenerationJob.update({
        where: { id: job.id },
        data: {
          providerJobId: submitted.providerJobId,
          status: primaryStillActive
            ? submitted.status === "IN_PROGRESS" ? "in_progress" : "queued"
            : currentJob.status,
          startedAt: primaryStillActive && submitted.status === "IN_PROGRESS"
            ? (currentJob.startedAt ?? now)
            : currentJob.startedAt,
        },
      });
      return { job: await tx.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } }), primaryStillActive };
      });
    await recordVoiceEvent(job.userId, "omnivoice_provider_submitted", {
      aiGenerationJobId: job.id,
      providerJobId: submitted.providerJobId,
      endpointId: job.providerEndpoint ?? "",
      sequence: attempt.sequence,
      segments: state.chunks.length,
      mode,
    });
    if (!updated.primaryStillActive) {
      return recordCloneCancelOnce(updated.job);
    }
    return updated.job;
  } catch (error) {
    if (cloneMode && preparedTask5Request && job.canaryRunId && job.canarySlotId) {
      const run = await prisma.reviewRun.findUnique({ where: { id: job.canaryRunId } });
      if (run && run.inFlightSlotId === job.canarySlotId) {
        const disposition = error instanceof HeroVoiceCloneProviderError && error.kind === "submit_rejected"
          ? "provider_rejected" as const : "transport_unknown" as const;
        await recordHeroVoiceCanarySubmissionWithinSerializedMutation({
          runId: run.id,
          ownerHmac: run.ownerHmac,
          slotId: job.canarySlotId,
          disposition,
        });
      } else if (run && !["aborted_no_go", "completed_no_go", "reviewable"].includes(run.runState)) {
        await abortHeroVoiceCanaryRunWithinSerializedMutation({
          runId: run.id,
          ownerHmac: run.ownerHmac,
          reason: "application_pre_dispatch_failure",
        });
      }
    }
    if (cloneMode && error instanceof HeroVoiceCloneProviderError) {
      if (error.kind === "submit_unknown") {
        await prisma.aiGenerationAttempt.updateMany({
          where: { id: attempt.id, submissionDisposition: "intent_committed" },
          data: {
            submissionDisposition: "transport_unknown",
            providerResponseAt: new Date(),
            dispatchLeaseExpiresAt: null,
          },
        });
        return failAndRefundVoiceJob(
          job,
          state,
          "CLONE_SUBMIT_OUTCOME_UNKNOWN",
          "Hero Voice clone submission outcome is unknown",
          "failed_unknown_submit",
        );
      }
      if (error.kind === "submit_rejected") {
        await prisma.aiGenerationAttempt.updateMany({
          where: { id: attempt.id, submissionDisposition: "intent_committed" },
          data: {
            submissionDisposition: "provider_rejected",
            providerResponseAt: new Date(),
            dispatchLeaseExpiresAt: null,
          },
        });
        return failAndRefundVoiceJob(
          job,
          state,
          "CLONE_SUBMIT_REJECTED",
          "Hero Voice clone submission was rejected",
        );
      }
      return failAndRefundVoiceJob(
        job,
        state,
        error.kind === "identity" ? "CLONE_IDENTITY_INVALID" : "CLONE_OUTPUT_INVALID",
        "Hero Voice clone request validation failed",
        error.kind === "identity" ? "failed_identity" : "failed_output",
      );
    }
    if (cloneMode && error instanceof HeroVoiceCloneConfigError) {
      return failAndRefundVoiceJob(
        job,
        state,
        "CLONE_CONFIG_UNAVAILABLE",
        "Hero Voice clone configuration is unavailable",
      );
    }
    const message = error instanceof Error ? error.message : "Hero Voice provider submission failed";
    if (error instanceof OmniVoiceProviderError) {
      const code = error.status === 429
        ? "OMNIVOICE_PROVIDER_RATE_LIMITED"
        : "OMNIVOICE_PROVIDER_SUBMIT_REJECTED";
      return failAndRefundVoiceJob(job, state, code, message);
    }
    // A stock connection failure can happen after RunPod accepted the POST. Keep the
    // attempt in "submitting" briefly and never replay it without a provider id.
    await recordVoiceEvent(job.userId, "omnivoice_provider_submit_unknown", {
      aiGenerationJobId: job.id,
      endpointId: job.providerEndpoint ?? "",
      sequence: attempt.sequence,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  }
}

export type StartHeroVoiceGenerationInput = {
  userId: string;
  plan: Plan;
  text: string;
  voiceId: string;
  speed: number;
  studio: boolean;
  cloneCanarySurface?: "ai-studio";
  /** Server-owned immutable manifest seed. Browser routes must not expose it. */
  cloneSeed?: number;
  /** Present only for the authenticated loopback submit-by-slot route. The
   * capability is consumed atomically with reservation/job creation. */
  canaryAdmission?: Readonly<{
    ownerHmac: string;
    capabilityBytes: Buffer;
    submitHmac: string;
  }>;
  idempotencyKey: string;
  backend?: "runpod" | "hostinger";
};

async function startHeroVoiceGenerationUnlocked(
  input: StartHeroVoiceGenerationInput,
): Promise<{ job: AiGenerationJob; created: boolean }> {
  const fullText = input.text.trim();
  if (!fullText) throw new HeroVoiceGenerationError("text required", "OMNIVOICE_TEXT_REQUIRED", 400);
  const planCap = omnivoiceScriptCharCapForPlan(input.plan);
  if (fullText.length > planCap) {
    throw new HeroVoiceGenerationError(
      `สคริปต์ยาวเกินแพ็กเกจ กรุณาย่อให้ไม่เกินประมาณ ${planCap.toLocaleString("th-TH")} ตัวอักษร`,
      "OMNIVOICE_SCRIPT_TOO_LONG",
      413,
    );
  }
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.idempotencyKey)) {
    throw new HeroVoiceGenerationError("idempotencyKey ไม่ถูกต้อง", "INVALID_IDEMPOTENCY_KEY", 400);
  }
  if (!Number.isFinite(input.speed) || input.speed < 0.3 || input.speed > 3) {
    throw new HeroVoiceGenerationError("speed ไม่ถูกต้อง", "OMNIVOICE_SPEED_INVALID", 400);
  }
  const mode = isUserVoiceId(input.voiceId) ? "clone" : "tts";
  const requiresCanaryAdmission = mode === "clone"
    && process.env.HERO_VOICE_CANARY_EXECUTION_MODE === "1"
    && heroVoiceCanaryDeletionConfigured();
  let cloneRef: Awaited<ReturnType<typeof loadUserVoiceRef>> = null;
  if (mode === "clone") {
    await assertHeroVoiceCanaryMutationReady();
    if (input.cloneCanarySurface !== "ai-studio") {
      throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
    }
    await requireHeroVoiceCloneCanaryActor(input.userId);
    cloneRef = await loadUserVoiceRef(input.userId, input.voiceId);
    if (!cloneRef) throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
    if (requiresCanaryAdmission !== Boolean(input.canaryAdmission)) {
      throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
    }
  } else if (input.cloneCanarySurface !== undefined || input.cloneSeed !== undefined) {
    throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
  }
  if (!requiresCanaryAdmission) {
    const existing = await prisma.aiGenerationJob.findFirst({
      where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return {
        job: await reconcileExistingHeroVoiceGeneration(existing, { mode, voiceId: input.voiceId }),
        created: false,
      };
    }
  }

  // This is deliberately a read-only inspection. The nonce is consumed only
  // later, inside the same transaction that reserves credits and creates the
  // job and attempt. It gives preparation the manifest-owned slot identity
  // without opening a second durable-intent owner.
  const inspectedAdmission = requiresCanaryAdmission
    ? await inspectHeroVoiceCanaryAdmission({
        ownerHmac: input.canaryAdmission!.ownerHmac,
        capabilityBytes: input.canaryAdmission!.capabilityBytes,
        submitHmac: input.canaryAdmission!.submitHmac,
      })
    : null;

  const cloneConfig = mode === "clone" ? heroVoiceCloneConfig() : null;
  const config = cloneConfig ?? omnivoiceConfig(input.backend);
  if (config.backend !== "runpod") {
    throw new HeroVoiceGenerationError(
      "Durable Hero Voice รองรับเฉพาะ RunPod backend",
      "OMNIVOICE_DURABLE_BACKEND_UNSUPPORTED",
      409,
    );
  }
  if (mode === "clone") heroVoiceCloneHumanDataGate();

  const admittedScript = inspectedAdmission
    ? HERO_VOICE_CANARY_SCRIPTS.find((script) => script.scriptId === inspectedAdmission.slot.scriptId)
    : undefined;
  if (inspectedAdmission && admittedScript?.sourceText !== fullText) {
    throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
  }
  const chunks = inspectedAdmission && admittedScript
    ? [{
        text: admittedScript.sourceText,
        speechText: speechTextForHeroVoiceCanarySlot(inspectedAdmission.slot),
        risks: [],
      }]
    : splitHeroVoiceScriptForTts(fullText, config.maxChunkChars);
  const speechRisks = [...new Map(
    chunks.flatMap((chunk) => chunk.risks).map((risk) => [risk.code, risk]),
  ).values()];
  const blocking = speechRisks.filter((risk) => risk.severity === "block");
  if (blocking.length > 0) {
    throw new HeroVoiceGenerationError(
      "Hero Voice พบสัญลักษณ์ที่ยังไม่มีคำอ่านภาษาไทย กรุณาเขียนสัญลักษณ์นั้นเป็นคำแล้วลองใหม่",
      "OMNIVOICE_SPEECH_TOKEN_UNSUPPORTED",
      422,
    );
  }

  const cloneSnapshots = mode === "clone" && cloneRef
    ? (() => {
        const referenceBytes = Buffer.from(cloneRef.audioBase64, "base64");
        const { pcm: referencePcm, sampleRate: referenceSampleRate } = pcmFromWav(referenceBytes);
        const referenceDurationSamples24000 = Math.round(
          (referencePcm.length / 2) * 24_000 / referenceSampleRate,
        );
        return chunks.map((chunk, index) => {
          const seed = input.cloneSeed === undefined ? randomInt(0, 2_147_483_648) : input.cloneSeed;
          if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) {
            throw new HeroVoiceGenerationError("clone seed ไม่ถูกต้อง", "CLONE_SEED_INVALID", 400);
          }
          return createCandidateAiStudioV3Snapshot({
            config: cloneConfig!,
            attemptId: randomUUID(),
            sequence: index + 1,
            normalizerVersion: inspectedAdmission?.slot.normalizerVersion
              ?? HERO_VOICE_SPEECH_NORMALIZER_VERSION,
            speed: input.speed,
            seed,
            text: chunk.speechText,
            refAudioSha256: sha256Hex(referenceBytes),
            refDurationSamples24000: referenceDurationSamples24000,
            refText: cloneRef.refText,
          });
        });
      })()
    : undefined;
  if (cloneSnapshots?.some((snapshot) => snapshotContainsForbiddenReferenceData(snapshot))) {
    throw new HeroVoiceGenerationError(
      "Hero Voice clone snapshot ไม่ผ่านข้อกำหนดข้อมูลส่วนตัว",
      "CLONE_SNAPSHOT_PRIVACY_INVALID",
      500,
    );
  }
  const window = requiresCanaryAdmission
    ? await prisma.user.findUnique({
        where: { id: input.userId },
        select: { minutesLimit: true, minutesUsed: true, aiAudioMinutesUsed: true },
      })
    : await syncMinuteWindow(input.userId);
  if (!window) throw new HeroVoiceGenerationError("ไม่พบผู้ใช้", "USER_NOT_FOUND", 404);
  const aiReservedMin = estimateTtsAudioMinutes(chunks.map((chunk) => chunk.text).join(""));
  const studioReservedMin = input.studio ? Math.max(1, Math.ceil(aiReservedMin)) : 0;
  const ceiling = aiAudioCeilingFor(window.minutesLimit);
  const state: HeroVoiceGenerationStateV1 = {
    version: STATE_VERSION,
    mode,
    ...(mode === "clone" ? { cloneCanarySurface: input.cloneCanarySurface } : {}),
    voiceId: input.voiceId,
    speed: input.speed,
    backend: "runpod",
    providerDeadlineAt: new Date(Date.now() + config.requestBudgetMs).toISOString(),
    aiReservedMin,
    studioReservedMin,
    speechNormalizerVersion: inspectedAdmission?.slot.normalizerVersion
      ?? HERO_VOICE_SPEECH_NORMALIZER_VERSION,
    speechRiskCategories: speechRisks.map((risk) => risk.code).sort(),
    chunks: chunks.map((chunk) => ({ text: chunk.text, speechText: chunk.speechText })),
    ...(cloneSnapshots ? { cloneSnapshots } : {}),
  };

  const jobId = randomUUID();
  let created: AiGenerationJob;
  let createdInTransaction = true;
  try {
    created = await prisma.$transaction(async (tx) => {
      const admitted = requiresCanaryAdmission
        ? await consumeHeroVoiceCanaryAdmissionInTransaction(tx, {
            ownerHmac: input.canaryAdmission!.ownerHmac,
            capabilityBytes: input.canaryAdmission!.capabilityBytes,
            submitHmac: input.canaryAdmission!.submitHmac,
            jobId,
          })
        : null;
      if (mode === "clone") {
        await assertNoCanaryAccountDeletionInTransaction(tx, input.userId);
        const voiceRowId = input.voiceId.slice("user_".length);
        const unclaimedVoice = await tx.userVoice.findFirst({
          where: {
            id: voiceRowId,
            userId: input.userId,
            deletionTransactionId: null,
          },
          select: { id: true },
        });
        if (!unclaimedVoice) {
          throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
        }
        if (admitted) {
          const script = HERO_VOICE_CANARY_SCRIPTS.find((item) => item.scriptId === admitted.slot.scriptId);
          const snapshot = cloneSnapshots?.[0];
          const admissionMatches = admitted.referenceVoiceId === input.voiceId
            && admitted.runId === inspectedAdmission?.runId
            && admitted.slotId === inspectedAdmission.slotId
            && admitted.manifestSha256 === inspectedAdmission.manifestSha256
            && admitted.slot.runnerKind === "CandidateAiStudioV3"
            && admitted.slot.phase === "candidate"
            && input.studio === true
            && input.speed === admitted.slot.matchedSettings.speed
            && input.cloneSeed === admitted.slot.arm.seed
            && chunks.length === 1
            && script?.sourceText === fullText
            && chunks[0]?.speechText === (admitted.slot.speechTextKind === "source" ? script.sourceText : script.speechText)
            && snapshot?.endpointId === admitted.slot.endpointId
            && snapshot?.imageDigest === admitted.slot.imageDigest
            && snapshot?.sourceRevision === admitted.slot.sourceRevision
            && snapshot?.modelManifestSha256 === admitted.slot.modelManifestSha256
            && snapshot?.workerVersion === admitted.slot.expectedWorkerVersion
            && snapshot?.referenceSha256 === admitted.slot.referenceSha256
            && snapshot?.synthesis.textSha256 === admitted.slot.speechTextSha256
            && snapshot?.synthesis.requestCommitmentSha256 === admitted.slot.requestCommitmentSha256
            && snapshot?.synthesis.matchedSettingsSha256 === admitted.slot.matchedSettingsSha256;
          if (!admissionMatches) {
            throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
          }
        }
      }
      if (!requiresCanaryAdmission) {
        const raced = await tx.aiGenerationJob.findFirst({
          where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
        });
        if (raced) {
          createdInTransaction = false;
          return raced;
        }
      }
      const reserved = await tx.$executeRaw`UPDATE "User" SET
        "aiAudioMinutesUsed" = "aiAudioMinutesUsed" + ${aiReservedMin},
        "minutesUsed" = "minutesUsed" + ${studioReservedMin}
        WHERE "id" = ${input.userId}
          AND "aiAudioMinutesUsed" + ${aiReservedMin} <= ${ceiling}
          AND "minutesUsed" + ${studioReservedMin} <= "minutesLimit"`;
      const reservationAccepted = reserved === 1;
      let errorCode: string | null = null;
      let errorMessage: string | null = null;
      if (!reservationAccepted) {
        const user = await tx.user.findUnique({
          where: { id: input.userId },
          select: { aiAudioMinutesUsed: true, minutesUsed: true, minutesLimit: true },
        });
        if (!user) throw new HeroVoiceGenerationError("ไม่พบผู้ใช้", "USER_NOT_FOUND", 404);
        const aiUnavailable = user.aiAudioMinutesUsed + aiReservedMin > ceiling;
        errorCode = aiUnavailable ? "QUOTA_AI_AUDIO" : "QUOTA_MINUTES";
        errorMessage = aiUnavailable
          ? `ใช้เสียง AI ครบเพดานรอบนี้แล้ว (${input.plan})`
          : "นาทีในแพ็กเกจไม่พอสำหรับสร้างเสียงนี้";
        if (requiresCanaryAdmission) {
          throw new HeroVoiceGenerationError(errorMessage, errorCode, 409);
        }
      }
      const durableState = reservationAccepted
        ? state
        : { ...state, aiReservedMin: 0, studioReservedMin: 0 };
      const finishedAt = reservationAccepted ? undefined : new Date();
      return tx.aiGenerationJob.create({
        data: {
        id: jobId,
        userId: input.userId,
        kind: "voice",
        provider: "runpod",
        model: input.voiceId,
        providerModel: mode === "clone" ? "omnivoice-clone" : "omnivoice",
        providerRoute: "runpod-custom",
        providerEndpoint: config.endpointId,
        productSurface: mode === "clone" ? "ai_studio" : undefined,
        status: reservationAccepted ? "queued" : "failed",
        inputPreview: fullText.replace(/\s+/g, " ").slice(0, 180),
        inputJson: serializeState(durableState),
        creditCost: 0,
        chargeState: reservationAccepted ? "reserved" : "none",
        reservedAiAudioMinutes: reservationAccepted ? aiReservedMin : 0,
        reservedStudioMinutes: reservationAccepted ? studioReservedMin : 0,
        errorCode,
        errorMessage,
        finishedAt,
        idempotencyKey: requiresCanaryAdmission ? null : input.idempotencyKey,
        ...(admitted ? { canaryRunId: admitted.runId, canarySlotId: admitted.slotId } : {}),
        mediaExpiresAt: videoExpiryFor(input.plan),
        attempts: {
          create: {
            ...(cloneSnapshots ? { id: cloneSnapshots[0].attemptId, inputJson: JSON.stringify(cloneSnapshots[0]) } : {}),
            sequence: 1,
            provider: "runpod",
            providerModel: mode === "clone" ? "omnivoice-clone" : "omnivoice",
            providerRoute: "runpod-custom",
            providerEndpoint: config.endpointId,
            status: reservationAccepted ? "planned" : "failed",
            estimatedCostUsdMicros: 0,
            errorCode,
            errorMessage,
            finishedAt,
          },
        },
        },
      });
    });
  } catch (error) {
    if (requiresCanaryAdmission && (error as { code?: string })?.code === "P2002") {
      throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
    }
    if ((error as { code?: string })?.code === "P2002") {
      const raced = await prisma.aiGenerationJob.findFirst({
        where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
      });
      if (raced) {
        return {
          job: await reconcileExistingHeroVoiceGeneration(raced, { mode, voiceId: input.voiceId }),
          created: false,
        };
      }
    }
    throw error;
  }
  if (!createdInTransaction) {
    return {
      job: await reconcileExistingHeroVoiceGeneration(created, { mode, voiceId: input.voiceId }),
      created: false,
    };
  }
  if (created.status === "failed") {
    throw new HeroVoiceGenerationError(
      created.errorMessage ?? "ไม่สามารถจองโควตา Hero Voice ได้",
      created.errorCode ?? "OMNIVOICE_RESERVATION_FAILED",
      409,
    );
  }
  const submitted = await submitPendingAttempt(created);
  return { job: submitted, created: true };
}

export async function startHeroVoiceGeneration(
  input: StartHeroVoiceGenerationInput,
): Promise<{ job: AiGenerationJob; created: boolean }> {
  return runHeroVoiceCanarySerializedMutation(() => startHeroVoiceGenerationUnlocked(input));
}

async function finalizeVoiceJob(job: AiGenerationJob, state: HeroVoiceGenerationStateV1): Promise<AiGenerationJob> {
  const pcms: Buffer[] = [];
  let sampleRate = 0;
  for (const [index, chunk] of state.chunks.entries()) {
    if (!chunk.partFilename) {
      throw new HeroVoiceGenerationError("Hero Voice chunk file หาย", "OMNIVOICE_CHUNK_FILE_MISSING", 500);
    }
    const sourcePath = generationPartFilePath(job.id, index + 1, state);
    if (path.basename(sourcePath) !== chunk.partFilename) {
      throw new HeroVoiceGenerationError("Hero Voice chunk path ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
    }
    const source = fs.readFileSync(sourcePath);
    const parsed = pcmFromWav(source);
    if (sampleRate === 0) sampleRate = parsed.sampleRate;
    if (sampleRate !== parsed.sampleRate) {
      throw new HeroVoiceGenerationError("Hero Voice ส่ง sample rate ไม่สม่ำเสมอ", "OMNIVOICE_SAMPLE_RATE_MISMATCH", 502);
    }
    pcms.push(parsed.pcm);
  }

  const cloneMode = generationMode(state) === "clone";
  const filename = finalFilename(job.id);
  const filePath = cloneMode
    ? heroVoiceCloneAudioFilePath(job.id)
    : path.join(ensureRendersDir(), filename);
  if (!filePath) throw new HeroVoiceGenerationError("Hero Voice job id ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  fs.writeFileSync(filePath, wavFromPcm(Buffer.concat(pcms), sampleRate), { mode: cloneMode ? 0o600 : 0o644 });
  if (cloneMode) {
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }
  const audioDurationMs = state.chunks.reduce((sum, chunk) => sum + (chunk.durationMs ?? 0), 0);
  const silences = await detectSilences(filePath);
  const result: HeroVoiceGenerationResult = {
    voiceUrl: cloneMode
      ? `/api/ai-studio/voice-audio/${encodeURIComponent(job.id)}`
      : `/api/renders/${filename}`,
    audioDurationMs,
    timing: {
      provider: "omnivoice",
      segments: mergeSegmentTiming(state.chunks.map((chunk) => ({
        text: chunk.text,
        durationMs: chunk.durationMs ?? 0,
      }))),
      chars: null,
      silences: silences.midpoints,
      silenceIntervals: silences.intervals,
    },
  };
  const settledState = { ...state, result };
  const actualAiMinutes = audioDurationMs / 60_000;
  const actualStudioMinutes = job.reservedStudioMinutes > 0 ? Math.max(1, Math.ceil(actualAiMinutes)) : 0;
  const aiDelta = actualAiMinutes - job.reservedAiAudioMinutes;
  const studioDelta = actualStudioMinutes - job.reservedStudioMinutes;

  const completed = await prisma.$transaction(async (tx) => {
    const owned = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId: job.userId } });
    if (!owned) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
    if (cloneMode ? isHeroVoiceCloneTerminalStatus(owned.status) : ["completed", "failed", "canceled"].includes(owned.status)) {
      return owned;
    }
    if (owned.chargeState !== "reserved") {
      throw new HeroVoiceGenerationError(
        "Hero Voice reservation state ไม่ถูกต้อง",
        cloneMode ? "CLONE_SETTLEMENT_INVALID" : "OMNIVOICE_SETTLEMENT_INVALID",
        500,
      );
    }
    if (cloneMode && !cloneReservationMatchesTrustedColumns(owned, state)) {
      throw new HeroVoiceGenerationError(
        "Hero Voice clone reservation identity ไม่ถูกต้อง",
        "CLONE_SETTLEMENT_INVALID",
        500,
      );
    }
    const user = await tx.user.findUnique({
      where: { id: job.userId },
      select: { minutesUsed: true, minutesLimit: true },
    });
    if (!user) throw new HeroVoiceGenerationError("ไม่พบผู้ใช้", "USER_NOT_FOUND", 404);
    if (studioDelta > 0 && user.minutesUsed + studioDelta > user.minutesLimit) {
      throw new HeroVoiceGenerationError("นาทีในแพ็กเกจไม่พอสำหรับเสียงที่สร้างเสร็จ", "QUOTA_MINUTES", 409);
    }
    await tx.user.update({
      where: { id: job.userId },
      data: {
        ...(aiDelta !== 0 ? { aiAudioMinutesUsed: { increment: aiDelta } } : {}),
        ...(studioDelta !== 0 ? { minutesUsed: { increment: studioDelta } } : {}),
      },
    });
    const now = new Date();
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        chargeState: "settled",
        outputUrl: result.voiceUrl,
        inputJson: serializeState(settledState),
        delayTimeMs: state.chunks.reduce((sum, chunk) => sum + (chunk.delayTimeMs ?? 0), 0),
        executionTimeMs: state.chunks.reduce((sum, chunk) => sum + (chunk.executionTimeMs ?? 0), 0),
        finishedAt: now,
      },
    });
  }).catch(async (error) => {
    try { fs.unlinkSync(filePath); } catch {}
    if (error instanceof HeroVoiceGenerationError && error.code === "QUOTA_MINUTES") {
      return failAndRefundVoiceJob(
        job,
        state,
        error.code,
        error.message,
        cloneMode ? "failed" : "failed",
      );
    }
    if (cloneMode && error instanceof HeroVoiceGenerationError) {
      return failAndRefundVoiceJob(
        job,
        state,
        "CLONE_SETTLEMENT_FAILED",
        "Hero Voice clone settlement failed",
      );
    }
    throw error;
  });

  if (completed.status === "completed") {
    removeParts(job.id, state);
    await recordVoiceEvent(job.userId, generationMode(state) === "clone" ? "omnivoice_clone" : "omnivoice_tts", {
      aiGenerationJobId: job.id,
      providerJobIds: state.chunks.map((chunk) => chunk.providerJobId).filter(Boolean).join(","),
      endpointId: job.providerEndpoint ?? "",
      scriptChars: state.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      audioDurationMs,
      providerDelayTimeMs: completed.delayTimeMs ?? 0,
      providerExecutionTimeMs: completed.executionTimeMs ?? 0,
      backend: state.backend,
      mode: generationMode(state),
      numStep: [...new Set(state.chunks.map((chunk) => chunk.numStep).filter((value) => value !== undefined))].join(","),
      workerVersions: [...new Set(state.chunks.map((chunk) => chunk.workerVersion).filter(Boolean))].join(","),
      catalogVersions: [...new Set(state.chunks.map((chunk) => chunk.catalogVersion).filter(Boolean))].join(","),
      languageHints: [...new Set(state.chunks.map((chunk) => chunk.language).filter(Boolean))].join(","),
      segments: state.chunks.length,
      speechNormalizerVersion: state.speechNormalizerVersion,
      speechRiskCategories: state.speechRiskCategories.join(","),
    });
  } else {
    try { fs.unlinkSync(filePath); } catch {}
  }
  return completed;
}

async function finalizeVoiceJobTerminally(
  job: AiGenerationJob,
  state: HeroVoiceGenerationStateV1,
): Promise<AiGenerationJob> {
  try {
    return await finalizeVoiceJob(job, state);
  } catch (error) {
    if (generationMode(state) === "clone") {
      return failAndRefundVoiceJob(
        job,
        state,
        "CLONE_OUTPUT_INVALID",
        "Hero Voice clone output could not be finalized",
        "failed_output",
      );
    }
    throw error;
  }
}

/**
 * The ASR gate rejected the audio of the current chunk: swap its immutable
 * snapshot for one with the next seed (new attempt id, same sequence), replace
 * the attempt row under the poll lease, and dispatch it. The rejected
 * generation stays on record in `state.asrGate` (attempt id, provider job id,
 * seed, dropped run) since its attempt row is replaced.
 */
async function replaceRejectedCloneAttempt(input: {
  job: AiGenerationJob;
  state: HeroVoiceGenerationStateV1;
  attempt: AiGenerationAttempt;
  chunk: HeroVoiceChunkState;
  currentSnapshot: CandidateAiStudioV3Snapshot;
  rejection: HeroVoiceAsrGateRejection;
  priorRejected: HeroVoiceAsrGateRejection[];
  pollLeaseToken: string;
  pollFailureCountAtLease: number;
}): Promise<AiGenerationJob> {
  const { job, state, attempt, chunk, currentSnapshot } = input;
  const cloneRef = await loadUserVoiceRef(job.userId, state.voiceId);
  if (!cloneRef) {
    return failAndRefundVoiceJob(job, state, "USER_VOICE_REFERENCE_MISSING", "ไม่พบไฟล์อ้างอิงของเสียงโคลนนี้", "failed_identity");
  }
  let replacement: CandidateAiStudioV3Snapshot;
  try {
    replacement = createCandidateAiStudioV3Snapshot({
      // Pin every identity field to the rejected snapshot so the retry differs by seed only.
      config: {
        ...heroVoiceCloneConfig(),
        endpointId: currentSnapshot.endpointId,
        imageDigest: currentSnapshot.imageDigest,
        sourceRevision: currentSnapshot.sourceRevision,
        modelManifestSha256: currentSnapshot.modelManifestSha256,
        experimentProfile: currentSnapshot.experimentProfile,
      },
      attemptId: randomUUID(),
      sequence: attempt.sequence,
      normalizerVersion: currentSnapshot.normalizerVersion,
      speed: currentSnapshot.synthesis.speed,
      seed: (currentSnapshot.synthesis.seed + 1) % 2_147_483_648,
      text: chunk.speechText,
      refAudioSha256: currentSnapshot.referenceSha256,
      refDurationSamples24000: currentSnapshot.referenceDurationSamples24000,
      refText: cloneRef.refText,
    });
    if (!parseCandidateAiStudioV3Snapshot(replacement) || snapshotContainsForbiddenReferenceData(replacement)) {
      throw new HeroVoiceGenerationError("Hero Voice clone snapshot ไม่ถูกต้อง", "CLONE_SNAPSHOT_INVALID", 500);
    }
  } catch (error) {
    const code = error instanceof HeroVoiceCloneConfigError ? "CLONE_CONFIG_UNAVAILABLE" : "CLONE_SNAPSHOT_INVALID";
    return failAndRefundVoiceJob(job, state, code, "Hero Voice clone cannot be regenerated", "failed_identity");
  }
  const replacedState: HeroVoiceGenerationStateV1 = {
    ...state,
    cloneSnapshots: (state.cloneSnapshots ?? []).map((snapshot, index) => index === attempt.sequence - 1 ? replacement : snapshot),
    asrGate: mergeAsrGateChunk(state.asrGate, {
      sequence: attempt.sequence,
      attempts: input.priorRejected.length + 2,
      droppedRun: null,
      ears: 0,
      rejected: [...input.priorRejected, input.rejection],
    }),
  };
  const replaced = await prisma.$transaction(async (tx) => {
    const removed = await tx.aiGenerationAttempt.deleteMany({
      where: {
        id: attempt.id,
        pollLeaseToken: input.pollLeaseToken,
        pollFailureCount: input.pollFailureCountAtLease,
        status: { in: [...ACTIVE_CLONE_ATTEMPT_STATUSES] },
      },
    });
    if (removed.count !== 1) return false;
    await tx.aiGenerationAttempt.create({
      data: {
        id: replacement.attemptId,
        inputJson: JSON.stringify(replacement),
        jobId: job.id,
        sequence: attempt.sequence,
        provider: "runpod",
        providerModel: "omnivoice-clone",
        providerRoute: "runpod-custom",
        providerEndpoint: job.providerEndpoint,
        estimatedCostUsdMicros: 0,
      },
    });
    const updated = await tx.aiGenerationJob.updateMany({
      where: { id: job.id, status: { in: [...ACTIVE_CLONE_JOB_STATUSES] }, chargeState: "reserved" },
      data: { status: "in_progress", providerJobId: null, inputJson: serializeState(replacedState) },
    });
    if (updated.count !== 1) {
      throw new HeroVoiceGenerationError("Hero Voice job changed during poll", "CLONE_POLL_STALE", 409);
    }
    return true;
  }).catch((error) => {
    if (error instanceof HeroVoiceGenerationError && error.code === "CLONE_POLL_STALE") return false;
    throw error;
  });
  const current = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  if (!replaced) return current;
  return submitPendingAttempt(current);
}

async function advanceHeroVoiceGenerationUnlocked(userId: string, jobId: string): Promise<AiGenerationJob> {
  let job = await prisma.aiGenerationJob.findFirst({ where: { id: jobId, userId } });
  if (!job || job.kind !== "voice") {
    throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
  }
  const cloneCanaryJob = isHeroVoiceCloneDurableRecord(job);
  if (cloneCanaryJob) await assertHeroVoiceCanaryMutationReady();
  const attempts = await prisma.aiGenerationAttempt.findMany({
    where: { jobId: job.id },
    orderBy: { sequence: "asc" },
  });
  let state = parseState(job.inputJson);
  if (!state) {
    if (cloneCanaryJob) return failCorruptCloneJob(job);
    throw new HeroVoiceGenerationError("ข้อมูล durable Hero Voice ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  }
  const mode = generationMode(state);
  if (cloneCanaryJob && !validateCloneDurableIdentity(job, state, attempts)) {
    return failCorruptCloneJob(job);
  }
  if (cloneCanaryJob) {
    try {
      await requireHeroVoiceCloneCanaryActor(userId);
    } catch {
      const failed = await failAndRefundVoiceJob(
        job,
        state,
        "CLONE_POLICY_REVOKED",
        "Hero Voice clone policy is no longer valid",
        "failed_identity",
      );
      const known = attempts.at(-1);
      return known?.providerJobId || job.providerJobId ? recordCloneCancelOnce(failed) : failed;
    }
  }
  requireExistingHeroVoiceGenerationInvariant(job, { mode, voiceId: state.voiceId });
  if (mode === "clone" ? isHeroVoiceCloneTerminalStatus(job.status) : ["completed", "failed", "canceled"].includes(job.status)) {
    if (mode === "clone" && [
      "failed_timeout", "failed_poll_unavailable", "failed_provider_status", "failed_provider_missing", "canceled",
    ].includes(job.status)) {
      const terminalAttempt = await prisma.aiGenerationAttempt.findFirst({
        where: { jobId: job.id },
        orderBy: { sequence: "desc" },
      });
      if (terminalAttempt?.providerJobId && terminalAttempt.cancelDisposition === "not_requested") {
        return recordCloneCancelOnce(job);
      }
    }
    return job;
  }
  let attempt = await prisma.aiGenerationAttempt.findFirst({
    where: { jobId: job.id },
    orderBy: { sequence: "desc" },
  });
  if (!attempt) return failAndRefundVoiceJob(job, state, "OMNIVOICE_ATTEMPT_MISSING", "ไม่พบ Hero Voice provider attempt");
  if (attempt.status === "completed") {
    const completedChunk = state.chunks[attempt.sequence - 1];
    if (!completedChunk?.partFilename) {
      return failAndRefundVoiceJob(
        job,
        state,
        mode === "clone" ? "CLONE_OUTPUT_MISSING" : "OMNIVOICE_CHUNK_FILE_MISSING",
        "Hero Voice completed attempt is missing its private output",
        mode === "clone" ? "failed_output" : "failed",
      );
    }
    if (attempt.sequence === state.chunks.length) return finalizeVoiceJobTerminally(job, state);
  }
  if (attempt.status === "planned") return submitPendingAttempt(job);
  if (attempt.status === "submitting" && !attempt.providerJobId) {
    if (mode === "clone") {
      if (attempt.dispatchLeaseExpiresAt && Date.now() < attempt.dispatchLeaseExpiresAt.getTime()) return job;
      const claimedUnknown = await prisma.aiGenerationAttempt.updateMany({
        where: {
          id: attempt.id,
          status: "submitting",
          providerJobId: null,
          submissionDisposition: "intent_committed",
          dispatchLeaseExpiresAt: { lte: new Date() },
        },
        data: {
          submissionDisposition: "transport_unknown",
          providerResponseAt: new Date(),
          dispatchLeaseExpiresAt: null,
        },
      });
      if (claimedUnknown.count !== 1) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
      return failAndRefundVoiceJob(
        job,
        state,
        "CLONE_SUBMIT_OUTCOME_UNKNOWN",
        "Hero Voice clone submission outcome is unknown",
        "failed_unknown_submit",
      );
    }
    if (Date.now() - attempt.createdAt.getTime() >= SUBMISSION_UNKNOWN_AFTER_MS) {
      return failAndRefundVoiceJob(
        job,
        state,
        "OMNIVOICE_PROVIDER_SUBMIT_UNKNOWN",
        "Hero Voice submission outcome is unknown; the same provider job was not retried",
      );
    }
    return job;
  }
  const providerJobId = attempt.providerJobId;
  if (!providerJobId) {
    return failAndRefundVoiceJob(
      job,
      state,
      mode === "clone" ? "CLONE_SNAPSHOT_INVALID" : "OMNIVOICE_PROVIDER_ID_MISSING",
      mode === "clone" ? "Hero Voice clone provider identity is incomplete" : "Hero Voice provider job id หาย",
      mode === "clone" ? "failed_identity" : "failed",
    );
  }

  if (Date.now() >= Date.parse(state.providerDeadlineAt)) {
    if (mode === "clone") {
      return failCloneAndCancelKnownJob(
        job,
        state,
        "failed_timeout",
        "CLONE_TIMEOUT",
        "Hero Voice clone exceeded its immutable execution deadline",
      );
    }
    const config = pinnedStockRunpodConfig(job, state);
    const cancelled = await cancelRunpodOmniVoiceJob(config, providerJobId);
    await recordVoiceEvent(userId, "omnivoice_provider_timeout", {
      aiGenerationJobId: job.id,
      providerJobId,
      endpointId: job.providerEndpoint ?? "",
      cancelled,
      providerDeadlineAt: state.providerDeadlineAt,
    });
    return failAndRefundVoiceJob(
      job,
      state,
      "OMNIVOICE_PROVIDER_TIMEOUT",
      "Hero Voice ใช้เวลารอ provider เกินขอบเขตของงาน งานเดิมถูกยกเลิกแล้ว",
    );
  }

  let snapshot;
  let pollLeaseToken: string | null = null;
  let pollFailureCountAtLease: number | null = null;
  const releaseClaimedPollLease = async (): Promise<boolean> => {
    if (!pollLeaseToken || pollFailureCountAtLease === null) return true;
    const released = await prisma.aiGenerationAttempt.updateMany({
      where: {
        id: attempt!.id,
        pollLeaseToken,
        pollFailureCount: pollFailureCountAtLease,
        status: { in: [...ACTIVE_CLONE_ATTEMPT_STATUSES] },
      },
      data: { pollLeaseToken: null, pollLeaseExpiresAt: null },
    });
    return released.count === 1;
  };
  if (mode === "clone") {
    const leaseNow = new Date();
    pollLeaseToken = randomUUID();
    const leaseExpiresAt = new Date(leaseNow.getTime() + CLONE_POLL_LEASE_MS);
    const claimedPoll = await prisma.$transaction(async (tx) => {
      const currentJob = await tx.aiGenerationJob.findFirst({ where: { id: job!.id, userId } });
      const currentAttempt = await tx.aiGenerationAttempt.findUnique({ where: { id: attempt!.id } });
      const currentAttempts = await tx.aiGenerationAttempt.findMany({
        where: { jobId: job!.id },
        orderBy: { sequence: "asc" },
      });
      const currentState = parseState(currentJob?.inputJson ?? null);
      if (!currentJob || !currentAttempt || currentJob.chargeState !== "reserved"
        || !ACTIVE_CLONE_JOB_STATUSES.includes(currentJob.status as typeof ACTIVE_CLONE_JOB_STATUSES[number])
        || !ACTIVE_CLONE_ATTEMPT_STATUSES.includes(currentAttempt.status as typeof ACTIVE_CLONE_ATTEMPT_STATUSES[number])
        || !currentState || !validateCloneDurableIdentity(currentJob, currentState, currentAttempts)
        || currentAttempts.at(-1)?.id !== currentAttempt.id
        || (currentAttempt.nextPollAt !== null && currentAttempt.nextPollAt > leaseNow)
        || (currentAttempt.pollLeaseExpiresAt !== null && currentAttempt.pollLeaseExpiresAt > leaseNow)) return null;
      if (currentAttempt.pollFailureCount >= CLONE_POLL_BACKOFF_MS.length) {
        return { kind: "terminal" as const };
      }
      const expectedFailureCount = currentAttempt.pollFailureCount;
      const update = await tx.aiGenerationAttempt.updateMany({
        where: {
          id: currentAttempt.id,
          status: { in: [...ACTIVE_CLONE_ATTEMPT_STATUSES] },
          pollFailureCount: expectedFailureCount,
          OR: [{ pollLeaseExpiresAt: null }, { pollLeaseExpiresAt: { lte: leaseNow } }],
        },
        data: { pollLeaseToken, pollLeaseExpiresAt: leaseExpiresAt },
      });
      return update.count === 1
        ? {
            kind: "claimed" as const,
            failureCount: expectedFailureCount,
            providerJobId: currentAttempt.providerJobId!,
            snapshot: cloneSnapshotForAttempt(currentJob, currentState, currentAttempt),
          }
        : null;
    });
    if (!claimedPoll) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
    if (claimedPoll.kind === "terminal") {
      return failCloneAndCancelKnownJob(
        job,
        state,
        "failed_poll_unavailable",
        "CLONE_POLL_UNAVAILABLE",
        "Hero Voice clone provider status remained unavailable",
      );
    }
    pollFailureCountAtLease = claimedPoll.failureCount;
    try {
      snapshot = await pollRunpodHeroVoiceCloneJob(claimedPoll.snapshot, claimedPoll.providerJobId);
    } catch (error) {
      if (error instanceof HeroVoiceCloneProviderError && error.kind === "poll_transport") {
        const failureCount = claimedPoll.failureCount + 1;
        const nextPollAt = new Date(Date.now() + CLONE_POLL_BACKOFF_MS[Math.min(failureCount - 1, 2)]);
        await prisma.aiGenerationAttempt.updateMany({
          where: {
            id: attempt.id,
            pollLeaseToken,
            pollFailureCount: claimedPoll.failureCount,
            status: { in: [...ACTIVE_CLONE_ATTEMPT_STATUSES] },
          },
          data: {
            pollFailureCount: failureCount,
            nextPollAt,
            pollLeaseToken: null,
            pollLeaseExpiresAt: null,
          },
        });
        return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
      }
      if (error instanceof HeroVoiceCloneProviderError && error.kind === "provider_missing") {
        if (!await releaseClaimedPollLease()) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
        return failCloneAndCancelKnownJob(
          job,
          state,
          "failed_provider_missing",
          "CLONE_PROVIDER_JOB_MISSING",
          "Hero Voice clone provider job is unavailable",
        );
      }
      if (error instanceof HeroVoiceCloneProviderError && error.kind === "provider_status") {
        if (!await releaseClaimedPollLease()) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
        return failCloneAndCancelKnownJob(
          job,
          state,
          "failed_provider_status",
          "CLONE_PROVIDER_STATUS_INVALID",
          "Hero Voice clone provider returned an invalid status",
        );
      }
      if (error instanceof HeroVoiceCloneProviderError && error.kind === "identity") {
        if (!await releaseClaimedPollLease()) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
        return failAndRefundVoiceJob(
          job,
          state,
          "CLONE_IDENTITY_MISMATCH",
          "Hero Voice clone provider identity did not match the immutable snapshot",
          "failed_identity",
        );
      }
      if (error instanceof HeroVoiceCloneProviderError && error.kind === "output") {
        if (!await releaseClaimedPollLease()) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
        return failAndRefundVoiceJob(
          job,
          state,
          "CLONE_OUTPUT_INVALID",
          "Hero Voice clone provider output was invalid",
          "failed_output",
        );
      }
      if (!await releaseClaimedPollLease()) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
      return failCloneAndCancelKnownJob(
        job,
        state,
        "failed_poll_unavailable",
        "CLONE_POLL_UNAVAILABLE",
        "Hero Voice clone provider status remained unavailable",
      );
    }
  } else {
    const config = pinnedStockRunpodConfig(job, state);
    try {
      snapshot = await pollRunpodOmniVoiceJob(config, providerJobId, mode);
    } catch (error) {
      await recordVoiceEvent(userId, "omnivoice_provider_poll_error", {
        aiGenerationJobId: job.id,
        providerJobId,
        endpointId: job.providerEndpoint ?? "",
        status: error instanceof OmniVoiceProviderError ? error.status : 0,
      });
      return job;
    }
  }
  if (snapshot.status === "IN_QUEUE" || snapshot.status === "IN_PROGRESS") {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const progressed = await tx.aiGenerationAttempt.updateMany({
        where: {
          id: attempt!.id,
          status: { in: ["submitted", "queued", "in_progress"] },
          ...(mode === "clone" ? {
            pollLeaseToken: pollLeaseToken!,
            pollFailureCount: pollFailureCountAtLease!,
          } : {}),
        },
        data: {
          status: snapshot.status === "IN_PROGRESS" ? "in_progress" : "queued",
          ...(mode === "clone" ? {
            pollFailureCount: 0,
            nextPollAt: null,
            pollLeaseToken: null,
            pollLeaseExpiresAt: null,
          } : {}),
        },
      });
      if (progressed.count !== 1) return;
      await tx.aiGenerationJob.updateMany({
        where: {
          id: job!.id,
          status: { in: ["queued", "in_progress"] },
          ...(mode === "clone" ? { chargeState: "reserved" } : {}),
        },
        data: {
          status: snapshot.status === "IN_PROGRESS" ? "in_progress" : "queued",
          delayTimeMs: snapshot.delayTimeMs,
          startedAt: snapshot.status === "IN_PROGRESS" ? (job!.startedAt ?? now) : job!.startedAt,
        },
      });
    });
    return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  if (snapshot.status === "FAILED" || snapshot.status === "TIMED_OUT" || snapshot.status === "CANCELLED") {
    if (mode === "clone") {
      if (!await releaseClaimedPollLease()) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
      return failAndRefundVoiceJob(
        job,
        state,
        snapshot.status === "TIMED_OUT" ? "CLONE_TIMEOUT" : `CLONE_PROVIDER_${snapshot.status}`,
        `Hero Voice clone provider reached ${snapshot.status.toLowerCase()}`,
        snapshot.status === "TIMED_OUT" ? "failed_timeout" : "failed",
      );
    }
    return failAndRefundVoiceJob(
      job,
      state,
      `OMNIVOICE_PROVIDER_${snapshot.status}`,
      "reason" in snapshot && typeof snapshot.reason === "string"
        ? snapshot.reason
        : `Hero Voice provider reached ${snapshot.status.toLowerCase()}`,
    );
  }
  if (snapshot.status !== "COMPLETED") {
    return job;
  }

  const sequence = attempt.sequence;
  const audio = "audio" in snapshot ? snapshot.audio : Buffer.from(snapshot.response.audio_base64, "base64");
  let parsed: ReturnType<typeof pcmFromWav>;
  let filename: string;
  try {
    parsed = pcmFromWav(audio);
    const partPath = generationPartFilePath(job.id, sequence, state);
    filename = path.basename(partPath);
    fs.writeFileSync(partPath, audio, { mode: mode === "clone" ? 0o600 : 0o644 });
    if (mode === "clone") {
      try { fs.chmodSync(partPath, 0o600); } catch {}
    }
  } catch (error) {
    if (mode === "clone") {
      return failAndRefundVoiceJob(
        job,
        state,
        "CLONE_OUTPUT_INVALID",
        "Hero Voice clone output could not be validated or stored",
        "failed_output",
      );
    }
    throw error;
  }
  const chunk = state.chunks[sequence - 1];
  if (!chunk) return failAndRefundVoiceJob(job, state, "OMNIVOICE_CHUNK_MISSING", "ไม่พบ Hero Voice chunk");
  let asrGateChunk: HeroVoiceAsrGateChunkState | null = null;
  // The gate is clone-only (stock TTS has no seed to walk) and never runs on the
  // canary admission path, whose manifests pin one seed per slot.
  if (mode === "clone" && heroVoiceAsrGateEnabled() && job.canaryRunId === null) {
    const rejected = state.asrGate?.chunks.find((item) => item.sequence === sequence)?.rejected ?? [];
    const leaseExtended = await prisma.aiGenerationAttempt.updateMany({
      where: {
        id: attempt.id,
        pollLeaseToken: pollLeaseToken!,
        pollFailureCount: pollFailureCountAtLease!,
        status: { in: [...ACTIVE_CLONE_ATTEMPT_STATUSES] },
      },
      data: { pollLeaseExpiresAt: new Date(Date.now() + ASR_GATE_LEASE_EXTENSION_MS) },
    });
    if (leaseExtended.count !== 1) {
      try { fs.unlinkSync(generationPartFilePath(job.id, sequence, state)); } catch {}
      return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    const heard = await listenToHeroVoicePart(audio);
    if (heard.ears === 0) {
      // An ASR outage is not a content failure: keep the part, record it as unverified.
      await recordVoiceEvent(userId, "omnivoice_asr_gate_unavailable", {
        aiGenerationJobId: job.id,
        providerJobId,
        sequence,
        failures: heard.failures.join(","),
      });
      asrGateChunk = { sequence, attempts: rejected.length + 1, droppedRun: null, ears: 0, rejected };
    } else {
      const verdict = evaluateHeroVoiceTranscripts(chunk.speechText, heard.transcripts);
      if (verdict.pass) {
        asrGateChunk = { sequence, attempts: rejected.length + 1, droppedRun: verdict.droppedRun, ears: heard.ears, rejected };
      } else {
        const currentSnapshot = cloneSnapshotForAttempt(job, state, attempt);
        await recordVoiceEvent(userId, "omnivoice_asr_gate_rejected", {
          aiGenerationJobId: job.id,
          providerJobId,
          sequence,
          droppedRun: verdict.droppedRun,
          ears: heard.ears,
          generation: rejected.length + 1,
        });
        try { fs.unlinkSync(generationPartFilePath(job.id, sequence, state)); } catch {}
        if (rejected.length >= ASR_GATE_MAX_RETRIES) {
          return failAndRefundVoiceJob(
            job,
            state,
            "OMNIVOICE_CONTENT_DROPPED",
            "Hero Voice อ่านข้ามคำในสคริปต์แม้สร้างซ้ำแล้ว งานนี้ไม่ถูกส่งออก และคืนนาทีให้แล้ว",
            "failed_output",
          );
        }
        return replaceRejectedCloneAttempt({
          job,
          state,
          attempt,
          chunk,
          currentSnapshot,
          rejection: { attemptId: attempt.id, providerJobId, seed: currentSnapshot.synthesis.seed, droppedRun: verdict.droppedRun },
          priorRejected: rejected,
          pollLeaseToken: pollLeaseToken!,
          pollFailureCountAtLease: pollFailureCountAtLease!,
        });
      }
    }
  }
  const nextState: HeroVoiceGenerationStateV1 = {
    ...state,
    ...(asrGateChunk ? { asrGate: mergeAsrGateChunk(state.asrGate, asrGateChunk) } : {}),
    chunks: state.chunks.map((item, index) => index === sequence - 1
      ? {
          ...item,
          providerJobId,
          partFilename: filename,
          durationMs: Math.round(pcmDurationMs(parsed.pcm.length, parsed.sampleRate)),
          sampleRate: parsed.sampleRate,
          generationTimeMs: "generation_time" in snapshot.response && typeof snapshot.response.generation_time === "number"
            ? Math.round(snapshot.response.generation_time * 1000)
            : "duration_ms" in snapshot.response ? snapshot.response.duration_ms : 0,
          delayTimeMs: snapshot.delayTimeMs,
          executionTimeMs: snapshot.executionTimeMs,
          workerVersion: snapshot.response.worker_version,
          catalogVersion: "catalog_version" in snapshot.response ? snapshot.response.catalog_version : undefined,
          language: "language" in snapshot.response ? snapshot.response.language : undefined,
          numStep: mode === "clone"
            ? cloneSnapshotForAttempt(job!, state!, attempt!).synthesis.numStep
            : "num_step" in snapshot.response ? snapshot.response.num_step : undefined,
          ...(mode === "clone" ? {
            responseEnvelopeSha256: heroVoiceCanarySha256(heroVoiceCanaryJcsBytes(snapshot.response)),
            outputAudioSha256: heroVoiceCanarySha256(audio),
          } : {}),
        }
      : item),
  };
  const hasNext = sequence < nextState.chunks.length;
  const advanced = await prisma.$transaction(async (tx) => {
    const completed = await tx.aiGenerationAttempt.updateMany({
      where: {
        id: attempt!.id,
        status: { in: ["submitted", "queued", "in_progress"] },
        ...(mode === "clone" ? {
          pollLeaseToken: pollLeaseToken!,
          pollFailureCount: pollFailureCountAtLease!,
        } : {}),
      },
      data: {
        status: "completed",
        finishedAt: new Date(),
        ...(mode === "clone" ? {
          pollFailureCount: 0,
          nextPollAt: null,
          pollLeaseToken: null,
          pollLeaseExpiresAt: null,
        } : {}),
      },
    });
    if (completed.count !== 1) return false;
    if (hasNext) {
      const nextCloneSnapshot = generationMode(nextState) === "clone"
        ? nextState.cloneSnapshots?.[sequence]
        : undefined;
      if (generationMode(nextState) === "clone" && !parseCandidateAiStudioV3Snapshot(nextCloneSnapshot)) {
        throw new HeroVoiceGenerationError("ข้อมูล Hero Voice clone ไม่ถูกต้อง", "CLONE_SNAPSHOT_INVALID", 500);
      }
      await tx.aiGenerationAttempt.create({
        data: {
          ...(nextCloneSnapshot ? { id: nextCloneSnapshot.attemptId, inputJson: JSON.stringify(nextCloneSnapshot) } : {}),
          jobId: job!.id,
          sequence: sequence + 1,
          provider: "runpod",
          providerModel: generationMode(nextState) === "clone" ? "omnivoice-clone" : "omnivoice",
          providerRoute: "runpod-custom",
          providerEndpoint: job!.providerEndpoint,
          estimatedCostUsdMicros: 0,
        },
      });
    }
    const jobAdvanced = await tx.aiGenerationJob.updateMany({
      where: {
        id: job!.id,
        ...(mode === "clone" ? {
          status: { in: [...ACTIVE_CLONE_JOB_STATUSES] },
          chargeState: "reserved",
        } : {}),
      },
      data: {
        status: "in_progress",
        providerJobId: hasNext ? null : providerJobId,
        inputJson: serializeState(nextState),
        delayTimeMs: nextState.chunks.reduce((sum, item) => sum + (item.delayTimeMs ?? 0), 0),
        executionTimeMs: nextState.chunks.reduce((sum, item) => sum + (item.executionTimeMs ?? 0), 0),
      },
    });
    if (jobAdvanced.count !== 1) {
      throw new HeroVoiceGenerationError("Hero Voice job changed during poll", "CLONE_POLL_STALE", 409);
    }
    return true;
  }).catch((error) => {
    if (mode === "clone" && error instanceof HeroVoiceGenerationError && error.code === "CLONE_POLL_STALE") {
      return false;
    }
    throw error;
  });
  job = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  if (!advanced) {
    try { fs.unlinkSync(generationPartFilePath(job.id, sequence, state)); } catch {}
    return job;
  }
  state = nextState;
  attempt = hasNext
    ? await prisma.aiGenerationAttempt.findFirst({ where: { jobId: job.id }, orderBy: { sequence: "desc" } })
    : attempt;
  if (hasNext) return submitPendingAttempt(job);
  return finalizeVoiceJobTerminally(job, state);
}

export async function advanceHeroVoiceGeneration(userId: string, jobId: string): Promise<AiGenerationJob> {
  return runHeroVoiceCanarySerializedMutation(() => advanceHeroVoiceGenerationUnlocked(userId, jobId));
}

export type HeroVoiceCanaryApplicationTerminalProof = Readonly<{
  outcome: "valid_completed" | "provider_terminal_failed" | "application_validation_failed";
  primaryStatus: "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
  cancelDisposition: "not_requested" | "confirmed" | "rejected_or_unknown";
  audioSha256?: string;
  responseEnvelopeSha256?: string;
  durationMs?: number;
  delayTimeMs?: number;
  executionTimeMs?: number;
}>;

function readProtectedCanaryOutput(filename: string): Buffer {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(filename, flags);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 46 || before.size > 7_000_000
      || (before.mode & 0o777) !== 0o600) {
      throw new HeroVoiceGenerationError("Hero Voice canary output is invalid", "CLONE_OUTPUT_INVALID", 500);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new HeroVoiceGenerationError("Hero Voice canary output is invalid", "CLONE_OUTPUT_INVALID", 500);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      throw new HeroVoiceGenerationError("Hero Voice canary output changed", "CLONE_OUTPUT_INVALID", 500);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

async function proveHeroVoiceCanaryApplicationTerminal(input: {
  runId: string;
  ownerHmac: string;
  slot: HeroVoiceCanarySlot;
  applicationJobId: string;
}): Promise<HeroVoiceCanaryApplicationTerminalProof | null> {
  const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
  if (!run?.slotManifestJson || !run.slotManifestSha256 || !run.referenceVoiceId
    || heroVoiceCanarySha256(run.slotManifestJson) !== run.slotManifestSha256) {
    throw new HeroVoiceGenerationError("Hero Voice canary run is unavailable", "CLONE_IDENTITY_INVALID", 404);
  }
  const manifest = parseHeroVoiceCanaryManifest(parseHeroVoiceCanaryStrictJson(Buffer.from(run.slotManifestJson, "utf8")));
  const expectedSlot = manifest.slots.find((slot) => slot.slotId === input.slot.slotId);
  if (!expectedSlot || expectedSlot.runnerKind !== "CandidateAiStudioV3"
    || !heroVoiceCanaryJcsBytes(expectedSlot).equals(heroVoiceCanaryJcsBytes(input.slot))) {
    throw new HeroVoiceGenerationError("Hero Voice canary slot is invalid", "CLONE_IDENTITY_INVALID", 404);
  }
  const job = await prisma.aiGenerationJob.findFirst({
    where: {
      id: input.applicationJobId,
      canaryRunId: input.runId,
      canarySlotId: input.slot.slotId,
    },
    include: { attempts: { orderBy: { sequence: "asc" } } },
  });
  if (!job || job.kind !== "voice" || job.model !== run.referenceVoiceId
    || job.provider !== "runpod" || job.providerModel !== "omnivoice-clone"
    || job.providerRoute !== "runpod-custom" || job.providerEndpoint !== expectedSlot.endpointId
    || job.idempotencyKey !== null || job.attempts.length !== 1) {
    throw new HeroVoiceGenerationError("Hero Voice canary job identity is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  const state = parseState(job.inputJson);
  const attempt = job.attempts[0];
  const snapshot = parseCandidateAiStudioV3Snapshot(state?.cloneSnapshots?.[0]);
  if (!state || !snapshot || !validateCloneDurableIdentity(job, state, job.attempts)
    || snapshot.attemptId !== attempt.id || snapshot.sequence !== 1
    || snapshot.endpointId !== expectedSlot.endpointId
    || snapshot.imageDigest !== expectedSlot.imageDigest
    || snapshot.sourceRevision !== expectedSlot.sourceRevision
    || snapshot.modelManifestSha256 !== expectedSlot.modelManifestSha256
    || snapshot.experimentProfile !== expectedSlot.arm.profile
    || snapshot.normalizerVersion !== expectedSlot.normalizerVersion
    || snapshot.referenceSha256 !== manifest.referenceSha256
    || snapshot.synthesis.speed !== expectedSlot.matchedSettings.speed
    || snapshot.synthesis.numStep !== expectedSlot.matchedSettings.numStep
    || snapshot.synthesis.seed !== expectedSlot.arm.seed
    || snapshot.synthesis.textSha256 !== expectedSlot.speechTextSha256
    || snapshot.synthesis.requestCommitmentSha256 !== expectedSlot.requestCommitmentSha256
    || snapshot.synthesis.matchedSettingsSha256 !== expectedSlot.matchedSettingsSha256) {
    throw new HeroVoiceGenerationError("Hero Voice canary snapshot is invalid", "CLONE_IDENTITY_INVALID", 500);
  }
  if (!["completed", "failed", "canceled", "failed_timeout", "failed_poll_unavailable",
    "failed_provider_status", "failed_provider_missing", "failed_identity", "failed_output",
    "failed_unknown_submit"].includes(job.status)) return null;
  if (job.status !== "completed") {
    return Object.freeze({
      outcome: job.status === "failed_output" || job.status === "failed_identity"
        ? "application_validation_failed" as const : "provider_terminal_failed" as const,
      primaryStatus: job.status === "canceled" ? "cancelled" as const
        : job.status === "failed_timeout" ? "timed_out" as const : "failed" as const,
      cancelDisposition: job.cancelDisposition as HeroVoiceCanaryApplicationTerminalProof["cancelDisposition"],
      delayTimeMs: job.delayTimeMs ?? 0,
      executionTimeMs: job.executionTimeMs ?? 0,
    });
  }
  const records = await verifyHeroVoiceCanaryLedger({ runId: run.id, ownerHmac: run.ownerHmac });
  const accepted = records.find(({ record }) => record.type === "provider_accepted"
    && record.slotId === expectedSlot.slotId)?.record;
  const chunk = state.chunks[0];
  if (!accepted || accepted.type !== "provider_accepted" || !accepted.providerJobId
    || job.chargeState !== "settled" || !job.finishedAt
    || job.providerJobId !== accepted.providerJobId
    || attempt.status !== "completed" || !attempt.finishedAt
    || attempt.providerJobId !== accepted.providerJobId
    || attempt.submissionDisposition !== "provider_accepted"
    || chunk.providerJobId !== accepted.providerJobId
    || !chunk.responseEnvelopeSha256 || !chunk.outputAudioSha256
    || chunk.workerVersion !== expectedSlot.expectedWorkerVersion
    || chunk.numStep !== expectedSlot.matchedSettings.numStep
    || job.outputUrl !== `/api/ai-studio/voice-audio/${encodeURIComponent(job.id)}`) {
    throw new HeroVoiceGenerationError("Hero Voice canary terminal proof is invalid", "CLONE_SETTLEMENT_INVALID", 500);
  }
  const outputPath = heroVoiceCloneAudioFilePath(job.id);
  if (!outputPath) throw new HeroVoiceGenerationError("Hero Voice canary output is invalid", "CLONE_OUTPUT_INVALID", 500);
  const wav = readProtectedCanaryOutput(outputPath);
  const parsedWav = validatePcm16MonoWav(wav, { sampleRate: 24_000 });
  const audioSha256 = heroVoiceCanarySha256(wav);
  if (!parsedWav || audioSha256 !== chunk.outputAudioSha256
    || state.result?.audioDurationMs !== parsedWav.durationMs) {
    throw new HeroVoiceGenerationError("Hero Voice canary output proof is invalid", "CLONE_OUTPUT_INVALID", 500);
  }
  return Object.freeze({
    outcome: "valid_completed",
    primaryStatus: "completed",
    cancelDisposition: "not_requested",
    audioSha256,
    responseEnvelopeSha256: chunk.responseEnvelopeSha256,
    durationMs: parsedWav.durationMs,
    delayTimeMs: job.delayTimeMs ?? 0,
    executionTimeMs: job.executionTimeMs ?? 0,
  });
}

/** Candidate slots become ledger-valid only after the real application poller
 * has validated/stored the provider output and committed settlement. Adapter
 * terminal assertions are deliberately absent from this boundary. */
export async function awaitHeroVoiceCanaryApplicationTerminal(input: {
  runId: string;
  ownerHmac: string;
  slot: HeroVoiceCanarySlot;
  applicationJobId: string;
  maximumWaitMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<HeroVoiceCanaryApplicationTerminalProof> {
  const deadline = Date.now() + Math.min(input.maximumWaitMs ?? 540_000, 540_000);
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (Date.now() <= deadline) {
    const before = await proveHeroVoiceCanaryApplicationTerminal(input);
    if (before) return before;
    const job = await prisma.aiGenerationJob.findFirst({
      where: { id: input.applicationJobId, canaryRunId: input.runId, canarySlotId: input.slot.slotId },
      select: { userId: true },
    });
    if (!job) throw new HeroVoiceGenerationError("Hero Voice canary job is unavailable", "CLONE_IDENTITY_INVALID", 404);
    await advanceHeroVoiceGeneration(job.userId, input.applicationJobId);
    const after = await proveHeroVoiceCanaryApplicationTerminal(input);
    if (after) return after;
    await wait(1_000);
  }
  throw new HeroVoiceGenerationError("Hero Voice canary terminal proof timed out", "CLONE_POLL_UNAVAILABLE", 503);
}

export function heroVoiceResultFromJob(job: AiGenerationJob): HeroVoiceGenerationResult | null {
  if (job.kind !== "voice" || job.status !== "completed") return null;
  return parseState(job.inputJson)?.result ?? null;
}

export function heroVoiceProviderDeadlineFromJob(
  job: Pick<AiGenerationJob, "kind" | "inputJson">,
): string | null {
  return job.kind === "voice" ? parseState(job.inputJson)?.providerDeadlineAt ?? null : null;
}

async function cancelHeroVoiceGenerationUnlocked(userId: string, jobId: string): Promise<AiGenerationJob> {
  const job = await prisma.aiGenerationJob.findFirst({ where: { id: jobId, userId } });
  if (!job || job.kind !== "voice") {
    throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
  }
  const cloneCanaryJob = isHeroVoiceCloneDurableRecord(job);
  if (cloneCanaryJob) await assertHeroVoiceCanaryMutationReady();
  const attempts = await prisma.aiGenerationAttempt.findMany({
    where: { jobId: job.id },
    orderBy: { sequence: "asc" },
  });
  const state = parseState(job.inputJson);
  if (!state) {
    if (cloneCanaryJob) return failCorruptCloneJob(job);
    throw new HeroVoiceGenerationError("ข้อมูล durable Hero Voice ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  }
  const mode = generationMode(state);
  if (cloneCanaryJob && !validateCloneDurableIdentity(job, state, attempts)) {
    return failCorruptCloneJob(job);
  }
  if (cloneCanaryJob) {
    try {
      await requireHeroVoiceCloneCanaryActor(userId);
    } catch {
      const failed = await failAndRefundVoiceJob(
        job,
        state,
        "CLONE_POLICY_REVOKED",
        "Hero Voice clone policy is no longer valid",
        "failed_identity",
      );
      const known = attempts.at(-1);
      return known?.providerJobId || job.providerJobId ? recordCloneCancelOnce(failed) : failed;
    }
  }
  requireExistingHeroVoiceGenerationInvariant(job, { mode, voiceId: state.voiceId });
  if (mode === "clone" ? isHeroVoiceCloneTerminalStatus(job.status) : ["completed", "failed", "canceled"].includes(job.status)) {
    const terminalAttempt = attempts.at(-1);
    if (mode === "clone" && terminalAttempt?.providerJobId && terminalAttempt.cancelDisposition === "not_requested"
      && job.status !== "completed") {
      return recordCloneCancelOnce(job);
    }
    return job;
  }
  const attempt = attempts.at(-1) ?? null;
  if (mode === "clone") {
    const canceled = await prisma.$transaction(async (tx) => {
      const owned = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId } });
      if (!owned) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
      if (isHeroVoiceCloneTerminalStatus(owned.status)) return owned;
      if (owned.chargeState === "reserved") {
        await tx.user.update({
          where: { id: userId },
          data: {
            aiAudioMinutesUsed: { increment: -owned.reservedAiAudioMinutes },
            ...(owned.reservedStudioMinutes !== 0
              ? { minutesUsed: { increment: -owned.reservedStudioMinutes } }
              : {}),
          },
        });
      }
      const now = new Date();
      await tx.aiGenerationAttempt.updateMany({
        where: { jobId: job.id, status: { in: ["planned", "submitting", "submitted", "queued", "in_progress"] } },
        data: {
          status: "canceled",
          errorCode: "CLONE_OWNER_CANCELED",
          errorMessage: "canceled by owner",
          finishedAt: now,
          pollLeaseToken: null,
          pollLeaseExpiresAt: null,
        },
      });
      return tx.aiGenerationJob.update({
        where: { id: job.id },
        data: {
          status: "canceled",
          chargeState: owned.chargeState === "reserved" ? "refunded" : owned.chargeState,
          externalRunDisposition: "abort_required",
          errorCode: "CLONE_OWNER_CANCELED",
          errorMessage: "canceled by owner",
          finishedAt: now,
        },
      });
    });
    const latestState = parseState(canceled.inputJson);
    if (latestState) removeParts(job.id, latestState);
    const withCancel = attempt?.providerJobId
      ? await recordCloneCancelOnce(canceled)
      : canceled;
    await recordVoiceEvent(userId, "omnivoice_provider_canceled", {
      aiGenerationJobId: job.id,
      providerJobId: attempt?.providerJobId ?? "",
      sequence: attempt?.sequence ?? 0,
      cancelDisposition: withCancel.cancelDisposition,
    });
    return withCancel;
  }
  let cancellationConfirmed = false;
  if (attempt?.providerJobId) {
    try {
      cancellationConfirmed = await cancelRunpodOmniVoiceJob(
        pinnedStockRunpodConfig(job, state),
        attempt.providerJobId,
      );
    } catch {
      cancellationConfirmed = false;
    }
  }

  const canceled = await prisma.$transaction(async (tx) => {
    const owned = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId } });
    if (!owned) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
    if (owned.status === "completed" || owned.status === "failed" || owned.status === "canceled") return owned;
    if (owned.chargeState === "reserved") {
      await tx.$executeRaw`UPDATE "User" SET
        "aiAudioMinutesUsed" = MAX(0, "aiAudioMinutesUsed" - ${state.aiReservedMin}),
        "minutesUsed" = MAX(0, "minutesUsed" - ${state.studioReservedMin})
        WHERE "id" = ${userId}`;
    }
    const now = new Date();
    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, status: { in: ["planned", "submitting", "submitted", "queued", "in_progress"] } },
      data: {
        status: "failed",
        errorCode: "OMNIVOICE_USER_CANCELED",
        errorMessage: "canceled by user",
        finishedAt: now,
      },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "canceled",
        chargeState: owned.chargeState === "reserved" ? "refunded" : owned.chargeState,
        errorCode: "OMNIVOICE_USER_CANCELED",
        errorMessage: "canceled by user",
        finishedAt: now,
      },
    });
  });
  removeParts(job.id, state);
  await recordVoiceEvent(userId, "omnivoice_provider_canceled", {
    aiGenerationJobId: job.id,
    providerJobId: attempt?.providerJobId ?? "",
    endpointId: job.providerEndpoint ?? "",
    cancellationConfirmed,
  });
  return canceled;
}

export async function cancelHeroVoiceGeneration(userId: string, jobId: string): Promise<AiGenerationJob> {
  return runHeroVoiceCanarySerializedMutation(() => cancelHeroVoiceGenerationUnlocked(userId, jobId));
}

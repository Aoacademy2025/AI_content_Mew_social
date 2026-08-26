import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AiGenerationJob, Plan } from "@prisma/client";
import { promisify } from "node:util";

import { aiAudioCeilingFor, estimateTtsAudioMinutes } from "@/lib/ai-spend-limits";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  HERO_VOICE_SPEECH_NORMALIZER_VERSION,
  splitHeroVoiceScriptForTts,
} from "@/lib/hero-voice-speech";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import {
  cancelRunpodOmniVoiceJob,
  OmniVoiceProviderError,
  omnivoiceConfig,
  pcmFromWav,
  pollRunpodOmniVoiceJob,
  submitRunpodOmniVoiceJob,
  type OmniVoiceConfig,
  type RunpodOmniVoiceRequest,
} from "@/lib/omnivoice";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { mergeSegmentTiming, pcmDurationMs } from "@/lib/tts-timing";
import { syncMinuteWindow } from "@/lib/minute-limits";
import { videoExpiryFor } from "@/lib/plan-limits";
import { isUserVoiceId, loadUserVoiceRef } from "@/lib/user-voices.server";
import { isHeroVoiceCloningEnabled } from "@/lib/omnivoice-policy";

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1 as const;
const SUBMISSION_UNKNOWN_AFTER_MS = 2 * 60_000;

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
};

type HeroVoiceGenerationStateV1 = {
  version: typeof STATE_VERSION;
  // Optional for backward compatibility with durable TTS jobs accepted before
  // clone mode shipped. Missing means stock TTS.
  mode?: "tts" | "clone";
  voiceId: string;
  speed: number;
  backend: "runpod";
  providerDeadlineAt: string;
  aiReservedMin: number;
  studioReservedMin: number;
  speechNormalizerVersion: string;
  speechRiskCategories: string[];
  chunks: HeroVoiceChunkState[];
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
      && (typeof chunk.partFilename !== "string" || !/^tts-omni-part-[A-Za-z0-9_-]+-\d+\.wav$/.test(chunk.partFilename))) {
      return null;
    }
  }
  return parsed as unknown as HeroVoiceGenerationStateV1;
}

function serializeState(value: HeroVoiceGenerationStateV1): string {
  return JSON.stringify(value);
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

function pinnedRunpodConfig(job: AiGenerationJob, state: HeroVoiceGenerationStateV1): Extract<OmniVoiceConfig, { backend: "runpod" }> {
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

function partFilename(jobId: string, sequence: number): string {
  return `tts-omni-part-${jobId}-${sequence}.wav`;
}

function finalFilename(jobId: string): string {
  return `tts-omni-${jobId}.wav`;
}

function removeParts(state: HeroVoiceGenerationStateV1): void {
  for (const chunk of state.chunks) {
    if (!chunk.partFilename) continue;
    try { fs.unlinkSync(path.join(rendersDir(), chunk.partFilename)); } catch {}
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
  state: HeroVoiceGenerationStateV1,
  code: string,
  message: string,
): Promise<AiGenerationJob> {
  const failed = await prisma.$transaction(async (tx) => {
    const owned = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId: job.userId } });
    if (!owned) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
    if (owned.status === "completed" || owned.status === "failed" || owned.status === "canceled") return owned;
    if (owned.chargeState === "reserved") {
      await tx.$executeRaw`UPDATE "User" SET
        "aiAudioMinutesUsed" = MAX(0, "aiAudioMinutesUsed" - ${state.aiReservedMin}),
        "minutesUsed" = MAX(0, "minutesUsed" - ${state.studioReservedMin})
        WHERE "id" = ${job.userId}`;
    }
    const now = new Date();
    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, status: { in: ["planned", "submitting", "submitted", "queued", "in_progress"] } },
      data: {
        status: "failed",
        errorCode: code,
        errorMessage: message.slice(0, 500),
        finishedAt: now,
      },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        chargeState: owned.chargeState === "reserved" ? "refunded" : owned.chargeState,
        errorCode: code,
        errorMessage: message.slice(0, 500),
        finishedAt: now,
      },
    });
  });
  removeParts(state);
  await recordVoiceEvent(job.userId, "omnivoice_provider_failed", {
    aiGenerationJobId: job.id,
    providerJobId: job.providerJobId ?? "",
    endpointId: job.providerEndpoint ?? "",
    code,
  });
  return failed;
}

async function submitPendingAttempt(job: AiGenerationJob): Promise<AiGenerationJob> {
  const state = parseState(job.inputJson);
  if (!state) throw new HeroVoiceGenerationError("ข้อมูล durable Hero Voice ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  const attempt = await prisma.aiGenerationAttempt.findFirst({
    where: { jobId: job.id },
    orderBy: { sequence: "desc" },
  });
  if (!attempt) throw new HeroVoiceGenerationError("ไม่พบ Hero Voice provider attempt", "OMNIVOICE_ATTEMPT_MISSING", 500);
  if (attempt.status !== "planned") return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  const claimed = await prisma.aiGenerationAttempt.updateMany({
    where: { id: attempt.id, status: "planned" },
    data: { status: "submitting" },
  });
  if (claimed.count !== 1) return prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });

  const chunk = state.chunks[attempt.sequence - 1];
  if (!chunk) {
    return failAndRefundVoiceJob(job, state, "OMNIVOICE_CHUNK_MISSING", "ไม่พบข้อความส่วนที่ต้องสร้างเสียง");
  }

  try {
    const config = pinnedRunpodConfig(job, state);
    const mode = generationMode(state);
    let request: RunpodOmniVoiceRequest;
    if (mode === "clone") {
      const ref = await loadUserVoiceRef(job.userId, state.voiceId);
      if (!ref) {
        return failAndRefundVoiceJob(
          job,
          state,
          "USER_VOICE_REFERENCE_MISSING",
          "ไม่พบไฟล์อ้างอิงของเสียงโคลนนี้",
        );
      }
      request = {
        mode: "clone",
        text: chunk.speechText,
        speed: state.speed,
        refAudioBase64: ref.audioBase64,
        refText: ref.refText,
      };
    } else {
      request = { mode: "tts", voiceId: state.voiceId, text: chunk.speechText, speed: state.speed };
    }
    const submitted = await submitRunpodOmniVoiceJob(config, request);
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const recorded = await tx.aiGenerationAttempt.updateMany({
        where: { id: attempt.id, status: "submitting" },
        data: {
          providerJobId: submitted.providerJobId,
          status: submitted.status === "IN_PROGRESS" ? "in_progress" : "queued",
          submittedAt: now,
        },
      });
      if (recorded.count !== 1) throw new Error("Hero Voice attempt changed before provider id was recorded");
      return tx.aiGenerationJob.update({
        where: { id: job.id },
        data: {
          providerJobId: submitted.providerJobId,
          status: submitted.status === "IN_PROGRESS" ? "in_progress" : "queued",
          startedAt: submitted.status === "IN_PROGRESS" ? (job.startedAt ?? now) : job.startedAt,
        },
      });
    });
    await recordVoiceEvent(job.userId, "omnivoice_provider_submitted", {
      aiGenerationJobId: job.id,
      providerJobId: submitted.providerJobId,
      endpointId: job.providerEndpoint ?? "",
      sequence: attempt.sequence,
      segments: state.chunks.length,
      mode,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hero Voice provider submission failed";
    if (error instanceof OmniVoiceProviderError) {
      const code = error.status === 429
        ? "OMNIVOICE_PROVIDER_RATE_LIMITED"
        : "OMNIVOICE_PROVIDER_SUBMIT_REJECTED";
      return failAndRefundVoiceJob(job, state, code, message);
    }
    // A connection failure can happen after RunPod accepted the POST. Keep the
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

async function reserveVoiceCapacity(
  job: AiGenerationJob,
  state: HeroVoiceGenerationStateV1,
  plan: Plan,
  studio: boolean,
): Promise<AiGenerationJob> {
  const window = await syncMinuteWindow(job.userId);
  if (!window) throw new HeroVoiceGenerationError("ไม่พบผู้ใช้", "USER_NOT_FOUND", 404);
  const aiReservedMin = estimateTtsAudioMinutes(state.chunks.map((chunk) => chunk.text).join(""));
  const studioReservedMin = studio ? Math.max(1, Math.ceil(aiReservedMin)) : 0;
  const ceiling = aiAudioCeilingFor(window.minutesLimit);

  const reserved = await prisma.$transaction(async (tx) => {
    const currentJob = await tx.aiGenerationJob.findUnique({ where: { id: job.id } });
    if (!currentJob) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
    if (currentJob.chargeState !== "pending") return currentJob;
    const user = await tx.user.findUnique({
      where: { id: job.userId },
      select: { aiAudioMinutesUsed: true, minutesUsed: true, minutesLimit: true },
    });
    if (!user) throw new HeroVoiceGenerationError("ไม่พบผู้ใช้", "USER_NOT_FOUND", 404);
    if (user.aiAudioMinutesUsed + aiReservedMin > ceiling) {
      return tx.aiGenerationJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          chargeState: "none",
          errorCode: "QUOTA_AI_AUDIO",
          errorMessage: `ใช้เสียง AI ครบเพดานรอบนี้แล้ว (${plan})`,
          finishedAt: new Date(),
        },
      });
    }
    if (studioReservedMin > 0 && user.minutesUsed + studioReservedMin > user.minutesLimit) {
      return tx.aiGenerationJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          chargeState: "none",
          errorCode: "QUOTA_MINUTES",
          errorMessage: "นาทีในแพ็กเกจไม่พอสำหรับสร้างเสียงนี้",
          finishedAt: new Date(),
        },
      });
    }
    await tx.user.update({
      where: { id: job.userId },
      data: {
        aiAudioMinutesUsed: { increment: aiReservedMin },
        ...(studioReservedMin > 0 ? { minutesUsed: { increment: studioReservedMin } } : {}),
      },
    });
    const reservedState = { ...state, aiReservedMin, studioReservedMin };
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: { chargeState: "reserved", inputJson: serializeState(reservedState) },
    });
  });
  return reserved;
}

export async function startHeroVoiceGeneration(input: {
  userId: string;
  plan: Plan;
  text: string;
  voiceId: string;
  speed: number;
  studio: boolean;
  idempotencyKey: string;
  backend?: "runpod" | "hostinger";
}): Promise<{ job: AiGenerationJob; created: boolean }> {
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
  const config = omnivoiceConfig(input.backend);
  if (config.backend !== "runpod") {
    throw new HeroVoiceGenerationError(
      "Durable Hero Voice รองรับเฉพาะ RunPod backend",
      "OMNIVOICE_DURABLE_BACKEND_UNSUPPORTED",
      409,
    );
  }
  const existing = await prisma.aiGenerationJob.findFirst({
    where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { job: existing, created: false };

  const mode = isUserVoiceId(input.voiceId) ? "clone" : "tts";
  if (mode === "clone") {
    if (!isHeroVoiceCloningEnabled()) {
      throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
    }
    const owner = await prisma.user.findUnique({ where: { id: input.userId }, select: { role: true } });
    if (owner?.role !== "ADMIN") {
      throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
    }
    const ref = await loadUserVoiceRef(input.userId, input.voiceId);
    if (!ref) throw new HeroVoiceGenerationError("ไม่พบเสียงโคลนนี้", "USER_VOICE_NOT_FOUND", 404);
  }

  const chunks = splitHeroVoiceScriptForTts(fullText, config.maxChunkChars);
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

  const state: HeroVoiceGenerationStateV1 = {
    version: STATE_VERSION,
    mode,
    voiceId: input.voiceId,
    speed: input.speed,
    backend: "runpod",
    providerDeadlineAt: new Date(Date.now() + config.requestBudgetMs).toISOString(),
    aiReservedMin: 0,
    studioReservedMin: 0,
    speechNormalizerVersion: HERO_VOICE_SPEECH_NORMALIZER_VERSION,
    speechRiskCategories: speechRisks.map((risk) => risk.code).sort(),
    chunks: chunks.map((chunk) => ({ text: chunk.text, speechText: chunk.speechText })),
  };

  let created: AiGenerationJob;
  try {
    created = await prisma.aiGenerationJob.create({
      data: {
        userId: input.userId,
        kind: "voice",
        provider: "runpod",
        model: input.voiceId,
        providerModel: mode === "clone" ? "omnivoice-clone" : "omnivoice",
        providerRoute: "runpod-custom",
        providerEndpoint: config.endpointId,
        status: "queued",
        inputPreview: fullText.replace(/\s+/g, " ").slice(0, 180),
        inputJson: serializeState(state),
        creditCost: 0,
        chargeState: "pending",
        idempotencyKey: input.idempotencyKey,
        mediaExpiresAt: videoExpiryFor(input.plan),
        attempts: {
          create: {
            sequence: 1,
            provider: "runpod",
            providerModel: mode === "clone" ? "omnivoice-clone" : "omnivoice",
            providerRoute: "runpod-custom",
            providerEndpoint: config.endpointId,
            estimatedCostUsdMicros: 0,
          },
        },
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      const raced = await prisma.aiGenerationJob.findFirst({
        where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
      });
      if (raced) return { job: raced, created: false };
    }
    throw error;
  }

  const reserved = await reserveVoiceCapacity(created, state, input.plan, input.studio);
  if (reserved.status === "failed") {
    throw new HeroVoiceGenerationError(
      reserved.errorMessage ?? "ไม่สามารถจองโควตา Hero Voice ได้",
      reserved.errorCode ?? "OMNIVOICE_RESERVATION_FAILED",
      409,
    );
  }
  const submitted = await submitPendingAttempt(reserved);
  return { job: submitted, created: true };
}

async function finalizeVoiceJob(job: AiGenerationJob, state: HeroVoiceGenerationStateV1): Promise<AiGenerationJob> {
  const pcms: Buffer[] = [];
  let sampleRate = 0;
  for (const chunk of state.chunks) {
    if (!chunk.partFilename) {
      throw new HeroVoiceGenerationError("Hero Voice chunk file หาย", "OMNIVOICE_CHUNK_FILE_MISSING", 500);
    }
    const source = fs.readFileSync(path.join(rendersDir(), chunk.partFilename));
    const parsed = pcmFromWav(source);
    if (sampleRate === 0) sampleRate = parsed.sampleRate;
    if (sampleRate !== parsed.sampleRate) {
      throw new HeroVoiceGenerationError("Hero Voice ส่ง sample rate ไม่สม่ำเสมอ", "OMNIVOICE_SAMPLE_RATE_MISMATCH", 502);
    }
    pcms.push(parsed.pcm);
  }

  const filename = finalFilename(job.id);
  const filePath = path.join(ensureRendersDir(), filename);
  fs.writeFileSync(filePath, wavFromPcm(Buffer.concat(pcms), sampleRate));
  const audioDurationMs = state.chunks.reduce((sum, chunk) => sum + (chunk.durationMs ?? 0), 0);
  const silences = await detectSilences(filePath);
  const result: HeroVoiceGenerationResult = {
    voiceUrl: `/api/renders/${filename}`,
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
  const actualStudioMinutes = state.studioReservedMin > 0 ? Math.max(1, Math.ceil(actualAiMinutes)) : 0;
  const aiDelta = actualAiMinutes - state.aiReservedMin;
  const studioDelta = actualStudioMinutes - state.studioReservedMin;

  const completed = await prisma.$transaction(async (tx) => {
    const owned = await tx.aiGenerationJob.findFirst({ where: { id: job.id, userId: job.userId } });
    if (!owned) throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
    if (owned.status === "completed" || owned.status === "failed" || owned.status === "canceled") return owned;
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
      return failAndRefundVoiceJob(job, state, error.code, error.message);
    }
    throw error;
  });

  if (completed.status === "completed") {
    removeParts(state);
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

export async function advanceHeroVoiceGeneration(userId: string, jobId: string): Promise<AiGenerationJob> {
  let job = await prisma.aiGenerationJob.findFirst({ where: { id: jobId, userId } });
  if (!job || job.kind !== "voice") {
    throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
  let state = parseState(job.inputJson);
  if (!state) {
    throw new HeroVoiceGenerationError("ข้อมูล durable Hero Voice ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  }
  let attempt = await prisma.aiGenerationAttempt.findFirst({
    where: { jobId: job.id },
    orderBy: { sequence: "desc" },
  });
  if (!attempt) return failAndRefundVoiceJob(job, state, "OMNIVOICE_ATTEMPT_MISSING", "ไม่พบ Hero Voice provider attempt");
  if (attempt.status === "planned") return submitPendingAttempt(job);
  if (attempt.status === "submitting" && !attempt.providerJobId) {
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
    return failAndRefundVoiceJob(job, state, "OMNIVOICE_PROVIDER_ID_MISSING", "Hero Voice provider job id หาย");
  }

  const config = pinnedRunpodConfig(job, state);
  if (Date.now() >= Date.parse(state.providerDeadlineAt)) {
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
  try {
    snapshot = await pollRunpodOmniVoiceJob(config, providerJobId, generationMode(state));
  } catch (error) {
    await recordVoiceEvent(userId, "omnivoice_provider_poll_error", {
      aiGenerationJobId: job.id,
      providerJobId,
      endpointId: job.providerEndpoint ?? "",
      status: error instanceof OmniVoiceProviderError ? error.status : 0,
    });
    return job;
  }
  if (snapshot.status === "IN_QUEUE" || snapshot.status === "IN_PROGRESS") {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.aiGenerationAttempt.updateMany({
        where: { id: attempt!.id, status: { in: ["submitted", "queued", "in_progress"] } },
        data: { status: snapshot.status === "IN_PROGRESS" ? "in_progress" : "queued" },
      });
      await tx.aiGenerationJob.updateMany({
        where: { id: job!.id, status: { in: ["queued", "in_progress"] } },
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
    return failAndRefundVoiceJob(
      job,
      state,
      `OMNIVOICE_PROVIDER_${snapshot.status}`,
      snapshot.reason,
    );
  }
  if (snapshot.status !== "COMPLETED") {
    return job;
  }

  const audio = Buffer.from(snapshot.response.audio_base64, "base64");
  const parsed = pcmFromWav(audio);
  const sequence = attempt.sequence;
  const filename = partFilename(job.id, sequence);
  fs.writeFileSync(path.join(ensureRendersDir(), filename), audio);
  const chunk = state.chunks[sequence - 1];
  if (!chunk) return failAndRefundVoiceJob(job, state, "OMNIVOICE_CHUNK_MISSING", "ไม่พบ Hero Voice chunk");
  const nextState: HeroVoiceGenerationStateV1 = {
    ...state,
    chunks: state.chunks.map((item, index) => index === sequence - 1
      ? {
          ...item,
          providerJobId,
          partFilename: filename,
          durationMs: Math.round(pcmDurationMs(parsed.pcm.length, parsed.sampleRate)),
          sampleRate: parsed.sampleRate,
          generationTimeMs: typeof snapshot.response.generation_time === "number"
            ? Math.round(snapshot.response.generation_time * 1000)
            : 0,
          delayTimeMs: snapshot.delayTimeMs,
          executionTimeMs: snapshot.executionTimeMs,
          workerVersion: snapshot.response.worker_version,
          catalogVersion: snapshot.response.catalog_version,
          language: snapshot.response.language,
          numStep: snapshot.response.num_step,
        }
      : item),
  };
  const hasNext = sequence < nextState.chunks.length;
  const advanced = await prisma.$transaction(async (tx) => {
    const completed = await tx.aiGenerationAttempt.updateMany({
      where: { id: attempt!.id, status: { in: ["submitted", "queued", "in_progress"] } },
      data: { status: "completed", finishedAt: new Date() },
    });
    if (completed.count !== 1) return false;
    if (hasNext) {
      await tx.aiGenerationAttempt.create({
        data: {
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
    await tx.aiGenerationJob.update({
      where: { id: job!.id },
      data: {
        status: "in_progress",
        providerJobId: null,
        inputJson: serializeState(nextState),
        delayTimeMs: nextState.chunks.reduce((sum, item) => sum + (item.delayTimeMs ?? 0), 0),
        executionTimeMs: nextState.chunks.reduce((sum, item) => sum + (item.executionTimeMs ?? 0), 0),
      },
    });
    return true;
  });
  job = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
  if (!advanced) return job;
  state = nextState;
  attempt = hasNext
    ? await prisma.aiGenerationAttempt.findFirst({ where: { jobId: job.id }, orderBy: { sequence: "desc" } })
    : attempt;
  if (hasNext) return submitPendingAttempt(job);
  return finalizeVoiceJob(job, state);
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

export async function cancelHeroVoiceGeneration(userId: string, jobId: string): Promise<AiGenerationJob> {
  const job = await prisma.aiGenerationJob.findFirst({ where: { id: jobId, userId } });
  if (!job || job.kind !== "voice") {
    throw new HeroVoiceGenerationError("ไม่พบงาน Hero Voice", "OMNIVOICE_JOB_NOT_FOUND", 404);
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
  const state = parseState(job.inputJson);
  if (!state) {
    throw new HeroVoiceGenerationError("ข้อมูล durable Hero Voice ไม่ถูกต้อง", "OMNIVOICE_STATE_INVALID", 500);
  }
  const attempt = await prisma.aiGenerationAttempt.findFirst({
    where: { jobId: job.id },
    orderBy: { sequence: "desc" },
  });
  let cancellationConfirmed = false;
  if (attempt?.providerJobId) {
    try {
      cancellationConfirmed = await cancelRunpodOmniVoiceJob(
        pinnedRunpodConfig(job, state),
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
  removeParts(state);
  await recordVoiceEvent(userId, "omnivoice_provider_canceled", {
    aiGenerationJobId: job.id,
    providerJobId: attempt?.providerJobId ?? "",
    endpointId: job.providerEndpoint ?? "",
    cancellationConfirmed,
  });
  return canceled;
}

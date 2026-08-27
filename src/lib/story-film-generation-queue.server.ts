import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { Prisma, StoryFilmGenerationJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { STORY_FILM_STAGES, StoryFilmError, type StoryFilmStage } from "@/lib/story-film.server";

export const STORY_FILM_WORKER_CONCURRENCY = 2;
export const STORY_FILM_LEASE_MS = 90_000;

export const STORY_FILM_JOB_KINDS = [
  "narration_voice",
  "storyboard_plan",
  "look_image",
  "keyframe_image",
  "scene_video",
  "music",
  "final_render",
] as const;

export type StoryFilmJobKind = (typeof STORY_FILM_JOB_KINDS)[number];
export type StoryFilmProviderBackend =
  | "grok_subscription"
  | "hero_voice"
  | "hero_text"
  | "vidiq"
  | "hero_render";

const BACKENDS = new Set<StoryFilmProviderBackend>([
  "grok_subscription",
  "hero_voice",
  "hero_text",
  "vidiq",
  "hero_render",
]);
const JOB_STAGE: Record<StoryFilmJobKind, StoryFilmStage> = {
  narration_voice: "narration",
  storyboard_plan: "storyboard",
  look_image: "character_look",
  keyframe_image: "keyframes",
  scene_video: "videos",
  music: "music",
  final_render: "final_render",
};
const JOB_BACKENDS: Record<StoryFilmJobKind, StoryFilmProviderBackend[]> = {
  narration_voice: ["hero_voice"],
  storyboard_plan: ["hero_text"],
  look_image: ["grok_subscription"],
  keyframe_image: ["grok_subscription"],
  scene_video: ["grok_subscription"],
  music: ["vidiq"],
  final_render: ["hero_render"],
};
const KEY_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const WORKER_PATTERN = /^[A-Za-z0-9._:-]{3,120}$/;
const LIVE_STATUSES = ["leased", "running"];

function hashLease(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newLeaseToken() {
  return randomBytes(32).toString("base64url");
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payloadJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cleanPayload(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload);
  if (json.length > 100_000) throw new StoryFilmError("invalid_input", "Generation payload ยาวเกิน 100,000 ตัวอักษร");
  return json;
}

function publicJob(job: StoryFilmGenerationJob) {
  return {
    id: job.id,
    projectId: job.projectId,
    stage: job.stage as StoryFilmStage,
    projectRevision: job.projectRevision,
    generationEpoch: job.generationEpoch,
    kind: job.kind as StoryFilmJobKind,
    providerBackend: job.providerBackend as StoryFilmProviderBackend,
    sceneKey: job.sceneKey,
    status: job.status,
    attemptCount: job.attemptCount,
    technicalFailureCount: job.technicalFailureCount,
    providerJobId: job.providerJobId,
    availableAt: job.availableAt.toISOString(),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function enqueueStoryFilmGeneration(
  userId: string,
  input: {
    projectId: string;
    expectedStage: StoryFilmStage;
    expectedRevision: number;
    kind: StoryFilmJobKind;
    providerBackend: StoryFilmProviderBackend;
    sceneKey?: string | null;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    priority?: number;
  },
) {
  if (!(STORY_FILM_STAGES as readonly string[]).includes(input.expectedStage)) {
    throw new StoryFilmError("invalid_input", "Generation stage ไม่ถูกต้อง");
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new StoryFilmError("invalid_input", "Generation revision ไม่ถูกต้อง");
  }
  if (!(STORY_FILM_JOB_KINDS as readonly string[]).includes(input.kind)) {
    throw new StoryFilmError("invalid_input", "Generation kind ไม่ถูกต้อง");
  }
  if (JOB_STAGE[input.kind] !== input.expectedStage) {
    throw new StoryFilmError("invalid_input", "Generation kind ไม่ตรงกับ stage ปัจจุบัน");
  }
  if (!BACKENDS.has(input.providerBackend)) {
    throw new StoryFilmError("invalid_input", "Generation backend ไม่ถูกต้อง");
  }
  if (!JOB_BACKENDS[input.kind].includes(input.providerBackend)) {
    throw new StoryFilmError("invalid_input", "Generation backend ไม่ตรงกับงานชนิดนี้");
  }
  if (!KEY_PATTERN.test(input.idempotencyKey)) {
    throw new StoryFilmError("invalid_input", "Generation idempotencyKey ไม่ถูกต้อง");
  }
  const sceneKey = input.sceneKey?.trim() || null;
  if (sceneKey && sceneKey.length > 120) throw new StoryFilmError("invalid_input", "sceneKey ยาวเกินกำหนด");
  const priority = Math.max(0, Math.min(1_000, Math.floor(input.priority ?? 100)));
  const payloadJson = cleanPayload(input.payload);

  return prisma.$transaction(async (tx) => {
    const project = await tx.storyFilmProject.findFirst({ where: { id: input.projectId, userId } });
    if (!project) throw new StoryFilmError("not_found", "ไม่พบ Hero Story Film Project");
    const existing = await tx.storyFilmGenerationJob.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) return { created: false, job: publicJob(existing) };

    if (project.stage !== input.expectedStage || project.revision !== input.expectedRevision) {
      throw new StoryFilmError("stale_revision", "โปรเจกต์เปลี่ยนก่อนสร้าง Generation Job");
    }
    if (project.awaitingApproval) {
      throw new StoryFilmError("gate_not_ready", "ยังมีงานรออนุมัติ จึงสร้าง Generation Job ไม่ได้");
    }
    if (["paused", "rendering", "completed", "archived"].includes(project.status)) {
      throw new StoryFilmError("decision_not_allowed", "สถานะโปรเจกต์ไม่อนุญาตให้สร้าง Generation Job");
    }
    const job = await tx.storyFilmGenerationJob.create({
      data: {
        projectId: project.id,
        stage: project.stage,
        projectRevision: project.revision,
        generationEpoch: project.generationEpoch,
        kind: input.kind,
        providerBackend: input.providerBackend,
        sceneKey,
        payloadJson,
        idempotencyKey: input.idempotencyKey,
        priority,
      },
    });
    return { created: true, job: publicJob(job) };
  });
}

export type LeasedStoryFilmJob = ReturnType<typeof publicJob> & {
  leaseToken: string;
  leaseExpiresAt: string;
  payload: Record<string, unknown>;
  resumeProviderJobId: string | null;
};

async function requeueExpiredLeases(tx: Prisma.TransactionClient, now: Date) {
  await tx.storyFilmGenerationJob.updateMany({
    where: { status: { in: LIVE_STATUSES }, leaseExpiresAt: { lte: now } },
    data: {
      status: "queued",
      leaseOwner: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: now,
    },
  });
}

export async function leaseStoryFilmGenerationJobs(input: {
  workerId: string;
  providerBackends: StoryFilmProviderBackend[];
  maxJobs?: number;
  now?: Date;
}): Promise<LeasedStoryFilmJob[]> {
  if (!WORKER_PATTERN.test(input.workerId)) throw new Error("invalid workerId");
  const providerBackends = [...new Set(input.providerBackends)].filter((value) => BACKENDS.has(value));
  if (providerBackends.length === 0) return [];
  const requested = Math.max(1, Math.min(STORY_FILM_WORKER_CONCURRENCY, Math.floor(input.maxJobs ?? 1)));
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + STORY_FILM_LEASE_MS);

  return prisma.$transaction(async (tx) => {
    await requeueExpiredLeases(tx, now);
    const active = await tx.storyFilmGenerationJob.count({
      where: {
        status: { in: LIVE_STATUSES },
        providerBackend: { in: providerBackends },
        leaseExpiresAt: { gt: now },
      },
    });
    const capacity = Math.max(0, Math.min(requested, STORY_FILM_WORKER_CONCURRENCY - active));
    if (capacity === 0) return [];
    const candidates = await tx.storyFilmGenerationJob.findMany({
      where: {
        status: "queued",
        providerBackend: { in: providerBackends },
        availableAt: { lte: now },
        project: { status: { notIn: ["paused", "rendering", "completed", "archived"] } },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: capacity,
    });
    const leased: LeasedStoryFilmJob[] = [];
    for (const candidate of candidates) {
      const leaseToken = newLeaseToken();
      const nextStatus = candidate.providerJobId ? "running" : "leased";
      const claimed = await tx.storyFilmGenerationJob.updateMany({
        where: { id: candidate.id, status: "queued", availableAt: { lte: now } },
        data: {
          status: nextStatus,
          leaseOwner: input.workerId,
          leaseTokenHash: hashLease(leaseToken),
          leaseExpiresAt,
          heartbeatAt: now,
        },
      });
      if (claimed.count !== 1) continue;
      leased.push({
        ...publicJob({ ...candidate, status: nextStatus }),
        leaseToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        payload: parsePayload(candidate.payloadJson),
        resumeProviderJobId: candidate.providerJobId,
      });
    }
    return leased;
  });
}

async function requireLiveLease(
  tx: Prisma.TransactionClient,
  input: { jobId: string; workerId: string; leaseToken: string; now: Date },
) {
  const job = await tx.storyFilmGenerationJob.findUnique({ where: { id: input.jobId } });
  if (!job
    || !LIVE_STATUSES.includes(job.status)
    || job.leaseOwner !== input.workerId
    || job.leaseTokenHash !== hashLease(input.leaseToken)
    || !job.leaseExpiresAt
    || job.leaseExpiresAt <= input.now) {
    throw new Error("invalid_or_expired_lease");
  }
  return job;
}

function validateArtifactForJob(
  job: StoryFilmGenerationJob,
  artifact: {
    mimeType: string;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
  },
) {
  const sizeBytes = artifact.sizeBytes ?? null;
  if (sizeBytes != null && (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 500 * 1024 * 1024)) {
    throw new Error("invalid_artifact_size");
  }
  if (["look_image", "keyframe_image"].includes(job.kind)) {
    if (!artifact.mimeType.startsWith("image/") || sizeBytes == null || sizeBytes > 25 * 1024 * 1024) {
      throw new Error("invalid_image_artifact");
    }
    if (!(artifact.width && artifact.height) || Math.abs(artifact.width / artifact.height - 9 / 16) > 0.03) {
      throw new Error("image_artifact_not_9_16");
    }
  }
  if (["scene_video", "final_render"].includes(job.kind)) {
    if (!artifact.mimeType.startsWith("video/") || sizeBytes == null) throw new Error("invalid_video_artifact");
    if (!(artifact.width && artifact.height) || Math.abs(artifact.width / artifact.height - 9 / 16) > 0.03) {
      throw new Error("video_artifact_not_9_16");
    }
    if (!(artifact.durationMs && artifact.durationMs > 0)) throw new Error("video_duration_unknown");
    if (job.kind === "final_render" && artifact.durationMs > 180_000) throw new Error("final_render_over_180_seconds");
  }
  if (job.kind === "storyboard_plan" && (
    artifact.mimeType !== "application/json"
    || sizeBytes == null
    || sizeBytes > 2 * 1024 * 1024
  )) {
    throw new Error("invalid_storyboard_artifact");
  }
  if (job.kind === "narration_voice" && (
    !artifact.mimeType.startsWith("audio/")
    || sizeBytes == null
    || sizeBytes > 100 * 1024 * 1024
  )) {
    throw new Error("invalid_narration_artifact");
  }
  if (job.kind === "narration_voice" && (!(artifact.durationMs && artifact.durationMs > 0) || artifact.durationMs > 180_000)) {
    throw new Error("narration_duration_invalid");
  }
  if (job.kind === "music" && (
    !artifact.mimeType.startsWith("audio/")
    || sizeBytes == null
    || sizeBytes > 100 * 1024 * 1024
  )) {
    throw new Error("invalid_music_artifact");
  }
  if (job.kind === "music" && !(artifact.durationMs && artifact.durationMs > 0)) {
    throw new Error("music_duration_unknown");
  }
}

export async function heartbeatStoryFilmGenerationJob(input: {
  jobId: string;
  workerId: string;
  leaseToken: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const job = await requireLiveLease(tx, { ...input, now });
    const leaseExpiresAt = new Date(now.getTime() + STORY_FILM_LEASE_MS);
    const updated = await tx.storyFilmGenerationJob.update({
      where: { id: job.id },
      data: { heartbeatAt: now, leaseExpiresAt },
    });
    return { job: publicJob(updated), leaseExpiresAt: leaseExpiresAt.toISOString() };
  });
}

export async function markStoryFilmGenerationSubmitted(input: {
  jobId: string;
  workerId: string;
  leaseToken: string;
  providerJobId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const providerJobId = input.providerJobId.trim();
  if (!providerJobId || providerJobId.length > 500) throw new Error("invalid providerJobId");
  return prisma.$transaction(async (tx) => {
    const job = await requireLiveLease(tx, { ...input, now });
    if (job.providerJobId) {
      if (job.providerJobId !== providerJobId) throw new Error("provider_job_mismatch");
      return { job: publicJob(job), submitted: false };
    }
    const updated = await tx.storyFilmGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "running",
        providerJobId,
        attemptCount: { increment: 1 },
        submittedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + STORY_FILM_LEASE_MS),
      },
    });
    return { job: publicJob(updated), submitted: true };
  });
}

export async function failStoryFilmGenerationJob(input: {
  jobId: string;
  workerId: string;
  leaseToken: string;
  errorCode: string;
  errorMessage: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const errorCode = input.errorCode.trim().slice(0, 120) || "technical_failure";
  const errorMessage = input.errorMessage.trim().slice(0, 2_000) || "Generation failed";
  return prisma.$transaction(async (tx) => {
    const job = await requireLiveLease(tx, { ...input, now });
    const technicalFailureCount = job.technicalFailureCount + 1;
    const terminal = technicalFailureCount >= 2;
    const updated = await tx.storyFilmGenerationJob.update({
      where: { id: job.id },
      data: {
        technicalFailureCount,
        status: terminal ? "needs_attention" : "queued",
        availableAt: now,
        leaseOwner: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        providerJobId: terminal ? job.providerJobId : null,
        submittedAt: terminal ? job.submittedAt : null,
        finishedAt: terminal ? now : null,
        errorCode,
        errorMessage,
      },
    });
    if (terminal) {
      await tx.storyFilmProject.updateMany({
        where: {
          id: job.projectId,
          stage: job.stage,
          generationEpoch: job.generationEpoch,
          status: { notIn: ["paused", "completed", "archived"] },
        },
        data: { status: "needs_attention" },
      });
    }
    return { job: publicJob(updated), retryQueued: !terminal, needsAttention: terminal };
  });
}

export async function completeStoryFilmGenerationJob(input: {
  jobId: string;
  workerId: string;
  leaseToken: string;
  artifact: {
    storageUrl: string;
    mimeType: string;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  };
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!input.artifact.storageUrl || input.artifact.storageUrl.length > 2_000) throw new Error("invalid artifact URL");
  if (!input.artifact.mimeType || input.artifact.mimeType.length > 120) throw new Error("invalid artifact MIME");
  const metadataJson = cleanPayload(input.artifact.metadata ?? {});
  return prisma.$transaction(async (tx) => {
    const existing = await tx.storyFilmArtifact.findUnique({ where: { jobId: input.jobId } });
    if (existing) return { artifact: existing, activatedReview: false, idempotent: true };
    const job = await requireLiveLease(tx, { ...input, now });
    if (job.status !== "running" || !job.providerJobId || job.attemptCount < 1) {
      throw new Error("submission_not_confirmed");
    }
    validateArtifactForJob(job, input.artifact);
    const artifact = await tx.storyFilmArtifact.create({
      data: {
        projectId: job.projectId,
        jobId: job.id,
        stage: job.stage,
        projectRevision: job.projectRevision,
        generationEpoch: job.generationEpoch,
        kind: job.kind,
        sceneKey: job.sceneKey,
        storageUrl: input.artifact.storageUrl,
        mimeType: input.artifact.mimeType,
        sizeBytes: input.artifact.sizeBytes ?? null,
        width: input.artifact.width ?? null,
        height: input.artifact.height ?? null,
        durationMs: input.artifact.durationMs ?? null,
        metadataJson,
      },
    });
    await tx.storyFilmGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        finishedAt: now,
        leaseOwner: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });

    const batchJobs = await tx.storyFilmGenerationJob.findMany({
      where: {
        projectId: job.projectId,
        stage: job.stage,
        generationEpoch: job.generationEpoch,
      },
      select: { status: true },
    });
    const batchComplete = batchJobs.length > 0 && batchJobs.every((item) => item.status === "completed");
    let activatedReview = false;
    if (batchComplete) {
      const artifacts = await tx.storyFilmArtifact.findMany({
        where: {
          projectId: job.projectId,
          stage: job.stage,
          generationEpoch: job.generationEpoch,
        },
        orderBy: { createdAt: "asc" },
      });
      const project = await tx.storyFilmProject.findUnique({ where: { id: job.projectId } });
      if (project
        && project.stage === job.stage
        && project.generationEpoch === job.generationEpoch
        && !project.awaitingApproval) {
        const activated = await tx.storyFilmProject.updateMany({
          where: {
            id: project.id,
            stage: job.stage,
            generationEpoch: job.generationEpoch,
            awaitingApproval: false,
          },
          data: {
            revision: { increment: 1 },
            awaitingApproval: true,
            status: project.status === "paused" ? "paused" : "active",
            ...(job.kind === "narration_voice" ? {
              narrationMasterUrl: artifact.storageUrl,
              narrationDurationMs: artifact.durationMs,
            } : {}),
            ...(job.kind === "final_render" ? {
              finalRenderUrl: artifact.storageUrl,
            } : {}),
            stageDataJson: JSON.stringify({
              gate: job.stage,
              artifactIds: artifacts.map((item) => item.id),
              artifacts: artifacts.map((item) => ({
                id: item.id,
                kind: item.kind,
                sceneKey: item.sceneKey,
                storageUrl: item.storageUrl,
                mimeType: item.mimeType,
                width: item.width,
                height: item.height,
                durationMs: item.durationMs,
              })),
            }),
            lastOpenedAt: now,
          },
        });
        activatedReview = activated.count === 1;
      }
    }
    return { artifact, activatedReview, idempotent: false };
  });
}

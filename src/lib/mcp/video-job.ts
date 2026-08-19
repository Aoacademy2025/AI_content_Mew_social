import type { Prisma, VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { videoExpiryFor } from "@/lib/plan-limits";
import { assertRenderEnqueueOpen } from "@/lib/render-deploy-drain";
import { syncMinuteWindow } from "@/lib/minute-limits";
import { reserveMinutesOrCreditsInTransaction } from "@/lib/minute-credits";
import { serializeCreditFunding } from "@/lib/credits";
import {
  parseAvatarProviderCheckpoint,
  serializeAvatarProviderCheckpoint,
  type AvatarProviderCheckpointV1,
} from "@/lib/mcp/avatar-provider-checkpoint";
import {
  parseHeroVoiceProviderCheckpoint,
  serializeHeroVoiceProviderCheckpoint,
  type HeroVoiceProviderCheckpointV1,
} from "@/lib/mcp/hero-voice-provider-checkpoint";
import type { SubtitleQualityReport } from "@/lib/mcp/subtitle-quality";
import type { VideoJobBillingReceipt } from "@/lib/mcp/billing-receipt";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
export {
  toPublicVideoJobStatus,
  VIDEO_JOB_INFLIGHT_STATUSES,
} from "@/lib/mcp/video-job-status";

const WORKER_REQUEUE_MESSAGE_RE = /^worker restarted - requeued (\d+)\/(\d+)$/;
export const VIDEO_JOB_CANCELED_ERROR = "__job_canceled__";
export const VIDEO_JOB_NOT_PROCESSING_ERROR = "video_job_not_processing";
function restartRequeueCount(errorMessage: string | null): number {
  const match = (errorMessage ?? "").match(WORKER_REQUEUE_MESSAGE_RE);
  return match ? Number(match[1]) : 0;
}

// Pipeline steps that run BEFORE the render route. At these stages nothing billable or
// irreversible has happened yet: no clip reserved (render), no HeyGen call (avatar/composite),
// no gallery Video row (burn). Only these are safe to requeue and replay from the top after a
// worker restart. Anything else (incl. unknown/future steps) is failed instead, so a restart
// can never double-charge clip quota or HeyGen.
const SAFE_TO_REQUEUE_STEPS = new Set(["tts", "captions", "keywords", "stock", "config"]);

function withVideoJobSqliteRetry<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  return withTransientSqliteRetry(operation, {
    onRetry: ({ attempt, delayMs, error }) => {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
      console.warn(`[video-job] ${scope} transient SQLite ${code}; retry ${attempt} in ${delayMs}ms`);
    },
  });
}

export class VideoJobFundingError extends Error {
  readonly code = "insufficient_render_funding";

  constructor(
    message: string,
    public readonly remainingMinutes: number,
  ) {
    super(message);
    this.name = "VideoJobFundingError";
  }
}

export async function createVideoJob(
  userId: string,
  input: unknown,
  idempotencyKey?: string,
  opts: {
    projectId?: string | null;
    type?: string | null;
    idempotencyFingerprint?: string | null;
    projectVisualPin?: {
      contentPreflightId: string | null;
      projectVisualContextJson: string;
    } | null;
    brandVisualAcceptanceJson?: string | null;
    funding?: { meteredMinutes: number; creditsLive: boolean };
  } = {},
) {
  if (opts.funding) {
    await syncMinuteWindow(userId);
  }
  return prisma.$transaction(async (tx) => {
    await assertRenderEnqueueOpen(tx);
    const funding = opts.funding
      ? await reserveMinutesOrCreditsInTransaction(
          tx,
          userId,
          opts.funding.meteredMinutes,
          { creditsLive: opts.funding.creditsLive, ref: idempotencyKey },
        )
      : null;
    if (funding && !funding.allowed) {
      throw new VideoJobFundingError(
        funding.message ?? "เครดิตหรือนาทีคงเหลือไม่เพียงพอ",
        funding.remaining,
      );
    }
    return tx.videoJob.create({
      data: {
        userId,
        projectId: opts.projectId ?? null,
        contentPreflightId: opts.projectVisualPin?.contentPreflightId ?? null,
        projectVisualContextJson: opts.projectVisualPin?.projectVisualContextJson ?? null,
        brandVisualAcceptanceJson: opts.brandVisualAcceptanceJson ?? null,
        ...(opts.type ? { type: opts.type } : {}),
        inputJson: JSON.stringify(input),
        idempotencyKey: idempotencyKey ?? null,
        idempotencyFingerprint: opts.idempotencyFingerprint ?? null,
        status: "queued",
        ...(funding?.allowed
          ? {
              fundingState: "reserved",
              fundedMeteredMinutes: funding.reservedMinutes,
              fundedCreditsSpent: funding.via === "minutes" ? 0 : funding.creditsSpent,
              fundedCreditsFromGranted: funding.via === "minutes" ? 0 : funding.fromGranted,
              fundedCreditsFromPromotional: funding.via === "minutes" ? 0 : funding.fromPromotional,
              fundedCreditFundingJson: funding.via === "minutes" ? null : serializeCreditFunding(funding),
              fundedCreditBalanceAfter: funding.via === "minutes" ? null : funding.balanceAfter,
              walletFundingAuthorized: funding.via === "credits" || funding.via === "mixed",
            }
          : {}),
      },
    });
  });
}

/** Atomically claim the oldest queued job (→ processing). Returns it, or null if none. */
export async function claimNextQueuedJob() {
  const next = await prisma.videoJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
  if (!next) return null;
  const res = await withVideoJobSqliteRetry("claim queued", () => prisma.videoJob.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "processing", startedAt: new Date() },
  }));
  if (res.count !== 1) return null; // lost the race
  return prisma.videoJob.findUnique({ where: { id: next.id } });
}

/**
 * Atomically claim either a due provider wait or the oldest queued job. Provider waits have
 * priority so a completed external job does not sit behind newly-created work.
 */
export async function claimNextRunnableJob(now: Date = new Date()) {
  const due = await prisma.videoJob.findFirst({
    where: { status: "waiting_provider", providerNextPollAt: { lte: now } },
    orderBy: [{ providerNextPollAt: "asc" }, { createdAt: "asc" }],
  });
  if (due) {
    const claimed = await withVideoJobSqliteRetry("claim provider wait", () => prisma.videoJob.updateMany({
      where: {
        id: due.id,
        status: "waiting_provider",
        providerNextPollAt: { lte: now },
      },
      data: { status: "processing", providerNextPollAt: null },
    }));
    if (claimed.count === 1) return prisma.videoJob.findUnique({ where: { id: due.id } });
  }

  return claimNextQueuedJob();
}

export async function saveProviderCheckpoint(id: string, checkpoint: AvatarProviderCheckpointV1) {
  const composite = checkpoint.phase === "composite";
  return withVideoJobSqliteRetry("save provider checkpoint", () => prisma.videoJob.updateMany({
    where: { id, status: "processing" },
    data: {
      providerCheckpointJson: serializeAvatarProviderCheckpoint(checkpoint),
      currentStep: composite ? "composite" : "avatar",
      progress: composite ? 86 : 84,
    },
  }));
}

export async function parkProviderJob(
  id: string,
  checkpoint: AvatarProviderCheckpointV1,
  nextPollAt: Date,
) {
  const composite = checkpoint.phase === "composite";
  return withVideoJobSqliteRetry("park provider job", () => prisma.videoJob.updateMany({
    where: { id, status: "processing" },
    data: {
      status: "waiting_provider",
      currentStep: composite ? "composite" : "avatar",
      progress: composite ? 86 : 84,
      providerCheckpointJson: serializeAvatarProviderCheckpoint(checkpoint),
      providerNextPollAt: nextPollAt,
    },
  }));
}

export async function parkHeroVoiceProviderJob(
  id: string,
  checkpoint: HeroVoiceProviderCheckpointV1,
  nextPollAt: Date,
) {
  return prisma.videoJob.updateMany({
    where: { id, status: "processing" },
    data: {
      status: "waiting_provider",
      currentStep: "tts",
      progress: 10,
      providerCheckpointJson: serializeHeroVoiceProviderCheckpoint(checkpoint),
      providerNextPollAt: nextPollAt,
    },
  });
}

export async function clearProviderCheckpoint(
  id: string,
  expectedCheckpointJson: string,
) {
  return prisma.videoJob.updateMany({
    where: {
      id,
      status: "processing",
      providerCheckpointJson: expectedCheckpointJson,
    },
    data: {
      providerCheckpointJson: null,
      providerNextPollAt: null,
    },
  });
}

export async function setJobStep(id: string, currentStep: string, progress: number) {
  await prisma.videoJob.update({ where: { id }, data: { currentStep, progress } });
}

export async function finishJobWithTransition(
  id: string,
  output: { videoUrl: string; videoId?: string } & Record<string, unknown>,
  opts: {
    now?: Date;
    onTransition?: (input: { tx: Prisma.TransactionClient; job: VideoJob }) => Promise<void>;
  } = {},
) {
  const now = opts.now ?? new Date();
  const owner = await prisma.videoJob.findUnique({
    where: { id },
    select: { status: true, fundingState: true, user: { select: { plan: true } } },
  });
  if (!owner) throw new Error("video_job_not_found");
  if (owner.status === "done") {
    return {
      job: await prisma.videoJob.findUniqueOrThrow({ where: { id } }),
      transitioned: false,
    };
  }

  const mediaExpiresAt = videoExpiryFor(owner.user.plan, now);

  return withVideoJobSqliteRetry("finish job", () => prisma.$transaction(async (tx) => {
    const transitioned = await tx.videoJob.updateMany({
      where: { id, status: "processing" },
      data: {
        status: "done",
        progress: 100,
        outputJson: JSON.stringify(output),
        videoId: output.videoId ?? null,
        finishedAt: now,
        mediaExpiresAt,
        providerCheckpointJson: null,
        providerNextPollAt: null,
        ...(owner.fundingState === "transferred" ? { fundingState: "settled" } : {}),
      },
    });

    // Another terminal transition won after the initial owner lookup. Return an
    // immutable completion, but never resurrect canceled/failed/queued jobs.
    if (transitioned.count === 0) {
      const winner = await tx.videoJob.findUniqueOrThrow({ where: { id } });
      if (winner.status === "done") return { job: winner, transitioned: false };
      if (winner.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
      throw new Error(VIDEO_JOB_NOT_PROCESSING_ERROR);
    }

    const job = await tx.videoJob.findUniqueOrThrow({ where: { id } });
    await opts.onTransition?.({ tx, job });
    if (job.projectId) {
      if (job.type === "export") {
        await tx.editorProject.updateMany({
          where: { id: job.projectId, userId: job.userId, status: { not: "archived" } },
          data: {
            activeExportJobId: job.id,
            ...(output.videoId ? { latestVideoId: output.videoId } : {}),
            status: output.videoId ? "exported" : "post",
            lastOpenedAt: new Date(),
          },
        });
      } else {
        await tx.editorProject.updateMany({
          where: { id: job.projectId, userId: job.userId, status: { not: "archived" } },
          data: {
            activeJobId: job.id,
            ...(output.videoId ? { latestVideoId: output.videoId } : {}),
            status: output.videoId ? "exported" : "post",
            lastOpenedAt: new Date(),
          },
        });
      }
    }

    return { job, transitioned: true };
  }));
}

/**
 * Backward-compatible completion API. Callers that need to own a post-completion
 * side effect should use finishJobWithTransition and require transitioned=true.
 */
export async function finishJob(
  id: string,
  output: { videoUrl: string; videoId?: string } & Record<string, unknown>,
  opts: { now?: Date } = {},
) {
  return (await finishJobWithTransition(id, output, opts)).job;
}

// ── Versioned output (ADR 0001) ──────────────────────────────────────────────
// v1 (MCP full pipeline, ORIGINAL shape): { videoUrl, videoId }
// v2 preview (Editor v2 background render): { version: 2, mode: "preview", videoUrl,
//   preview: { captions, config, voiceUrl, voiceModel, audioDurationMs, avatarModel, avatarVideoUrl,
//   avatarMode, avatarIntroSecs, avatarTailSecs, compositeBaseUrl, tailAvatarUrl } }
// Readers MUST accept both — old rows never get migrated.

export interface VideoJobPreviewData {
  captions: { text: string; startMs: number; endMs: number; tag?: string }[];
  config: Record<string, unknown>;
  voiceUrl: string;
  /** Exact TTS voice used for Gallery metadata. Optional for pre-field preview rows. */
  voiceModel?: string;
  audioDurationMs: number;
  avatarModel?: string;
  avatarVideoUrl?: string | null;
  /** ข้อมูลสำหรับ re-composite อวตารจากจอแต่งซับ (spec 07-03 ข้อ 1) — งานเก่าไม่มี = ซ่อนปุ่มปรับ */
  avatarMode?: string | null;
  avatarIntroSecs?: number;
  avatarTailSecs?: number;
  /** base render ก่อน composite อวตาร = bgVideoUrl ของ /api/heygen/composite */
  compositeBaseUrl?: string | null;
  /** อวตารท้ายคลิป (bookend-both) — จำเป็นตอน re-composite โหมดนั้น */
  tailAvatarUrl?: string | null;
  /** Uploaded-clip cutaway: ranges where the original full-frame speaker overlays B-roll. */
  cutawayPersonRanges?: { start: number; end: number }[];
  /** per-word TTS timeline (script path only) — lets the editor regroup cards
   *  by word count (1/2/3/4 คำ) with exact timing. Absent on cutaway/old jobs
   *  → editor falls back to proportional split. */
  words?: { word: string; startMs: number; endMs: number; startChar: number; endChar: number }[];
  /** exact TTS-spoken text `words` char offsets index into */
  fullText?: string;
}

export interface ParsedVideoJobOutput {
  version: 1 | 2;
  videoUrl?: string;
  videoId?: string;
  sourceJobId?: string;
  subtitleQa?: SubtitleQualityReport;
  billingReceipt?: VideoJobBillingReceipt;
  /** present only on v2 preview jobs */
  preview?: VideoJobPreviewData | null;
}

/** Tolerant parser for VideoJob.outputJson — handles v1, v2, null, and garbage. */
export function parseVideoJobOutput(outputJson: string | null): ParsedVideoJobOutput | null {
  if (!outputJson) return null;
  try {
    const raw = JSON.parse(outputJson) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return null;
    const version = raw.version === 2 ? 2 : 1;
    const preview = version === 2 && typeof raw.preview === "object" && raw.preview !== null
      ? (raw.preview as unknown as VideoJobPreviewData)
      : null;
    const subtitleQa = typeof raw.subtitleQa === "object" && raw.subtitleQa !== null
      ? raw.subtitleQa as unknown as SubtitleQualityReport
      : null;
    const billingReceipt = typeof raw.billingReceipt === "object" && raw.billingReceipt !== null
      ? raw.billingReceipt as unknown as VideoJobBillingReceipt
      : null;
    return {
      version,
      videoUrl: typeof raw.videoUrl === "string" ? raw.videoUrl : undefined,
      videoId: typeof raw.videoId === "string" ? raw.videoId : undefined,
      sourceJobId: typeof raw.sourceJobId === "string" ? raw.sourceJobId : undefined,
      ...(subtitleQa ? { subtitleQa } : {}),
      ...(billingReceipt ? { billingReceipt } : {}),
      ...(preview ? { preview } : {}),
    };
  } catch {
    return null;
  }
}

export type VideoJobFailure = {
  message: string;
  code?: string;
  provider?: string;
  /** Durable retry marker when terminal failure won before its base reservation settled. */
  reservationRefundReason?: string;
};

export async function failJob(id: string, failure: string | VideoJobFailure) {
  const normalized = typeof failure === "string" ? { message: failure } : failure;
  const job = await withVideoJobSqliteRetry("fail job", () => prisma.$transaction(async (tx) => {
    const transitioned = await tx.videoJob.updateMany({
      where: { id, status: "processing" },
      data: {
        status: "failed",
        errorMessage: normalized.message.slice(0, 1000),
        errorCode: normalized.code?.slice(0, 80) ?? null,
        errorProvider: normalized.provider?.slice(0, 80) ?? null,
        ...(normalized.reservationRefundReason
          ? {
              reservationRefundPending: true,
              reservationRefundReason: normalized.reservationRefundReason.slice(0, 160),
            }
          : {}),
        finishedAt: new Date(),
        providerNextPollAt: null,
      },
    });
    if (transitioned.count === 0) {
      return tx.videoJob.findUniqueOrThrow({ where: { id } });
    }

    const job = await tx.videoJob.findUniqueOrThrow({ where: { id } });
    if (job.projectId) {
      if (job.type === "export") {
        await tx.editorProject.updateMany({
          where: { id: job.projectId, userId: job.userId, activeExportJobId: job.id },
          data: { status: "post", lastOpenedAt: new Date() },
        });
      } else {
        await tx.editorProject.updateMany({
          where: { id: job.projectId, userId: job.userId, activeJobId: job.id },
          data: { status: "draft", lastOpenedAt: new Date() },
        });
      }
    }
    return job;
  }));
  // Pre-render wallet funding is still owned by VideoJob. Once transferred,
  // RenderJob/render-route owns any refund and this is an idempotent no-op.
  const { refundVideoJobFunding } = await import("@/lib/mcp/video-job-funding");
  await refundVideoJobFunding(id, job.userId, "job-failed");
  return job;
}

/**
 * On worker startup, any `processing` job was owned by the previous worker process.
 * Requeue jobs that were interrupted in a pre-render (free) stage so a deploy/restart does
 * not turn a recoverable interruption into a user-visible MCP failure.
 *
 * Jobs at or past `render` are NOT auto-requeued — they are failed instead. By then the run
 * has reserved a clip (render), called HeyGen (avatar/composite), or created a gallery Video
 * row (burn); replaying from the top would double-charge clip quota / HeyGen money, or
 * duplicate gallery entries. Resuming those stages idempotently is a larger change — see
 * SAFE_TO_REQUEUE_STEPS.
 */
export async function recoverProcessingJobsAfterWorkerRestart(opts: { maxRequeues?: number; now?: Date } = {}) {
  const rawMaxRequeues = Number(opts.maxRequeues ?? 2);
  const maxRequeues = Number.isFinite(rawMaxRequeues) ? Math.max(0, Math.floor(rawMaxRequeues)) : 2;
  const now = opts.now ?? new Date();
  const jobs = await prisma.videoJob.findMany({
    where: { status: "processing" },
    select: {
      id: true,
      currentStep: true,
      errorMessage: true,
      providerCheckpointJson: true,
      providerNextPollAt: true,
    },
  });

  let requeued = 0;
  let failed = 0;
  let parked = 0;

  for (const job of jobs) {
    const heroVoiceCheckpoint = parseHeroVoiceProviderCheckpoint(job.providerCheckpointJson);
    if (heroVoiceCheckpoint && job.currentStep === "tts") {
      const res = await prisma.videoJob.updateMany({
        where: { id: job.id, status: "processing" },
        data: {
          status: "waiting_provider",
          providerCheckpointJson: serializeHeroVoiceProviderCheckpoint(heroVoiceCheckpoint),
          providerNextPollAt: job.providerNextPollAt ?? now,
        },
      });
      if (res.count === 1) parked++;
      continue;
    }

    const checkpoint = parseAvatarProviderCheckpoint(job.providerCheckpointJson);
    const isProviderStage = job.currentStep === "avatar"
      || job.currentStep === "composite_queue"
      || job.currentStep === "composite";
    if (checkpoint && isProviderStage) {
      let resumable = checkpoint;
      if (checkpoint.phase === "intro_generate") {
        if (!checkpoint.avatar.introVideoId) {
          const res = await prisma.videoJob.updateMany({
            where: { id: job.id, status: "processing" },
            data: {
              status: "failed",
              errorMessage: "worker restarted during HeyGen generate with unknown provider outcome - manual recovery required",
              finishedAt: now,
              providerNextPollAt: null,
            },
          });
          if (res.count === 1) failed++;
          continue;
        }
        resumable = { ...checkpoint, phase: "intro_wait" };
      } else if (checkpoint.phase === "tail_generate") {
        if (!checkpoint.avatar.tailVideoId) {
          const res = await prisma.videoJob.updateMany({
            where: { id: job.id, status: "processing" },
            data: {
              status: "failed",
              errorMessage: "worker restarted during HeyGen generate with unknown provider outcome - manual recovery required",
              finishedAt: now,
              providerNextPollAt: null,
            },
          });
          if (res.count === 1) failed++;
          continue;
        }
        resumable = { ...checkpoint, phase: "tail_wait" };
      }

      const res = await prisma.videoJob.updateMany({
        where: { id: job.id, status: "processing" },
        data: {
          status: "waiting_provider",
          providerCheckpointJson: serializeAvatarProviderCheckpoint(resumable),
          providerNextPollAt: job.providerNextPollAt ?? now,
        },
      });
      if (res.count === 1) parked++;
      continue;
    }

    const previousRequeues = restartRequeueCount(job.errorMessage);
    const isSafeToReplay = job.currentStep === null || SAFE_TO_REQUEUE_STEPS.has(job.currentStep);
    const retryLimitReached = previousRequeues >= maxRequeues;

    if (!isSafeToReplay || retryLimitReached) {
      const reason = !isSafeToReplay
        ? job.currentStep === "burn"
          ? "worker restarted during burn - not auto-requeued to avoid duplicate gallery rows"
          : `worker restarted after billable step (${job.currentStep ?? "unknown"}) - not auto-requeued to avoid double-charging`
        : `worker restarted - retry limit exceeded after ${previousRequeues} requeue(s)`;
      const res = await prisma.videoJob.updateMany({
        where: { id: job.id, status: "processing" },
        data: {
          status: "failed",
          errorMessage: reason,
          reservationRefundPending: true,
          reservationRefundReason: `worker_restart_${job.currentStep ?? "unknown"}_failed`,
          finishedAt: now,
          providerNextPollAt: null,
        },
      });
      if (res.count === 1) failed++;
      continue;
    }

    const nextRequeue = previousRequeues + 1;
    const res = await prisma.videoJob.updateMany({
      where: { id: job.id, status: "processing" },
      data: {
        status: "queued",
        currentStep: null,
        progress: 0,
        startedAt: null,
        finishedAt: null,
        errorMessage: `worker restarted - requeued ${nextRequeue}/${maxRequeues}`,
      },
    });
    if (res.count === 1) requeued++;
  }

  return { inspected: jobs.length, requeued, parked, failed };
}

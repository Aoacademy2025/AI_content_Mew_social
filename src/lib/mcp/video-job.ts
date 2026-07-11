import { prisma } from "@/lib/prisma";
import { videoExpiryFor } from "@/lib/plan-limits";

const WORKER_REQUEUE_MESSAGE_RE = /^worker restarted - requeued (\d+)\/(\d+)$/;

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

export async function createVideoJob(
  userId: string,
  input: unknown,
  idempotencyKey?: string,
  opts: { projectId?: string | null; type?: string | null } = {},
) {
  return prisma.videoJob.create({
    data: {
      userId,
      projectId: opts.projectId ?? null,
      ...(opts.type ? { type: opts.type } : {}),
      inputJson: JSON.stringify(input),
      idempotencyKey: idempotencyKey ?? null,
      status: "queued",
    },
  });
}

/** Atomically claim the oldest queued job (→ processing). Returns it, or null if none. */
export async function claimNextQueuedJob() {
  const next = await prisma.videoJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
  if (!next) return null;
  const res = await prisma.videoJob.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "processing", startedAt: new Date() },
  });
  if (res.count !== 1) return null; // lost the race
  return prisma.videoJob.findUnique({ where: { id: next.id } });
}

export async function setJobStep(id: string, currentStep: string, progress: number) {
  await prisma.videoJob.update({ where: { id }, data: { currentStep, progress } });
}

export async function finishJob(
  id: string,
  output: { videoUrl: string; videoId?: string } & Record<string, unknown>,
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const owner = await prisma.videoJob.findUnique({
    where: { id },
    select: { status: true, user: { select: { plan: true } } },
  });
  if (!owner) throw new Error("video_job_not_found");
  if (owner.status === "done") {
    return prisma.videoJob.findUniqueOrThrow({ where: { id } });
  }

  const mediaExpiresAt = videoExpiryFor(owner.user.plan, now);

  return prisma.$transaction(async (tx) => {
    const transitioned = await tx.videoJob.updateMany({
      where: { id, status: { not: "done" } },
      data: {
        status: "done",
        progress: 100,
        outputJson: JSON.stringify(output),
        videoId: output.videoId ?? null,
        finishedAt: now,
        mediaExpiresAt,
      },
    });

    // Another finisher won after the initial owner lookup. Return its immutable
    // completion and do not repeat any project side effect.
    if (transitioned.count === 0) {
      return tx.videoJob.findUniqueOrThrow({ where: { id } });
    }

    const job = await tx.videoJob.findUniqueOrThrow({ where: { id } });
    if (job.projectId) {
      if (job.type === "export") {
        await tx.editorProject.updateMany({
          where: { id: job.projectId, userId: job.userId },
          data: {
            activeExportJobId: job.id,
            ...(output.videoId ? { latestVideoId: output.videoId } : {}),
            status: output.videoId ? "exported" : "post",
            lastOpenedAt: new Date(),
          },
        });
      } else {
        await tx.editorProject.updateMany({
          where: { id: job.projectId, userId: job.userId },
          data: {
            activeJobId: job.id,
            ...(output.videoId ? { latestVideoId: output.videoId } : {}),
            status: output.videoId ? "exported" : "post",
            lastOpenedAt: new Date(),
          },
        });
      }
    }

    return job;
  });
}

// ── Versioned output (ADR 0001) ──────────────────────────────────────────────
// v1 (MCP full pipeline, ORIGINAL shape): { videoUrl, videoId }
// v2 preview (Editor v2 background render): { version: 2, mode: "preview", videoUrl,
//   preview: { captions, config, voiceUrl, audioDurationMs, avatarModel, avatarVideoUrl,
//   avatarMode, avatarIntroSecs, avatarTailSecs, compositeBaseUrl, tailAvatarUrl } }
// Readers MUST accept both — old rows never get migrated.

export interface VideoJobPreviewData {
  captions: { text: string; startMs: number; endMs: number; tag?: string }[];
  config: Record<string, unknown>;
  voiceUrl: string;
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
    return {
      version,
      videoUrl: typeof raw.videoUrl === "string" ? raw.videoUrl : undefined,
      videoId: typeof raw.videoId === "string" ? raw.videoId : undefined,
      sourceJobId: typeof raw.sourceJobId === "string" ? raw.sourceJobId : undefined,
      ...(preview ? { preview } : {}),
    };
  } catch {
    return null;
  }
}

export async function failJob(id: string, message: string) {
  const job = await prisma.videoJob.update({
    where: { id },
    data: { status: "failed", errorMessage: message.slice(0, 1000), finishedAt: new Date() },
  });
  if (job.projectId) {
    if (job.type === "export") {
      await prisma.editorProject.updateMany({
        where: { id: job.projectId, userId: job.userId, activeExportJobId: job.id },
        data: { status: "post", lastOpenedAt: new Date() },
      });
    } else {
      await prisma.editorProject.updateMany({
        where: { id: job.projectId, userId: job.userId, activeJobId: job.id },
        data: { status: "draft", lastOpenedAt: new Date() },
      });
    }
  }
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
export async function recoverProcessingJobsAfterWorkerRestart(opts: { maxRequeues?: number } = {}) {
  const rawMaxRequeues = Number(opts.maxRequeues ?? 2);
  const maxRequeues = Number.isFinite(rawMaxRequeues) ? Math.max(0, Math.floor(rawMaxRequeues)) : 2;
  const jobs = await prisma.videoJob.findMany({
    where: { status: "processing" },
    select: { id: true, currentStep: true, errorMessage: true },
  });

  let requeued = 0;
  let failed = 0;

  for (const job of jobs) {
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
          finishedAt: new Date(),
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

  return { inspected: jobs.length, requeued, failed };
}

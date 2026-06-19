import { prisma } from "@/lib/prisma";

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

export async function createVideoJob(userId: string, input: unknown, idempotencyKey?: string) {
  return prisma.videoJob.create({
    data: { userId, inputJson: JSON.stringify(input), idempotencyKey: idempotencyKey ?? null, status: "queued" },
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

export async function finishJob(id: string, output: { videoUrl: string; videoId?: string }) {
  await prisma.videoJob.update({
    where: { id },
    data: { status: "done", progress: 100, outputJson: JSON.stringify(output), videoId: output.videoId ?? null, finishedAt: new Date() },
  });
}

export async function failJob(id: string, message: string) {
  await prisma.videoJob.update({
    where: { id },
    data: { status: "failed", errorMessage: message.slice(0, 1000), finishedAt: new Date() },
  });
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

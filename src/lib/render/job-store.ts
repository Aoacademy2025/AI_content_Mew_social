import { prisma } from "@/lib/prisma";
import { refundClipUsage, reserveClipUsage } from "@/lib/usage-limits";
import type { RenderJobType, RenderPayload } from "@/lib/render/types";

export type RenderJobRow = Awaited<ReturnType<typeof prisma.renderJob.findFirst>>;

export async function enqueueRenderJob(input: {
  userId: string;
  type: RenderJobType;
  payload: RenderPayload;
  videoId?: string;
  parentJobId?: string;
  idempotencyKey?: string;
  /** videoId this job is responsible for reserving quota for (first render of a video) */
  reserveQuotaFor?: string;
  /**
   * Set `reservedQuota: true` on the row WITHOUT calling reserveClipUsage here.
   * Use when the caller already reserved the clip (e.g. the legacy render route
   * reserves once before branching) so failRenderJob still refunds, but quota is
   * reserved exactly once per video. Ignored if `reserveQuotaFor` is set.
   */
  markReserved?: boolean;
}): Promise<{ id: string }> {
  let reserved = false;
  if (input.reserveQuotaFor) {
    const r = await reserveClipUsage(input.userId);
    // r === null means user not found; r.allowed === false means quota exceeded
    if (!r || !r.allowed) {
      const e = new Error("quota_exceeded");
      (e as any).code = "quota_exceeded";
      throw e;
    }
    reserved = true;
  } else if (input.markReserved) {
    // Caller already reserved the clip — flag the row so failRenderJob refunds it,
    // but do NOT reserve again (no double-charge).
    reserved = true;
  }
  const job = await prisma.renderJob.create({
    data: {
      userId: input.userId,
      type: input.type,
      payload: JSON.stringify(input.payload),
      videoId: input.videoId ?? null,
      parentJobId: input.parentJobId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      reservedQuota: reserved,
      status: "QUEUED",
    },
  });
  return { id: job.id };
}

/**
 * Atomic claim: oldest QUEUED → RUNNING.
 * Uses guarded updateMany (same pattern as video-job.ts:claimNextQueuedJob).
 * Retries once on a lost race so a second concurrent claimer can still claim
 * the next available job (important for parallel workers / Promise.all tests).
 * Returns null only when there are genuinely no QUEUED jobs remaining.
 */
export async function claimNextRenderJob(): Promise<RenderJobRow | null> {
  // Up to 2 attempts: on a lost race the next-oldest job may still be claimable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await prisma.renderJob.findFirst({
      where: { status: "QUEUED" },
      orderBy: { createdAt: "asc" },
    });
    if (!next) return null; // no QUEUED jobs left
    const res = await prisma.renderJob.updateMany({
      where: { id: next.id, status: "QUEUED" },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        heartbeatAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (res.count === 1) {
      return prisma.renderJob.findUnique({ where: { id: next.id } });
    }
    // Lost the race — loop to try the next available job
  }
  return null;
}

/** Update progress percentage and optional phase label; also bumps heartbeatAt. */
export async function updateRenderProgress(
  id: string,
  progress: number,
  phase?: string,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id },
    data: { progress, phase: phase ?? undefined, heartbeatAt: new Date() },
  });
}

/** Touch heartbeatAt to prevent the sweeper from reclaiming this job. */
export async function heartbeat(id: string): Promise<void> {
  await prisma.renderJob.update({ where: { id }, data: { heartbeatAt: new Date() } });
}

export async function isCancelRequested(id: string): Promise<boolean> {
  const r = await prisma.renderJob.findUnique({ where: { id }, select: { cancelRequested: true } });
  return !!r?.cancelRequested;
}

/** Mark a QUEUED or RUNNING job as cancel-requested; the worker polls isCancelRequested. */
export async function requestCancel(id: string): Promise<void> {
  await prisma.renderJob.updateMany({
    where: { id, status: { in: ["QUEUED", "RUNNING"] } },
    data: { cancelRequested: true },
  });
}

export async function finishRenderJob(id: string, videoUrl: string): Promise<void> {
  await prisma.renderJob.update({
    where: { id },
    data: { status: "DONE", progress: 100, videoUrl, finishedAt: new Date() },
  });
}

/**
 * Fail with retry policy.
 * - If attempts < maxAttempts and requeue !== false: requeue (status → QUEUED).
 * - Otherwise: terminal FAILED + one-time idempotent quota refund (guarded by reservedQuota flag).
 * - No-op if already in a terminal state (FAILED / DONE).
 */
export async function failRenderJob(
  id: string,
  error: unknown,
  opts?: { requeue?: boolean },
): Promise<void> {
  const job = await prisma.renderJob.findUnique({ where: { id } });
  if (!job || job.status === "FAILED" || job.status === "DONE") return; // idempotent: terminal stays terminal

  const errStr = JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
  }).slice(0, 1000);

  const canRetry = (opts?.requeue ?? true) && job.attempts < job.maxAttempts;
  if (canRetry) {
    await prisma.renderJob.update({
      where: { id },
      data: { status: "QUEUED", error: errStr, heartbeatAt: null, startedAt: null },
    });
    return;
  }

  // Terminal path: mark FAILED first, then attempt quota refund
  await prisma.renderJob.update({
    where: { id },
    data: { status: "FAILED", error: errStr, finishedAt: new Date() },
  });

  if (job.reservedQuota) {
    try {
      await refundClipUsage(job.userId);
    } catch (refundErr) {
      // Refund failure must never block the terminal transition — log and continue.
      console.error(`[job-store] refundClipUsage failed for job ${id} user ${job.userId}:`, refundErr);
    }
    // Clear the flag regardless — prevent double-refund on any retry of this path.
    await prisma.renderJob.update({ where: { id }, data: { reservedQuota: false } });
  }
}

/**
 * Graceful-drain requeue (deploy/SIGTERM). The worker already paid an `attempts+1`
 * at claim time (claimNextRenderJob increments on the QUEUED→RUNNING transition).
 * A deploy interruption is NOT a real attempt, so a plain requeue would unfairly
 * burn one retry per deploy. This puts the job back to QUEUED, clears the run
 * markers (startedAt/heartbeatAt) AND decrements attempts by 1 — exactly undoing
 * the claim increment so a drain-requeue nets ZERO consumed attempts.
 *
 * Guarded to RUNNING so it can't resurrect a DONE/FAILED/QUEUED job, and attempts
 * is floored at 0 (never negative). No-op if the job isn't RUNNING.
 */
export async function requeueForShutdown(id: string): Promise<void> {
  const job = await prisma.renderJob.findUnique({ where: { id } });
  if (!job || job.status !== "RUNNING") return; // only an in-flight (claimed) job
  await prisma.renderJob.update({
    where: { id },
    data: {
      status: "QUEUED",
      startedAt: null,
      heartbeatAt: null,
      attempts: Math.max(0, job.attempts - 1), // undo the claim's increment
    },
  });
}

/**
 * Sweep RUNNING jobs whose heartbeatAt is older than staleMs milliseconds.
 * Each dead job is failed with the retry policy (requeue if attempts remain, else FAILED).
 * Returns the count of jobs swept.
 */
export async function sweepDeadRenderJobs(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const dead = await prisma.renderJob.findMany({
    where: { status: "RUNNING", heartbeatAt: { lt: cutoff } },
  });
  for (const job of dead) {
    await failRenderJob(job.id, new Error("stale heartbeat — worker presumed dead"));
  }
  return dead.length;
}

export async function getRenderJob(id: string): Promise<RenderJobRow | null> {
  return prisma.renderJob.findUnique({ where: { id } });
}

import { prisma } from "@/lib/prisma";
import { reserveClipUsage } from "@/lib/usage-limits";
import { refundReservation } from "@/lib/minute-credits";
import type { RenderJobType, RenderPayload } from "@/lib/render/types";

// Refund a job's reserved quota in the SAME bucket it was reserved. Credit-funded
// (creditsSpent>0, set when CREDITS_LIVE overflowed at enqueue) refunds credits;
// minutes-mode (reservedMinutes != null, MINUTE_QUOTA at enqueue) refunds minutes;
// otherwise (clips-mode / flag-off) it refunds a clip. With both flags off, creditsSpent
// is null and reservedMinutes is null → refundReservation calls refundClipUsage exactly
// as before. Fail-open: a refund error must never block the caller's terminal/cancel
// transition.
async function refundJobReservation(
  job: { userId: string; reservedMinutes: number | null; creditsSpent: number | null; creditsFromGranted: number | null },
  context: string,
): Promise<void> {
  try {
    await refundReservation(
      job.userId,
      { reservedMinutes: job.reservedMinutes, creditsSpent: job.creditsSpent, creditsFromGranted: job.creditsFromGranted },
      `queue-${context}`,
    );
  } catch (refundErr) {
    console.error(`[job-store] refund failed ${context} user ${job.userId}:`, refundErr);
  }
}

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
  /**
   * Minutes the CALLER already reserved for this job (MINUTE_QUOTA on). Persisted on
   * RenderJob.reservedMinutes so failRenderJob/supersedeScope refund minutes (not a clip).
   * Does NOT reserve here — the route reserves once before enqueue (paired with markReserved).
   * Undefined → clips-mode row (reservedMinutes null), byte-identical to flag-off.
   */
  reservedMinutes?: number;
  /**
   * Credits the CALLER already spent for this job (CREDITS_LIVE overflow at reserve).
   * Persisted on RenderJob.creditsSpent so failRenderJob/supersedeScope refund the SAME
   * bucket (credits, not minutes/clips). Does NOT spend here — the route spends once
   * before enqueue (paired with markReserved). Undefined → minute/clip-funded row
   * (creditsSpent null), byte-identical to flag-off.
   */
  creditsSpent?: number;
  /**
   * Granted-bucket portion of creditsSpent (the rest came from purchased). Persisted on
   * RenderJob.creditsFromGranted so failRenderJob/supersedeScope refund the EXACT buckets
   * the spend drained — refunding the lump to purchased permanently inflates it (H3).
   * Undefined → null (legacy/lump refund falls back to all-purchased).
   */
  creditsFromGranted?: number;
  /**
   * Render-scope identity (= the legacy route's `renderOwnerKey`, `${userId}:${renderScopeId}`).
   * Stored on the row so the queue path can supersede a prior in-flight job for the
   * same scope+user across processes (the in-memory cancel-registry can't, since the
   * worker renders in a separate process). Null when the request has no jobScopeId
   * (e.g. some MCP jobs, which dedupe via idempotencyKey instead).
   */
  scopeKey?: string | null;
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
      scopeKey: input.scopeKey ?? null,
      reservedQuota: reserved,
      reservedMinutes: input.reservedMinutes ?? null,
      creditsSpent: input.creditsSpent ?? null,
      creditsFromGranted: input.creditsFromGranted ?? null,
      status: "QUEUED",
    },
  });
  return { id: job.id };
}

/**
 * Cross-process scope supersession for the queue path (replaces the in-memory
 * cancel-registry, which lives in the WEB process while the queue renders in a
 * SEPARATE worker). When a user re-renders the same scope (clicks Render again /
 * refresh-resume), cancel any in-flight job for that scope+user so we don't run a
 * second duplicate render or charge a second clip.
 *
 * Handling differs by status because the worker, not this caller, owns the
 * RUNNING→terminal transition:
 *  - QUEUED jobs never ran → cancel them directly (guarded updateMany so a job that
 *    just got claimed isn't clobbered), refunding any reserved clip exactly once
 *    (same idempotent pattern as failRenderJob).
 *  - RUNNING jobs → only set cancelRequested=true; the worker's watchdog polls
 *    isCancelRequested → cancels → failRenderJob(requeue:false) → FAILED + refund via
 *    reservedQuota. Touching their status here would race that refund.
 *
 * A refund failure never blocks the supersede. Returns the count of jobs superseded.
 */
export async function supersedeScope(scopeKey: string, userId: string): Promise<number> {
  let superseded = 0;

  // QUEUED jobs never ran — cancel directly and refund their reserved clip once.
  const queued = await prisma.renderJob.findMany({
    where: { scopeKey, userId, status: "QUEUED" },
  });
  for (const job of queued) {
    // Atomic guarded transition: only cancel if STILL QUEUED (a concurrent claim may
    // have just moved it to RUNNING — let the RUNNING path / worker own that one).
    // Clear reservedQuota, reservedMinutes, creditsSpent AND creditsFromGranted in the SAME
    // write so a CANCELLED job can never linger with any set → no double-refund window. The
    // refund below uses the pre-read job fields (captured by findMany before this update).
    const res = await prisma.renderJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "CANCELLED", finishedAt: new Date(), reservedQuota: false, reservedMinutes: null, creditsSpent: null, creditsFromGranted: null },
    });
    if (res.count !== 1) continue; // lost the race — it's RUNNING now, skip
    superseded++;
    if (job.reservedQuota) {
      // Refund in the SAME bucket reserved: credit-funded (creditsSpent>0) → credits;
      // minutes-mode (reservedMinutes != null) → minutes; else clips. Refund failure must
      // never block the supersede — logged, continue.
      await refundJobReservation(job, `superseding QUEUED job ${job.id}`);
    }
  }

  // RUNNING jobs — request cancel; the worker's watchdog finishes the transition + refund.
  const running = await prisma.renderJob.updateMany({
    where: { scopeKey, userId, status: "RUNNING" },
    data: { cancelRequested: true },
  });
  superseded += running.count;

  return superseded;
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
        progress: 0,
        phase: null,
        error: null,
        cancelRequested: false,
        finishedAt: null,
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
    data: {
      status: "DONE",
      progress: 100,
      phase: "done",
      videoUrl,
      error: null,
      heartbeatAt: null,
      cancelRequested: false,
      finishedAt: new Date(),
    },
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
  if (!job || job.status === "FAILED" || job.status === "DONE" || job.status === "QUEUED") return; // idempotent: terminal stays terminal; QUEUED = already re-enqueued (drain race), must not be re-failed

  const errStr = JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
  }).slice(0, 1000);

  const canRetry = (opts?.requeue ?? true) && job.attempts < job.maxAttempts;
  if (canRetry) {
    await prisma.renderJob.update({
      where: { id },
      data: {
        status: "QUEUED",
        progress: 0,
        phase: null,
        error: null,
        heartbeatAt: null,
        startedAt: null,
        finishedAt: null,
        cancelRequested: false,
      },
    });
    return;
  }

  // Terminal path: mark FAILED first, then attempt quota refund
  await prisma.renderJob.update({
    where: { id },
    data: { status: "FAILED", error: errStr, finishedAt: new Date() },
  });

  if (job.reservedQuota) {
    // Refund in the SAME bucket reserved: credit-funded (creditsSpent>0) → credits;
    // minutes-mode (reservedMinutes != null) → minutes; else clips. Refund failure must
    // never block the terminal transition — logged, continue.
    await refundJobReservation(job, `for job ${id}`);
    // Clear all reservation flags regardless — prevent double-refund on any retry of this path.
    await prisma.renderJob.update({ where: { id }, data: { reservedQuota: false, reservedMinutes: null, creditsSpent: null, creditsFromGranted: null } });
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
      progress: 0,
      phase: null,
      error: null,
      finishedAt: null,
      cancelRequested: false,
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

// Poll-time projection: only the fields the render-progress route reads on each tick
// (ownership + status/progress/receipt) plus createdAt for the queue-position count.
// Deliberately EXCLUDES `payload` (the full render-config JSON) so a status poll never
// hydrates it (PERF-APP-2). The worker still reads the FULL row via claimNextRenderJob
// (findUnique, no select) — this narrow read is only for progress polling.
const RENDER_JOB_POLL_SELECT = {
  id: true,
  userId: true,
  status: true,
  progress: true,
  error: true,
  videoUrl: true,
  creditsSpent: true,
  createdAt: true,
} as const;

export async function getRenderJob(id: string) {
  return prisma.renderJob.findUnique({ where: { id }, select: RENDER_JOB_POLL_SELECT });
}

/**
 * 1-based queue position for a QUEUED RenderJob = (# of QUEUED jobs created strictly
 * before `createdAt`) + 1. `lt` (strict) mirrors the claim order (`createdAt asc` in
 * claimNextRenderJob) so the oldest-waiting job is "#1" — i.e. "you are #N in line".
 * Takes `createdAt` (not an id) because getRenderJob's poll projection already returns it,
 * so this is a single indexed COUNT with no extra row fetch. Only meaningful for a job
 * that is still QUEUED; callers gate on status === "QUEUED".
 */
export async function getRenderQueuePosition(createdAt: Date): Promise<number> {
  const ahead = await prisma.renderJob.count({
    where: { status: "QUEUED", createdAt: { lt: createdAt } },
  });
  return ahead + 1;
}

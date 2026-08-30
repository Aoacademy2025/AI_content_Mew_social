import { prisma } from "@/lib/prisma";
import { failJob } from "@/lib/mcp/video-job";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
import { recordTelemetryEvent } from "@/lib/telemetry";

/**
 * Server-side stall watchdog for VideoJob.
 *
 * Two prod failure shapes this repairs, both invisible to the user until they give up:
 *  1. A row left `processing` because the worker died mid-step without reaching
 *     `recoverProcessingJobsAfterWorkerRestart` (crash without restart, or an orchestration
 *     slot that leaked). Nothing ever moves it, so the customer polls forever.
 *  2. A row left `waiting_provider` with `providerNextPollAt = NULL`. Even with the claim
 *     query widened to cover NULL polls, an explicit poll time keeps the row visible to
 *     ordering and to ops views instead of relying on that one query's null handling.
 *
 * Both are swept by the worker on its poll loop — no cron, no schema change.
 */

const DEFAULT_STALE_MS = 45 * 60_000;

/** Most rows a single sweep will touch. Normally zero; bounds a first-run backlog. */
const SWEEP_BATCH = 200;

export const VIDEO_JOB_STALLED_CODE = "job_stalled";

function parseStaleMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_STALE_MS;
  const value = Number(raw);
  // A malformed override must never widen (or NaN out) the deadline — fail back to 45 min.
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_STALE_MS;
}

export const VIDEO_JOB_STALE_MS = parseStaleMs(process.env.VIDEO_JOB_STALE_MS);

/** Customer-facing copy for a stall. Minutes are derived so an override stays truthful. */
export function stalledVideoJobMessage(staleMs: number = VIDEO_JOB_STALE_MS): string {
  const minutes = Math.round(staleMs / 60_000);
  return `งานหยุดตอบสนองนานเกิน ${minutes} นาที (${VIDEO_JOB_STALLED_CODE}) — ระบบยกเลิกและคืนโควต้าให้แล้ว กรุณาลองใหม่`;
}

function withWatchdogSqliteRetry<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  return withTransientSqliteRetry(operation, {
    onRetry: ({ attempt, delayMs, error }) => {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
      console.warn(`[video-job-watchdog] ${scope} transient SQLite ${code}; retry ${attempt} in ${delayMs}ms`);
    },
  });
}

/**
 * Fail `processing` jobs that stopped making progress, and give unclaimable provider waits
 * a poll time. Safe to run on every worker poll: both passes are guarded by the state they
 * observed, so a concurrent orchestration always wins and a repeat sweep is a no-op.
 *
 * Provider-bound rows (a live `providerCheckpointJson`) are deliberately exempt — HeyGen /
 * Hero Voice work legitimately outlives 45 minutes and owns its own deadline. `queued` rows
 * are exempt too: a long queue is backlog, not a stall.
 */
export async function sweepStalledVideoJobs(
  now: Date = new Date(),
): Promise<{ failed: string[]; repairedPoll: string[] }> {
  const cutoff = new Date(now.getTime() - VIDEO_JOB_STALE_MS);

  const stalled = await prisma.videoJob.findMany({
    where: {
      status: "processing",
      updatedAt: { lt: cutoff },
      providerCheckpointJson: null,
    },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true, userId: true, currentStep: true },
  });

  const failed: string[] = [];
  const message = stalledVideoJobMessage();
  for (const job of stalled) {
    let outcome;
    try {
      // Reuse failJob so the refund marker and the EditorProject transition are byte-identical
      // to any other terminal failure. reservationRefundReason is what sets
      // reservationRefundPending, which the worker's settlement retry then drains.
      outcome = await failJob(job.id, {
        message,
        code: VIDEO_JOB_STALLED_CODE,
        reservationRefundReason: VIDEO_JOB_STALLED_CODE,
      });
    } catch (error) {
      console.error(`[video-job-watchdog] could not fail stalled job ${job.id}:`, error);
      continue;
    }
    // failJob returns the row even when it lost the race to a real terminal transition
    // (the job finished, or the orchestrator failed it first). Only claim — and only
    // report — the transitions this sweep actually owns.
    if (outcome.status !== "failed" || outcome.errorCode !== VIDEO_JOB_STALLED_CODE) continue;
    failed.push(job.id);

    try {
      await recordTelemetryEvent(job.userId, {
        name: "video_job_stalled",
        category: "error",
        source: "server",
        step: job.currentStep,
        status: "failed",
        properties: { videoJobId: job.id, staleMs: VIDEO_JOB_STALE_MS },
      });
    } catch (error) {
      // Telemetry is observability, never a reason to leave a customer's job stuck.
      console.warn(`[video-job-watchdog] telemetry for stalled job ${job.id} failed:`, error);
    }
  }

  const unclaimable = await prisma.videoJob.findMany({
    where: { status: "waiting_provider", providerNextPollAt: null },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true },
  });

  const repairedPoll: string[] = [];
  for (const job of unclaimable) {
    try {
      // Guarded per row (rather than one blanket updateMany) so a row claimed between the
      // read and the write is left alone, and so the returned ids are exactly the rows this
      // sweep repaired. The candidate set is normally empty, so this costs nothing.
      const res = await withWatchdogSqliteRetry("repair provider poll", () => prisma.videoJob.updateMany({
        where: { id: job.id, status: "waiting_provider", providerNextPollAt: null },
        data: { providerNextPollAt: now },
      }));
      if (res.count === 1) repairedPoll.push(job.id);
    } catch (error) {
      console.error(`[video-job-watchdog] could not repair provider poll for ${job.id}:`, error);
    }
  }

  return { failed, repairedPoll };
}

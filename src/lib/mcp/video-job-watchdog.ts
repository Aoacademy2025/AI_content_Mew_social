import { prisma } from "@/lib/prisma";
import { failJob, withVideoJobSqliteRetry } from "@/lib/mcp/video-job";
import { recordTelemetryEvent } from "@/lib/telemetry";

/**
 * Server-side stall watchdog for VideoJob.
 *
 * Two prod failure shapes this repairs, both invisible to the user until they give up:
 *  1. A row left `processing` because the worker died mid-step without reaching
 *     `recoverProcessingJobsAfterWorkerRestart` (crash without restart, or an orchestration
 *     slot that leaked). Nothing ever moves it, so the customer polls forever.
 *  2. A row left `waiting_provider` with `providerNextPollAt = NULL` while still holding a
 *     provider checkpoint. Give it a poll time so it re-enters the normal resume path.
 *
 * Both are swept by the worker on its poll loop — no cron, no schema change.
 */

const DEFAULT_STALE_MS = 45 * 60_000;

/**
 * Longer deadline for the steps that make ONE blocking, progress-silent call to
 * `/api/heygen/composite` (route `maxDuration = 3600`, several sequential ffmpeg stages).
 * Such a job legitimately writes nothing for far longer than 45 minutes, so the ordinary
 * rule would fail-and-refund work that is still running and about to succeed.
 *
 * Sits deliberately above `DEFAULT_PIPELINE_TIMEOUT_MS` (65 min, pipeline-client.ts): the
 * HTTP client always gives up first and the orchestrator fails the job itself, so this
 * deadline only ever fires on a genuinely abandoned row. Module constant, not an env knob.
 */
const COMPOSITE_STALE_MS = 90 * 60_000;

/**
 * `currentStep` values a job can be parked at during that blocking composite call — verified
 * against the three non-checkpointed composite POSTs in orchestrator.ts:
 *   :1089 `step("composite", 80)`  → b-roll re-render, cutaway re-composite
 *   :1110 `step("avatar", 80)`     → b-roll re-render, AI-avatar re-composite
 *   :1700 `step("composite", 90)`  → uploaded-clip cutaway composite
 * None of the three passes `videoJobId`, so `markOwningCompositeJob` in the composite route
 * is a no-op for them and the orchestrator's own step name is what the row carries.
 * `composite_queue` is included because callers that DO pass `videoJobId` (avatar-steps.ts)
 * make the route write that step while it waits for an admission lease.
 */
const COMPOSITE_BOUND_STEPS = new Set(["composite", "composite_queue", "avatar"]);

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

/** How long a job at this step may go silent before it counts as stalled. */
export function staleMsForStep(currentStep: string | null): number {
  return currentStep != null && COMPOSITE_BOUND_STEPS.has(currentStep)
    ? Math.max(VIDEO_JOB_STALE_MS, COMPOSITE_STALE_MS)
    : VIDEO_JOB_STALE_MS;
}

/** Customer-facing copy for a stall. Minutes are derived so the number is always truthful. */
export function stalledVideoJobMessage(staleMs: number = VIDEO_JOB_STALE_MS): string {
  const minutes = Math.round(staleMs / 60_000);
  return `งานหยุดตอบสนองนานเกิน ${minutes} นาที (${VIDEO_JOB_STALLED_CODE}) — ระบบยกเลิกและคืนโควต้าให้แล้ว กรุณาลองใหม่`;
}

/**
 * Fail `processing` jobs that stopped making progress, and give unclaimable provider waits
 * a poll time. Safe to run on every worker poll: both passes are guarded by the state they
 * observed, so a concurrent orchestration always wins and a repeat sweep is a no-op.
 *
 * Rows with a live `providerCheckpointJson` are exempt entirely — HeyGen / Hero Voice work
 * owns its own 2 h provider deadline. `queued` rows are exempt too: a long queue is backlog,
 * not a stall. Composite-bound steps get the longer deadline above.
 */
export async function sweepStalledVideoJobs(
  now: Date = new Date(),
): Promise<{ failed: string[]; repairedPoll: string[] }> {
  // Read at the SHORTEST deadline, then apply each row's own deadline in JS. One query, and
  // adding a longer-deadline step can never accidentally widen what the query returns.
  const candidates = await withVideoJobSqliteRetry("watchdog scan stalled", () => prisma.videoJob.findMany({
    where: {
      status: "processing",
      updatedAt: { lt: new Date(now.getTime() - VIDEO_JOB_STALE_MS) },
      providerCheckpointJson: null,
    },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true, userId: true, currentStep: true, updatedAt: true },
  }));

  const failed: string[] = [];
  for (const job of candidates) {
    const staleMs = staleMsForStep(job.currentStep);
    if (job.updatedAt.getTime() >= now.getTime() - staleMs) continue; // still inside its deadline

    let outcome;
    try {
      // Reuse failJob so the refund marker and the EditorProject transition are byte-identical
      // to any other terminal failure. reservationRefundReason is what sets
      // reservationRefundPending, which the worker's settlement retry then drains.
      outcome = await failJob(job.id, {
        message: stalledVideoJobMessage(staleMs),
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
        properties: { videoJobId: job.id, staleMs },
      });
    } catch (error) {
      // Telemetry is observability, never a reason to leave a customer's job stuck.
      console.warn(`[video-job-watchdog] telemetry for stalled job ${job.id} failed:`, error);
    }
  }

  // Only checkpointed waits are repaired. A checkpoint-less waiting_provider row has nothing
  // for the orchestrator to resume from, so scheduling it would replay TTS/render/HeyGen from
  // the top and charge the provider twice — the same reason claimNextRunnableJob refuses it.
  // Such rows are left inert; no current writer produces one.
  const unclaimable = await withVideoJobSqliteRetry("watchdog scan provider waits", () => prisma.videoJob.findMany({
    where: {
      status: "waiting_provider",
      providerNextPollAt: null,
      providerCheckpointJson: { not: null },
    },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true },
  }));

  const repairedPoll: string[] = [];
  for (const job of unclaimable) {
    try {
      // Guarded per row (rather than one blanket updateMany) so a row claimed between the
      // read and the write is left alone, and so the returned ids are exactly the rows this
      // sweep repaired. The candidate set is normally empty, so this costs nothing.
      const res = await withVideoJobSqliteRetry("watchdog repair provider poll", () => prisma.videoJob.updateMany({
        where: {
          id: job.id,
          status: "waiting_provider",
          providerNextPollAt: null,
          providerCheckpointJson: { not: null },
        },
        data: { providerNextPollAt: now },
      }));
      if (res.count === 1) repairedPoll.push(job.id);
    } catch (error) {
      console.error(`[video-job-watchdog] could not repair provider poll for ${job.id}:`, error);
    }
  }

  return { failed, repairedPoll };
}

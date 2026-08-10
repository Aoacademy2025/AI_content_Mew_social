import "server-only";

import type { AiGenerationJob } from "@prisma/client";
import {
  completeImageJob,
  failAndRefundAiJob,
  latestImageGenerationAttempt,
} from "@/lib/ai-generation-jobs.server";
import { persistAiGenerationImage } from "@/lib/ai-generation-media.server";
import {
  pollImageGenerationAttempt,
  type ImageGenerationAttemptRef,
  type ImageProviderSnapshot,
} from "@/lib/image-generation-provider.server";
import { prisma } from "@/lib/prisma";
import { cancelRunpodImageJob } from "@/lib/runpod-serverless";

/**
 * Money-safety backstop for AI image credit reservations.
 *
 * `generateHeroImageForVideo` deliberately KEEPS a reservation in two cases where
 * refunding could double-pay or double-generate: a RunPod status-poll outage
 * (PROVIDER_POLL_FAILED, after 5 consecutive failures) and a hard deadline reached
 * while the provider job could not be confirmed cancelled (PROVIDER_TIMEOUT). Those
 * rows sit at chargeState="reserved" forever — `refundSettledVideoImageBatch` only
 * compensates already-settled work, so nothing else sweeps them.
 *
 * This sweeper is namespace-agnostic: every AiGenerationJob with kind="image"
 * qualifies (`video:<id>:scene:`, `video:<id>:automix:`, `broll-window:`, `studio:`).
 * Every mutation goes through the existing helpers (completeImageJob /
 * failAndRefundAiJob) so their chargeState transition guards make re-runs safe —
 * a job can never be refunded twice or settled after a refund.
 */

/**
 * The safety property here is `updatedAt`, not age: a live request refreshes its job
 * row on every poll tick (markImageAttemptProgress, roughly once a second), so
 * `updatedAt < cutoff` can only match rows that nobody is driving any more. The
 * 30-minute floor is generous margin over the ~28-minute worst case from creation to
 * abandonment (two bounded 840s provider attempts plus queue waits).
 *
 * NEVER switch this query to `createdAt` — that would match jobs a request is still
 * actively polling and would reintroduce the double-spend race this sweep closes.
 */
export const SWEEP_MIN_STALE_MINUTES = 30;
export const SWEEP_MAX_STALE_MINUTES = 10_080; // 7 days
export const SWEEP_DEFAULT_STALE_MINUTES = 30;
export const SWEEP_MIN_LIMIT = 1;
export const SWEEP_MAX_LIMIT = 200;
export const SWEEP_DEFAULT_LIMIT = 50;

const TERMINAL_PROVIDER_STATUS = new Set(["FAILED", "TIMED_OUT", "CANCELLED"]);

/** Reservation could not be reconciled to a delivered image. */
const REFUND_STALE = "SWEEP_STALE_RESERVED";
/** Provider says the work completed but the image can no longer be retrieved. */
const REFUND_OUTPUT_LOST = "SWEEP_OUTPUT_LOST";
/** The provider result arrived after its parent video became undeliverable. */
const REFUND_PARENT_TERMINAL = "PARENT_VIDEO_TERMINAL";

export type StaleReservedImageAction = "settle" | "refund" | "skip";

export type StaleReservedImageDecision = {
  jobId: string;
  action: StaleReservedImageAction;
  /** Why the sweep chose this action — operator-facing, never provider payloads. */
  reason: string;
  credits: number;
  /** Set when the sweep tried to stop a still-running provider job before refunding. */
  cancelAttempted?: boolean;
  cancelOk?: boolean;
};

type CancelOutcome = { cancelAttempted: boolean; cancelOk: boolean };

export type StaleReservedImageSweepSummary = {
  dryRun: boolean;
  olderThanMinutes: number;
  limit: number;
  scanned: number;
  settled: number;
  refunded: number;
  refundedCredits: number;
  skipped: number;
  decisions: StaleReservedImageDecision[];
  errors: { jobId: string; message: string }[];
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Provider/system error text kept short and free of request payloads. */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown error";
  return raw.replace(/\s+/g, " ").slice(0, 200);
}

function parseInputJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Mirror the label the hero seam would have written had it settled inline. */
function sceneTitleForJob(job: AiGenerationJob): string | undefined {
  const input = parseInputJson(job.inputJson);
  const videoJobId = typeof input?.videoJobId === "string" ? input.videoJobId : null;
  const sceneIndex = typeof input?.sceneIndex === "number" && Number.isInteger(input.sceneIndex)
    ? input.sceneIndex
    : null;
  if (videoJobId && sceneIndex !== null) return `Video ${videoJobId} · scene ${sceneIndex + 1}`;
  return undefined;
}

function parentVideoJobId(job: AiGenerationJob): string | null {
  const match = /^video:([^:]+):/.exec(job.idempotencyKey ?? "");
  return match?.[1]?.trim() || null;
}

async function terminalParentVideoStatus(job: AiGenerationJob): Promise<"done" | "failed" | "canceled" | null> {
  const videoJobId = parentVideoJobId(job);
  if (!videoJobId) return null;
  const parent = await prisma.videoJob.findFirst({
    where: { id: videoJobId, userId: job.userId },
    select: { status: true },
  });
  return parent?.status === "done" || parent?.status === "failed" || parent?.status === "canceled"
    ? parent.status
    : null;
}

/**
 * Ask the provider to stop work we are about to refund, so an abandoned job stops
 * burning COGS. Strictly best-effort: every failure is swallowed and only logged, so
 * it can never block, reorder or fail the refund that follows.
 */
async function bestEffortCancel(input: {
  jobId: string;
  attemptProvider: string;
  providerEndpoint: string | null;
  providerJobId: string;
}): Promise<CancelOutcome> {
  if (input.attemptProvider !== "runpod" || !input.providerEndpoint) {
    return { cancelAttempted: false, cancelOk: false };
  }
  try {
    const cancelled = await cancelRunpodImageJob(input.providerEndpoint, input.providerJobId);
    if (!cancelled) {
      console.warn(
        `[reconcile-ai-images] orphaned RunPod job ${input.providerJobId} (image job ${input.jobId}) was not confirmed cancelled`,
      );
    }
    return { cancelAttempted: true, cancelOk: cancelled };
  } catch (error) {
    console.warn(
      `[reconcile-ai-images] orphaned RunPod job ${input.providerJobId} (image job ${input.jobId}) cancel failed: ${safeMessage(error)}`,
    );
    return { cancelAttempted: true, cancelOk: false };
  }
}

async function refundJob(input: {
  job: AiGenerationJob;
  errorCode: typeof REFUND_STALE | typeof REFUND_OUTPUT_LOST | typeof REFUND_PARENT_TERMINAL;
  errorMessage: string;
  reason: string;
  dryRun: boolean;
  cancel?: CancelOutcome;
}): Promise<StaleReservedImageDecision> {
  const { job, reason } = input;
  const cancel = input.cancel ?? {};
  if (input.dryRun) {
    return { jobId: job.id, action: "refund", reason, credits: job.creditCost, ...cancel };
  }
  const updated = await failAndRefundAiJob(job.userId, job.id, input.errorCode, input.errorMessage);
  if (updated?.chargeState !== "refunded") {
    // Another worker (or the original request) settled/refunded it first. The
    // transition guard inside failAndRefundAiJob already prevented a second payout.
    return { jobId: job.id, action: "skip", reason: "already_terminal", credits: 0, ...cancel };
  }
  return { jobId: job.id, action: "refund", reason, credits: job.creditCost, ...cancel };
}

async function reconcileJob(job: AiGenerationJob, dryRun: boolean): Promise<StaleReservedImageDecision> {
  const parentStatus = await terminalParentVideoStatus(job);
  if (parentStatus) {
    // A terminal parent can no longer consume a reserved image. This includes a
    // successful `done` AutoMix which deliberately omitted an ambiguous slot:
    // accepting a late provider result would charge for an image that is absent
    // from the delivered video. Refund before polling or persisting output.
    return refundJob({
      job,
      errorCode: REFUND_PARENT_TERMINAL,
      errorMessage: `Parent video is ${parentStatus}`,
      reason: `parent_${parentStatus}`,
      dryRun,
    });
  }
  const attempt = await latestImageGenerationAttempt(job.userId, job.id);
  const providerJobId = attempt?.providerJobId ?? job.providerJobId;
  if (!attempt || !providerJobId) {
    // Nothing durable to poll: the reservation can never be reconciled to work.
    return refundJob({
      job,
      errorCode: REFUND_STALE,
      errorMessage: "Stale reservation without a durable provider job id",
      reason: "no_provider_job",
      dryRun,
    });
  }

  const ref: ImageGenerationAttemptRef = {
    provider: attempt.provider,
    providerModel: attempt.providerModel,
    providerRoute: attempt.providerRoute,
    providerEndpoint: attempt.providerEndpoint,
    providerJobId,
  };

  let snapshot: ImageProviderSnapshot;
  try {
    snapshot = await pollImageGenerationAttempt(ref);
  } catch (error) {
    // 30+ minutes stale AND the provider still cannot be queried: bias to the
    // customer and release the money.
    return refundJob({
      job,
      errorCode: REFUND_STALE,
      errorMessage: `Provider status unavailable during reconcile: ${safeMessage(error)}`,
      reason: "poll_failed",
      dryRun,
    });
  }

  if (snapshot.status === "COMPLETED") {
    if (!snapshot.image) {
      return refundJob({
        job,
        errorCode: REFUND_OUTPUT_LOST,
        errorMessage: "Provider reported COMPLETED without an image",
        reason: "output_missing",
        dryRun,
      });
    }
    if (dryRun) {
      // Upper bound on settlements: whether the image is still RETRIEVABLE can only
      // be proven by storing it, which a dry run must not do. A live run turns an
      // unretrievable output into a SWEEP_OUTPUT_LOST refund instead.
      return { jobId: job.id, action: "settle", reason: "provider_completed", credits: job.creditCost };
    }
    let outputUrl: string;
    try {
      outputUrl = await persistAiGenerationImage(snapshot.image);
    } catch (error) {
      return refundJob({
        job,
        errorCode: REFUND_OUTPUT_LOST,
        errorMessage: `Provider output could not be stored: ${safeMessage(error)}`,
        reason: "output_unretrievable",
        dryRun,
      });
    }
    const completed = await completeImageJob({
      userId: job.userId,
      jobId: job.id,
      outputUrl,
      delayTimeMs: snapshot.delayTimeMs,
      executionTimeMs: snapshot.executionTimeMs,
      providerReportedCostUsdMicros: snapshot.providerReportedCostUsdMicros,
      providerReportedCredits: snapshot.providerReportedCredits,
      sceneTitle: sceneTitleForJob(job),
    });
    if (completed?.status !== "completed" || !completed.outputUrl) {
      // completeImageJob refuses to settle a job that was failed/refunded meanwhile.
      return { jobId: job.id, action: "skip", reason: "already_terminal", credits: 0 };
    }
    return { jobId: job.id, action: "settle", reason: "provider_completed", credits: job.creditCost };
  }

  if (TERMINAL_PROVIDER_STATUS.has(snapshot.status)) {
    return refundJob({
      job,
      errorCode: REFUND_STALE,
      errorMessage: snapshot.error || `Provider job ${snapshot.status.toLowerCase()}`,
      reason: `provider_${snapshot.status.toLowerCase()}`,
      dryRun,
    });
  }

  // Still queued/running long after the caller's own bounded wait expired, or an
  // unrecognized status. The image is no longer deliverable to that request, so the
  // money goes back — after a best-effort attempt to stop the orphaned provider job.
  const cancel = dryRun
    ? undefined
    : await bestEffortCancel({
        jobId: job.id,
        attemptProvider: attempt.provider,
        providerEndpoint: attempt.providerEndpoint,
        providerJobId,
      });
  return refundJob({
    job,
    errorCode: REFUND_STALE,
    errorMessage: `Provider still reports ${snapshot.status} after the reservation went stale`,
    reason: `provider_${String(snapshot.status).toLowerCase()}`,
    dryRun,
    cancel,
  });
}

/**
 * Settle-or-refund image reservations that have been stuck at chargeState="reserved"
 * longer than `olderThanMinutes`. Oldest first, capped at `limit` per run. One bad
 * job never aborts the sweep — failures are collected in `errors`.
 */
export async function sweepStaleReservedImageJobs(opts: {
  olderThanMinutes?: number;
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<StaleReservedImageSweepSummary> {
  const olderThanMinutes = clampInt(
    opts.olderThanMinutes,
    SWEEP_DEFAULT_STALE_MINUTES,
    SWEEP_MIN_STALE_MINUTES,
    SWEEP_MAX_STALE_MINUTES,
  );
  const limit = clampInt(opts.limit, SWEEP_DEFAULT_LIMIT, SWEEP_MIN_LIMIT, SWEEP_MAX_LIMIT);
  const dryRun = opts.dryRun === true;

  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const jobs = await prisma.aiGenerationJob.findMany({
    where: { kind: "image", chargeState: "reserved", updatedAt: { lt: cutoff } },
    orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  const summary: StaleReservedImageSweepSummary = {
    dryRun,
    olderThanMinutes,
    limit,
    scanned: jobs.length,
    settled: 0,
    refunded: 0,
    refundedCredits: 0,
    skipped: 0,
    decisions: [],
    errors: [],
  };

  for (const job of jobs) {
    try {
      const decision = await reconcileJob(job, dryRun);
      summary.decisions.push(decision);
      if (decision.action === "settle") summary.settled += 1;
      else if (decision.action === "refund") {
        summary.refunded += 1;
        summary.refundedCredits += decision.credits;
      } else summary.skipped += 1;
    } catch (error) {
      summary.errors.push({ jobId: job.id, message: safeMessage(error) });
      console.error(`[reconcile-ai-images] job ${job.id} reconcile error:`, safeMessage(error));
    }
  }

  return summary;
}

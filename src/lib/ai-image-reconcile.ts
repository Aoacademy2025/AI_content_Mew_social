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

/** An in-flight hero request can legitimately hold a reservation for ~28 minutes
 * (two bounded 840s provider attempts plus queue waits), so the sweep window can
 * never be tightened below the 30 minutes the launch plan specifies. */
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

export type StaleReservedImageAction = "settle" | "refund" | "skip";

export type StaleReservedImageDecision = {
  jobId: string;
  action: StaleReservedImageAction;
  /** Why the sweep chose this action — operator-facing, never provider payloads. */
  reason: string;
  credits: number;
};

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

async function refundJob(input: {
  job: AiGenerationJob;
  errorCode: typeof REFUND_STALE | typeof REFUND_OUTPUT_LOST;
  errorMessage: string;
  reason: string;
  dryRun: boolean;
}): Promise<StaleReservedImageDecision> {
  const { job, reason } = input;
  if (input.dryRun) {
    return { jobId: job.id, action: "refund", reason, credits: job.creditCost };
  }
  const updated = await failAndRefundAiJob(job.userId, job.id, input.errorCode, input.errorMessage);
  if (updated?.chargeState !== "refunded") {
    // Another worker (or the original request) settled/refunded it first. The
    // transition guard inside failAndRefundAiJob already prevented a second payout.
    return { jobId: job.id, action: "skip", reason: "already_terminal", credits: 0 };
  }
  return { jobId: job.id, action: "refund", reason, credits: job.creditCost };
}

async function reconcileJob(job: AiGenerationJob, dryRun: boolean): Promise<StaleReservedImageDecision> {
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
  // unrecognized status. The image is no longer deliverable to that request.
  return refundJob({
    job,
    errorCode: REFUND_STALE,
    errorMessage: `Provider still reports ${snapshot.status} after the reservation went stale`,
    reason: `provider_${String(snapshot.status).toLowerCase()}`,
    dryRun,
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

import { prisma } from "@/lib/prisma";
import { parseCreditFunding, refundCreditsInTransaction } from "@/lib/credits";
import {
  restoreSettledStarterAiImageAllowance,
  settleStarterAiImageAllowance,
} from "@/lib/starter-ai-image-allowance.server";

/**
 * Compensate one completed Hero image when the customer-facing derivative
 * (for example its B-roll Ken Burns clip) cannot be delivered. The exact job
 * and chargeState claim make retries safe and prevent cross-request refunds.
 */
export async function refundSettledVideoImageJob(input: {
  userId: string;
  jobId: string;
  reason: string;
}): Promise<{ refunded: boolean; refundedCredits: number }> {
  const reason = input.reason.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80) || "output_failed";
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({
      where: {
        id: input.jobId,
        userId: input.userId,
        kind: "image",
        status: "completed",
        chargeState: "settled",
      },
    });
    if (!job) return { refunded: false, refundedCredits: 0 };

    const claimed = await tx.aiGenerationJob.updateMany({
      where: {
        id: job.id,
        userId: input.userId,
        status: "completed",
        chargeState: "settled",
      },
      data: {
        status: "failed",
        chargeState: "refunded",
        errorCode: "POST_PROCESSING_FAILED",
        errorMessage: `Hero B-roll output failed: ${reason}`,
      },
    });
    if (claimed.count !== 1) return { refunded: false, refundedCredits: 0 };

    await tx.projectVisualBeat.updateMany({
      where: { userId: input.userId, existingImageJobId: job.id },
      data: { status: "outdated", outdatedAt: new Date() },
    });

    if (job.fundingSource === "starter_allowance") {
      if (!job.allowanceWindowStartedAt) {
        throw new Error("Starter allowance job is missing its usage window");
      }
      await restoreSettledStarterAiImageAllowance(tx, {
        userId: input.userId,
        windowStartedAt: job.allowanceWindowStartedAt,
        units: job.allowanceUnits,
      });
      return { refunded: true, refundedCredits: 0 };
    }
    const funding = parseCreditFunding(job.creditFundingJson, {
      fromGranted: job.creditsFromGranted,
      fromPromotional: job.creditsFromPromotional,
      fromPurchased: job.creditsFromPurchased,
    }, job.creditCost);
    await refundCreditsInTransaction(
      tx,
      input.userId,
      funding.fromGranted,
      funding.fromPurchased,
      `ai-image-output-refund:${job.id}:${reason}`,
      funding.promotionalDebits,
    );
    return { refunded: true, refundedCredits: job.creditCost };
  });
}

/**
 * Compensate every charged/reserved scene image when its parent video cannot be
 * delivered. Claiming both states in one transaction closes the race where the
 * provider completes a reserved child only after the parent already failed.
 */
export async function refundSettledVideoImageBatch(input: {
  userId: string;
  videoJobId: string;
  reason: string;
}): Promise<{
  refundedJobs: number;
  refundedCredits: number;
  creditsFromGranted: number;
  creditsFromPromotional: number;
  creditsFromPurchased: number;
}> {
  // Every image charged to a video shares the `video:<jobId>:` idempotency namespace
  // (`:scene:` for Hero-only mode, `:automix:` for AutoMix AI slots), so one prefix
  // compensates the whole video. Per-window regenerations live in the separate
  // `broll-window:` namespace and are deliberately NOT swept here — they are explicit,
  // already-delivered purchases against a finished video.
  const prefix = `video:${input.videoJobId}:`;
  const reason = input.reason.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80) || "video_failed";
  return prisma.$transaction(async (tx) => {
    const jobs = await tx.aiGenerationJob.findMany({
      where: {
        userId: input.userId,
        kind: "image",
        chargeState: { in: ["reserved", "settled"] },
        idempotencyKey: { startsWith: prefix },
      },
      orderBy: { createdAt: "asc" },
    });
    let refundedJobs = 0;
    let refundedCredits = 0;
    let creditsFromGranted = 0;
    let creditsFromPromotional = 0;
    let creditsFromPurchased = 0;

    for (const job of jobs) {
      const previousChargeState = job.chargeState;
      const claimed = await tx.aiGenerationJob.updateMany({
        where: { id: job.id, userId: input.userId, chargeState: previousChargeState },
        data: {
          status: "failed",
          chargeState: "refunded",
          errorCode: "PARENT_VIDEO_FAILED",
          errorMessage: `Parent video failed: ${reason}`,
          finishedAt: new Date(),
        },
      });
      if (claimed.count !== 1) continue;

      await tx.aiGenerationAttempt.updateMany({
        where: {
          jobId: job.id,
          status: { in: ["planned", "submitting", "submitted", "queued", "in_progress"] },
        },
        data: {
          status: "failed",
          errorCode: "PARENT_VIDEO_FAILED",
          errorMessage: `Parent video failed: ${reason}`,
          finishedAt: new Date(),
        },
      });

      await tx.projectVisualBeat.updateMany({
        where: { userId: input.userId, existingImageJobId: job.id },
        data: { status: "outdated", outdatedAt: new Date() },
      });

      if (job.fundingSource === "starter_allowance") {
        if (!job.allowanceWindowStartedAt) {
          throw new Error("Starter allowance job is missing its usage window");
        }
        if (previousChargeState === "reserved") {
          await settleStarterAiImageAllowance(tx, {
            userId: input.userId,
            windowStartedAt: job.allowanceWindowStartedAt,
            units: job.allowanceUnits,
            outcome: "refunded",
          });
        } else {
          await restoreSettledStarterAiImageAllowance(tx, {
            userId: input.userId,
            windowStartedAt: job.allowanceWindowStartedAt,
            units: job.allowanceUnits,
          });
        }
        refundedJobs += 1;
        continue;
      }

      const funding = parseCreditFunding(job.creditFundingJson, {
        fromGranted: job.creditsFromGranted,
        fromPromotional: job.creditsFromPromotional,
        fromPurchased: job.creditsFromPurchased,
      }, job.creditCost);
      await refundCreditsInTransaction(
        tx,
        input.userId,
        funding.fromGranted,
        funding.fromPurchased,
        `ai-image-batch-refund:${job.id}:${reason}`,
        funding.promotionalDebits,
      );
      refundedJobs += 1;
      refundedCredits += job.creditCost;
      creditsFromGranted += funding.fromGranted;
      creditsFromPromotional += funding.fromPromotional;
      creditsFromPurchased += funding.fromPurchased;
    }

    return {
      refundedJobs,
      refundedCredits,
      creditsFromGranted,
      creditsFromPromotional,
      creditsFromPurchased,
    };
  });
}

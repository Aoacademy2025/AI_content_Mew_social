import { prisma } from "@/lib/prisma";

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

    const restored = await tx.creditBalance.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        granted: job.creditsFromGranted,
        purchased: job.creditsFromPurchased,
      },
      update: {
        granted: { increment: job.creditsFromGranted },
        purchased: { increment: job.creditsFromPurchased },
      },
    });
    await tx.creditLedger.create({
      data: {
        userId: input.userId,
        delta: job.creditCost,
        kind: "refund",
        action: `ai-image-output-refund:${job.id}:${reason}`,
        balanceAfter: restored.granted + restored.purchased,
      },
    });
    return { refunded: true, refundedCredits: job.creditCost };
  });
}

/**
 * Compensate completed scene images when their parent video cannot be delivered.
 * Each job is claimed by chargeState inside the transaction, making retries safe.
 */
export async function refundSettledVideoImageBatch(input: {
  userId: string;
  videoJobId: string;
  reason: string;
}): Promise<{
  refundedJobs: number;
  refundedCredits: number;
  creditsFromGranted: number;
  creditsFromPurchased: number;
}> {
  const prefix = `video:${input.videoJobId}:scene:`;
  const reason = input.reason.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80) || "video_failed";
  return prisma.$transaction(async (tx) => {
    const jobs = await tx.aiGenerationJob.findMany({
      where: {
        userId: input.userId,
        kind: "image",
        status: "completed",
        chargeState: "settled",
        idempotencyKey: { startsWith: prefix },
      },
      orderBy: { createdAt: "asc" },
    });
    let refundedJobs = 0;
    let refundedCredits = 0;
    let creditsFromGranted = 0;
    let creditsFromPurchased = 0;

    for (const job of jobs) {
      const claimed = await tx.aiGenerationJob.updateMany({
        where: { id: job.id, userId: input.userId, chargeState: "settled" },
        data: { chargeState: "refunded" },
      });
      if (claimed.count !== 1) continue;

      const restored = await tx.creditBalance.upsert({
        where: { userId: input.userId },
        create: {
          userId: input.userId,
          granted: job.creditsFromGranted,
          purchased: job.creditsFromPurchased,
        },
        update: {
          granted: { increment: job.creditsFromGranted },
          purchased: { increment: job.creditsFromPurchased },
        },
      });
      await tx.creditLedger.create({
        data: {
          userId: input.userId,
          delta: job.creditCost,
          kind: "refund",
          action: `ai-image-batch-refund:${job.id}:${reason}`,
          balanceAfter: restored.granted + restored.purchased,
        },
      });
      refundedJobs += 1;
      refundedCredits += job.creditCost;
      creditsFromGranted += job.creditsFromGranted;
      creditsFromPurchased += job.creditsFromPurchased;
    }

    return {
      refundedJobs,
      refundedCredits,
      creditsFromGranted,
      creditsFromPurchased,
    };
  });
}

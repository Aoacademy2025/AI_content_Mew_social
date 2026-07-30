import { prisma } from "@/lib/prisma";

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

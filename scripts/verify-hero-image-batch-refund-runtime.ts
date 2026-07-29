import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { refundSettledVideoImageBatch } from "../src/lib/ai-generation-jobs.server";

const userId = "hero-image-refund-user";
const videoJobId = "hero-video-job";

async function main() {
  await prisma.user.create({
    data: {
      id: userId,
      name: "Hero image refund test",
      email: "hero-image-refund@example.com",
    },
  });
  await prisma.creditBalance.create({
    data: {
      userId,
      granted: 8,
      purchased: 38,
    },
  });
  await prisma.aiGenerationJob.createMany({
    data: [
      {
        id: "settled-granted",
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        chargeState: "settled",
        creditCost: 2,
        creditsFromGranted: 2,
        creditsFromPurchased: 0,
        idempotencyKey: `video:${videoJobId}:scene:0`,
      },
      {
        id: "settled-purchased",
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        chargeState: "settled",
        creditCost: 2,
        creditsFromGranted: 0,
        creditsFromPurchased: 2,
        idempotencyKey: `video:${videoJobId}:scene:1`,
      },
      {
        id: "already-refunded",
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "failed",
        chargeState: "refunded",
        creditCost: 2,
        creditsFromGranted: 2,
        creditsFromPurchased: 0,
        idempotencyKey: `video:${videoJobId}:scene:2`,
      },
      {
        id: "other-video-settled",
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        chargeState: "settled",
        creditCost: 2,
        creditsFromGranted: 2,
        creditsFromPurchased: 0,
        idempotencyKey: "video:other-video:scene:0",
      },
    ],
  });

  const first = await refundSettledVideoImageBatch({
    userId,
    videoJobId,
    reason: "provider_batch_failed",
  });
  assert.deepEqual(first, {
    refundedJobs: 2,
    refundedCredits: 4,
    creditsFromGranted: 2,
    creditsFromPurchased: 2,
  });

  const balance = await prisma.creditBalance.findUniqueOrThrow({ where: { userId } });
  assert.deepEqual(
    { granted: balance.granted, purchased: balance.purchased },
    { granted: 10, purchased: 40 },
  );
  const batchJobs = await prisma.aiGenerationJob.findMany({
    where: { userId, idempotencyKey: { startsWith: `video:${videoJobId}:scene:` } },
    orderBy: { id: "asc" },
  });
  assert.equal(batchJobs.filter((job) => job.chargeState === "refunded").length, 3);
  assert.equal(
    await prisma.creditLedger.count({
      where: { userId, action: { startsWith: "ai-image-batch-refund:" } },
    }),
    2,
  );
  assert.equal(
    (await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: "other-video-settled" } })).chargeState,
    "settled",
  );

  const second = await refundSettledVideoImageBatch({
    userId,
    videoJobId,
    reason: "provider_batch_failed",
  });
  assert.deepEqual(second, {
    refundedJobs: 0,
    refundedCredits: 0,
    creditsFromGranted: 0,
    creditsFromPurchased: 0,
  });
  assert.equal(
    await prisma.creditLedger.count({
      where: { userId, action: { startsWith: "ai-image-batch-refund:" } },
    }),
    2,
    "batch compensation must be idempotent",
  );

  console.log("verify-hero-image-batch-refund: ALL PASS");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

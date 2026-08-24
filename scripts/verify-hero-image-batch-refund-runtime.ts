import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  refundSettledVideoImageBatch,
  refundSettledVideoImageJob,
} from "../src/lib/ai-generation-jobs.server";

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
        id: "reserved-purchased",
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "in_progress",
        chargeState: "reserved",
        creditCost: 2,
        creditsFromGranted: 0,
        creditsFromPurchased: 2,
        idempotencyKey: `video:${videoJobId}:scene:reserved`,
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
        id: "window-settled",
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        chargeState: "settled",
        creditCost: 3,
        creditsFromGranted: 0,
        creditsFromPurchased: 3,
        idempotencyKey: `broll-window:${videoJobId}:scene:3:request:fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3`,
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
    refundedJobs: 3,
    refundedCredits: 6,
    creditsFromGranted: 2,
    creditsFromPromotional: 0,
    creditsFromPurchased: 4,
  });

  const balance = await prisma.creditBalance.findUniqueOrThrow({ where: { userId } });
  assert.deepEqual(
    { granted: balance.granted, purchased: balance.purchased },
    { granted: 10, purchased: 42 },
  );
  const batchJobs = await prisma.aiGenerationJob.findMany({
    where: { userId, idempotencyKey: { startsWith: `video:${videoJobId}:scene:` } },
    orderBy: { id: "asc" },
  });
  assert.equal(batchJobs.filter((job) => job.chargeState === "refunded").length, 4);
  assert.equal(
    (await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: "reserved-purchased" } })).errorCode,
    "PARENT_VIDEO_FAILED",
    "a reserved child must be claimed before a late provider completion can settle it",
  );
  assert.equal(
    await prisma.creditLedger.count({
      where: { userId, action: { startsWith: "ai-image-batch-refund:" } },
    }),
    3,
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
    creditsFromPromotional: 0,
    creditsFromPurchased: 0,
  });
  assert.equal(
    await prisma.creditLedger.count({
      where: { userId, action: { startsWith: "ai-image-batch-refund:" } },
    }),
    3,
    "batch compensation must be idempotent",
  );

  const windowRefund = await refundSettledVideoImageJob({
    userId,
    jobId: "window-settled",
    reason: "broll_window_post_processing_failed",
  });
  assert.deepEqual(windowRefund, { refunded: true, refundedCredits: 3 });
  const windowJob = await prisma.aiGenerationJob.findUniqueOrThrow({
    where: { id: "window-settled" },
  });
  assert.equal(windowJob.status, "failed");
  assert.equal(windowJob.chargeState, "refunded");
  assert.equal(windowJob.errorCode, "POST_PROCESSING_FAILED");
  const afterWindowRefund = await prisma.creditBalance.findUniqueOrThrow({ where: { userId } });
  assert.deepEqual(
    { granted: afterWindowRefund.granted, purchased: afterWindowRefund.purchased },
    { granted: 10, purchased: 45 },
  );
  assert.deepEqual(
    await refundSettledVideoImageJob({
      userId,
      jobId: "window-settled",
      reason: "broll_window_post_processing_failed",
    }),
    { refunded: false, refundedCredits: 0 },
    "per-window output compensation must be idempotent",
  );
  assert.equal(
    await prisma.creditLedger.count({
      where: { userId, action: { startsWith: "ai-image-output-refund:window-settled:" } },
    }),
    1,
  );

  console.log("verify-hero-image-batch-refund: ALL PASS");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

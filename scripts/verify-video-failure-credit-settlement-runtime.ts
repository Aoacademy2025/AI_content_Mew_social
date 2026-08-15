import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";
import {
  AVATAR_PROVIDER_CHECKPOINT_VERSION,
  serializeAvatarProviderCheckpoint,
} from "../src/lib/mcp/avatar-provider-checkpoint";

const userId = "video-failure-credit-user";
const videoJobId = "video-failure-credit-job";
const imageJobId = "video-failure-credit-image";
const renderJobId = "video-failure-credit-render";

async function main() {
  await prisma.user.create({
    data: {
      id: userId,
      name: "Video failure credit settlement",
      email: "video-failure-credit@example.com",
      plan: "BUSINESS",
    },
  });
  await prisma.creditBalance.create({
    data: { userId, granted: 0, purchased: 0 },
  });
  await prisma.videoJob.create({
    data: {
      id: videoJobId,
      userId,
      status: "processing",
      currentStep: "composite",
      progress: 86,
      inputJson: JSON.stringify({
        script: "terminal composite failure",
        previewMode: true,
        avatarMode: "full",
        avatarId: "avatar-1",
      }),
      providerCheckpointJson: serializeAvatarProviderCheckpoint({
        version: AVATAR_PROVIDER_CHECKPOINT_VERSION,
        provider: "heygen",
        phase: "composite",
        // Resume the final allowed local-composite attempt. Provider deadlines do
        // not govern this phase; the executor's own retry budget does.
        compositeAttempts: 1,
        providerStartedAt: "2026-07-30T10:00:00.000Z",
        providerDeadlineAt: "2026-07-30T10:30:00.000Z",
        baseUrl: "/api/renders/base.mp4",
        voiceUrl: "/api/renders/voice.mp3",
        audioDurationMs: 60_000,
        captions: [{ text: "terminal composite failure", startMs: 0, endMs: 60_000 }],
        words: [],
        fullText: "terminal composite failure",
        baseConfig: {},
        avatar: {
          mode: "full",
          id: "avatar-1",
          introSecs: 5,
          tailSecs: 5,
          layout: { scale: 1, offsetX: 0, offsetY: 0 },
          introVideoUrl: "https://files2.heygen.ai/avatar.mp4",
        },
      }),
    },
  });
  await prisma.aiGenerationJob.create({
    data: {
      id: imageJobId,
      userId,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      status: "completed",
      chargeState: "settled",
      creditCost: 3,
      creditsFromGranted: 0,
      creditsFromPurchased: 3,
      idempotencyKey: `video:${videoJobId}:scene:0`,
    },
  });
  await prisma.renderJob.create({
    data: {
      id: renderJobId,
      userId,
      parentJobId: videoJobId,
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      videoUrl: "/api/renders/base.mp4",
      reservedQuota: true,
      reservedMinutes: 2,
      creditsSpent: 4,
      creditsFromGranted: 0,
    },
  });
  await prisma.creditLedger.createMany({
    data: [
      {
        id: "video-failure-credit-image-spend",
        userId,
        delta: -3,
        kind: "spend",
        action: `ai-image:${imageJobId}`,
        balanceAfter: 4,
      },
      {
        id: "video-failure-credit-render-spend",
        userId,
        delta: -4,
        kind: "spend",
        action: "render-overflow:test",
        balanceAfter: 0,
      },
    ],
  });

  await runOrchestrator(videoJobId, userId, {
    caller: {
      async post<T>(path: string): Promise<T> {
        assert.equal(path, "/api/heygen/composite");
        throw new Error("composite executor deadline exceeded");
      },
      async patch<T>(path: string): Promise<T> {
        throw new Error(`unexpected PATCH ${path}`);
      },
      async get<T>(path: string): Promise<T> {
        throw new Error(`unexpected GET ${path}`);
      },
    },
    recordTelemetryEvent: async () => {},
  });

  const videoJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: videoJobId } });
  const imageJob = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: imageJobId } });
  const renderJob = await prisma.renderJob.findUniqueOrThrow({ where: { id: renderJobId } });
  const balance = await prisma.creditBalance.findUniqueOrThrow({ where: { userId } });
  const refunds = await prisma.creditLedger.findMany({
    where: { userId, kind: "refund" },
    orderBy: { createdAt: "asc" },
  });

  assert.equal(videoJob.status, "failed");
  assert.match(videoJob.errorMessage ?? "", /deadline/);
  assert.equal(imageJob.chargeState, "refunded", "terminal VideoJob failure must refund settled images");
  assert.equal(renderJob.reservedQuota, false, "terminal VideoJob failure must release the base render reservation");
  assert.deepEqual(
    { granted: balance.granted, purchased: balance.purchased },
    { granted: 0, purchased: 7 },
  );
  assert.deepEqual(refunds.map((row) => row.delta).sort((a, b) => a - b), [3, 4]);
  assert.equal(
    refunds.filter((row) => row.action.startsWith(`ai-image-batch-refund:${imageJobId}:`)).length,
    1,
  );
  assert.equal(
    refunds.filter((row) => row.action.startsWith(`render-refund:${renderJobId}:`)).length,
    1,
  );

  await runOrchestrator(videoJobId, userId, {
    recordTelemetryEvent: async () => {},
  });
  assert.equal(
    await prisma.creditLedger.count({ where: { userId, kind: "refund" } }),
    2,
    "terminal settlement must be idempotent",
  );

  console.log("verify-video-failure-credit-settlement: ALL PASS");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

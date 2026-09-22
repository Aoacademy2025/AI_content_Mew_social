import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  getActiveRunpodImageCostSnapshot,
  getRunpodImageCostSnapshot,
  syncRunpodImageBilling,
} from "../src/lib/runpod-image-cost.server";
import { resolveAiImageCost } from "../src/lib/ai-image-ledger-report";

const endpointId = "runpod-cost-test-endpoint";
const now = new Date();
const bucketStart = new Date(Math.floor((now.getTime() - 60_000) / 3_600_000) * 3_600_000);

async function main() {
  process.env.RUNPOD_API_KEY = "test-only-key";
  process.env.HERO_RUNPOD_COST_MIN_SAMPLE = "20";
  process.env.HERO_RUNPOD_COST_TARGET_BAHT = "0.90";
  process.env.HERO_RUNPOD_COST_HARD_LIMIT_BAHT = "1.08";
  process.env.AI_STUDIO_IMAGE_ENABLED = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED = "1";
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "public";

  const user = await prisma.user.create({
    data: {
      name: "RunPod Cost Test",
      email: "runpod-cost-test@example.invalid",
    },
  });
  await prisma.aiGenerationJob.createMany({
    data: Array.from({ length: 20 }, (_, index) => ({
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      providerEndpoint: endpointId,
      status: "completed",
      chargeState: "settled",
      outputUrl: `/test/runpod-cost-${index}.png`,
      idempotencyKey: `runpod-cost-${index}`,
      finishedAt: new Date(now.getTime() - 30_000),
    })),
  });

  let amount = 0.1;
  const fetchImpl: typeof fetch = async (request) => {
    const url = new URL(String(request));
    assert.equal(url.searchParams.get("endpointId"), endpointId);
    assert.equal(url.searchParams.get("bucketSize"), "hour");
    assert.equal(url.searchParams.get("grouping"), "gpuTypeId");
    return new Response(JSON.stringify([{
      amount,
      gpuTypeId: "NVIDIA A40",
      time: bucketStart.toISOString(),
      timeBilledMs: 294_118,
    }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const start = new Date(bucketStart.getTime() - 60_000);
  await syncRunpodImageBilling({ endpointId, start, end: now, fetchImpl });
  amount = 0.2;
  await syncRunpodImageBilling({ endpointId, start, end: now, fetchImpl });

  assert.equal(
    await prisma.runpodBillingBucket.count({ where: { endpointId } }),
    1,
    "the current hour must be updated instead of double-counted",
  );
  const bucket = await prisma.runpodBillingBucket.findFirstOrThrow({ where: { endpointId } });
  assert.equal(bucket.amountUsdMicros, 200_000);

  const healthy = await getRunpodImageCostSnapshot({ endpointId, now, windowDays: 7 });
  assert.equal(healthy.deliveredImages, 20);
  assert.equal(healthy.billedUsd, 0.2);
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.admitted, true);

  await prisma.runpodBillingSync.update({
    where: { endpointId },
    data: { lastSuccessAt: new Date(now.getTime() - 4 * 60 * 60_000) },
  });
  const stale = await getRunpodImageCostSnapshot({ endpointId, now, windowDays: 7 });
  assert.equal(stale.status, "stale");
  assert.equal(stale.admitted, false);

  // A successful empty billing sync does not prove that a delivered image cost
  // zero. Keep monthly COGS unavailable until an invoice bucket exists.
  await prisma.aiGenerationJob.deleteMany({ where: { providerEndpoint: endpointId } });
  const freshZeroEndpointId = "runpod-cost-fresh-zero-endpoint";
  await prisma.aiGenerationJob.create({
    data: {
      id: "runpod-cost-fresh-zero-job",
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      providerRoute: "runpod-custom",
      providerEndpoint: freshZeroEndpointId,
      status: "completed",
      chargeState: "settled",
      outputUrl: "/test/runpod-cost-fresh-zero.png",
      idempotencyKey: "runpod-cost-fresh-zero",
      finishedAt: new Date(now.getTime() - 30_000),
    },
  });
  await prisma.runpodBillingSync.create({
    data: {
      endpointId: freshZeroEndpointId,
      lastWindowStart: new Date(now.getTime() - 24 * 60 * 60_000),
      lastWindowEnd: now,
      lastSuccessAt: now,
      rowsSeen: 0,
    },
  });
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "custom";
  process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = freshZeroEndpointId;
  process.env.RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH = "config/ai-workflows/z-image-turbo.json";
  const freshZero = await getActiveRunpodImageCostSnapshot({ now, windowDays: 1 });
  assert.equal(freshZero.status, "insufficient_data");
  assert.equal(freshZero.deliveredImages, 1);
  assert.equal(freshZero.billedUsdMicros, 0);
  assert.equal(freshZero.costCoverage, "unavailable");
  assert.equal(resolveAiImageCost({
    providerSnapshot: freshZero,
    estimatedOtherBaht: 0,
    unattributedImages: 0,
  }).totalBaht, null);
  await prisma.aiGenerationJob.delete({ where: { id: "runpod-cost-fresh-zero-job" } });
  await prisma.runpodBillingBucket.deleteMany({
    where: { endpointId: { in: [endpointId, freshZeroEndpointId] } },
  });
  await prisma.runpodBillingSync.deleteMany({
    where: { endpointId: { in: [endpointId, freshZeroEndpointId] } },
  });
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "public";

  const publicEndpointId = "z-image-turbo";
  const publicJobIds = Array.from({ length: 20 }, (_, index) => `runpod-public-cost-${index}`);
  const refundedPublicJobId = "runpod-public-cost-refunded";
  await prisma.aiGenerationJob.createMany({
    data: publicJobIds.map((id, index) => ({
      id,
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      providerRoute: "runpod-public",
      providerEndpoint: publicEndpointId,
      status: "completed",
      chargeState: "settled",
      outputUrl: `/test/runpod-public-cost-${index}.png`,
      idempotencyKey: `runpod-public-cost-${index}`,
      finishedAt: new Date(now.getTime() - 30_000),
    })),
  });
  await prisma.aiGenerationAttempt.createMany({
    data: [
      ...publicJobIds.map((jobId) => ({
        jobId,
        sequence: 1,
        provider: "runpod",
        providerModel: "z-image-turbo",
        providerRoute: "runpod-public",
        providerEndpoint: publicEndpointId,
        status: "completed",
        estimatedCostUsdMicros: 5_000,
        providerReportedCostUsdMicros: 5_000,
        finishedAt: new Date(now.getTime() - 30_000),
      })),
      ...publicJobIds.slice(0, 2).map((jobId) => ({
        jobId,
        sequence: 2,
        provider: "runpod",
        providerModel: "z-image-turbo",
        providerRoute: "runpod-public",
        providerEndpoint: publicEndpointId,
        status: "completed",
        estimatedCostUsdMicros: 5_000,
        providerReportedCostUsdMicros: 5_000,
        finishedAt: new Date(now.getTime() - 20_000),
      })),
    ],
  });
  await prisma.aiGenerationJob.create({
    data: {
      id: refundedPublicJobId,
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      providerRoute: "runpod-public",
      providerEndpoint: publicEndpointId,
      status: "failed",
      chargeState: "refunded",
      idempotencyKey: refundedPublicJobId,
      finishedAt: new Date(now.getTime() - 10_000),
      attempts: {
        create: {
          sequence: 1,
          provider: "runpod",
          providerModel: "z-image-turbo",
          providerRoute: "runpod-public",
          providerEndpoint: publicEndpointId,
          status: "failed",
          estimatedCostUsdMicros: 5_000,
          providerReportedCostUsdMicros: 5_000,
          finishedAt: new Date(now.getTime() - 10_000),
        },
      },
    },
  });

  const active = await getActiveRunpodImageCostSnapshot({ now, windowDays: 1 });
  assert.equal(active.endpointId, publicEndpointId);
  assert.equal(active.providerRoute, "runpod-public");
  assert.equal(active.costSource, "provider_reported_attempts");
  assert.equal(active.totalAttempts, 23);
  assert.equal(active.pricedAttempts, 23);
  assert.equal(active.costCoverage, "complete");
  assert.equal(active.deliveredImages, 20);
  assert.equal(active.billedUsdMicros, 115_000);
  assert.equal(active.costBahtPerImage, 0.20125);
  assert.equal(active.status, "healthy");
  assert.equal(active.admitted, true);

  const priorCustomEndpointId = "runpod-cost-prior-custom-endpoint";
  await prisma.aiGenerationJob.create({
    data: {
      id: "runpod-cost-prior-custom-job",
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      providerRoute: "runpod-custom",
      providerEndpoint: priorCustomEndpointId,
      status: "failed",
      chargeState: "refunded",
      idempotencyKey: "runpod-cost-prior-custom",
      finishedAt: new Date(now.getTime() - 30_000),
      attempts: {
        create: {
          sequence: 1,
          provider: "runpod",
          providerModel: "z-image-turbo",
          providerRoute: "runpod-custom",
          providerEndpoint: priorCustomEndpointId,
          status: "failed",
          estimatedCostUsdMicros: 10_000,
          finishedAt: new Date(now.getTime() - 30_000),
        },
      },
    },
  });
  await prisma.runpodBillingBucket.create({
    data: {
      endpointId: priorCustomEndpointId,
      bucketStart,
      gpuTypeId: "NVIDIA A40",
      amountUsdMicros: 10_000,
      timeBilledMs: 10_000,
    },
  });
  const switchedRoute = await getActiveRunpodImageCostSnapshot({ now, windowDays: 1 });
  assert.equal(
    switchedRoute.costCoverage,
    "partial",
    "an inactive route inside the P&L window makes active-route-only COGS partial",
  );
  await prisma.aiGenerationJob.delete({ where: { id: "runpod-cost-prior-custom-job" } });
  assert.equal(
    (await getActiveRunpodImageCostSnapshot({ now, windowDays: 1 })).costCoverage,
    "partial",
    "an inactive invoice bucket remains partial after its refunded job is removed",
  );
  await prisma.runpodBillingBucket.deleteMany({ where: { endpointId: priorCustomEndpointId } });

  await prisma.aiGenerationJob.create({
    data: {
      id: "runpod-public-cost-unpriced",
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      providerRoute: "runpod-public",
      providerEndpoint: publicEndpointId,
      status: "failed",
      chargeState: "refunded",
      finishedAt: new Date(now.getTime() - 5_000),
      attempts: {
        create: {
          sequence: 1,
          provider: "runpod",
          providerModel: "z-image-turbo",
          providerRoute: "runpod-public",
          providerEndpoint: publicEndpointId,
          status: "failed",
          estimatedCostUsdMicros: 5_000,
          finishedAt: new Date(now.getTime() - 5_000),
        },
      },
    },
  });
  const incomplete = await getActiveRunpodImageCostSnapshot({ now, windowDays: 1 });
  assert.equal(incomplete.totalAttempts, 24);
  assert.equal(incomplete.pricedAttempts, 23);
  assert.equal(incomplete.costCoverage, "partial");

  console.log("verify-runpod-image-cost-runtime: ALL PASS");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

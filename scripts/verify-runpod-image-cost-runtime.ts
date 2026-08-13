import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  getActiveRunpodImageCostSnapshot,
  getRunpodImageCostSnapshot,
  syncRunpodImageBilling,
} from "../src/lib/runpod-image-cost.server";

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

  const publicEndpointId = "z-image-turbo";
  const publicJobIds = Array.from({ length: 20 }, (_, index) => `runpod-public-cost-${index}`);
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

  const active = await getActiveRunpodImageCostSnapshot({ now, windowDays: 1 });
  assert.equal(active.endpointId, publicEndpointId);
  assert.equal(active.providerRoute, "runpod-public");
  assert.equal(active.costSource, "provider_reported_attempts");
  assert.equal(active.pricedAttempts, 22);
  assert.equal(active.deliveredImages, 20);
  assert.equal(active.billedUsdMicros, 110_000);
  assert.equal(active.costBahtPerImage, 0.1925);
  assert.equal(active.status, "healthy");
  assert.equal(active.admitted, true);

  console.log("verify-runpod-image-cost-runtime: ALL PASS");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

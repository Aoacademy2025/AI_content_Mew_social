import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-visual-funnel-health-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
const stageStart = new Date("2026-08-01T00:00:00.000Z");
const now = new Date("2026-08-11T00:00:00.000Z");
process.env.BRAND_VISUAL_50_PERCENT_STARTED_AT = stageStart.toISOString();
process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
process.env.BRAND_VISUAL_ROLLOUT_PERCENT = "50";
process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT = stageStart.toISOString();
process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = "verified-brand-endpoint";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getBrandVisualFunnelHealth } = await import("../src/lib/brand-visual-rollout-health.server");
  const controlIds = Array.from({ length: 100 }, (_, index) => `control-${index}`);
  const treatmentIds = Array.from({ length: 100 }, (_, index) => `treatment-${index}`);
  await prisma.user.createMany({
    data: [...controlIds, ...treatmentIds].map((id) => ({
      id,
      email: `${id}@example.test`,
      name: id,
      createdAt: stageStart,
    })),
  });
  await prisma.telemetryEvent.createMany({
    data: [
      ...controlIds.map((userId) => ({
        userId,
        name: "editor_step2_reached",
        properties: JSON.stringify({ cohort: "control", bucket: 75, projectId: `project-${userId}` }),
        createdAt: new Date(stageStart.getTime() + 60 * 60_000),
      })),
      ...treatmentIds.map((userId) => ({
        userId,
        name: "editor_step2_reached",
        properties: JSON.stringify({ cohort: "treatment-50", bucket: 25, projectId: `project-${userId}` }),
        createdAt: new Date(stageStart.getTime() + 60 * 60_000),
      })),
    ],
  });
  const successfulControl = controlIds.slice(0, 80);
  const successfulTreatment = treatmentIds.slice(0, 76);
  const renderedIds = [...successfulControl, ...successfulTreatment];
  await prisma.videoJob.createMany({
    data: renderedIds.map((userId) => ({
      id: `video-${userId}`,
      userId,
      type: "create",
      status: "done",
      inputJson: "{}",
      createdAt: new Date(stageStart.getTime() + 2 * 60 * 60_000),
      finishedAt: new Date(stageStart.getTime() + 12 * 60 * 60_000),
    })),
  });
  const brandedUsers = successfulTreatment.slice(0, 20);
  await prisma.aiGenerationJob.createMany({
    data: brandedUsers.map((userId) => ({
      userId,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      status: "completed",
      chargeState: "settled",
      fundingSource: "credits",
      creditCost: 2,
      outputUrl: `/generated/${userId}.webp`,
      providerEndpoint: "verified-brand-endpoint",
      inputJson: JSON.stringify({
        videoJobId: `video-${userId}`,
        brandVisualSource: "project-look",
        visualFormatId: "stick-figure-story",
        brandVisualIdentityKey: "bv1-look-a",
        brandVisualCohort: "treatment-50",
      }),
      createdAt: new Date(stageStart.getTime() + 4 * 60 * 60_000),
      finishedAt: new Date(stageStart.getTime() + 6 * 60 * 60_000),
    })),
  });
  await prisma.aiGenerationJob.createMany({
    data: Array.from({ length: 100 }, (_, index) => ({
      userId: brandedUsers[0],
      kind: "image",
      provider: "runpod",
      providerEndpoint: "internal-only-endpoint",
      model: "z-image-turbo",
      status: "completed",
      chargeState: "settled",
      outputUrl: `/generated/internal-${index}.webp`,
      inputJson: JSON.stringify({
        videoJobId: `internal-video-${index}`,
        brandVisualSource: "project-look",
        brandVisualCohort: "internal",
      }),
      createdAt: new Date(stageStart.getTime() + 4 * 60 * 60_000),
      finishedAt: new Date(stageStart.getTime() + 6 * 60 * 60_000),
    })),
  });
  await prisma.telemetryEvent.createMany({
    data: brandedUsers.slice(0, 4).map((userId) => ({
      userId,
      name: "brand_profile_saved",
      properties: JSON.stringify({
        visualFormatId: "stick-figure-story",
        brandVisualIdentityKey: "bv1-look-a",
      }),
      createdAt: new Date(stageStart.getTime() + 36 * 60 * 60_000),
    })),
  });
  await prisma.telemetryEvent.createMany({
    data: [
      ...Array.from({ length: 4 }, (_, index) => ({
        userId: brandedUsers[index],
        name: "brand_look_scene_rerolled",
        properties: JSON.stringify({ cohort: "treatment-50" }),
        createdAt: new Date(stageStart.getTime() + 40 * 60 * 60_000),
      })),
      ...Array.from({ length: 5 }, () => ({
        userId: brandedUsers[0],
        name: "brand_look_scene_rerolled",
        properties: JSON.stringify({ cohort: "internal" }),
        createdAt: new Date(stageStart.getTime() + 40 * 60 * 60_000),
      })),
    ],
  });
  await prisma.runpodBillingBucket.create({
    data: {
      endpointId: "verified-brand-endpoint",
      bucketStart: new Date(stageStart.getTime() + 5 * 60 * 60_000),
      gpuTypeId: "verify-gpu",
      amountUsdMicros: 100_000,
      timeBilledMs: 60_000,
    },
  });
  await prisma.runpodBillingSync.create({
    data: {
      endpointId: "verified-brand-endpoint",
      lastWindowStart: stageStart,
      lastWindowEnd: now,
      lastSuccessAt: new Date(now.getTime() - 60 * 60_000),
      rowsSeen: 1,
    },
  });
  const firstCanaryJob = await prisma.aiGenerationJob.findFirstOrThrow({
    where: { userId: brandedUsers[0], providerEndpoint: "verified-brand-endpoint" },
    select: { id: true },
  });
  await prisma.creditLedger.createMany({
    data: [1, 2].map((sequence) => ({
      userId: brandedUsers[0],
      delta: -2,
      kind: "spend",
      action: `ai-image:${firstCanaryJob.id}`,
      balanceAfter: 100 - sequence * 2,
      createdAt: new Date(stageStart.getTime() + 4 * 60 * 60_000),
    })),
  });

  // Paid conversion is observational only, but it must use the cash-backed
  // Payment ledger and a complete seven-day window anchored to each cohort's
  // first successful clip (brand-visual clip for treatment, first clip for
  // control). Credit-pack purchases are deliberately excluded via periodDays.
  await prisma.payment.createMany({
    data: [
      ...successfulControl.slice(0, 8).map((userId, index) => ({
        userId,
        stripeSessionId: `paid-control-${index}`,
        plan: "PRO" as const,
        amount: 49900,
        status: "PAID" as const,
        periodDays: 30,
        paidAt: new Date(stageStart.getTime() + 48 * 60 * 60_000),
      })),
      ...brandedUsers.slice(0, 2).map((userId, index) => ({
        userId,
        stripeSessionId: `paid-treatment-${index}`,
        plan: "PRO" as const,
        amount: 49900,
        status: "PAID" as const,
        periodDays: 30,
        paidAt: new Date(stageStart.getTime() + 48 * 60 * 60_000),
      })),
      {
        userId: brandedUsers[2],
        stripeSessionId: "credit-pack-is-not-paid-conversion",
        plan: "PRO" as const,
        amount: 9900,
        status: "PAID" as const,
        periodDays: 0,
        paidAt: new Date(stageStart.getTime() + 48 * 60 * 60_000),
      },
      {
        userId: brandedUsers[3],
        stripeSessionId: "late-payment-is-outside-window",
        plan: "PRO" as const,
        amount: 49900,
        status: "PAID" as const,
        periodDays: 30,
        paidAt: new Date(stageStart.getTime() + 9 * 24 * 60 * 60_000),
      },
    ],
  });

  const funnel = await getBrandVisualFunnelHealth({ from: stageStart, now });
  assert.equal(funnel.measurementWindow.configured, true);
  assert.equal(funnel.controlStep2Users, 100);
  assert.equal(funnel.treatmentStep2Users, 100);
  assert.equal(funnel.controlFirstRenderRate, 0.8);
  assert.equal(funnel.treatmentFirstRenderRate, 0.76);
  assert.equal(funnel.treatmentBrandVisualSuccessUsersObserved7d, 20);
  assert.equal(funnel.treatmentQualifiedWithin7dUsers, 4);
  assert.deepEqual(funnel.paidConversion7d, {
    observationalOnly: true,
    control: { observedUsers: 80, convertedUsers: 8, rate: 0.1 },
    treatment: { observedUsers: 20, convertedUsers: 2, rate: 0.1 },
    treatmentVsControlPercentagePointDelta: 0,
  });
  assert.equal(funnel.canExpandTo100, true);

  const { getBrandVisualRolloutHealth } = await import("../src/lib/brand-visual-rollout-health.server");
  const rollout = await getBrandVisualRolloutHealth({ now, days: 30 });
  assert.deepEqual(rollout.canary, {
    cohort: "treatment-50",
    candidateBrandedJobs: 120,
    excludedInternalJobs: 100,
    excludedOtherCohortJobs: 0,
  });
  assert.equal(rollout.jobs.accepted, 20, "internal jobs cannot satisfy the public safety sample");
  assert.deepEqual(rollout.latency, {
    sampleJobs: 20,
    p50Ms: 2 * 60 * 60_000,
    p95Ms: 2 * 60 * 60_000,
    blocksCanary: false,
  });
  assert.equal(rollout.settlement.duplicateDeductions, 1);
  assert.equal(rollout.safety.checks.noDuplicateDeductions, false);
  assert.deepEqual(rollout.leadingMetrics, {
    rerolls: 4,
    rerollsPerUsableImage: 0.2,
    activatedUsers: 20,
    estimatedRunpodCogsBahtPerActivatedUser: 0.175,
  });
  assert.equal(rollout.rollout.canExpandFrom10To50, false, "latency remains observational in the first canary");

  await prisma.runpodBillingSync.update({
    where: { endpointId: "verified-brand-endpoint" },
    data: { lastSuccessAt: new Date(now.getTime() - 4 * 60 * 60_000) },
  });
  const staleRollout = await getBrandVisualRolloutHealth({ now, days: 30 });
  assert.equal(staleRollout.cogs?.status, "stale");
  assert.equal(staleRollout.safety.checks.cogsDataAdmitted, false);
  assert.equal(staleRollout.safety.canExpand, false, "numeric but stale COGS must fail closed");

  await prisma.$disconnect();
  console.log("brand visual funnel health verification: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

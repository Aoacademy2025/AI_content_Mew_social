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
      outputUrl: `/generated/${userId}.webp`,
      inputJson: JSON.stringify({
        videoJobId: `video-${userId}`,
        brandVisualSource: "project-look",
        visualFormatId: "stick-figure-story",
        brandVisualIdentityKey: "bv1-look-a",
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

  const funnel = await getBrandVisualFunnelHealth({ from: stageStart, now });
  assert.equal(funnel.measurementWindow.configured, true);
  assert.equal(funnel.controlStep2Users, 100);
  assert.equal(funnel.treatmentStep2Users, 100);
  assert.equal(funnel.controlFirstRenderRate, 0.8);
  assert.equal(funnel.treatmentFirstRenderRate, 0.76);
  assert.equal(funnel.treatmentBrandVisualSuccessUsersObserved7d, 20);
  assert.equal(funnel.treatmentQualifiedWithin7dUsers, 4);
  assert.equal(funnel.canExpandTo100, true);

  await prisma.$disconnect();
  console.log("brand visual funnel health verification: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

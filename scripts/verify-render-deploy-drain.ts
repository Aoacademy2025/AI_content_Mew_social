import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { prisma } from "../src/lib/prisma";
import { createVideoJob } from "../src/lib/mcp/video-job";
import { enqueueRenderJob } from "../src/lib/render/job-store";
import {
  RENDER_DEPLOY_DRAIN_KEY,
  RenderDeployDrainError,
  assertRenderEnqueueOpen,
  readRenderQueueCounts,
} from "../src/lib/render-deploy-drain";

const USER_ID = "render-drain-user";

async function clean() {
  await prisma.renderJob.deleteMany({ where: { userId: USER_ID } });
  await prisma.videoJob.deleteMany({ where: { userId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  await prisma.siteConfig.deleteMany({ where: { key: RENDER_DEPLOY_DRAIN_KEY } });
}

function queueCheckExitCode(): number | null {
  const result = spawnSync(
    join(process.cwd(), "node_modules", ".bin", "tsx"),
    ["scripts/check-empty-render-queues.ts"],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  return result.status;
}

async function main() {
  await clean();
  try {
    await prisma.user.create({
      data: {
        id: USER_ID,
        name: "Render Drain",
        email: "render-drain@example.test",
        plan: "PRO",
        usageCount: 0,
        usageLimit: 100,
        usagePeriodStartedAt: new Date(),
      },
    });
    await prisma.siteConfig.upsert({
      where: { key: RENDER_DEPLOY_DRAIN_KEY },
      update: { value: "1" },
      create: { key: RENDER_DEPLOY_DRAIN_KEY, value: "1" },
    });

    await assert.rejects(() => assertRenderEnqueueOpen(), (error: unknown) => error instanceof RenderDeployDrainError);
    await assert.rejects(
      () => createVideoJob(USER_ID, { script: "blocked" }),
      (error: unknown) => error instanceof RenderDeployDrainError,
    );
    await assert.rejects(
      () => enqueueRenderJob({ userId: USER_ID, type: "RENDER", payload: { shortVideoConfig: {} } }),
      (error: unknown) => error instanceof RenderDeployDrainError,
    );
    assert.equal(await prisma.videoJob.count({ where: { userId: USER_ID } }), 0);
    assert.equal(await prisma.renderJob.count({ where: { userId: USER_ID } }), 0);

    let refunds = 0;
    const raceError = new RenderDeployDrainError();
    await Promise.all([
      raceError.refundOnce(async () => { refunds++; await new Promise<void>((resolve) => setImmediate(resolve)); }),
      raceError.refundOnce(async () => { refunds++; }),
    ]);
    await raceError.refundOnce(async () => { refunds++; });
    assert.equal(refunds, 1, "a post-reservation drain race refunds exactly once");
    assert.equal(raceError.reservationRefunded, true);

    await prisma.siteConfig.update({ where: { key: RENDER_DEPLOY_DRAIN_KEY }, data: { value: "0" } });
    await assertRenderEnqueueOpen();
    const videoJob = await createVideoJob(USER_ID, { script: "allowed" });
    const renderJob = await enqueueRenderJob({ userId: USER_ID, type: "RENDER", payload: { shortVideoConfig: {} } });
    const active = await readRenderQueueCounts();
    assert.deepEqual(active, { videoJobs: 1, renderJobs: 1, empty: false });

    await prisma.$disconnect();
    assert.equal(queueCheckExitCode(), 2, "queue checker exits 2 while either queue is active");

    await prisma.videoJob.update({ where: { id: videoJob.id }, data: { status: "done" } });
    await prisma.renderJob.update({ where: { id: renderJob.id }, data: { status: "DONE" } });
    const empty = await readRenderQueueCounts();
    assert.deepEqual(empty, { videoJobs: 0, renderJobs: 0, empty: true });
    await prisma.$disconnect();
    assert.equal(queueCheckExitCode(), 0, "queue checker exits 0 only when both queues are empty");

    console.log("ALL PASS");
  } finally {
    await clean();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

import assert from "node:assert/strict";
import { updateEditorProject } from "../src/lib/editor-projects";
import { finishJob } from "../src/lib/mcp/video-job";
import { prisma } from "../src/lib/prisma";

const FINISHED_AT = new Date("2026-07-01T12:00:00.000Z");
const FIXTURE_USER_IDS = [
  "video-job-expiry-free",
  "video-job-expiry-pro",
  "video-job-expiry-business",
];

async function cleanFixtures() {
  await prisma.user.deleteMany({
    where: { id: { in: FIXTURE_USER_IDS } },
  });
}

async function main() {
  await cleanFixtures();

  try {
    const freeUser = await prisma.user.create({
      data: {
        id: FIXTURE_USER_IDS[0],
        name: "Expiry Free",
        email: "video-job-expiry-free@example.test",
        plan: "FREE",
      },
    });
    const proUser = await prisma.user.create({
      data: {
        id: FIXTURE_USER_IDS[1],
        name: "Expiry Pro",
        email: "video-job-expiry-pro@example.test",
        plan: "PRO",
      },
    });
    const businessUser = await prisma.user.create({
      data: {
        id: FIXTURE_USER_IDS[2],
        name: "Expiry Business",
        email: "video-job-expiry-business@example.test",
        plan: "BUSINESS",
      },
    });

    const freeProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-free-project",
        userId: freeUser.id,
        title: "Free preview",
        status: "rendering",
      },
    });
    const businessProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-business-project",
        userId: businessUser.id,
        title: "Business export",
        status: "exporting",
        activeJobId: "existing-preview-job",
      },
    });

    const freeJob = await prisma.videoJob.create({
      data: {
        userId: freeUser.id,
        projectId: freeProject.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    const proJob = await prisma.videoJob.create({
      data: {
        userId: proUser.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    const businessJob = await prisma.videoJob.create({
      data: {
        userId: businessUser.id,
        projectId: businessProject.id,
        type: "export",
        status: "processing",
        inputJson: "{}",
      },
    });

    await prisma.editorProject.update({
      where: { id: freeProject.id },
      data: { activeJobId: freeJob.id },
    });
    await prisma.editorProject.update({
      where: { id: businessProject.id },
      data: { activeExportJobId: businessJob.id },
    });

    await finishJob(freeJob.id, { videoUrl: "/api/renders/free-preview.mp4" }, { now: FINISHED_AT });
    await finishJob(proJob.id, { videoUrl: "/api/renders/pro-preview.mp4" }, { now: FINISHED_AT });
    await finishJob(
      businessJob.id,
      { videoUrl: "/api/renders/business-export.mp4", videoId: "business-export-video" },
      { now: FINISHED_AT },
    );

    const [finishedFreeJob, finishedProJob, finishedBusinessJob] = await Promise.all([
      prisma.videoJob.findUnique({ where: { id: freeJob.id } }),
      prisma.videoJob.findUnique({ where: { id: proJob.id } }),
      prisma.videoJob.findUnique({ where: { id: businessJob.id } }),
    ]);

    assert.ok(finishedFreeJob);
    assert.ok(finishedProJob);
    assert.ok(finishedBusinessJob);
    assert.equal(finishedFreeJob.mediaExpiresAt?.toISOString() ?? null, "2026-07-04T12:00:00.000Z");
    assert.equal(finishedProJob.mediaExpiresAt?.toISOString() ?? null, "2026-07-08T12:00:00.000Z");
    assert.equal(finishedBusinessJob.mediaExpiresAt?.toISOString() ?? null, "2026-07-15T12:00:00.000Z");
    assert.equal(finishedFreeJob.finishedAt?.toISOString(), FINISHED_AT.toISOString());
    assert.equal(finishedBusinessJob.finishedAt?.toISOString(), FINISHED_AT.toISOString());

    const [finishedFreeProject, finishedBusinessProject] = await Promise.all([
      prisma.editorProject.findUnique({ where: { id: freeProject.id } }),
      prisma.editorProject.findUnique({ where: { id: businessProject.id } }),
    ]);
    assert.equal(finishedFreeProject?.activeJobId, freeJob.id);
    assert.equal(finishedFreeProject?.status, "post");
    assert.equal(finishedBusinessProject?.activeJobId, "existing-preview-job");
    assert.equal(finishedBusinessProject?.activeExportJobId, businessJob.id);
    assert.equal(finishedBusinessProject?.latestVideoId, "business-export-video");
    assert.equal(finishedBusinessProject?.status, "exported");

    const stampedFreeExpiry = finishedFreeJob.mediaExpiresAt?.toISOString();
    const stampedFreeFinishedAt = finishedFreeJob.finishedAt?.toISOString();
    const stampedFreeOutput = finishedFreeJob.outputJson;
    const stampedFreeVideoId = finishedFreeJob.videoId;
    await prisma.user.update({
      where: { id: freeUser.id },
      data: { plan: "BUSINESS" },
    });
    await updateEditorProject(freeUser.id, freeProject.id, {
      title: "Saved after upgrade",
      draft: { videoUrl: "/api/renders/free-preview.mp4" },
      touchLastOpened: true,
    });

    const freeJobAfterPlanAndProjectChanges = await prisma.videoJob.findUnique({
      where: { id: freeJob.id },
    });
    assert.equal(freeJobAfterPlanAndProjectChanges?.mediaExpiresAt?.toISOString(), stampedFreeExpiry);

    const replayedFreeJob = await finishJob(
      freeJob.id,
      { videoUrl: "/api/renders/replay-must-not-win.mp4", videoId: "replay-must-not-win" },
      { now: new Date("2026-07-20T12:00:00.000Z") },
    );
    const freeJobAfterReplay = await prisma.videoJob.findUnique({ where: { id: freeJob.id } });
    assert.equal(replayedFreeJob.id, freeJob.id);
    assert.equal(freeJobAfterReplay?.mediaExpiresAt?.toISOString(), stampedFreeExpiry);
    assert.equal(freeJobAfterReplay?.finishedAt?.toISOString(), stampedFreeFinishedAt);
    assert.equal(freeJobAfterReplay?.outputJson, stampedFreeOutput);
    assert.equal(freeJobAfterReplay?.videoId, stampedFreeVideoId);
    const freeProjectAfterReplay = await prisma.editorProject.findUnique({ where: { id: freeProject.id } });
    assert.equal(freeProjectAfterReplay?.latestVideoId, null);
    assert.equal(freeProjectAfterReplay?.status, "post");

    const concurrentJob = await prisma.videoJob.create({
      data: {
        userId: proUser.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    const concurrentOutputs = [
      { videoUrl: "/api/renders/concurrent-a.mp4", videoId: "concurrent-a" },
      { videoUrl: "/api/renders/concurrent-b.mp4", videoId: "concurrent-b" },
    ] as const;
    const concurrentTimes = [
      new Date("2026-07-02T12:00:00.000Z"),
      new Date("2026-07-03T12:00:00.000Z"),
    ] as const;
    const concurrentResults = await Promise.all([
      finishJob(concurrentJob.id, concurrentOutputs[0], { now: concurrentTimes[0] }),
      finishJob(concurrentJob.id, concurrentOutputs[1], { now: concurrentTimes[1] }),
    ]);
    const storedConcurrent = await prisma.videoJob.findUnique({ where: { id: concurrentJob.id } });
    assert.ok(storedConcurrent);
    assert.ok(
      concurrentOutputs.some((candidate, index) =>
        storedConcurrent.outputJson === JSON.stringify(candidate)
        && storedConcurrent.videoId === candidate.videoId
        && storedConcurrent.finishedAt?.toISOString() === concurrentTimes[index].toISOString()
        && storedConcurrent.mediaExpiresAt?.toISOString()
          === new Date(concurrentTimes[index].getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()),
      "all completion fields must come from exactly one concurrent finisher",
    );
    assert.deepEqual(
      concurrentResults.map((result) => ({
        id: result.id,
        outputJson: result.outputJson,
        videoId: result.videoId,
        finishedAt: result.finishedAt?.toISOString(),
        mediaExpiresAt: result.mediaExpiresAt?.toISOString(),
      })),
      concurrentResults.map(() => ({
        id: storedConcurrent.id,
        outputJson: storedConcurrent.outputJson,
        videoId: storedConcurrent.videoId,
        finishedAt: storedConcurrent.finishedAt?.toISOString(),
        mediaExpiresAt: storedConcurrent.mediaExpiresAt?.toISOString(),
      })),
      "both concurrent callers must observe the immutable winning completion",
    );

    const rollbackProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-rollback-project",
        userId: proUser.id,
        title: "Atomic rollback",
        status: "rendering",
      },
    });
    const rollbackJob = await prisma.videoJob.create({
      data: {
        userId: proUser.id,
        projectId: rollbackProject.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    await prisma.editorProject.update({
      where: { id: rollbackProject.id },
      data: { activeJobId: rollbackJob.id },
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_video_job_project_finish
      BEFORE UPDATE ON EditorProject
      WHEN OLD.id = '${rollbackProject.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced project side-effect failure');
      END
    `);
    try {
      await assert.rejects(
        finishJob(
          rollbackJob.id,
          { videoUrl: "/api/renders/rollback.mp4", videoId: "rollback-video" },
          { now: FINISHED_AT },
        ),
      );
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_video_job_project_finish");
    }
    const rolledBackJob = await prisma.videoJob.findUnique({ where: { id: rollbackJob.id } });
    assert.equal(rolledBackJob?.status, "processing", "project failure rolls back the completion transition");
    assert.equal(rolledBackJob?.finishedAt, null);
    assert.equal(rolledBackJob?.mediaExpiresAt, null);
    assert.equal(rolledBackJob?.outputJson, null);
    assert.equal(rolledBackJob?.videoId, null);

    const retriedRollbackJob = await finishJob(
      rollbackJob.id,
      { videoUrl: "/api/renders/rollback.mp4", videoId: "rollback-video" },
      { now: FINISHED_AT },
    );
    assert.equal(retriedRollbackJob.status, "done", "rolled-back completion remains retryable");
    const retriedRollbackProject = await prisma.editorProject.findUnique({ where: { id: rollbackProject.id } });
    assert.equal(retriedRollbackProject?.status, "exported");
    assert.equal(retriedRollbackProject?.latestVideoId, "rollback-video");

    await assert.rejects(
      finishJob(
        "video-job-expiry-missing",
        { videoUrl: "/api/renders/missing.mp4" },
        { now: FINISHED_AT },
      ),
      /video_job_not_found/,
    );

    console.log("PASS video job expiry integration");
  } finally {
    await cleanFixtures();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

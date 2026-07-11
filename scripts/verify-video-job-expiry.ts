import assert from "node:assert/strict";
import { updateEditorProject } from "../src/lib/editor-projects";
import { finishJob } from "../src/lib/mcp/video-job";
import { prisma } from "../src/lib/prisma";

const FINISHED_AT = new Date("2026-07-01T12:00:00.000Z");
const REPLAYED_AT = new Date("2026-07-10T12:00:00.000Z");
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

    // Completion is immutable. A delayed replay after a plan downgrade must
    // return the original completed row without shortening retention, changing
    // output/video ownership, or re-running project side effects.
    await prisma.user.update({ where: { id: businessUser.id }, data: { plan: "FREE" } });
    const replayedBusiness = await finishJob(
      businessJob.id,
      { videoUrl: "/api/renders/replayed.mp4", videoId: "replayed-video" },
      { now: REPLAYED_AT },
    );
    const businessAfterReplay = await prisma.videoJob.findUnique({ where: { id: businessJob.id } });
    const businessProjectAfterReplay = await prisma.editorProject.findUnique({ where: { id: businessProject.id } });
    assert.ok(replayedBusiness);
    assert.equal(replayedBusiness.id, businessJob.id);
    assert.equal(businessAfterReplay?.finishedAt?.toISOString(), FINISHED_AT.toISOString());
    assert.equal(businessAfterReplay?.mediaExpiresAt?.toISOString(), "2026-07-15T12:00:00.000Z");
    assert.equal(businessAfterReplay?.outputJson, finishedBusinessJob.outputJson);
    assert.equal(businessAfterReplay?.videoId, "business-export-video");
    assert.equal(businessProjectAfterReplay?.latestVideoId, "business-export-video");
    assert.equal(
      businessProjectAfterReplay?.lastOpenedAt.toISOString(),
      finishedBusinessProject?.lastOpenedAt.toISOString(),
    );

    // The first status transition and owner-scoped project update are one
    // transaction. Force the project write to fail and prove the job rolls back,
    // then prove an ordinary retry can complete it.
    const rollbackProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-rollback-project",
        userId: proUser.id,
        title: "Rollback project",
        status: "rendering",
      },
    });
    const rollbackJob = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-rollback-job",
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
      CREATE TRIGGER verify_finish_job_project_failure
      BEFORE UPDATE ON EditorProject
      WHEN OLD.id = 'video-job-expiry-rollback-project'
      BEGIN
        SELECT RAISE(ABORT, 'forced_project_update_failure');
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
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS verify_finish_job_project_failure");
    }
    const rolledBackJob = await prisma.videoJob.findUnique({ where: { id: rollbackJob.id } });
    assert.equal(rolledBackJob?.status, "processing");
    assert.equal(rolledBackJob?.finishedAt, null);
    assert.equal(rolledBackJob?.mediaExpiresAt, null);
    assert.equal(rolledBackJob?.outputJson, null);
    assert.equal(rolledBackJob?.videoId, null);

    const retriedRollbackJob = await finishJob(
      rollbackJob.id,
      { videoUrl: "/api/renders/rollback.mp4", videoId: "rollback-video" },
      { now: FINISHED_AT },
    );
    assert.equal(retriedRollbackJob.status, "done");
    const rollbackProjectAfterRetry = await prisma.editorProject.findUnique({ where: { id: rollbackProject.id } });
    assert.equal(rollbackProjectAfterRetry?.latestVideoId, "rollback-video");

    // Concurrent finishers race on one conditional transition. Both callers
    // observe the same winner, and the project points to that winner's video.
    const concurrentProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-concurrent-project",
        userId: proUser.id,
        title: "Concurrent project",
        status: "rendering",
      },
    });
    const concurrentJob = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-concurrent-job",
        userId: proUser.id,
        projectId: concurrentProject.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    const [concurrentA, concurrentB] = await Promise.all([
      finishJob(
        concurrentJob.id,
        { videoUrl: "/api/renders/concurrent-a.mp4", videoId: "concurrent-video-a" },
        { now: FINISHED_AT },
      ),
      finishJob(
        concurrentJob.id,
        { videoUrl: "/api/renders/concurrent-b.mp4", videoId: "concurrent-video-b" },
        { now: REPLAYED_AT },
      ),
    ]);
    const concurrentStored = await prisma.videoJob.findUnique({ where: { id: concurrentJob.id } });
    const concurrentProjectStored = await prisma.editorProject.findUnique({ where: { id: concurrentProject.id } });
    assert.ok(concurrentStored);
    assert.equal(concurrentA.outputJson, concurrentStored.outputJson);
    assert.equal(concurrentB.outputJson, concurrentStored.outputJson);
    assert.equal(concurrentProjectStored?.latestVideoId, concurrentStored.videoId);
    assert.ok(["concurrent-video-a", "concurrent-video-b"].includes(concurrentStored.videoId ?? ""));

    const stampedFreeExpiry = finishedFreeJob.mediaExpiresAt?.toISOString();
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

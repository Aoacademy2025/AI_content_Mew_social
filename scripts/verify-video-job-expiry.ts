import assert from "node:assert/strict";
import { updateEditorProject } from "../src/lib/editor-projects";
import { failJob, finishJob } from "../src/lib/mcp/video-job";
import { prisma } from "../src/lib/prisma";

const FINISHED_AT = new Date("2026-07-01T12:00:00.000Z");
const REPLAYED_AT = new Date("2026-07-10T12:00:00.000Z");
const CANCELED_AT = new Date("2026-07-01T11:59:00.000Z");
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

    // Cancellation and completion are competing terminal transitions. When
    // cancellation wins first, a delayed worker completion must not resurrect
    // the job or apply completion side effects to its project.
    const canceledProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-canceled-project",
        userId: proUser.id,
        title: "Canceled project",
        status: "rendering",
      },
    });
    const canceledJob = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-canceled-job",
        userId: proUser.id,
        projectId: canceledProject.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    await prisma.editorProject.update({
      where: { id: canceledProject.id },
      data: { activeJobId: canceledJob.id },
    });
    const canceledTransition = await prisma.videoJob.updateMany({
      where: { id: canceledJob.id, status: { in: ["queued", "processing"] } },
      data: {
        status: "canceled",
        finishedAt: CANCELED_AT,
        errorMessage: "canceled by user (editor v2)",
      },
    });
    assert.equal(canceledTransition.count, 1);
    await prisma.editorProject.updateMany({
      where: { id: canceledProject.id, userId: proUser.id, activeJobId: canceledJob.id },
      data: { status: "draft", lastOpenedAt: CANCELED_AT },
    });
    await assert.rejects(
      finishJob(
        canceledJob.id,
        { videoUrl: "/api/renders/must-not-complete.mp4", videoId: "must-not-complete-video" },
        { now: FINISHED_AT },
      ),
      /__job_canceled__/,
    );
    // The worker's catch path historically passed every finish error to failJob.
    // Even if that defensive call occurs, terminal cancellation must remain immutable.
    await failJob(canceledJob.id, "video_job_not_processing");
    const canceledAfterFinish = await prisma.videoJob.findUnique({ where: { id: canceledJob.id } });
    const canceledProjectAfterFinish = await prisma.editorProject.findUnique({
      where: { id: canceledProject.id },
    });
    assert.equal(canceledAfterFinish?.status, "canceled");
    assert.equal(canceledAfterFinish?.finishedAt?.toISOString(), CANCELED_AT.toISOString());
    assert.equal(canceledAfterFinish?.mediaExpiresAt, null);
    assert.equal(canceledAfterFinish?.outputJson, null);
    assert.equal(canceledAfterFinish?.videoId, null);
    assert.equal(canceledProjectAfterFinish?.status, "draft");
    assert.equal(canceledProjectAfterFinish?.latestVideoId, null);
    assert.equal(canceledProjectAfterFinish?.lastOpenedAt.toISOString(), CANCELED_AT.toISOString());

    assert.equal(canceledAfterFinish?.errorMessage, "canceled by user (editor v2)");

    // When completion wins first, the cancellation endpoint's guarded update
    // must lose and leave the immutable completion and project side effects intact.
    const completedBeforeCancelProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-completed-before-cancel-project",
        userId: proUser.id,
        title: "Completed before cancel",
        status: "rendering",
      },
    });
    const completedBeforeCancelJob = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-completed-before-cancel-job",
        userId: proUser.id,
        projectId: completedBeforeCancelProject.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    await prisma.editorProject.update({
      where: { id: completedBeforeCancelProject.id },
      data: { activeJobId: completedBeforeCancelJob.id },
    });
    const completedBeforeCancel = await finishJob(
      completedBeforeCancelJob.id,
      {
        videoUrl: "/api/renders/completed-before-cancel.mp4",
        videoId: "completed-before-cancel-video",
      },
      { now: FINISHED_AT },
    );
    const losingCancellation = await prisma.videoJob.updateMany({
      where: {
        id: completedBeforeCancelJob.id,
        status: { in: ["queued", "processing"] },
      },
      data: {
        status: "canceled",
        finishedAt: CANCELED_AT,
        errorMessage: "canceled by user (editor v2)",
      },
    });
    assert.equal(losingCancellation.count, 0);
    const completedAfterCancel = await prisma.videoJob.findUnique({
      where: { id: completedBeforeCancelJob.id },
    });
    const completedProjectAfterCancel = await prisma.editorProject.findUnique({
      where: { id: completedBeforeCancelProject.id },
    });
    assert.equal(completedAfterCancel?.status, "done");
    assert.equal(completedAfterCancel?.finishedAt?.toISOString(), FINISHED_AT.toISOString());
    assert.equal(completedAfterCancel?.mediaExpiresAt?.toISOString(), "2026-07-08T12:00:00.000Z");
    assert.equal(completedAfterCancel?.outputJson, completedBeforeCancel.outputJson);
    assert.equal(completedAfterCancel?.videoId, "completed-before-cancel-video");
    assert.equal(completedProjectAfterCancel?.status, "exported");
    assert.equal(completedProjectAfterCancel?.latestVideoId, "completed-before-cancel-video");

    // Failure reporting is also a guarded terminal transition. A late error
    // cannot replace an immutable successful completion.
    await failJob(completedBeforeCancelJob.id, "late worker error after completion");
    const completedAfterLateFailure = await prisma.videoJob.findUnique({
      where: { id: completedBeforeCancelJob.id },
    });
    const completedProjectAfterLateFailure = await prisma.editorProject.findUnique({
      where: { id: completedBeforeCancelProject.id },
    });
    assert.equal(completedAfterLateFailure?.status, "done");
    assert.equal(completedAfterLateFailure?.outputJson, completedBeforeCancel.outputJson);
    assert.equal(completedProjectAfterLateFailure?.status, "exported");
    assert.equal(completedProjectAfterLateFailure?.latestVideoId, "completed-before-cancel-video");

    const alreadyFailedProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-already-failed-project",
        userId: proUser.id,
        title: "Already failed project",
        status: "draft",
        lastOpenedAt: CANCELED_AT,
      },
    });
    const alreadyFailedJob = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-already-failed-job",
        userId: proUser.id,
        projectId: alreadyFailedProject.id,
        status: "failed",
        inputJson: "{}",
        errorMessage: "original failure",
        finishedAt: CANCELED_AT,
      },
    });
    await prisma.editorProject.update({
      where: { id: alreadyFailedProject.id },
      data: { activeJobId: alreadyFailedJob.id },
    });
    await assert.rejects(
      finishJob(
        alreadyFailedJob.id,
        { videoUrl: "/api/renders/must-not-revive-failed.mp4" },
        { now: FINISHED_AT },
      ),
      /video_job_not_processing/,
    );
    await failJob(alreadyFailedJob.id, "replacement failure");
    const alreadyFailedAfterReplay = await prisma.videoJob.findUnique({ where: { id: alreadyFailedJob.id } });
    const alreadyFailedProjectAfterReplay = await prisma.editorProject.findUnique({
      where: { id: alreadyFailedProject.id },
    });
    assert.equal(alreadyFailedAfterReplay?.status, "failed");
    assert.equal(alreadyFailedAfterReplay?.errorMessage, "original failure");
    assert.equal(alreadyFailedAfterReplay?.finishedAt?.toISOString(), CANCELED_AT.toISOString());
    assert.equal(alreadyFailedAfterReplay?.outputJson, null);
    assert.equal(alreadyFailedAfterReplay?.mediaExpiresAt, null);
    assert.equal(alreadyFailedProjectAfterReplay?.status, "draft");
    assert.equal(alreadyFailedProjectAfterReplay?.lastOpenedAt.toISOString(), CANCELED_AT.toISOString());

    const queuedLoser = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-queued-loser",
        userId: proUser.id,
        status: "queued",
        inputJson: "{}",
      },
    });
    await assert.rejects(
      finishJob(
        queuedLoser.id,
        { videoUrl: "/api/renders/must-not-finish-queued.mp4" },
        { now: FINISHED_AT },
      ),
      /video_job_not_processing/,
    );
    const queuedAfterFinish = await prisma.videoJob.findUnique({ where: { id: queuedLoser.id } });
    assert.equal(queuedAfterFinish?.status, "queued");
    assert.equal(queuedAfterFinish?.outputJson, null);
    assert.equal(queuedAfterFinish?.mediaExpiresAt, null);

    // Failure state and its project side effect are one transaction. If the
    // project write fails, the processing job must remain retryable.
    const failureRollbackProject = await prisma.editorProject.create({
      data: {
        id: "video-job-expiry-failure-rollback-project",
        userId: proUser.id,
        title: "Failure rollback project",
        status: "rendering",
      },
    });
    const failureRollbackJob = await prisma.videoJob.create({
      data: {
        id: "video-job-expiry-failure-rollback-job",
        userId: proUser.id,
        projectId: failureRollbackProject.id,
        status: "processing",
        inputJson: "{}",
      },
    });
    await prisma.editorProject.update({
      where: { id: failureRollbackProject.id },
      data: { activeJobId: failureRollbackJob.id },
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER verify_fail_job_project_failure
      BEFORE UPDATE ON EditorProject
      WHEN OLD.id = 'video-job-expiry-failure-rollback-project'
      BEGIN
        SELECT RAISE(ABORT, 'forced_failure_project_update_failure');
      END
    `);
    try {
      await assert.rejects(failJob(failureRollbackJob.id, "worker failed"));
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS verify_fail_job_project_failure");
    }
    const failureRolledBackJob = await prisma.videoJob.findUnique({ where: { id: failureRollbackJob.id } });
    assert.equal(failureRolledBackJob?.status, "processing");
    assert.equal(failureRolledBackJob?.errorMessage, null);
    assert.equal(failureRolledBackJob?.finishedAt, null);

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

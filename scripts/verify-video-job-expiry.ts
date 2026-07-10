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

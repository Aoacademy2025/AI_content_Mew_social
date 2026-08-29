// Run with: node --conditions=react-server --import tsx scripts/verify-story-film-final-alignment-order.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "story-film-final-alignment-order-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const story = await import("../src/lib/story-film.server");
  const queue = await import("../src/lib/story-film-generation-queue.server");
  try {
    const user = await prisma.user.create({
      data: { id: "alignment-order-user", name: "Mew", email: "alignment-order@example.com", plan: "BUSINESS" },
    });
    const presenter = await story.registerStoryFilmPresenterAsset(user.id, {
      url: "/api/renders/alignment-order-presenter.mp4",
      originalName: "presenter.mp4",
      mimeType: "video/mp4",
      sizeBytes: 50_000,
      width: 1080,
      height: 1920,
      durationMs: 145_220,
    });
    const started = await story.startStoryFilm(user.id, {
      title: "Alignment before final render",
      idempotencyKey: "alignment:order:project:001",
      presentationMode: "presenter_led",
      presenterAssetId: presenter.id,
      narrativeSource: "ทดสอบให้การจัดเวลาเสียงเสร็จก่อนเริ่มเรนเดอร์วิดีโอฉบับตรวจทุกครั้ง",
      aspectRatio: "9:16",
    });
    await prisma.storyFilmProject.update({
      where: { id: started.project.id },
      data: { stage: "final_render", status: "waiting_generation", revision: 10, generationEpoch: 5 },
    });
    const captionJob = await prisma.storyFilmGenerationJob.create({
      data: {
        projectId: started.project.id,
        stage: "storyboard",
        projectRevision: 10,
        generationEpoch: 5,
        kind: "caption_alignment",
        providerBackend: "hero_alignment",
        sceneKey: "narration-captions",
        payloadJson: "{}",
        idempotencyKey: "alignment:order:caption:005",
        priority: 40,
      },
    });
    const renderJob = await prisma.storyFilmGenerationJob.create({
      data: {
        projectId: started.project.id,
        stage: "final_render",
        projectRevision: 10,
        generationEpoch: 5,
        kind: "final_render",
        providerBackend: "hero_render",
        sceneKey: "master",
        payloadJson: "{}",
        idempotencyKey: "alignment:order:render:005",
        priority: 50,
      },
    });

    const firstLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "alignment-order-worker",
      providerBackends: ["hero_alignment", "hero_render"],
      maxJobs: 2,
    });
    assert.deepEqual(firstLease.map((job) => job.id), [captionJob.id]);
    await queue.markStoryFilmGenerationSubmitted({
      jobId: captionJob.id,
      workerId: "alignment-order-worker",
      leaseToken: firstLease[0].leaseToken,
      providerJobId: "gemini-alignment:test",
    });
    await queue.completeStoryFilmGenerationJob({
      jobId: captionJob.id,
      workerId: "alignment-order-worker",
      leaseToken: firstLease[0].leaseToken,
      artifact: {
        storageUrl: "/api/renders/alignment-order-captions.json",
        mimeType: "application/vnd.hero.caption-track+json",
        sizeBytes: 4_000,
        durationMs: 145_220,
      },
    });
    const secondLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "alignment-order-worker",
      providerBackends: ["hero_alignment", "hero_render"],
      maxJobs: 2,
    });
    assert.deepEqual(secondLease.map((job) => job.id), [renderJob.id]);
    console.log("ok: Final Preview cannot lease before its same-epoch caption alignment completes");
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(testDir, { recursive: true, force: true }));

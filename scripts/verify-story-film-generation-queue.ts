// Run with: npm run verify:story-film-generation-queue
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "story-film-queue-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok: ${message}`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const story = await import("../src/lib/story-film.server");
  const queue = await import("../src/lib/story-film-generation-queue.server");
  try {
    const alice = await prisma.user.create({
      data: { id: "queue-alice", name: "Alice", email: "queue-alice@example.com", plan: "BUSINESS" },
    });
    const bob = await prisma.user.create({
      data: { id: "queue-bob", name: "Bob", email: "queue-bob@example.com", plan: "BUSINESS" },
    });
    const presenterAsset = await story.registerStoryFilmPresenterAsset(alice.id, {
      url: "/api/renders/story-film-presenter-queue.mp4",
      originalName: "presenter.mp4",
      mimeType: "video/mp4",
      sizeBytes: 50_000,
      width: 1080,
      height: 1920,
      durationMs: 90_000,
    });

    const imageProject = await story.startStoryFilm(alice.id, {
      title: "Grok queue capacity",
      idempotencyKey: "queue:image-project:001",
      presentationMode: "presenter_led",
      presenterAssetId: presenterAsset.id,
      narrativeSource: "เรื่องนี้ใช้ทดสอบคิวภาพที่มี lease และจำนวนงานพร้อมกันไม่เกินสองงาน",
      aspectRatio: "9:16",
    });
    await prisma.storyFilmProject.update({
      where: { id: imageProject.project.id },
      data: {
        stage: "keyframes",
        revision: 7,
        generationEpoch: 4,
        awaitingApproval: false,
        status: "waiting_generation",
      },
    });

    const enqueueImage = (sceneKey: string) => queue.enqueueStoryFilmGeneration(alice.id, {
      projectId: imageProject.project.id,
      expectedStage: "keyframes",
      expectedRevision: 7,
      kind: "keyframe_image",
      providerBackend: "grok_subscription",
      sceneKey,
      payload: { prompt: `cinematic ${sceneKey}`, aspectRatio: "9:16" },
      idempotencyKey: `keyframe:${sceneKey}:epoch:004`,
    });
    const images = await Promise.all([enqueueImage("scene-01"), enqueueImage("scene-02"), enqueueImage("scene-03")]);
    ok(images.every((item) => item.created), "three FIFO Grok jobs are durable before a worker is online");
    const replay = await enqueueImage("scene-01");
    ok(!replay.created && replay.job.id === images[0].job.id, "job enqueue is idempotent per project key");
    await assert.rejects(
      queue.enqueueStoryFilmGeneration(bob.id, {
        projectId: imageProject.project.id,
        expectedStage: "keyframes",
        expectedRevision: 7,
        kind: "keyframe_image",
        providerBackend: "grok_subscription",
        sceneKey: "scene-01",
        payload: {},
        idempotencyKey: "keyframe:cross-user:001",
      }),
      (error: unknown) => (error as { code?: string }).code === "not_found",
    );
    passed += 1;
    console.log("ok: queue idempotency cannot leak another account's job");

    const t0 = new Date("2026-08-28T00:00:00.000Z");
    const firstLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-mac-mini",
      providerBackends: ["grok_subscription"],
      maxJobs: 2,
      now: t0,
    });
    ok(firstLease.length === 2, "one worker leases at most the global concurrency of two");
    ok(firstLease.every((job) => job.attemptCount === 0), "leasing alone does not consume a Grok attempt");
    const noCapacity = await queue.leaseStoryFilmGenerationJobs({
      workerId: "second-worker",
      providerBackends: ["grok_subscription"],
      maxJobs: 2,
      now: new Date(t0.getTime() + 100),
    });
    ok(noCapacity.length === 0, "global concurrency applies across worker identities");

    const first = firstLease[0];
    const heartbeat = await queue.heartbeatStoryFilmGenerationJob({
      jobId: first.id,
      workerId: "mew-mac-mini",
      leaseToken: first.leaseToken,
      now: new Date(t0.getTime() + 1_000),
    });
    ok(new Date(heartbeat.leaseExpiresAt) > new Date(first.leaseExpiresAt), "heartbeat renews an exclusive lease");
    const submitted = await queue.markStoryFilmGenerationSubmitted({
      jobId: first.id,
      workerId: "mew-mac-mini",
      leaseToken: first.leaseToken,
      providerJobId: "grok-provider-job-001",
      now: new Date(t0.getTime() + 2_000),
    });
    ok(submitted.job.attemptCount === 1, "attempt count increments only after Grok submission is confirmed");

    const resumedLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-mac-mini-restarted",
      providerBackends: ["grok_subscription"],
      maxJobs: 2,
      now: new Date(t0.getTime() + 100_000),
    });
    const resumed = resumedLease.find((job) => job.id === first.id);
    ok(
      resumed?.resumeProviderJobId === "grok-provider-job-001" && resumed.attemptCount === 1,
      "an expired running lease resumes provider polling without double submission",
    );
    const firstFailure = await queue.failStoryFilmGenerationJob({
      jobId: resumed!.id,
      workerId: "mew-mac-mini-restarted",
      leaseToken: resumed!.leaseToken,
      errorCode: "provider_timeout",
      errorMessage: "poll timed out",
      now: new Date(t0.getTime() + 101_000),
    });
    ok(firstFailure.retryQueued && firstFailure.job.technicalFailureCount === 1, "first technical failure queues one automatic retry");
    const retryLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "mew-mac-mini",
      providerBackends: ["grok_subscription"],
      maxJobs: 1,
      now: new Date(t0.getTime() + 102_000),
    });
    ok(retryLease[0]?.id === first.id && retryLease[0].resumeProviderJobId === null, "technical retry starts a clean provider submission");
    const retrySubmitted = await queue.markStoryFilmGenerationSubmitted({
      jobId: first.id,
      workerId: "mew-mac-mini",
      leaseToken: retryLease[0].leaseToken,
      providerJobId: "grok-provider-job-002",
      now: new Date(t0.getTime() + 103_000),
    });
    ok(retrySubmitted.job.attemptCount === 2, "the second confirmed provider submission is the second attempt");
    const terminalFailure = await queue.failStoryFilmGenerationJob({
      jobId: first.id,
      workerId: "mew-mac-mini",
      leaseToken: retryLease[0].leaseToken,
      errorCode: "empty_asset",
      errorMessage: "provider returned no asset",
      now: new Date(t0.getTime() + 104_000),
    });
    ok(terminalFailure.needsAttention && terminalFailure.job.status === "needs_attention", "second technical failure stops automatic retries");
    const attentionProject = await prisma.storyFilmProject.findUniqueOrThrow({ where: { id: imageProject.project.id } });
    ok(attentionProject.status === "needs_attention", "terminal worker failure surfaces Needs Attention on the active epoch");

    await prisma.storyFilmProject.update({
      where: { id: imageProject.project.id },
      data: {
        stage: "narration",
        revision: 8,
        generationEpoch: 5,
        awaitingApproval: false,
        status: "waiting_generation",
      },
    });
    const elevenJob = await queue.enqueueStoryFilmGeneration(alice.id, {
      projectId: imageProject.project.id,
      expectedStage: "narration",
      expectedRevision: 8,
      kind: "narration_voice",
      providerBackend: "elevenlabs",
      sceneKey: "narration-master",
      payload: { text: "ทดสอบการสร้างเสียงแบบจ่ายตามการใช้งาน", voiceId: "mew-clone" },
      idempotencyKey: "narration:elevenlabs:epoch:005",
    });
    const [elevenLease] = await queue.leaseStoryFilmGenerationJobs({
      workerId: "hero-elevenlabs-worker",
      providerBackends: ["elevenlabs"],
      maxJobs: 1,
      now: new Date(t0.getTime() + 105_000),
    });
    assert.equal(elevenLease.id, elevenJob.job.id);
    await queue.markStoryFilmGenerationSubmitted({
      jobId: elevenLease.id,
      workerId: "hero-elevenlabs-worker",
      leaseToken: elevenLease.leaseToken,
      providerJobId: "elevenlabs-v3:test",
      now: new Date(t0.getTime() + 106_000),
    });
    const paidCallFailure = await queue.failStoryFilmGenerationJob({
      jobId: elevenLease.id,
      workerId: "hero-elevenlabs-worker",
      leaseToken: elevenLease.leaseToken,
      errorCode: "narration_voice_failure",
      errorMessage: "provider outcome is uncertain",
      retryable: false,
      now: new Date(t0.getTime() + 107_000),
    });
    ok(
      paidCallFailure.needsAttention
        && !paidCallFailure.retryQueued
        && paidCallFailure.job.technicalFailureCount === 1,
      "an uncertain ElevenLabs POST stops after one submission instead of spending quota twice",
    );

    const storyboardProject = await story.startStoryFilm(alice.id, {
      title: "Paused completion",
      idempotencyKey: "queue:storyboard-project:001",
      presentationMode: "presenter_led",
      presenterAssetId: presenterAsset.id,
      narrativeSource: "เรื่องนี้ทดสอบว่างานที่เริ่มก่อนพักโปรเจกต์ยังรายงานผลและเปิด review ได้",
      aspectRatio: "9:16",
    });
    const narration = await story.decideStoryFilm(alice.id, {
      projectId: storyboardProject.project.id,
      expectedStage: "setup",
      expectedRevision: 1,
      decision: "approve",
      idempotencyKey: "queue:setup:approve:001",
    });
    const storyboard = await story.decideStoryFilm(alice.id, {
      projectId: storyboardProject.project.id,
      expectedStage: "narration",
      expectedRevision: narration.revision,
      decision: "approve",
      idempotencyKey: "queue:narration:approve:001",
    });
    ok(storyboard.stage === "storyboard" && storyboard.generationEpoch === 3, "content transitions advance the generation epoch");
    const automaticStoryboardJob = await prisma.storyFilmGenerationJob.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId: storyboard.id,
          idempotencyKey: "auto:storyboard:epoch:3",
        },
      },
    });
    ok(
      automaticStoryboardJob?.kind === "storyboard_plan"
        && automaticStoryboardJob.providerBackend === "hero_text",
      "approving the Narration Master automatically queues the Hero storyboard planner",
    );
    const extraStoryboardJob = await queue.enqueueStoryFilmGeneration(alice.id, {
      projectId: storyboard.id,
      expectedStage: "storyboard",
      expectedRevision: storyboard.revision,
      kind: "storyboard_plan",
      providerBackend: "hero_text",
      sceneKey: "draft-b",
      payload: { narrativeSource: storyboard.narrativeSource, segment: "draft-b" },
      idempotencyKey: "storyboard:draft-b:epoch:003",
    });
    ok(extraStoryboardJob.created, "a review batch can contain multiple independently leased jobs");
    const textLease = await queue.leaseStoryFilmGenerationJobs({
      workerId: "hero-text-worker",
      providerBackends: ["hero_text"],
      maxJobs: 2,
      now: new Date(t0.getTime() + 200_000),
    });
    ok(textLease.length === 2, "provider capability filters the shared FIFO queue");
    const paused = await story.decideStoryFilm(alice.id, {
      projectId: storyboard.id,
      expectedStage: "storyboard",
      expectedRevision: storyboard.revision,
      decision: "pause",
      idempotencyKey: "queue:pause:storyboard:001",
    });
    ok(paused.status === "paused" && paused.generationEpoch === storyboard.generationEpoch, "pause changes review revision without invalidating generation epoch");

    for (let index = 0; index < textLease.length; index += 1) {
      const leased = textLease[index];
      await queue.markStoryFilmGenerationSubmitted({
        jobId: leased.id,
        workerId: "hero-text-worker",
        leaseToken: leased.leaseToken,
        providerJobId: `hero-text-${index + 1}`,
        now: new Date(t0.getTime() + 201_000 + index),
      });
      const completed = await queue.completeStoryFilmGenerationJob({
        jobId: leased.id,
        workerId: "hero-text-worker",
        leaseToken: leased.leaseToken,
        artifact: {
          storageUrl: `/api/renders/storyboard-${index + 1}.json`,
          mimeType: "application/json",
          sizeBytes: 1_000,
          metadata: { segment: index + 1 },
        },
        now: new Date(t0.getTime() + 202_000 + index),
      });
      ok(completed.activatedReview === (index === textLease.length - 1), index === 0
        ? "a partial batch cannot open its approval gate"
        : "the final artifact atomically opens one approval revision");
    }
    const pausedReview = await story.readStoryFilm(alice.id, { projectId: storyboard.id });
    assert.equal(pausedReview.kind, "project");
    ok(
      pausedReview.project.status === "paused"
        && pausedReview.project.awaitingApproval
        && pausedReview.project.revision === paused.revision + 1,
      "running jobs may report while paused and preserve the paused state",
    );
    const resumedReview = await story.decideStoryFilm(alice.id, {
      projectId: storyboard.id,
      expectedStage: "storyboard",
      expectedRevision: pausedReview.project.revision,
      decision: "resume",
      idempotencyKey: "queue:resume:storyboard:001",
    });
    ok(resumedReview.status === "active" && resumedReview.awaitingApproval, "resume returns directly to the completed review gate");
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log(`\n${passed} Story Film generation-queue checks passed`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(testDir, { recursive: true, force: true }));

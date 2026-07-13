//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-videojob.ts
import { prisma } from "../src/lib/prisma";
import {
  createVideoJob,
  claimNextQueuedJob,
  claimNextRunnableJob,
  VIDEO_JOB_INFLIGHT_STATUSES,
  toPublicVideoJobStatus,
  saveProviderCheckpoint,
  parkProviderJob,
  setJobStep,
  finishJob,
  failJob,
  recoverProcessingJobsAfterWorkerRestart,
} from "../src/lib/mcp/video-job";
import {
  serializeAvatarProviderCheckpoint,
  type AvatarProviderCheckpointV1,
} from "../src/lib/mcp/avatar-provider-checkpoint";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

async function main() {
  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { name: "u", email: "u@t.test", plan: "PRO" } });

  const job = await createVideoJob(u.id, { script: "hi" });
  assert(job.status === "queued", "createVideoJob → queued");

  const claimed = await claimNextQueuedJob();
  assert(claimed?.id === job.id && claimed?.status === "processing", "claim flips queued→processing");
  assert((await claimNextQueuedJob()) === null, "no second claim of the same job");

  await setJobStep(job.id, "tts", 20);
  const mid = await prisma.videoJob.findUnique({ where: { id: job.id } });
  assert(mid?.currentStep === "tts" && mid?.progress === 20, "setJobStep updates step+progress");

  await finishJob(job.id, { videoUrl: "/v.mp4", videoId: "vid_1" });
  const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
  assert(done?.status === "done" && done?.videoId === "vid_1" && !!done?.outputJson, "finishJob → done + output");

  const job2 = await createVideoJob(u.id, { script: "x" });
  await claimNextQueuedJob();
  await failJob(job2.id, "boom");
  const failed = await prisma.videoJob.findUnique({ where: { id: job2.id } });
  assert(failed?.status === "failed" && failed?.errorMessage === "boom", "failJob → failed + message");

  // idempotency
  const a = await createVideoJob(u.id, { script: "k" }, "key1");
  let dup = false;
  try { await createVideoJob(u.id, { script: "k" }, "key1"); } catch { dup = true; }
  assert(dup, "duplicate idempotencyKey rejected");
  assert(!!a.id, "first idempotent job created");

  // --- durable provider wait lifecycle ---
  await prisma.videoJob.deleteMany();
  const checkpoint: AvatarProviderCheckpointV1 = {
    version: 1,
    provider: "heygen",
    phase: "intro_wait",
    providerStartedAt: "2026-07-13T08:00:00.000Z",
    providerDeadlineAt: "2026-07-13T10:00:00.000Z",
    baseUrl: "/api/renders/base.mp4",
    voiceUrl: "/api/renders/voice.mp3",
    audioDurationMs: 90_000,
    captions: [{ text: "ทดสอบ", startMs: 0, endMs: 900 }],
    words: [],
    fullText: "ทดสอบ",
    baseConfig: { voiceFile: "/api/renders/voice.mp3" },
    avatar: {
      mode: "full",
      id: "avatar-1",
      introSecs: 5,
      tailSecs: 5,
      layout: { scale: 1, offsetX: 0, offsetY: 0 },
      introVideoId: "hg-1",
    },
  };
  const prepared = await createVideoJob(u.id, { script: "checkpoint intent" });
  await claimNextRunnableJob();
  const generateIntent: AvatarProviderCheckpointV1 = {
    ...checkpoint,
    phase: "intro_generate",
    avatar: { ...checkpoint.avatar, introVideoId: undefined },
  };
  assert((await saveProviderCheckpoint(prepared.id, generateIntent)).count === 1, "checkpoint intent saves only while processing");
  const preparedRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: prepared.id } });
  assert(preparedRow.currentStep === "avatar" && preparedRow.progress === 84, "checkpoint intent atomically records the provider step");
  await prisma.videoJob.update({ where: { id: prepared.id }, data: { status: "canceled" } });
  assert((await saveProviderCheckpoint(prepared.id, checkpoint)).count === 0, "cancellation blocks every later checkpoint write");

  const waiting = await createVideoJob(u.id, { script: "avatar" });
  assert((await claimNextRunnableJob())?.id === waiting.id, "runnable claim claims a queued job");
  const dueAt = new Date("2026-07-13T09:00:00.000Z");
  assert((await parkProviderJob(waiting.id, checkpoint, dueAt)).count === 1, "processing job parks atomically");
  const parked = await prisma.videoJob.findUniqueOrThrow({ where: { id: waiting.id } });
  assert(parked.status === "waiting_provider" && parked.progress === 84, "park records waiting_provider at avatar 84%");
  assert(toPublicVideoJobStatus(parked.status) === "processing", "waiting_provider is normalized for public clients");
  assert(VIDEO_JOB_INFLIGHT_STATUSES.includes("waiting_provider"), "waiting_provider counts as in-flight");
  assert(await claimNextRunnableJob(new Date("2026-07-13T08:59:59.000Z")) === null, "provider wait is not claimed before due time");
  const resumed = await claimNextRunnableJob(dueAt);
  assert(resumed?.id === waiting.id && resumed.status === "processing", "due provider wait is reclaimed atomically");
  await finishJob(waiting.id, { videoUrl: "/api/renders/final.mp4" });
  const finishedWait = await prisma.videoJob.findUniqueOrThrow({ where: { id: waiting.id } });
  assert(finishedWait.providerCheckpointJson === null && finishedWait.providerNextPollAt === null, "finish clears provider checkpoint and next poll");

  // Restart recovery parks resumable waits/composites instead of replaying billed work.
  await prisma.videoJob.deleteMany();
  const orphanWait = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      currentStep: "avatar",
      progress: 84,
      inputJson: JSON.stringify({ script: "wait" }),
      providerCheckpointJson: serializeAvatarProviderCheckpoint(checkpoint),
    },
  });
  const waitRecovery = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  const recoveredWait = await prisma.videoJob.findUniqueOrThrow({ where: { id: orphanWait.id } });
  assert(waitRecovery.parked === 1 && recoveredWait.status === "waiting_provider" && !!recoveredWait.providerNextPollAt, "restart recovery parks a valid provider wait");

  await prisma.videoJob.deleteMany();
  const compositeCheckpoint: AvatarProviderCheckpointV1 = {
    ...checkpoint,
    phase: "composite",
    avatar: { ...checkpoint.avatar, introVideoUrl: "https://files2.heygen.ai/intro.mp4" },
  };
  const orphanComposite = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      currentStep: "composite",
      progress: 86,
      inputJson: JSON.stringify({ script: "composite" }),
      providerCheckpointJson: serializeAvatarProviderCheckpoint(compositeCheckpoint),
    },
  });
  const compositeRecovery = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  assert(compositeRecovery.parked === 1 && (await prisma.videoJob.findUniqueOrThrow({ where: { id: orphanComposite.id } })).status === "waiting_provider", "restart recovery parks a valid composite checkpoint");

  await prisma.videoJob.deleteMany();
  const generateCheckpoint: AvatarProviderCheckpointV1 = {
    ...checkpoint,
    phase: "intro_generate",
    avatar: { ...checkpoint.avatar, introVideoId: undefined },
  };
  const unknownGenerate = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      currentStep: "avatar",
      progress: 84,
      inputJson: JSON.stringify({ script: "unknown generate" }),
      providerCheckpointJson: serializeAvatarProviderCheckpoint(generateCheckpoint),
    },
  });
  const unknownRecovery = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  const unknownFailed = await prisma.videoJob.findUniqueOrThrow({ where: { id: unknownGenerate.id } });
  assert(unknownRecovery.failed === 1 && unknownFailed.status === "failed" && (unknownFailed.errorMessage ?? "").includes("unknown provider outcome"), "restart fails a stranded generate phase without regenerating");

  // --- worker-restart recovery: only pre-render (free) steps may requeue ---
  // Each scenario starts from a clean job table so the recovery scan sees only its own rows.

  // (a) safe pre-render step → requeued, progress reset
  await prisma.videoJob.deleteMany();
  const orphan = await prisma.videoJob.create({
    data: { userId: u.id, status: "processing", currentStep: "config", progress: 65, inputJson: JSON.stringify({ script: "orphan" }), startedAt: new Date() },
  });
  const recovered = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  const requeued = await prisma.videoJob.findUnique({ where: { id: orphan.id } });
  assert(recovered.requeued === 1 && recovered.failed === 0, "recovery requeues a safe pre-render step (config)");
  assert(requeued?.status === "queued" && requeued.progress === 0 && requeued.currentStep === null && requeued.startedAt === null, "requeued orphan resets progress/step/start");

  // (b) claimed but no step yet (currentStep null) → requeued
  await prisma.videoJob.deleteMany();
  const claimedOnly = await prisma.videoJob.create({
    data: { userId: u.id, status: "processing", currentStep: null, progress: 0, inputJson: JSON.stringify({ script: "claimed" }), startedAt: new Date() },
  });
  const claimedRes = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  assert(claimedRes.requeued === 1 && claimedRes.failed === 0, "recovery requeues a job claimed before its first step");
  assert((await prisma.videoJob.findUnique({ where: { id: claimedOnly.id } }))?.status === "queued", "claimed-only orphan → queued");

  // (c) billable/irreversible steps → FAILED, never replayed (no double clip-quota / HeyGen charge, no dup gallery row)
  for (const stepName of ["render", "avatar", "composite"]) {
    await prisma.videoJob.deleteMany();
    const billable = await prisma.videoJob.create({
      data: { userId: u.id, status: "processing", currentStep: stepName, progress: 80, inputJson: JSON.stringify({ script: stepName }) },
    });
    const res = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
    const row = await prisma.videoJob.findUnique({ where: { id: billable.id } });
    assert(res.failed === 1 && res.requeued === 0 && row?.status === "failed" && (row.errorMessage ?? "").includes("billable"), `recovery fails (not requeues) billable step "${stepName}"`);
  }

  // (d) retry cap on a safe step → failed
  await prisma.videoJob.deleteMany();
  const exhausted = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      currentStep: "config",
      inputJson: JSON.stringify({ script: "retry exhausted" }),
      errorMessage: "worker restarted - requeued 2/2",
    },
  });
  const exhaustedResult = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  const exhaustedFailed = await prisma.videoJob.findUnique({ where: { id: exhausted.id } });
  assert(exhaustedResult.failed === 1 && exhaustedFailed?.status === "failed", "recovery fails a safe step after retry cap");

  // (e) burn → failed with the gallery-row reason
  await prisma.videoJob.deleteMany();
  const burn = await prisma.videoJob.create({
    data: { userId: u.id, status: "processing", currentStep: "burn", inputJson: JSON.stringify({ script: "burn" }) },
  });
  const burnResult = await recoverProcessingJobsAfterWorkerRestart({ maxRequeues: 2 });
  const burnFailed = await prisma.videoJob.findUnique({ where: { id: burn.id } });
  assert(burnResult.failed === 1 && burnFailed?.status === "failed" && (burnFailed.errorMessage ?? "").includes("during burn"), "recovery does not replay burn stage");

  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} VIDEOJOB CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

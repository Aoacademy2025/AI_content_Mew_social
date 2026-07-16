//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-videojob.ts
import { prisma } from "../src/lib/prisma";
import {
  createVideoJob,
  claimNextQueuedJob,
  setJobStep,
  finishJob,
  failJob,
  recoverProcessingJobsAfterWorkerRestart,
} from "../src/lib/mcp/video-job";

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
  const fingerprint = "a".repeat(64);
  const fingerprinted = await createVideoJob(
    u.id,
    { script: "fingerprinted" },
    "key-with-fingerprint",
    { idempotencyFingerprint: fingerprint },
  );
  const fingerprintedRow = await prisma.videoJob.findUnique({ where: { id: fingerprinted.id } });
  assert(
    fingerprintedRow?.idempotencyFingerprint === fingerprint,
    "createVideoJob atomically persists an optional logical-request fingerprint",
  );
  assert(
    a.idempotencyFingerprint === null,
    "existing non-editor callers remain compatible with a nullable fingerprint",
  );

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

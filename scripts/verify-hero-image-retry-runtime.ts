import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  claimPlannedImageAttemptSubmission,
  completeImageJob,
  createReservedImageJob,
  markImageAttemptSubmitted,
  replaceCanceledImageAttempt,
} from "../src/lib/ai-generation-jobs.server";

async function main() {
  const user = await prisma.user.create({
    data: {
      name: "Hero Retry Test",
      email: "hero-retry@example.invalid",
    },
  });
  await prisma.creditBalance.create({
    data: { userId: user.id, granted: 10, purchased: 0 },
  });
  const reserved = await createReservedImageJob({
    userId: user.id,
    model: "z-image-turbo",
    inputPreview: "same exact prompt",
    inputJson: "{}",
    creditCost: 3,
    quoteVersion: "test",
    costBudgetUsdMicros: 58_333,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "endpoint-test",
    estimatedCostUsdMicros: 50_000,
    idempotencyKey: "video:test:scene:0",
    mediaExpiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;

  const firstClaims = await Promise.all([
    claimPlannedImageAttemptSubmission({
      userId: user.id,
      jobId: reserved.job.id,
      sequence: 1,
    }),
    claimPlannedImageAttemptSubmission({
      userId: user.id,
      jobId: reserved.job.id,
      sequence: 1,
    }),
  ]);
  assert.equal(firstClaims.filter(Boolean).length, 1, "only one concurrent caller may submit an attempt");
  await markImageAttemptSubmitted({
    userId: user.id,
    jobId: reserved.job.id,
    sequence: 1,
    providerJobId: "provider-job-1",
    inProgress: false,
  });
  assert.equal(await replaceCanceledImageAttempt({
    userId: user.id,
    jobId: reserved.job.id,
    sequence: 1,
    providerJobId: "provider-job-1",
    cancellationConfirmed: false,
    reason: "cancel unconfirmed",
  }), null, "an unconfirmed cancel must never create a duplicate provider attempt");

  const replacement = await replaceCanceledImageAttempt({
    userId: user.id,
    jobId: reserved.job.id,
    sequence: 1,
    providerJobId: "provider-job-1",
    cancellationConfirmed: true,
    reason: "confirmed orphan queue cancellation",
  });
  assert.equal(replacement?.sequence, 2);
  assert.equal(replacement?.provider, "runpod");
  assert.equal(replacement?.providerModel, "z-image-turbo");
  assert.equal(replacement?.providerEndpoint, "endpoint-test");

  assert.equal(await claimPlannedImageAttemptSubmission({
    userId: user.id,
    jobId: reserved.job.id,
    sequence: 2,
  }), true);
  await markImageAttemptSubmitted({
    userId: user.id,
    jobId: reserved.job.id,
    sequence: 2,
    providerJobId: "provider-job-2",
    inProgress: true,
  });
  await completeImageJob({
    userId: user.id,
    jobId: reserved.job.id,
    outputUrl: "/api/renders/retry-test.png",
  });

  const attempts = await prisma.aiGenerationAttempt.findMany({
    where: { jobId: reserved.job.id },
    orderBy: { sequence: "asc" },
  });
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["canceled", "completed"]);
  const job = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: reserved.job.id } });
  assert.equal(job.status, "completed");
  assert.equal(job.chargeState, "settled");
  assert.equal(job.providerJobId, "provider-job-2");

  const ledger = await prisma.creditLedger.findMany({ where: { userId: user.id } });
  assert.equal(ledger.filter((row) => row.kind === "spend").length, 1);
  assert.equal(ledger.filter((row) => row.kind === "refund").length, 0);
  const balance = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(balance.granted, 7, "a same-engine retry must not charge credits twice");

  console.log("verify-hero-image-retry-runtime: ALL PASS");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "ai-image-terminal-race-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
    const { markImageAttemptProgress, recordImageAttemptCost } = await import("../src/lib/ai-generation-jobs.server");

  try {
    const user = await prisma.user.create({
      data: { id: "terminal-race-user", name: "Terminal Race", email: "terminal-race@example.invalid" },
    });
    const finishedAt = new Date("2026-08-19T09:11:33.000Z");
    const job = await prisma.aiGenerationJob.create({
      data: {
        id: "terminal-race-job",
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        providerModel: "z-image-turbo",
        providerRoute: "runpod-custom",
        providerEndpoint: "test-endpoint",
        status: "completed",
        inputPreview: "terminal race",
        inputJson: "{}",
        outputUrl: "https://example.invalid/completed.png",
        creditCost: 2,
        chargeState: "settled",
        idempotencyKey: "studio:terminal-race",
        finishedAt,
        attempts: {
          create: {
            sequence: 1,
            provider: "runpod",
            providerModel: "z-image-turbo",
            providerRoute: "runpod-custom",
            providerEndpoint: "test-endpoint",
            providerJobId: "provider-terminal-race",
            status: "completed",
            estimatedCostUsdMicros: 1,
            finishedAt,
          },
        },
      },
    });

    const returned = await markImageAttemptProgress({
      userId: user.id,
      jobId: job.id,
      sequence: 1,
      inProgress: true,
      delayTimeMs: 2_000,
    });
    const stored = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
    const attempt = await prisma.aiGenerationAttempt.findUniqueOrThrow({
      where: { jobId_sequence: { jobId: job.id, sequence: 1 } },
    });

    assert.equal(returned?.status, "completed", "late progress must return the existing terminal job");
    assert.equal(stored.status, "completed", "late progress must not resurrect a completed job");
    assert.equal(stored.chargeState, "settled", "late progress must preserve settlement");
    assert.equal(stored.finishedAt?.toISOString(), finishedAt.toISOString());
    assert.equal(attempt.status, "completed", "late progress must not alter the completed attempt");
    console.log("PASS late image progress cannot overwrite a terminal job");

    const activeJob = await prisma.aiGenerationJob.create({
      data: {
        id: "active-poll-job",
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        providerModel: "z-image-turbo",
        providerRoute: "runpod-custom",
        providerEndpoint: "test-endpoint",
        providerJobId: "provider-active-poll",
        status: "queued",
        inputPreview: "active poll",
        inputJson: "{}",
        creditCost: 2,
        chargeState: "reserved",
        idempotencyKey: "studio:active-poll",
        attempts: {
          create: {
            sequence: 1,
            provider: "runpod",
            providerModel: "z-image-turbo",
            providerRoute: "runpod-custom",
            providerEndpoint: "test-endpoint",
            providerJobId: "provider-active-poll",
            status: "queued",
            estimatedCostUsdMicros: 1,
          },
        },
      },
    });

    let txCount = 0;
    const origTx = prisma.$transaction.bind(prisma);
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = ((...args: Parameters<typeof prisma.$transaction>) => {
      txCount += 1;
      return origTx(...args);
    }) as typeof prisma.$transaction;

    try {
      const firstTick = await markImageAttemptProgress({
        userId: user.id,
        jobId: activeJob.id,
        sequence: 1,
        inProgress: true,
        delayTimeMs: 420,
      });
      assert.equal(firstTick?.status, "in_progress");
      assert.equal(firstTick?.delayTimeMs, 420);
      assert.ok(firstTick?.startedAt instanceof Date);
      assert.equal(txCount, 1, "first transition to in_progress must open 1 write transaction");

      for (let i = 0; i < 5; i += 1) {
        const repeatTick = await markImageAttemptProgress({
          userId: user.id,
          jobId: activeJob.id,
          sequence: 1,
          inProgress: true,
          delayTimeMs: i % 2 === 0 ? 420 : undefined,
        });
        assert.equal(repeatTick?.status, "in_progress");
        assert.equal(repeatTick?.delayTimeMs, 420);
      }
      assert.equal(txCount, 1, "unchanged poll ticks must not open any SQLite write transactions");

      await recordImageAttemptCost({
        userId: user.id,
        jobId: activeJob.id,
        sequence: 1,
        providerJobId: "provider-active-poll",
        providerReportedCostUsdMicros: 500,
      });
      assert.equal(txCount, 2, "initial cost report must open 1 write transaction");

      await recordImageAttemptCost({
        userId: user.id,
        jobId: activeJob.id,
        sequence: 1,
        providerJobId: "provider-active-poll",
        providerReportedCostUsdMicros: 500,
      });
      assert.equal(txCount, 2, "duplicate cost report must not open a write transaction");
      console.log("PASS unchanged RunPod poll ticks and cost reports skip SQLite write transactions");
    } finally {
      (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = origTx;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

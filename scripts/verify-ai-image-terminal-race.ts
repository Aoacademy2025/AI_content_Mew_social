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
  const { markImageAttemptProgress } = await import("../src/lib/ai-generation-jobs.server");

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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

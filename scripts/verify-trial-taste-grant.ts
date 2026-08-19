import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "conversion-trial-image-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  process.env.CREDITS_LIVE = "1";
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  const { grantTrial, revertExpiredTrials, TRIAL_DAYS_PUBLIC } = await import("../src/lib/trial");
  const { getBalance } = await import("../src/lib/credits");
  const { getStarterAiImageAllowanceStatus } = await import("../src/lib/starter-ai-image-allowance.server");
  const { completeImageJob, createReservedImageJob } = await import("../src/lib/ai-generation-jobs.server");

  const trialUser = await prisma.user.create({
    data: { name: "Conversion Trial", email: "conversion-trial@example.invalid" },
  });
  assert.equal(await grantTrial(trialUser.id, TRIAL_DAYS_PUBLIC), true);
  assert.deepEqual(await getBalance(trialUser.id), { granted: 0, promotional: 0, purchased: 0, total: 0 });

  const initial = await getStarterAiImageAllowanceStatus(trialUser.id);
  assert.equal(initial.eligible, true);
  assert.equal(initial.accessMode, "trial");
  assert.equal(initial.limitImages, 8);
  assert.equal(initial.remainingImages, 8);
  assert.equal(
    initial.windowStartedAt.getTime(),
    (await prisma.user.findUniqueOrThrow({ where: { id: trialUser.id } })).trialStartedAt!.getTime(),
    "one-time allowance is anchored to Trial start",
  );

  const reserved = await createReservedImageJob({
    userId: trialUser.id,
    model: "z-image-turbo",
    inputPreview: "conversion trial",
    inputJson: "{}",
    creditCost: 2,
    quoteVersion: "verify",
    costBudgetUsdMicros: 38_888,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "verify-endpoint",
    estimatedCostUsdMicros: 10_000,
    idempotencyKey: "video:conversion-trial:scene:0",
    mediaExpiresAt: new Date(Date.now() + 60_000),
    fundingPolicy: "brand-visual-activation",
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("expected Trial reservation");
  assert.equal(reserved.fundingSource, "starter_allowance");
  await completeImageJob({ userId: trialUser.id, jobId: reserved.job.id, outputUrl: "/api/renders/trial.png" });
  assert.equal((await getStarterAiImageAllowanceStatus(trialUser.id)).remainingImages, 7);
  assert.equal(await grantTrial(trialUser.id, TRIAL_DAYS_PUBLIC), false, "Trial cannot be granted twice");

  await prisma.user.update({
    where: { id: trialUser.id },
    data: { trialEndsAt: new Date(Date.now() - 60_000) },
  });
  assert.equal(await revertExpiredTrials(), 1);
  const expired = await getStarterAiImageAllowanceStatus(trialUser.id);
  assert.equal(expired.eligible, false);
  assert.equal(expired.accessMode, "locked");
  assert.equal(expired.remainingImages, 7, "unused images remain historical but unavailable after day 7");

  const freeUser = await prisma.user.create({
    data: { name: "Never-paid Free", email: "never-paid-free@example.invalid" },
  });
  const free = await getStarterAiImageAllowanceStatus(freeUser.id);
  assert.equal(free.eligible, false);
  assert.equal(free.remainingImages, 0, "FREE outside an active Trial gets no image grant");

  await prisma.$disconnect();
  console.log("verify-trial-taste-grant: PASS one-time 8 images inside seven-day Trial only");
}

main().catch((error) => { console.error(error); process.exit(1); });

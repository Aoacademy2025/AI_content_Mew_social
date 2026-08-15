import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "conversion-trial-allowance-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
const DAY_MS = 24 * 60 * 60 * 1_000;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { completeImageJob, createReservedImageJob, failAndRefundAiJob } = await import("../src/lib/ai-generation-jobs.server");
  const { getStarterAiImageAllowanceStatus } = await import("../src/lib/starter-ai-image-allowance.server");
  const { refundSettledVideoImageJob } = await import("../src/lib/video-image-batch-settlement");
  const now = new Date();

  const trial = await prisma.user.create({
    data: {
      name: "Trial",
      email: "allowance-trial@example.test",
      plan: "PRO",
      trialStartedAt: new Date(now.getTime() - DAY_MS),
      trialEndsAt: new Date(now.getTime() + 6 * DAY_MS),
    },
  });
  await prisma.creditBalance.create({ data: { userId: trial.id, granted: 10, purchased: 0 } });

  const reserve = (key: string) => createReservedImageJob({
    userId: trial.id,
    model: "z-image-turbo",
    inputPreview: "safe preview",
    inputJson: "{}",
    creditCost: 2,
    quoteVersion: "verify-v1",
    costBudgetUsdMicros: 10_000,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "verify-endpoint",
    estimatedCostUsdMicros: 1_000,
    idempotencyKey: key,
    mediaExpiresAt: new Date(now.getTime() + DAY_MS),
    fundingPolicy: "brand-visual-activation",
  });

  const first = await reserve("trial:first");
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("first reservation failed");
  assert.equal(first.fundingSource, "starter_allowance");
  assert.equal(first.allowanceRemaining, 7);
  const replay = await reserve("trial:first");
  assert.equal(replay.ok && !replay.created && replay.allowanceRemaining === 7, true, "idempotent replay reserves once");

  for (let index = 2; index <= 8; index += 1) assert.equal((await reserve(`trial:${index}`)).ok, true);
  assert.deepEqual(await reserve("trial:ninth"), {
    ok: false, reason: "allowance_exhausted", balanceAfter: 10, allowanceRemaining: 0,
  });

  await failAndRefundAiJob(trial.id, first.job.id, "VERIFY_FAIL", "provider failed");
  assert.equal((await getStarterAiImageAllowanceStatus(trial.id)).remainingImages, 1, "failure restores one unit");
  const replacement = await reserve("trial:replacement");
  assert.equal(replacement.ok, true);
  if (!replacement.ok) throw new Error("replacement failed");
  await completeImageJob({ userId: trial.id, jobId: replacement.job.id, outputUrl: "/generated/trial.webp" });
  await completeImageJob({ userId: trial.id, jobId: replacement.job.id, outputUrl: "/generated/trial.webp" });
  assert.equal((await getStarterAiImageAllowanceStatus(trial.id)).usedImages, 1, "completion settles once");
  await refundSettledVideoImageJob({ userId: trial.id, jobId: replacement.job.id, reason: "delivery_failed" });
  await refundSettledVideoImageJob({ userId: trial.id, jobId: replacement.job.id, reason: "retry" });
  assert.equal((await getStarterAiImageAllowanceStatus(trial.id)).remainingImages, 1, "lost delivery restores exactly once");

  const original = await getStarterAiImageAllowanceStatus(trial.id);
  await prisma.user.update({ where: { id: trial.id }, data: { trialEndsAt: new Date(now.getTime() - 1_000), plan: "FREE" } });
  const expired = await getStarterAiImageAllowanceStatus(trial.id);
  assert.equal(expired.eligible, false);
  assert.equal(expired.windowStartedAt.getTime(), original.windowStartedAt.getTime());
  assert.equal(expired.remainingImages, 1);
  const dayThirty = await getStarterAiImageAllowanceStatus(trial.id, new Date(now.getTime() + 30 * DAY_MS));
  assert.equal(dayThirty.remainingImages, 1, "30/60-day time changes never issue a new grant");
  const daySixty = await getStarterAiImageAllowanceStatus(trial.id, new Date(now.getTime() + 60 * DAY_MS));
  assert.equal(daySixty.windowStartedAt.getTime(), original.windowStartedAt.getTime());

  const paid = await prisma.user.create({
    data: {
      name: "Paid", email: "allowance-paid@example.test", plan: "PRO",
      planExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
    },
  });
  await prisma.payment.create({
    data: { userId: paid.id, stripeSessionId: "paid-plan", plan: "PRO", amount: 9900, status: "PAID", periodDays: 30, paidAt: now },
  });
  const paidStatus = await getStarterAiImageAllowanceStatus(paid.id);
  assert.equal(paidStatus.accessMode, "paid");
  assert.equal(paidStatus.eligible, false);

  const legacyTrial = await prisma.user.create({
    data: {
      name: "Legacy Trial", email: "legacy-trial@example.test", plan: "PRO",
      trialStartedAt: new Date(now.getTime() - DAY_MS), trialEndsAt: new Date(now.getTime() + 6 * DAY_MS),
    },
  });
  await prisma.starterAiImageAllowance.create({
    data: { userId: legacyTrial.id, windowStartedAt: new Date(now.getTime() - DAY_MS), usedImages: 3 },
  });
  const carried = await getStarterAiImageAllowanceStatus(legacyTrial.id);
  assert.equal(carried.usedImages, 3);
  assert.equal(carried.remainingImages, 5, "legacy consumption carries into the cap without a fresh eight");

  await prisma.$disconnect();
  console.log("verify-starter-ai-image-allowance: PASS one-time reserve, settle, restore, expiry, carry-forward");
}

main().catch((error) => { console.error(error); process.exit(1); });

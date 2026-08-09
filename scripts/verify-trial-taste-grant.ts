// Regression for the Brand Visual V1 entitlement decision that replaced the
// legacy one-time 10-credit trial taste grant. Trial and never-paid Free users
// share one 8-image allowance window; the paid shared-credit wallet is unchanged.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "starter-ai-image-trial-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  process.env.CREDITS_LIVE = "1";
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  const { grantTrial, revertExpiredTrials, TRIAL_DAYS_PUBLIC } = await import("../src/lib/trial");
  const { getBalance, ensureMonthlyGrant, MONTHLY_GRANT } = await import("../src/lib/credits");
  const { grantOnPaidActivation } = await import("../src/lib/entitlements");
  const {
    getStarterAiImageAllowanceStatus,
    STARTER_AI_IMAGE_ALLOWANCE_LIMIT,
  } = await import("../src/lib/starter-ai-image-allowance.server");
  const { completeImageJob, createReservedImageJob } = await import("../src/lib/ai-generation-jobs.server");

  const trialUser = await prisma.user.create({
    data: { name: "Starter allowance trial", email: "starter-trial@example.invalid" },
  });
  assert.equal(await grantTrial(trialUser.id, TRIAL_DAYS_PUBLIC), true);

  const afterGrant = await getBalance(trialUser.id);
  assert.deepEqual(afterGrant, { granted: 0, purchased: 0, total: 0 }, "a trial must not receive a second credit currency");
  assert.equal(
    await prisma.creditLedger.count({ where: { userId: trialUser.id, action: { startsWith: "trial-taste:" } } }),
    0,
    "the removed 10-credit taste grant must leave no ledger row",
  );

  const initial = await getStarterAiImageAllowanceStatus(trialUser.id);
  assert.equal(STARTER_AI_IMAGE_ALLOWANCE_LIMIT, 8);
  assert.equal(initial.eligible, true);
  assert.equal(initial.limitImages, 8);
  assert.equal(initial.remainingImages, 8);

  const reserved = await createReservedImageJob({
    userId: trialUser.id,
    model: "z-image-turbo",
    inputPreview: "starter allowance regression",
    inputJson: "{}",
    creditCost: 2,
    quoteVersion: "verify",
    costBudgetUsdMicros: 38_888,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "verify-endpoint",
    estimatedCostUsdMicros: 10_000,
    idempotencyKey: "video:starter-trial:scene:0",
    mediaExpiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("expected starter allowance reservation");
  assert.equal(reserved.job.fundingSource, "starter_allowance");
  assert.equal(reserved.job.allowanceUnits, 1);
  assert.equal(reserved.job.creditsFromGranted + reserved.job.creditsFromPurchased, 0);
  await completeImageJob({
    userId: trialUser.id,
    jobId: reserved.job.id,
    outputUrl: "/api/renders/starter-trial.png",
  });

  const afterImage = await getStarterAiImageAllowanceStatus(trialUser.id);
  assert.equal(afterImage.usedImages, 1);
  assert.equal(afterImage.remainingImages, 7);
  assert.equal(await grantTrial(trialUser.id, TRIAL_DAYS_PUBLIC), false, "re-entering trial must not reset allowance");
  await ensureMonthlyGrant(trialUser.id);
  assert.equal((await getBalance(trialUser.id)).total, 0, "active trial remains outside the monthly credit grant");

  await prisma.user.update({
    where: { id: trialUser.id },
    data: { trialEndsAt: new Date(Date.now() - 60_000) },
  });
  assert.equal(await revertExpiredTrials(), 1);
  const expired = await prisma.user.findUniqueOrThrow({ where: { id: trialUser.id } });
  assert.equal(expired.plan, "FREE");
  const afterExpiry = await getStarterAiImageAllowanceStatus(trialUser.id);
  assert.equal(afterExpiry.eligible, true);
  assert.equal(afterExpiry.windowStartedAt.getTime(), initial.windowStartedAt.getTime());
  assert.equal(afterExpiry.remainingImages, 7, "Trial → Free continues the same 30-day allowance");

  await prisma.user.update({
    where: { id: trialUser.id },
    data: { plan: "PRO", subStatus: "active", trialEndsAt: null },
  });
  await grantOnPaidActivation(trialUser.id, "PRO");
  const paidFunding = await getStarterAiImageAllowanceStatus(trialUser.id);
  assert.equal(paidFunding.eligible, false);
  assert.equal(paidFunding.fundingSource, "credits");
  assert.equal((await getBalance(trialUser.id)).granted, MONTHLY_GRANT.PRO);

  const freeUser = await prisma.user.create({
    data: { name: "Never-paid Free", email: "starter-free@example.invalid" },
  });
  const freeAllowance = await getStarterAiImageAllowanceStatus(freeUser.id);
  assert.equal(freeAllowance.eligible, true);
  assert.equal(freeAllowance.remainingImages, 8);
  assert.equal((await getBalance(freeUser.id)).total, 0);

  await prisma.$disconnect();
  console.log("verify-trial-taste-grant: PASS 8-image Trial→Free allowance + paid shared credits");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

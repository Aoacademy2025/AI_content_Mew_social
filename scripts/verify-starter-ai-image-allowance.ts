import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "starter-ai-image-allowance-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const DAY_MS = 24 * 60 * 60 * 1_000;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    completeImageJob,
    createReservedImageJob,
    failAndRefundAiJob,
  } = await import("../src/lib/ai-generation-jobs.server");
  const { getStarterAiImageAllowanceStatus } = await import(
    "../src/lib/starter-ai-image-allowance.server"
  );
  const { refundSettledVideoImageJob } = await import("../src/lib/video-image-batch-settlement");

  const now = new Date();
  const starter = await prisma.user.create({
    data: {
      name: "Starter",
      email: "starter@example.test",
      plan: "PRO",
      createdAt: new Date(now.getTime() - 3 * DAY_MS),
      trialStartedAt: new Date(now.getTime() - 3 * DAY_MS),
      trialEndsAt: new Date(now.getTime() + 4 * DAY_MS),
    },
  });
  await prisma.creditBalance.create({
    data: { userId: starter.id, granted: 10, purchased: 0 },
  });

  const reserve = (
    userId: string,
    key: string,
    fundingPolicy: "credits-only" | "brand-visual-activation" = "brand-visual-activation",
  ) => createReservedImageJob({
    userId,
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
    fundingPolicy,
  });

  const genericTrialUser = await prisma.user.create({
    data: {
      name: "Generic image trial",
      email: "generic-image-trial@example.test",
      plan: "PRO",
      createdAt: new Date(now.getTime() - DAY_MS),
      trialStartedAt: new Date(now.getTime() - DAY_MS),
      trialEndsAt: new Date(now.getTime() + 6 * DAY_MS),
    },
  });
  await prisma.creditBalance.create({
    data: { userId: genericTrialUser.id, granted: 4, purchased: 0 },
  });
  const genericReservation = await reserve(
    genericTrialUser.id,
    "studio:generic-image",
    "credits-only",
  );
  assert.equal(genericReservation.ok, true);
  if (!genericReservation.ok) throw new Error("generic reservation failed");
  assert.equal(genericReservation.fundingSource, "credits", "generic image surfaces must never consume Brand Visual activation allowance");
  assert.equal(genericReservation.balanceAfter, 2);
  assert.equal(
    await prisma.starterAiImageAllowance.count({ where: { userId: genericTrialUser.id } }),
    0,
    "credits-only image generation must not materialize an allowance row",
  );

  const first = await reserve(starter.id, "brand:first");
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("first reservation failed");
  assert.equal(first.fundingSource, "starter_allowance");
  assert.equal(first.allowanceRemaining, 7);
  assert.equal(first.job.creditCost, 2, "quoted price stays 2 credits per image");
  assert.equal((await prisma.creditBalance.findUniqueOrThrow({ where: { userId: starter.id } })).granted, 10);

  const replay = await reserve(starter.id, "brand:first");
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error("replay failed");
  assert.equal(replay.created, false);
  assert.equal(replay.allowanceRemaining, 7, "idempotent replay cannot reserve twice");

  for (let index = 2; index <= 8; index += 1) {
    const result = await reserve(starter.id, `brand:${index}`);
    assert.equal(result.ok, true, `starter image ${index} should reserve`);
  }
  const exhausted = await reserve(starter.id, "brand:ninth");
  assert.deepEqual(
    exhausted,
    { ok: false, reason: "allowance_exhausted", balanceAfter: 10, allowanceRemaining: 0 },
  );

  await failAndRefundAiJob(starter.id, first.job.id, "VERIFY_FAIL", "provider failed");
  let allowance = await getStarterAiImageAllowanceStatus(starter.id);
  assert.equal(allowance.remainingImages, 1, "failure restores exactly one image allowance");
  assert.equal(allowance.usedImages, 0);

  const replacement = await reserve(starter.id, "brand:replacement");
  assert.equal(replacement.ok, true);
  if (!replacement.ok) throw new Error("replacement reservation failed");
  await completeImageJob({ userId: starter.id, jobId: replacement.job.id, outputUrl: "/generated/replacement.webp" });
  await completeImageJob({ userId: starter.id, jobId: replacement.job.id, outputUrl: "/generated/replacement.webp" });
  allowance = await getStarterAiImageAllowanceStatus(starter.id);
  assert.equal(allowance.usedImages, 1, "completion settles allowance exactly once");
  assert.equal(allowance.reservedImages, 7);
  assert.equal(allowance.remainingImages, 0);
  const postProcessRefund = await refundSettledVideoImageJob({
    userId: starter.id,
    jobId: replacement.job.id,
    reason: "verify_post_process",
  });
  assert.equal(postProcessRefund.refunded, true);
  assert.equal(postProcessRefund.refundedCredits, 0);
  await refundSettledVideoImageJob({ userId: starter.id, jobId: replacement.job.id, reason: "verify_replay" });
  allowance = await getStarterAiImageAllowanceStatus(starter.id);
  assert.equal(allowance.usedImages, 0, "post-processing failure restores a settled allowance once");
  assert.equal(allowance.remainingImages, 1);

  await prisma.user.update({
    where: { id: starter.id },
    data: { plan: "FREE", trialEndsAt: null },
  });
  const afterTrial = await getStarterAiImageAllowanceStatus(starter.id);
  assert.equal(afterTrial.windowStartedAt.getTime(), allowance.windowStartedAt.getTime());
  assert.equal(afterTrial.remainingImages, 1, "trial expiry cannot grant another eight images");

  const paid = await prisma.user.create({
    data: { name: "Paid", email: "paid@example.test", plan: "PRO", subStatus: "active" },
  });
  await prisma.payment.create({
    data: {
      userId: paid.id,
      stripeSessionId: "verify-paid-session",
      plan: "PRO",
      amount: 9900,
      status: "PAID",
      paidAt: now,
    },
  });
  await prisma.creditBalance.create({ data: { userId: paid.id, granted: 4, purchased: 0 } });
  const paidReservation = await reserve(paid.id, "brand:paid");
  assert.equal(paidReservation.ok, true);
  if (!paidReservation.ok) throw new Error("paid reservation failed");
  assert.equal(paidReservation.fundingSource, "credits");
  assert.equal(paidReservation.balanceAfter, 2);
  assert.equal(await prisma.starterAiImageAllowance.count({ where: { userId: paid.id } }), 0);

  const manualBusiness = await prisma.user.create({
    data: {
      name: "Manual Business",
      email: "manual-business@example.test",
      plan: "BUSINESS",
      subStatus: null,
      trialStartedAt: null,
      trialEndsAt: null,
    },
  });
  await prisma.creditBalance.create({ data: { userId: manualBusiness.id, granted: 4, purchased: 0 } });
  const manualBusinessReservation = await reserve(manualBusiness.id, "brand:manual-business");
  assert.equal(manualBusinessReservation.ok, true);
  if (!manualBusinessReservation.ok) throw new Error("manual Business reservation failed");
  assert.equal(
    manualBusinessReservation.fundingSource,
    "credits",
    "an effective manual BUSINESS entitlement uses the shared credit wallet, never Starter allowance",
  );

  const creditPackOnly = await prisma.user.create({
    data: {
      name: "Credit pack only",
      email: "credit-pack-only@example.test",
      plan: "FREE",
      createdAt: new Date(now.getTime() - 2 * DAY_MS),
    },
  });
  await prisma.payment.create({
    data: {
      userId: creditPackOnly.id,
      stripeSessionId: "verify-credit-pack",
      plan: "PRO",
      amount: 9900,
      status: "PAID",
      periodDays: 0,
      paidAt: now,
    },
  });
  await prisma.creditBalance.create({ data: { userId: creditPackOnly.id, granted: 0, purchased: 10 } });
  const creditPackReservation = await reserve(creditPackOnly.id, "brand:credit-pack-only");
  assert.equal(creditPackReservation.ok, true);
  if (!creditPackReservation.ok) throw new Error("credit-pack reservation failed");
  assert.equal(
    creditPackReservation.fundingSource,
    "starter_allowance",
    "buying a credit pack is not a paid subscription and cannot forfeit activation allowance",
  );

  const delayedTrial = await prisma.user.create({
    data: {
      name: "Delayed trial",
      email: "delayed-trial@example.test",
      plan: "PRO",
      createdAt: new Date(now.getTime() - 35 * DAY_MS),
      trialStartedAt: new Date(now.getTime() - 5 * DAY_MS),
      trialEndsAt: new Date(now.getTime() + 2 * DAY_MS),
    },
  });
  const delayedStatus = await getStarterAiImageAllowanceStatus(delayedTrial.id, now);
  assert.equal(
    delayedStatus.windowStartedAt.getTime(),
    delayedTrial.createdAt.getTime() + 30 * DAY_MS,
    "the 30-day activation window stays anchored to signup rather than a later trial start",
  );

  const rollover = await prisma.user.create({
    data: {
      name: "Rollover",
      email: "rollover@example.test",
      plan: "FREE",
      createdAt: new Date(now.getTime() - 31 * DAY_MS),
      trialStartedAt: new Date(now.getTime() - 31 * DAY_MS),
    },
  });
  await prisma.starterAiImageAllowance.create({
    data: {
      userId: rollover.id,
      windowStartedAt: new Date(now.getTime() - 31 * DAY_MS),
      usedImages: 8,
    },
  });
  const rolled = await getStarterAiImageAllowanceStatus(rollover.id);
  assert.equal(rolled.usedImages, 0);
  assert.equal(rolled.remainingImages, 8, "the signup-anchored 30-day window resets once");

  const boundary = await prisma.user.create({
    data: {
      name: "Settled rollover refund",
      email: "settled-rollover-refund@example.test",
      plan: "FREE",
      createdAt: new Date(now.getTime() - 29 * DAY_MS),
    },
  });
  await prisma.creditBalance.create({ data: { userId: boundary.id, granted: 0, purchased: 0 } });
  const boundaryReservation = await reserve(boundary.id, "brand:rollover-refund");
  assert.equal(boundaryReservation.ok, true);
  if (!boundaryReservation.ok) throw new Error("boundary reservation failed");
  assert.ok(
    boundaryReservation.job.allowanceWindowStartedAt,
    "an allowance-backed job must pin the exact usage window it reserved",
  );
  await completeImageJob({
    userId: boundary.id,
    jobId: boundaryReservation.job.id,
    outputUrl: "/generated/boundary.webp",
  });
  const nextWindowStatus = await getStarterAiImageAllowanceStatus(
    boundary.id,
    new Date(now.getTime() + 2 * DAY_MS),
  );
  assert.equal(nextWindowStatus.usedImages, 0, "a later usage window starts independently");
  const boundaryRefund = await refundSettledVideoImageJob({
    userId: boundary.id,
    jobId: boundaryReservation.job.id,
    reason: "cross_window_post_process",
  });
  assert.equal(boundaryRefund.refunded, true);
  const allowanceWindows = await prisma.starterAiImageAllowance.findMany({
    where: { userId: boundary.id },
    orderBy: { windowStartedAt: "asc" },
  });
  assert.equal(allowanceWindows.length, 2, "old settlement history survives a window rollover");
  assert.equal(allowanceWindows[0].usedImages, 0, "refund restores the exact old window");
  assert.equal(allowanceWindows[1].usedImages, 0, "refund never mutates the new window");

  await prisma.$disconnect();
  console.log("verify-starter-ai-image-allowance: PASS reserve + settle + refund + rollover");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

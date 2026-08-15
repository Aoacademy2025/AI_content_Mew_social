import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "grant-coupon-matrix-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { redeemGrantCoupon } = await import("../src/lib/grant-coupon-redemption");
  const now = new Date("2026-08-16T03:00:00.000Z");
  const day = 24 * 60 * 60 * 1_000;
  let sequence = 0;

  async function user(data: Record<string, unknown> = {}) {
    sequence += 1;
    return prisma.user.create({
      data: {
        id: `matrix-user-${sequence}`,
        name: `Matrix User ${sequence}`,
        email: `matrix-${sequence}@example.com`,
        plan: "FREE",
        ...data,
      },
    });
  }
  async function coupon(code: string, data: Record<string, unknown> = {}) {
    return prisma.coupon.create({
      data: {
        code,
        type: "GRANT",
        plan: "PRO",
        durationDays: 30,
        maxUses: 500,
        promoCredits: 50,
        promoCreditTtlDays: 30,
        expiresAt: new Date("2026-08-21T16:59:59.000Z"),
        ...data,
      },
    });
  }

  const trialCoupon = await coupon("MATRIX-TRIAL");
  const trial = await user({
    plan: "PRO",
    trialStartedAt: new Date(now.getTime() - day),
    trialEndsAt: new Date(now.getTime() + 6 * day),
    minutesUsed: 3,
    minutesLimit: 80,
  });
  const trialResult = await redeemGrantCoupon({ userId: trial.id, code: trialCoupon.code, now });
  assert.equal(trialResult.ok && trialResult.outcome, "ACTIVATED");
  assert.equal(trialResult.ok && trialResult.promoCredits, 0);
  const trialAfter = await prisma.user.findUniqueOrThrow({ where: { id: trial.id } });
  assert.equal(trialAfter.trialEndsAt, null);
  assert.equal(trialAfter.minutesUsed, 0);

  const expiredCoupon = await coupon("MATRIX-EXPIRED");
  const expired = await user({
    plan: "BUSINESS",
    planExpiresAt: new Date(now.getTime() - day),
    minutesUsed: 140,
    minutesLimit: 150,
  });
  const expiredResult = await redeemGrantCoupon({ userId: expired.id, code: expiredCoupon.code, now });
  assert.equal(expiredResult.ok && expiredResult.outcome, "ACTIVATED");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: expired.id } })).plan, "PRO");

  const bundleCoupon = await coupon("MATRIX-BUNDLE");
  const bundleEndsAt = new Date(now.getTime() + 15 * day);
  const bundle = await user({
    plan: "PRO",
    bundleStatus: "ACTIVE",
    bundleGrantId: "bundle-matrix",
    bundleAccessExpiresAt: bundleEndsAt,
    bundleAmountThb: 990,
    minutesUsed: 24,
    minutesLimit: 80,
  });
  const bundleResult = await redeemGrantCoupon({ userId: bundle.id, code: bundleCoupon.code, now });
  assert.equal(bundleResult.ok && bundleResult.outcome, "SCHEDULED");
  assert.equal(bundleResult.ok && bundleResult.entitlementStartsAt.getTime(), bundleEndsAt.getTime());
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: bundle.id } })).minutesUsed, 24);

  const adminCoupon = await coupon("MATRIX-ADMIN");
  const adminEndsAt = new Date(now.getTime() + 12 * day);
  const admin = await user({ plan: "BUSINESS", minutesUsed: 33, minutesLimit: 150 });
  await prisma.administratorGrant.create({
    data: {
      userId: admin.id,
      plan: "BUSINESS",
      reason: "matrix timed grant",
      startsAt: new Date(now.getTime() - day),
      expiresAt: adminEndsAt,
      grantedById: "admin-matrix",
    },
  });
  const adminResult = await redeemGrantCoupon({ userId: admin.id, code: adminCoupon.code, now });
  assert.equal(adminResult.ok && adminResult.outcome, "SCHEDULED");
  assert.equal(adminResult.ok && adminResult.entitlementStartsAt.getTime(), adminEndsAt.getTime());

  const permanentCoupon = await coupon("MATRIX-PERMANENT");
  const permanent = await user({ plan: "BUSINESS", minutesUsed: 44, minutesLimit: 150 });
  await prisma.administratorGrant.create({
    data: {
      userId: permanent.id,
      plan: "BUSINESS",
      reason: "matrix permanent grant",
      permanent: true,
      grantedById: "admin-matrix",
    },
  });
  const permanentResult = await redeemGrantCoupon({ userId: permanent.id, code: permanentCoupon.code, now });
  assert.equal(permanentResult.ok && permanentResult.outcome, "PROMO_ONLY");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: permanent.id } })).minutesUsed, 44);

  for (const [index, status] of ["active", "trialing", "past_due", "canceled"].entries()) {
    const stripeCoupon = await coupon(`MATRIX-STRIPE-${index}`);
    const stripe = await user({
      plan: index % 2 === 0 ? "PRO" : "BUSINESS",
      stripeSubscriptionId: `sub_matrix_${index}`,
      subStatus: status,
      planExpiresAt: new Date(now.getTime() + 9 * day),
      cancelAtPeriodEnd: status === "canceled",
      minutesUsed: 11 + index,
      minutesLimit: index % 2 === 0 ? 80 : 150,
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: stripe.id } });
    const result = await redeemGrantCoupon({ userId: stripe.id, code: stripeCoupon.code, now });
    assert.equal(result.ok && result.outcome, "PROMO_ONLY", `Stripe ${status} must be promo-only`);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: stripe.id } });
    assert.equal(after.plan, before.plan);
    assert.equal(after.planExpiresAt?.getTime(), before.planExpiresAt?.getTime());
    assert.equal(after.minutesUsed, before.minutesUsed);
  }

  const endedStripeCoupon = await coupon("MATRIX-STRIPE-ENDED");
  const endedStripe = await user({
    plan: "FREE",
    stripeSubscriptionId: "sub_matrix_ended",
    subStatus: "canceled",
    planExpiresAt: null,
    minutesUsed: 3,
    minutesLimit: 5,
  });
  const endedStripeResult = await redeemGrantCoupon({
    userId: endedStripe.id,
    code: endedStripeCoupon.code,
    now,
  });
  assert.equal(endedStripeResult.ok && endedStripeResult.outcome, "PROMO_ONLY");
  assert.equal(endedStripeResult.ok && endedStripeResult.effectivePlan, "FREE");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: endedStripe.id } })).plan, "FREE");

  const noBenefitCoupon = await coupon("MATRIX-NO-BENEFIT", { promoCredits: 0 });
  const noBenefitUser = await user({ plan: "PRO" });
  const noBenefit = await redeemGrantCoupon({ userId: noBenefitUser.id, code: noBenefitCoupon.code, now });
  assert.equal(!noBenefit.ok && noBenefit.code, "NO_BENEFIT");
  assert.equal((await prisma.coupon.findUniqueOrThrow({ where: { id: noBenefitCoupon.id } })).usedCount, 0);

  const disabledCoupon = await coupon("MATRIX-DISABLED", { isActive: false });
  const disabled = await redeemGrantCoupon({ userId: (await user()).id, code: disabledCoupon.code, now });
  assert.equal(!disabled.ok && disabled.code, "DISABLED");

  const boundaryCoupon = await coupon("MATRIX-BOUNDARY", { expiresAt: now });
  assert.equal((await redeemGrantCoupon({ userId: (await user()).id, code: boundaryCoupon.code, now })).ok, true);
  const afterBoundary = await redeemGrantCoupon({
    userId: (await user()).id,
    code: boundaryCoupon.code,
    now: new Date(now.getTime() + 1),
  });
  assert.equal(!afterBoundary.ok && afterBoundary.code, "EXPIRED");

  const cappedCoupon = await coupon("MATRIX-CAP", { maxUses: 1 });
  assert.equal((await redeemGrantCoupon({ userId: (await user()).id, code: cappedCoupon.code, now })).ok, true);
  const capped = await redeemGrantCoupon({ userId: (await user()).id, code: cappedCoupon.code, now });
  assert.equal(!capped.ok && capped.code, "FULL");
  assert.equal((await prisma.coupon.findUniqueOrThrow({ where: { id: cappedCoupon.id } })).usedCount, 1);

  const raceCoupon = await coupon("MATRIX-RACE", { maxUses: 1 });
  const [raceUserA, raceUserB] = await Promise.all([user(), user()]);
  const raced = await Promise.allSettled([
    redeemGrantCoupon({ userId: raceUserA.id, code: raceCoupon.code, now }),
    redeemGrantCoupon({ userId: raceUserB.id, code: raceCoupon.code, now }),
  ]);
  assert.equal(raced.filter((entry) => entry.status === "fulfilled" && entry.value.ok).length, 1);
  assert.equal(
    raced.filter((entry) => entry.status === "fulfilled" && !entry.value.ok && entry.value.code === "FULL").length,
    1,
  );
  assert.equal((await prisma.coupon.findUniqueOrThrow({ where: { id: raceCoupon.id } })).usedCount, 1);
  assert.equal(await prisma.couponRedemption.count({ where: { couponId: raceCoupon.id } }), 1);

  const annualCoupon = await coupon("MEWSOCIAL2026X-MATRIX", { promoCredits: 0 });
  const clipCoupon = await coupon("CLIP0819-MATRIX");
  const annualStudent = await user();
  assert.equal((await redeemGrantCoupon({ userId: annualStudent.id, code: annualCoupon.code, now })).ok, true);
  const crossCoupon = await redeemGrantCoupon({ userId: annualStudent.id, code: clipCoupon.code, now });
  assert.equal(crossCoupon.ok && crossCoupon.outcome, "SCHEDULED");
  const annualRepeat = await redeemGrantCoupon({ userId: annualStudent.id, code: annualCoupon.code, now });
  assert.equal(!annualRepeat.ok && annualRepeat.code, "ALREADY_REDEEMED");

  const vipCoupon = await coupon("MEWSOCIALVIP-MATRIX", { durationDays: 90, promoCredits: 0 });
  const vipStudent = await user();
  assert.equal((await redeemGrantCoupon({ userId: vipStudent.id, code: vipCoupon.code, now })).ok, true);
  const vipCross = await redeemGrantCoupon({ userId: vipStudent.id, code: clipCoupon.code, now });
  assert.equal(vipCross.ok && vipCross.outcome, "SCHEDULED");

  const atomicCoupon = await coupon("MATRIX-ATOMIC");
  const atomicUser = await user({
    plan: "PRO",
    stripeSubscriptionId: "sub_atomic",
    subStatus: "active",
    planExpiresAt: new Date(now.getTime() + 10 * day),
  });
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_matrix_promo BEFORE INSERT ON PromotionalCreditGrant WHEN NEW.userId = '${atomicUser.id}' BEGIN SELECT RAISE(ABORT, 'forced promo failure'); END`);
  await assert.rejects(() => redeemGrantCoupon({ userId: atomicUser.id, code: atomicCoupon.code, now }));
  assert.equal((await prisma.coupon.findUniqueOrThrow({ where: { id: atomicCoupon.id } })).usedCount, 0);
  assert.equal(await prisma.couponRedemption.count({ where: { couponId: atomicCoupon.id, userId: atomicUser.id } }), 0);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: atomicUser.id } })).plan, "PRO");
  await prisma.$executeRawUnsafe("DROP TRIGGER fail_matrix_promo");

  console.log("✅ grant coupon matrix passed");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

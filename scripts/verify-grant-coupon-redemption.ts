import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "grant-coupon-redemption-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

function equal<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
  console.log(`ok: ${message}`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { redeemGrantCoupon } = await import("../src/lib/grant-coupon-redemption");
  const { videoExpiryFor } = await import("../src/lib/plan-limits");
  const now = new Date("2026-08-16T03:00:00.000Z");

  await prisma.coupon.create({
    data: {
      id: "coupon-live0819",
      code: "CLIP0819",
      type: "GRANT",
      plan: "PRO",
      durationDays: 30,
      maxUses: 500,
      promoCredits: 50,
      promoCreditTtlDays: 30,
      expiresAt: new Date("2026-08-21T16:59:59.000Z"),
    },
  });
  await prisma.user.create({
    data: {
      id: "fresh-user",
      name: "Fresh User",
      email: "fresh@example.com",
      plan: "FREE",
      usageCount: 4,
      usageLimit: 5,
      minutesUsed: 5,
      minutesLimit: 5,
    },
  });
  await prisma.video.create({
    data: {
      id: "fresh-user-existing-video",
      userId: "fresh-user",
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    },
  });

  const result = await redeemGrantCoupon({ userId: "fresh-user", code: "clip0819", now });
  equal(result.ok, true, "fresh account redemption succeeds");
  if (!result.ok) throw new Error(result.message);
  equal(result.outcome, "ACTIVATED", "fresh account activates immediately");
  equal(result.effectivePlan, "PRO", "fresh account receives PRO");
  equal(result.entitlementStartsAt.toISOString(), now.toISOString(), "entitlement starts now");
  equal(
    result.entitlementExpiresAt?.toISOString(),
    "2026-09-15T03:00:00.000Z",
    "entitlement ends exactly 30 days later",
  );
  equal(result.minutesLimit, 80, "PRO includes 80 render minutes");
  equal(result.monthlyCredits, 50, "PRO includes 50 monthly credits");
  equal(result.videosExtended, 1, "activation extends existing video retention atomically");

  const [user, coupon, redemption, balance] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: "fresh-user" } }),
    prisma.coupon.findUniqueOrThrow({ where: { id: "coupon-live0819" } }),
    prisma.couponRedemption.findUniqueOrThrow({
      where: { couponId_userId: { couponId: "coupon-live0819", userId: "fresh-user" } },
    }),
    prisma.creditBalance.findUniqueOrThrow({ where: { userId: "fresh-user" } }),
  ]);
  equal(user.plan, "PRO", "materialized plan is PRO");
  equal(user.minutesUsed, 0, "fresh activation resets used minutes");
  equal(user.minutesLimit, 80, "fresh activation stores 80-minute limit");
  equal(balance.granted, 50, "fresh activation stores monthly 50-credit grant");
  equal(
    (await prisma.video.findUniqueOrThrow({ where: { id: "fresh-user-existing-video" } })).expiresAt?.toISOString(),
    videoExpiryFor("PRO", now).toISOString(),
    "existing video receives PRO retention inside the redemption transaction",
  );
  equal(
    await prisma.promotionalCreditGrant.count({ where: { userId: "fresh-user" } }),
    0,
    "fresh activation does not double the advertised 50 credits",
  );
  equal(coupon.usedCount, 1, "successful redemption consumes one seat");
  equal(redemption.redeemedAt.toISOString(), now.toISOString(), "redemption uses injected clock");

  await prisma.user.create({
    data: {
      id: "stripe-user",
      name: "Stripe User",
      email: "stripe@example.com",
      plan: "BUSINESS",
      stripeSubscriptionId: "sub_live",
      subStatus: "past_due",
      cancelAtPeriodEnd: true,
      planExpiresAt: new Date("2026-08-25T03:00:00.000Z"),
      minutesUsed: 71,
      minutesLimit: 150,
    },
  });
  const stripeResult = await redeemGrantCoupon({ userId: "stripe-user", code: "CLIP0819", now });
  equal(stripeResult.ok, true, "Stripe member can redeem the campaign benefit");
  if (!stripeResult.ok) throw new Error(stripeResult.message);
  equal(stripeResult.outcome, "PROMO_ONLY", "Stripe member receives promo credits only");
  equal(stripeResult.promoCredits, 50, "Stripe member receives 50 promo credits");
  const stripeAfter = await prisma.user.findUniqueOrThrow({ where: { id: "stripe-user" } });
  equal(stripeAfter.plan, "BUSINESS", "Stripe plan remains unchanged");
  equal(stripeAfter.planExpiresAt?.toISOString(), "2026-08-25T03:00:00.000Z", "Stripe expiry remains unchanged");
  equal(stripeAfter.minutesUsed, 71, "Stripe meter is not reset");
  const stripePromo = await prisma.promotionalCreditGrant.findFirstOrThrow({ where: { userId: "stripe-user" } });
  equal(stripePromo.remainingAmount, 50, "Stripe promo balance is stored separately");
  equal(stripePromo.expiresAt.toISOString(), "2026-09-15T03:00:00.000Z", "promo credits expire after exactly 30 days");

  await prisma.user.create({
    data: {
      id: "timed-business",
      name: "Timed Business",
      email: "timed-business@example.com",
      plan: "BUSINESS",
      planExpiresAt: new Date("2026-08-26T03:00:00.000Z"),
      minutesUsed: 29,
      minutesLimit: 150,
    },
  });
  await prisma.payment.create({
    data: {
      userId: "timed-business",
      stripeSessionId: "manual_timed_business",
      plan: "BUSINESS",
      amount: 299000,
      status: "PAID",
      periodDays: 30,
      manual: true,
    },
  });
  const timedResult = await redeemGrantCoupon({ userId: "timed-business", code: "CLIP0819", now });
  equal(timedResult.ok, true, "active timed BUSINESS can redeem");
  if (!timedResult.ok) throw new Error(timedResult.message);
  equal(timedResult.outcome, "SCHEDULED", "coupon appends after active timed entitlement");
  equal(timedResult.entitlementStartsAt.toISOString(), "2026-08-26T03:00:00.000Z", "appended PRO starts after BUSINESS");
  equal(timedResult.entitlementExpiresAt?.toISOString(), "2026-09-25T03:00:00.000Z", "appended PRO lasts 30 days");
  const timedAfter = await prisma.user.findUniqueOrThrow({ where: { id: "timed-business" } });
  equal(timedAfter.plan, "BUSINESS", "BUSINESS remains active before appended PRO starts");
  equal(timedAfter.minutesUsed, 29, "timed entitlement meter is not reset mid-cycle");
  equal(timedResult.promoCredits, 50, "scheduled account receives campaign credits immediately");

  const transitionNow = new Date("2026-08-27T03:00:00.000Z");
  const { resolvePaidEquivalentEntitlement } =
    await import("../src/lib/paid-equivalent-entitlement.server");
  const { syncUserEntitlement } = await import("../src/lib/entitlements");
  const scheduledEntitlement = await resolvePaidEquivalentEntitlement("timed-business", transitionNow);
  equal(scheduledEntitlement.effectivePlan, "PRO", "appended PRO becomes effective after BUSINESS expires");
  equal(
    scheduledEntitlement.expiresAt?.toISOString(),
    "2026-09-25T03:00:00.000Z",
    "resolver uses the durable appended expiry, not redeemedAt plus duration",
  );
  await syncUserEntitlement("timed-business", transitionNow);
  const transitioned = await prisma.user.findUniqueOrThrow({ where: { id: "timed-business" } });
  equal(transitioned.plan, "PRO", "entitlement sync materializes the appended PRO tier");
  equal(transitioned.planExpiresAt?.toISOString(), "2026-09-25T03:00:00.000Z", "sync stores appended PRO expiry");
  equal(transitioned.minutesUsed, 0, "new appended term starts a fresh minute window");
  equal(transitioned.minutesLimit, 80, "new appended PRO term stores 80 minutes");
  const transitionedBalance = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: "timed-business" } });
  equal(transitionedBalance.granted, 50, "new appended PRO term starts its 50 monthly credits");
  equal(
    (await prisma.promotionalCreditGrant.findFirstOrThrow({ where: { userId: "timed-business" } })).remainingAmount,
    50,
    "term transition cannot wipe the still-active promo bucket",
  );
  equal(
    (await prisma.creditLedger.findFirstOrThrow({
      where: { userId: "timed-business", action: { startsWith: "coupon-term-activation:" } },
    })).balanceAfter,
    100,
    "term-transition ledger balance includes monthly and promotional credits",
  );

  const repeat = await redeemGrantCoupon({ userId: "timed-business", code: "CLIP0819", now });
  equal(repeat.ok, false, "the same account cannot redeem the same coupon twice");
  if (repeat.ok) throw new Error("repeat redemption unexpectedly succeeded");
  equal(repeat.code, "ALREADY_REDEEMED", "repeat returns the stable error code");
  equal(
    (await prisma.coupon.findUniqueOrThrow({ where: { id: "coupon-live0819" } })).usedCount,
    3,
    "failed repeat does not consume another campaign seat",
  );

  await prisma.$disconnect();
  console.log("\n✅ grant coupon tracer passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

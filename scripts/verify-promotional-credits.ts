import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "promotional-credits-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

function equal<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  console.log(`ok: ${message}`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    getBalance,
    parseCreditFunding,
    refundCredits,
    resetMonthlyGranted,
    serializeCreditFunding,
    spendCredits,
  } = await import("../src/lib/credits");
  const { refundReservation, reserveMinutesOrCredits } = await import("../src/lib/minute-credits");
  const { createReservedImageJob, failAndRefundAiJob } =
    await import("../src/lib/ai-generation-jobs.server");
  const now = new Date("2026-08-16T03:00:00.000Z");
  const day = 24 * 60 * 60 * 1_000;

  const user = await prisma.user.create({
    data: { id: "wallet-user", name: "Wallet User", email: "wallet@example.com", plan: "PRO" },
  });
  const coupons = await Promise.all(["early", "late"].map((suffix) =>
    prisma.coupon.create({
      data: { id: `promo-coupon-${suffix}`, code: `PROMO-WALLET-${suffix}`, type: "GRANT", plan: "PRO", maxUses: 10 },
    }),
  ));
  const redemptions = await Promise.all(coupons.map((coupon, index) =>
    prisma.couponRedemption.create({
      data: { id: `redemption-${index}`, couponId: coupon.id, userId: user.id },
    }),
  ));
  await prisma.creditBalance.create({
    data: { userId: user.id, granted: 5, purchased: 10, grantedResetAt: now },
  });
  await prisma.promotionalCreditGrant.createMany({
    data: [
      {
        id: "promo-early",
        userId: user.id,
        couponRedemptionId: redemptions[0].id,
        initialAmount: 4,
        remainingAmount: 4,
        expiresAt: new Date(now.getTime() + 2 * day),
      },
      {
        id: "promo-late",
        userId: user.id,
        couponRedemptionId: redemptions[1].id,
        initialAmount: 3,
        remainingAmount: 3,
        expiresAt: new Date(now.getTime() + 40 * day),
      },
    ],
  });

  const before = await getBalance(user.id, now);
  equal(before.granted, 5, "monthly bucket is reported separately");
  equal(before.promotional, 7, "active promo grants are summed separately");
  equal(before.purchased, 10, "purchased bucket remains separate");
  equal(before.total, 22, "wallet total includes all active buckets");

  const spend = await spendCredits(user.id, 8, "promo-order-test", now);
  equal(spend.ok, true, "spend succeeds across expiring buckets");
  if (!spend.ok) throw new Error("spend unexpectedly failed");
  equal(spend.fromPromotional, 4, "earliest promo grant is drained first");
  equal(spend.fromGranted, 4, "monthly grant is next because it expires before late promo");
  equal(spend.fromPurchased, 0, "purchased credits are preserved while expiring credits exist");
  equal(spend.promotionalDebits.length, 1, "spend records exact promo grant provenance");
  equal(spend.promotionalDebits[0]?.grantId, "promo-early", "funding snapshot names the exact promo grant");

  await refundCredits(
    user.id,
    spend.fromGranted,
    spend.fromPurchased,
    "promo-order-refund",
    spend.promotionalDebits,
    now,
  );
  const restored = await getBalance(user.id, now);
  equal(restored.granted, 5, "refund restores the monthly bucket exactly");
  equal(restored.promotional, 7, "refund restores the original promo grant exactly");
  equal(restored.purchased, 10, "refund does not inflate purchased credits");

  await resetMonthlyGranted(user.id, "PRO");
  const afterReset = await getBalance(user.id, now);
  equal(afterReset.granted, 50, "monthly reset refreshes only the monthly bucket");
  equal(afterReset.promotional, 7, "monthly reset cannot wipe promo credits");

  const afterExpiry = await getBalance(user.id, new Date(now.getTime() + 3 * day));
  equal(afterExpiry.promotional, 3, "expired promo grant is excluded while later promo remains");
  equal(
    (await prisma.promotionalCreditGrant.findUniqueOrThrow({ where: { id: "promo-early" } })).remainingAmount,
    0,
    "expiry is materialized for audit and cannot be spent later",
  );

  const imageUser = await prisma.user.create({
    data: { id: "image-wallet-user", name: "Image Wallet", email: "image-wallet@example.com", plan: "PRO" },
  });
  const imageCoupon = await prisma.coupon.create({
    data: { id: "image-promo-coupon", code: "IMAGE-PROMO", type: "GRANT", plan: "PRO" },
  });
  const imageRedemption = await prisma.couponRedemption.create({
    data: {
      id: "image-promo-redemption",
      couponId: imageCoupon.id,
      userId: imageUser.id,
      outcome: "PROMO_ONLY",
    },
  });
  await prisma.creditBalance.create({ data: { userId: imageUser.id, purchased: 10 } });
  await prisma.promotionalCreditGrant.create({
    data: {
      id: "image-promo-grant",
      userId: imageUser.id,
      couponRedemptionId: imageRedemption.id,
      initialAmount: 4,
      remainingAmount: 4,
      expiresAt: new Date(now.getTime() + 2 * day),
    },
  });
  const imageReservation = await createReservedImageJob({
    userId: imageUser.id,
    model: "test-image",
    inputPreview: "test",
    inputJson: "{}",
    creditCost: 2,
    quoteVersion: "test-v1",
    costBudgetUsdMicros: 1_000,
    provider: "test",
    providerModel: "test-image",
    providerRoute: "test",
    providerEndpoint: "test",
    estimatedCostUsdMicros: 1,
    idempotencyKey: "studio:promo-refund",
    mediaExpiresAt: new Date(now.getTime() + day),
    productSurface: "ai_studio",
  });
  equal(imageReservation.ok, true, "AI image reservation can spend promo credits");
  if (!imageReservation.ok) throw new Error("image reservation unexpectedly failed");
  equal(imageReservation.job.creditsFromPromotional, 2, "AI image persists promo funding amount");
  equal(
    (await prisma.promotionalCreditGrant.findUniqueOrThrow({ where: { id: "image-promo-grant" } })).remainingAmount,
    2,
    "AI image drains promo before purchased credits",
  );
  await failAndRefundAiJob(imageUser.id, imageReservation.job.id, "TEST_FAILURE", "test refund");
  equal(
    (await prisma.promotionalCreditGrant.findUniqueOrThrow({ where: { id: "image-promo-grant" } })).remainingAmount,
    4,
    "failed AI image restores the exact promo grant",
  );
  equal(
    (await prisma.creditBalance.findUniqueOrThrow({ where: { userId: imageUser.id } })).purchased,
    10,
    "failed AI image never inflates purchased credits",
  );

  const renderUser = await prisma.user.create({
    data: {
      id: "render-wallet-user",
      name: "Render Wallet",
      email: "render-wallet@example.com",
      plan: "PRO",
      stripeSubscriptionId: "sub_render",
      subStatus: "active",
      planExpiresAt: new Date(now.getTime() + 20 * day),
      minutesUsed: 80,
      minutesLimit: 80,
      usagePeriodStartedAt: now,
    },
  });
  await prisma.payment.create({
    data: {
      userId: renderUser.id,
      stripeSessionId: "render-payment",
      plan: "PRO",
      amount: 99000,
      status: "PAID",
      periodDays: 30,
      paidAt: now,
    },
  });
  const renderCoupon = await prisma.coupon.create({
    data: { id: "render-promo-coupon", code: "RENDER-PROMO", type: "GRANT", plan: "PRO" },
  });
  const renderRedemption = await prisma.couponRedemption.create({
    data: {
      id: "render-promo-redemption",
      couponId: renderCoupon.id,
      userId: renderUser.id,
      outcome: "PROMO_ONLY",
    },
  });
  await prisma.creditBalance.create({ data: { userId: renderUser.id, purchased: 10 } });
  await prisma.promotionalCreditGrant.create({
    data: {
      id: "render-promo-grant",
      userId: renderUser.id,
      couponRedemptionId: renderRedemption.id,
      initialAmount: 4,
      remainingAmount: 4,
      expiresAt: new Date(now.getTime() + 2 * day),
    },
  });
  const renderReservation = await reserveMinutesOrCredits(
    renderUser.id,
    1,
    { creditsLive: true, ref: "promo-render" },
  );
  equal(renderReservation.allowed, true, "overflow render can spend promo credits");
  if (!renderReservation.allowed || renderReservation.via === "minutes") {
    throw new Error("render did not reserve credit funding");
  }
  equal(renderReservation.fromPromotional, 2, "overflow render drains promo before purchased");
  await refundReservation(
    renderUser.id,
    {
      reservedMinutes: renderReservation.reservedMinutes,
      creditsSpent: renderReservation.creditsSpent,
      creditsFromGranted: renderReservation.fromGranted,
      creditsFromPromotional: renderReservation.fromPromotional,
      creditFundingJson: serializeCreditFunding(renderReservation),
    },
    "promo-render-refund",
  );
  equal(
    (await prisma.promotionalCreditGrant.findUniqueOrThrow({ where: { id: "render-promo-grant" } })).remainingAmount,
    4,
    "failed render restores the exact promo grant",
  );
  equal(
    (await prisma.creditBalance.findUniqueOrThrow({ where: { userId: renderUser.id } })).purchased,
    10,
    "failed render preserves purchased credits",
  );

  let corruptPromoFundingRejected = false;
  try {
    parseCreditFunding("{broken", {
      fromGranted: 0,
      fromPromotional: 2,
      fromPurchased: 0,
    }, 2);
  } catch {
    corruptPromoFundingRejected = true;
  }
  equal(
    corruptPromoFundingRejected,
    true,
    "missing promo provenance fails closed instead of inflating purchased credits",
  );

  await prisma.$disconnect();
  console.log("\n✅ promotional credit lifecycle passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "first-clip-convert-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getFirstClipConvertPrompt, dismissFirstClipConvertPrompt } =
    await import("../src/lib/first-clip-convert.server");
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 86_400_000);
  const DAY_MS = 86_400_000;

  await prisma.coupon.create({
    data: {
      code: "FOUNDING100",
      type: "DISCOUNT",
      plan: "PRO",
      percentOff: 50,
      isActive: true,
      maxUses: 100,
      usedCount: 12,
      stripePromotionCodeId: "promo_founding",
    },
  });

  const grant = await prisma.user.create({
    data: {
      id: "grant-user",
      name: "Grant",
      email: "grant@example.invalid",
      plan: "PRO",
      planExpiresAt: future,
    },
  });
  const noClip = await getFirstClipConvertPrompt(grant.id, now);
  assert.equal(noClip.show, false);
  if (!noClip.show) assert.equal(noClip.reason, "no_completed_video");

  await prisma.video.create({
    data: {
      userId: grant.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/grant.mp4",
    },
  });
  const grantShown = await getFirstClipConvertPrompt(grant.id, now);
  assert.equal(grantShown.show, true);
  if (grantShown.show) {
    assert.equal(grantShown.monthlyPriceThb, 599);
    assert.equal(grantShown.founding?.annualPriceThb, 2995);
    assert.equal(grantShown.annualListThb, 5990);
    assert.equal(grantShown.founding?.annualMonthlyThb, 250, "Founding is quoted per month");
    assert.equal(grantShown.founding?.total, 100, "the seat counter carries the total");
    assert.deepEqual(
      grantShown.benefits,
      { storageDays: 7, minutesPerMonth: 80, monthlyCredits: 50 },
      "benefits are read from plan-limits/credits",
    );
  }

  // ── "ไว้ทีหลัง" is durable, with a 30-day cooldown (issue #303) ─────────────
  await dismissFirstClipConvertPrompt(grant.id, now);
  const afterDismiss = await getFirstClipConvertPrompt(grant.id, now);
  assert.equal(afterDismiss.show, false, "a dismissal silences the prompt immediately");
  if (!afterDismiss.show) assert.equal(afterDismiss.reason, "dismissed_cooldown");

  const insideCooldown = await getFirstClipConvertPrompt(grant.id, new Date(now.getTime() + 29 * DAY_MS));
  assert.equal(insideCooldown.show, false, "day 29 is still inside the cooldown");

  const afterCooldown = await getFirstClipConvertPrompt(grant.id, new Date(now.getTime() + 31 * DAY_MS));
  assert.equal(afterCooldown.show, true, "day 31 may ask once more");

  // Reset so the rest of this script reasons about a never-dismissed user.
  await prisma.user.update({ where: { id: grant.id }, data: { firstClipConvertDismissedAt: null } });

  const payer = await prisma.user.create({
    data: {
      id: "payer-user",
      name: "Payer",
      email: "payer@example.invalid",
      plan: "PRO",
      subStatus: "active",
      stripeSubscriptionId: "sub_payer",
      billingPeriod: "monthly",
      planExpiresAt: future,
    },
  });
  await prisma.payment.create({
    data: {
      userId: payer.id,
      stripeSessionId: "cs_payer",
      plan: "PRO",
      amount: 59900,
      status: "PAID",
      periodDays: 30,
      paidAt: now,
    },
  });
  await prisma.video.create({
    data: {
      userId: payer.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/payer.mp4",
    },
  });
  const payerHidden = await getFirstClipConvertPrompt(payer.id, now);
  assert.equal(payerHidden.show, false);
  if (!payerHidden.show) assert.equal(payerHidden.reason, "recurring_payer");

  const admin = await prisma.user.create({
    data: {
      id: "admin-user",
      name: "Admin",
      email: "qa@aoacademy.co",
      role: "ADMIN",
      plan: "PRO",
    },
  });
  await prisma.video.create({
    data: {
      userId: admin.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/admin.mp4",
    },
  });
  const adminHidden = await getFirstClipConvertPrompt(admin.id, now);
  assert.equal(adminHidden.show, false);
  if (!adminHidden.show) assert.equal(adminHidden.reason, "internal");

  // ── Paid-equivalent cohorts have nothing to buy here ───────────────────────
  // One-time / PromptPay annual: a PAID term with no Stripe subscription. The
  // recurring-payer rule alone would let this customer through.
  const oneTime = await prisma.user.create({
    data: {
      id: "one-time-user",
      name: "PromptPay",
      email: "promptpay@example.invalid",
      plan: "PRO",
      planExpiresAt: future,
    },
  });
  await prisma.payment.create({
    data: {
      userId: oneTime.id,
      stripeSessionId: "cs_one_time",
      plan: "PRO",
      amount: 299500,
      status: "PAID",
      periodDays: 365,
      paidAt: now,
    },
  });
  await prisma.video.create({
    data: {
      userId: oneTime.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/one-time.mp4",
    },
  });
  const oneTimeHidden = await getFirstClipConvertPrompt(oneTime.id, now);
  assert.equal(oneTimeHidden.show, false, "a one-time/PromptPay annual payer is never asked");
  if (!oneTimeHidden.show) assert.equal(oneTimeHidden.reason, "paid_equivalent");

  // Bundle: paid access that never touches Studio's own Stripe subscription.
  const bundle = await prisma.user.create({
    data: {
      id: "bundle-user",
      name: "Bundle",
      email: "bundle@example.invalid",
      plan: "PRO",
      bundleGrantId: "grant_bundle",
      bundleStatus: "ACTIVE",
      bundleAccessExpiresAt: future,
      bundleAmountThb: 1990,
    },
  });
  await prisma.video.create({
    data: {
      userId: bundle.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/bundle.mp4",
    },
  });
  const bundleHidden = await getFirstClipConvertPrompt(bundle.id, now);
  assert.equal(bundleHidden.show, false, "a Bundle customer is never asked");
  if (!bundleHidden.show) assert.equal(bundleHidden.reason, "paid_equivalent");

  // GRANT coupon: non-cash, but still PRO access for the duration.
  const couponUser = await prisma.user.create({
    data: {
      id: "coupon-user",
      name: "Coupon",
      email: "coupon@example.invalid",
      plan: "PRO",
    },
  });
  const grantCoupon = await prisma.coupon.create({
    data: {
      code: "GRANTPRO90",
      type: "GRANT",
      plan: "PRO",
      durationDays: 90,
      isActive: true,
      maxUses: 100,
    },
  });
  await prisma.couponRedemption.create({
    data: {
      userId: couponUser.id,
      couponId: grantCoupon.id,
      redeemedAt: new Date(now.getTime() - DAY_MS),
    },
  });
  await prisma.video.create({
    data: {
      userId: couponUser.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/coupon.mp4",
    },
  });
  const couponHidden = await getFirstClipConvertPrompt(couponUser.id, now);
  assert.equal(couponHidden.show, false, "a GRANT-coupon customer is never asked");
  if (!couponHidden.show) assert.equal(couponHidden.reason, "paid_equivalent");

  await prisma.$disconnect();
  console.log("verify-first-clip-convert-server: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

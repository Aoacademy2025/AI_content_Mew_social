// Integration proof for workshop/student GRANT coupons:
// redeeming an active coupon grants the paid-tier plan + immediate monthly
// credits, and the same active coupon unlocks Hero Script without cash payment.
// Runs against a throwaway SQLite DB and never touches prisma/dev.db.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "coupon-pro-entitlements-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
process.env.HERO_SCRIPT_ALLOWED_EMAILS = "";
process.env.HERO_SCRIPT_PAID_ENABLED = "1";
process.env.HERO_SCRIPT_PUBLIC_PREVIEW = "1";
process.env.HERO_SCRIPT_TRIAL_PERCENT = "0";
process.env.HERO_SCRIPT_FREE_PERCENT = "0";
process.env.HERO_AI_IMAGE_PUBLIC = "1";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`ok: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getBalance, grantCredits, resetMonthlyGranted, MONTHLY_GRANT } =
    await import("../src/lib/credits");
  const { activateGrantCouponEntitlement } =
    await import("../src/lib/grant-coupon-entitlement");
  const { resolveHeroScriptAccess } =
    await import("../src/lib/hero-script-rollout.server");
  const { isHeroAiImageEligible } = await import("../src/lib/internal-ai-access");
  const { resolvePaidEquivalentEntitlement } = await import("../src/lib/paid-equivalent-entitlement.server");
  const { getStarterAiImageAllowanceStatus } = await import("../src/lib/starter-ai-image-allowance.server");

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + 30 * dayMs);

  const coupon = await prisma.coupon.create({
    data: {
      id: "coupon-workshop-30",
      code: "WORKSHOP-TEST-30",
      type: "GRANT",
      plan: "PRO",
      durationDays: 30,
      maxUses: 100,
    },
  });
  const student = await prisma.user.create({
    data: {
      id: "coupon-student",
      name: "Coupon Student",
      email: "coupon-student@example.com",
      plan: "FREE",
      trialStartedAt: new Date(now.getTime() - 10 * dayMs),
      trialEndsAt: new Date(now.getTime() - 3 * dayMs),
      usageCount: 9,
      usageLimit: 10,
      minutesUsed: 4,
      minutesLimit: 5,
    },
  });

  // Reproduce the edge that lazy ensureMonthlyGrant cannot heal: a recent
  // FREE reset stamps grantedResetAt inside the 30-day window.
  await resetMonthlyGranted(student.id, "FREE");
  await grantCredits(student.id, 7, "purchase", "coupon-test-purchased");

  await activateGrantCouponEntitlement({
    userId: student.id,
    couponId: coupon.id,
    plan: coupon.plan,
    planExpiresAt: expiresAt,
    activatedAt: now,
  });

  const activated = await prisma.user.findUnique({ where: { id: student.id } });
  check(activated?.plan === "PRO", "GRANT coupon activates the PRO plan");
  check(activated?.planExpiresAt?.getTime() === expiresAt.getTime(),
    "GRANT coupon keeps its exact timed expiry");
  check(activated?.trialEndsAt === null, "GRANT coupon supersedes an old trial marker");
  check(activated?.usageCount === 0 && activated.minutesUsed === 0,
    "GRANT coupon starts fresh clip and minute usage windows");

  const redemptionCount = await prisma.couponRedemption.count({
    where: { userId: student.id, couponId: coupon.id },
  });
  check(redemptionCount === 1, "GRANT coupon redemption is recorded once");

  const balance = await getBalance(student.id);
  check(balance.granted === MONTHLY_GRANT.PRO,
    `coupon activation immediately grants ${MONTHLY_GRANT.PRO} PRO credits`);
  check(balance.purchased === 7,
    "coupon activation preserves purchased credits while resetting granted credits");

  const couponAccess = await resolveHeroScriptAccess(activated!);
  check(couponAccess.canUse && couponAccess.cohort === "coupon",
    "active GRANT coupon unlocks Hero Script without a cash Payment row");
  check(isHeroAiImageEligible(activated, {
    paidEquivalent: await resolvePaidEquivalentEntitlement(student.id),
    trialAllowance: await getStarterAiImageAllowanceStatus(student.id),
  }),
    "active GRANT coupon PRO remains eligible for public Hero AI Image");

  process.env.HERO_SCRIPT_PAID_ENABLED = "0";
  const rolloutOff = await resolveHeroScriptAccess(activated!);
  check(!rolloutOff.canUse && rolloutOff.canPreview,
    "GRANT coupon still obeys the paid rollout kill switch");
  process.env.HERO_SCRIPT_PAID_ENABLED = "1";

  // A historical coupon must not become a permanent backdoor after its own
  // grant window has expired, even if the user later receives manual PRO time.
  const staleCoupon = await prisma.coupon.create({
    data: {
      id: "coupon-stale-30",
      code: "STALE-TEST-30",
      type: "GRANT",
      plan: "PRO",
      durationDays: 30,
      maxUses: 100,
    },
  });
  const manualPro = await prisma.user.create({
    data: {
      id: "manual-pro-after-coupon",
      name: "Manual PRO",
      email: "manual-pro-after-coupon@example.com",
      plan: "PRO",
      planExpiresAt: new Date(now.getTime() + 10 * dayMs),
    },
  });
  await prisma.couponRedemption.create({
    data: {
      userId: manualPro.id,
      couponId: staleCoupon.id,
      redeemedAt: new Date(now.getTime() - 31 * dayMs),
    },
  });
  const staleAccess = await resolveHeroScriptAccess(manualPro);
  check(!staleAccess.canUse && staleAccess.cohort === "preview",
    "expired GRANT redemption cannot unlock a later manual PRO entitlement");

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

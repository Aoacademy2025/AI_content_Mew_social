import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hero-script-access-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { decideHeroScriptAccess, resolveHeroScriptAccess } = await import("../src/lib/hero-script-rollout.server");
  const off = { paidEnabled: false, publicPreview: false, trialPercent: 0, freePercent: 0 };
  const free = {
    canUsePaidFeatures: false, effectivePlan: "FREE" as const, source: "none" as const,
    reason: "no_qualifying_evidence" as const, expiresAt: null, cashBacked: false, recurring: false,
  };
  const paid = {
    canUsePaidFeatures: true, effectivePlan: "PRO" as const, source: "subscription" as const,
    reason: "eligible" as const, expiresAt: new Date(Date.now() + 86_400_000), cashBacked: true, recurring: true,
  };
  const coupon = { ...paid, source: "grant_coupon" as const, cashBacked: false, recurring: false };
  assert.equal(decideHeroScriptAccess({ internal: true, paidEquivalent: free, flags: off }).canUse, true);
  assert.equal(decideHeroScriptAccess({ internal: false, paidEquivalent: free, flags: { ...off, paidEnabled: true, publicPreview: true, trialPercent: 100, freePercent: 100 } }).cohort, "preview");
  assert.equal(decideHeroScriptAccess({ internal: false, paidEquivalent: paid, flags: { ...off, paidEnabled: true } }).cohort, "paid");
  assert.equal(decideHeroScriptAccess({ internal: false, paidEquivalent: coupon, flags: { ...off, paidEnabled: true } }).cohort, "coupon");

  process.env.HERO_SCRIPT_PAID_ENABLED = "1";
  process.env.HERO_SCRIPT_PUBLIC_PREVIEW = "1";
  process.env.HERO_SCRIPT_ALLOWED_EMAILS = "";
  const user = await prisma.user.create({ data: {
    name: "Paid", email: "hero-script-paid@example.invalid", plan: "PRO", subStatus: "active",
    stripeSubscriptionId: "sub_hero_script", planExpiresAt: new Date(Date.now() + 30 * 86_400_000),
  } });
  assert.equal((await resolveHeroScriptAccess(user)).canUse, false, "raw subscription state without Payment fails closed");
  await prisma.payment.create({ data: {
    userId: user.id, stripeSessionId: "cs_hero_script", plan: "PRO", amount: 9900,
    status: "PAID", periodDays: 30, paidAt: new Date(),
  } });
  assert.equal((await resolveHeroScriptAccess(user)).canUse, true, "PAID evidence opens full generation");
  await prisma.$disconnect();
  console.log("verify-hero-script-access: PASS paid-equivalent only; FREE/Trial preview only");
}

main().catch((error) => { console.error(error); process.exit(1); });

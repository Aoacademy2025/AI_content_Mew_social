// Proof of the markUserPaid contract: converting a trial / off-Stripe customer to a
// real paid TIMED plan must (a) set a future expiry from the payment date, (b) CLEAR the
// trial flag so the entitlement classifier stops auto-reverting them to FREE, and (c) keep
// trialStartedAt (one-trial-per-user guard). Run against a throwaway SQLite DB:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-paid-term.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-paid-term.db?connection_limit=1" npx tsx scripts/verify-paid-term.ts
import { prisma } from "../src/lib/prisma";
import { markUserPaid } from "../src/lib/paid-term";
import { classifyEntitlement } from "../src/lib/entitlements";
import { PRO_LIMITS } from "../src/lib/plan-limits";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const DAY_MS = 24 * 60 * 60 * 1000;

async function reload(id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw new Error("user vanished");
  return u;
}

async function main() {
  await prisma.user.deleteMany();
  const now = new Date();

  // --- Reproduce the Taonon state: trial-PRO whose trial is about to lapse, paid off-Stripe. ---
  const trialEndsSoon = new Date(now.getTime() + 6 * DAY_MS);
  const taonon = await prisma.user.create({
    data: {
      name: "taonon", email: "taonon@t.test", plan: "PRO",
      planExpiresAt: trialEndsSoon, trialStartedAt: now, trialEndsAt: trialEndsSoon,
      subStatus: null,
    },
  });

  // Before the fix: classifier sees an active (but unconverted) trial — it would DOWNGRADE the
  // moment trialEndsAt passes. Prove that the lapse-time decision is DOWNGRADE.
  const preLapse = classifyEntitlement(await reload(taonon.id), new Date(trialEndsSoon.getTime() + 1000));
  assert(preLapse.action === "DOWNGRADE" && preLapse.effectivePlan === "FREE",
    "BEFORE fix: an unconverted trial-PRO auto-DOWNGRADES to FREE at trialEndsAt");

  // Apply the fix — paid annual, term measured from the payment date (3 days ago).
  const paymentDate = new Date(now.getTime() - 3 * DAY_MS);
  const { planExpiresAt } = await markUserPaid(taonon.id, { plan: "PRO", periodDays: 365, from: paymentDate, billingPeriod: "annual" });

  const fixed = await reload(taonon.id);
  assert(fixed.plan === "PRO", "AFTER fix: plan is PRO");
  assert(fixed.trialEndsAt === null, "AFTER fix: trialEndsAt CLEARED (no longer an unconverted trial)");
  assert(fixed.trialStartedAt !== null, "AFTER fix: trialStartedAt KEPT (one-trial-per-user guard intact)");
  assert(fixed.subStatus === null, "AFTER fix: subStatus untouched (off-Stripe, manual renewal)");
  const expectedExpiry = paymentDate.getTime() + 365 * DAY_MS;
  assert(Math.abs(planExpiresAt.getTime() - expectedExpiry) < 1000, "AFTER fix: expiry = paymentDate + 365d");
  assert(fixed.usageLimit === PRO_LIMITS.clips, "AFTER fix: usage window reset to PRO clip limit");
  assert(fixed.usageCount === 0, "AFTER fix: usageCount reset to 0");

  // The decisive check: a year from now (well past the old trialEndsAt) the classifier KEEPS him.
  const farFuture = new Date(now.getTime() + 60 * DAY_MS);
  const post = classifyEntitlement(fixed, farFuture);
  assert(post.action === "KEEP" && post.effectivePlan === "PRO" && post.source === "TIMED_PLAN",
    "AFTER fix: classifier KEEPS PRO as a TIMED_PLAN past the old trial date (no auto-revert)");

  // And once the paid term truly ends, it correctly lapses to FREE.
  const afterTerm = new Date(planExpiresAt.getTime() + 1000);
  const lapsed = classifyEntitlement(fixed, afterTerm);
  assert(lapsed.action === "DOWNGRADE" && lapsed.effectivePlan === "FREE",
    "AFTER term: paid TIMED_PLAN correctly lapses to FREE at planExpiresAt");

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} PAID-TERM CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

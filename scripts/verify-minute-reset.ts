// Proof that plan transitions reset the MINUTE window, not just the clip window.
// Regression guard for the bug where a trial→FREE downgrade left `minutesUsed` stranded above the
// new FREE limit → 0 render minutes for 30 days once MINUTE_QUOTA is on. Run against throwaway DB:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-min-reset.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-min-reset.db?connection_limit=1" npx tsx scripts/verify-minute-reset.ts
import { prisma } from "../src/lib/prisma";
import { usageWindowForPlan } from "../src/lib/usage-limits";
import { syncUserEntitlement } from "../src/lib/entitlements";
import { minutesPerMonthForPlan } from "../src/lib/plan-limits";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }
const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  // 1) The window helper itself resets BOTH counters.
  const w = usageWindowForPlan("FREE") as Record<string, unknown>;
  assert(w.minutesUsed === 0, "usageWindowForPlan resets minutesUsed → 0");
  assert(w.minutesLimit === minutesPerMonthForPlan("FREE"), "usageWindowForPlan sets minutesLimit to plan value (FREE=5)");
  assert(w.usageCount === 0, "usageWindowForPlan still resets clip usageCount → 0");

  // 2) End-to-end: a trial-PRO user who burned all 15 trial minutes, trial now expired.
  await prisma.user.deleteMany();
  const now = new Date();
  const u = await prisma.user.create({
    data: {
      name: "min", email: "min@t.test", plan: "PRO",
      planExpiresAt: new Date(now.getTime() - 1000), trialEndsAt: new Date(now.getTime() - 1000),
      trialStartedAt: new Date(now.getTime() - 8 * DAY_MS), subStatus: null,
      minutesUsed: 15, minutesLimit: 15, usagePeriodStartedAt: new Date(now.getTime() - 8 * DAY_MS),
    },
  });

  // syncUserEntitlement should DOWNGRADE to FREE and reset the minute window in the same write.
  await syncUserEntitlement(u.id, now);
  const after = await prisma.user.findUnique({ where: { id: u.id } });
  assert(after!.plan === "FREE", "expired trial downgraded to FREE");
  assert(after!.minutesUsed === 0, "downgrade RESET minutesUsed → 0 (was 15) — FREE user is NOT locked out");
  assert(after!.minutesLimit === minutesPerMonthForPlan("FREE"), "downgrade set minutesLimit to FREE allowance (5)");
  // The decisive outcome: a freshly-downgraded FREE user actually has render minutes available.
  assert(after!.minutesLimit - after!.minutesUsed === 5, "FREE user has 5 render minutes available after downgrade (bug would give 0)");

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MINUTE-RESET CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

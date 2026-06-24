// verify-trial-cap.ts — Task P2-2: capped reverse-trial via the minute meter.
// Proves that active-trial PRO users gate at TRIAL_MINUTES (15) not the full 80-min plan limit.
// Run against a throwaway SQLite DB:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-trial-cap.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-trial-cap.db?connection_limit=1" npx tsx scripts/verify-trial-cap.ts
import { prisma } from "../src/lib/prisma";
import { checkMinuteQuota, reserveMinutes } from "../src/lib/minute-limits";
import { TRIAL_MINUTES } from "../src/lib/trial";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  await prisma.user.deleteMany();

  const now = new Date();
  const future = new Date(now.getTime() + 3 * DAY_MS);
  const past = new Date(now.getTime() - 1 * DAY_MS);

  // ── (a) PRO user with active trial (trialEndsAt = now + 3 days) ───────────
  // Effective limit should be TRIAL_MINUTES (15), not 80.
  const uTrial = await prisma.user.create({
    data: {
      name: "trial-pro",
      email: "trial-pro@t.test",
      plan: "PRO",
      minutesUsed: 0,
      minutesLimit: 80,       // stale DB value — syncMinuteWindow must override it
      usagePeriodStartedAt: now,
      trialEndsAt: future,
    },
  });

  // checkMinuteQuota should see 15 remaining (trial cap)
  const check_a = await checkMinuteQuota(uTrial.id);
  assert(check_a.allowed === true, "(a) active-trial PRO: checkMinuteQuota allowed");
  assert(check_a.remaining === TRIAL_MINUTES, `(a) active-trial PRO: remaining = ${TRIAL_MINUTES} (capped)`);

  // Verify the DB minutesLimit was updated to TRIAL_MINUTES
  const row_a = await prisma.user.findUnique({ where: { id: uTrial.id } });
  assert(row_a!.minutesLimit === TRIAL_MINUTES, `(a) DB minutesLimit updated to ${TRIAL_MINUTES}`);

  // Reserve 14 minutes — allowed
  const r_a1 = await reserveMinutes(uTrial.id, 14);
  assert(r_a1.allowed === true, "(a) reserve(14) within trial cap → allowed");
  assert(r_a1.remaining === 1, "(a) after reserve(14): remaining = 1");

  // Reserve 2 more: 14 + 2 = 16 > 15 → blocked
  const r_a2 = await reserveMinutes(uTrial.id, 2);
  assert(r_a2.allowed === false, "(a) reserve(2) when 1 left → blocked (trial cap enforced)");

  // ── (b) PRO user with NO trial (trialEndsAt = null) ──────────────────────
  // Effective limit should be full PRO = 80.
  const uNoTrial = await prisma.user.create({
    data: {
      name: "pro-no-trial",
      email: "pro-notrial@t.test",
      plan: "PRO",
      minutesUsed: 0,
      minutesLimit: 80,
      usagePeriodStartedAt: now,
      trialEndsAt: null,
    },
  });

  const check_b = await checkMinuteQuota(uNoTrial.id);
  assert(check_b.allowed === true, "(b) PRO no-trial: checkMinuteQuota allowed");
  assert(check_b.remaining === 80, "(b) PRO no-trial: remaining = 80 (full plan limit)");

  // ── (c) PRO user with EXPIRED trial (trialEndsAt = past) ─────────────────
  // syncUserEntitlement (called inside syncMinuteWindow) detects the expired trial
  // and downgrades the user to FREE. The effective limit becomes FREE=5, NOT PRO=80.
  // The trial cap (15) is also NOT applied — there is no active trial.
  const uExpired = await prisma.user.create({
    data: {
      name: "pro-expired-trial",
      email: "pro-expired@t.test",
      plan: "PRO",
      minutesUsed: 0,
      minutesLimit: 80,
      usagePeriodStartedAt: now,
      trialEndsAt: past,
    },
  });

  const check_c = await checkMinuteQuota(uExpired.id);
  // After entitlement sync the user is FREE (expired trial → downgraded). FREE limit = 5.
  assert(check_c.allowed === true, "(c) expired-trial PRO→FREE: checkMinuteQuota allowed (0/5 used)");
  assert(check_c.remaining === 5, "(c) expired-trial: remaining = 5 (FREE limit, trial cap NOT applied)");

  // Confirm the DB row was actually downgraded to FREE
  const row_c = await prisma.user.findUnique({ where: { id: uExpired.id } });
  assert(row_c!.plan === "FREE", "(c) expired-trial: DB plan downgraded to FREE");
  assert(row_c!.trialEndsAt === null, "(c) expired-trial: trialEndsAt cleared after downgrade");

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} TRIAL-CAP CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

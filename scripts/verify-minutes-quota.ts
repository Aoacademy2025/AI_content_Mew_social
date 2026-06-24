// verify-minutes-quota.ts — Task P2-1: single-source minute limits
// Pure unit test — no DB needed.
// Run: npx tsx scripts/verify-minutes-quota.ts
import { minutesLimitForPlan } from "../src/lib/minute-limits";
import { minutesPerMonthForPlan } from "../src/lib/plan-limits";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

function main() {
  // ── minutesLimitForPlan correctness ─────────────────────────────────────
  assert(minutesLimitForPlan("PRO") === 80, "minutesLimitForPlan(PRO) === 80");
  assert(minutesLimitForPlan("BUSINESS") === 150, "minutesLimitForPlan(BUSINESS) === 150");
  assert(minutesLimitForPlan("FREE") === 5, "minutesLimitForPlan(FREE) === 5");
  assert(minutesLimitForPlan("unknown") === 5, "minutesLimitForPlan(unknown) falls back to 5");

  // ── minutesPerMonthForPlan correctness ───────────────────────────────────
  assert(minutesPerMonthForPlan("PRO") === 80, "minutesPerMonthForPlan(PRO) === 80");
  assert(minutesPerMonthForPlan("BUSINESS") === 150, "minutesPerMonthForPlan(BUSINESS) === 150");
  assert(minutesPerMonthForPlan("FREE") === 5, "minutesPerMonthForPlan(FREE) === 5");
  assert(minutesPerMonthForPlan("unknown") === 5, "minutesPerMonthForPlan(unknown) falls back to 5");

  // ── single-source invariant: both functions return the same value ─────────
  for (const plan of ["FREE", "PRO", "BUSINESS", "unknown"]) {
    assert(
      minutesLimitForPlan(plan) === minutesPerMonthForPlan(plan),
      `minutesLimitForPlan(${plan}) === minutesPerMonthForPlan(${plan}) (single source)`
    );
  }

  console.log(`\n✅ ALL ${passed} MINUTES-QUOTA CHECKS PASSED`);
}

main();

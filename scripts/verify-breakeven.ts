// Run with: npx tsx scripts/verify-breakeven.ts
// Proves the LIVE break-even target is derived from this page's own margin (infra ÷ gross-profit-
// per-paying-customer) so it can never contradict the profit tile, falls back to the static
// constant only when there are no payers, and drives a never-negative "ต้องการอีก" display.
import { computeMargins, computeBreakEvenTarget, BREAK_EVEN_SUBS } from "../src/lib/cost-rates";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ FAIL " + m); process.exit(1); }
  console.log("✓ PASS " + m);
  passed++;
}

// Plan's worked example: mrr=3520, cogs=209, paying=6, infra=2600.
const mrr = 3520, cogs = 209, infra = 2600, paying = 6;
const margins = computeMargins({ revenue: mrr, variableCogs: cogs, infraMonthly: infra, periodDays: 30 });
assert(margins.grossProfit === 3311, `grossProfit = mrr - cogs = 3311 (got ${margins.grossProfit})`);

const target = computeBreakEvenTarget({ infraMonthly: infra, grossProfit: margins.grossProfit, payingTotal: paying });
assert(target === 5, `live target = ceil(2600 / (3311/6)) = 5 (got ${target})`);

// Display: "ต้องการอีก" is clamped at 0 when already covered.
assert(Math.max(0, target - paying) === 0, `covered → ต้องการอีก = max(0, 5-6) = 0`);

// No contradiction with the profit tile: this scenario is profitable (netProfit > 0) AND subs >= target.
assert(margins.netProfit > 0, `scenario is profitable (netProfit ฿${margins.netProfit} > 0)`);
assert(paying >= target, `profitable ⇒ subs (${paying}) >= target (${target}) — never contradicts the profit tile`);

// No payers yet → cannot derive a contribution → falls back to the static constant.
const fbTarget = computeBreakEvenTarget({ infraMonthly: infra, grossProfit: margins.grossProfit, payingTotal: 0 });
assert(fbTarget === BREAK_EVEN_SUBS && fbTarget === 14, `payingTotal=0 → fallback ${BREAK_EVEN_SUBS}`);

// Loss scenario: below break-even, "ต้องการอีก" is positive and consistent (netProfit < 0 ⇒ subs < target).
const lossMargins = computeMargins({ revenue: 600, variableCogs: 100, infraMonthly: infra, periodDays: 30 });
const lossTarget = computeBreakEvenTarget({ infraMonthly: infra, grossProfit: lossMargins.grossProfit, payingTotal: 1 });
assert(lossTarget === Math.ceil(infra / (lossMargins.grossProfit / 1)), `loss target = ceil(2600/500) = 6 (got ${lossTarget})`);
assert(lossMargins.netProfit < 0 && 1 < lossTarget, `loss ⇒ subs (1) < target (${lossTarget}) — needs more, still consistent`);
assert(Math.max(0, lossTarget - 1) === lossTarget - 1 && lossTarget - 1 > 0, `below break-even → ต้องการอีก positive (${lossTarget - 1})`);

// Degenerate: payers exist but COGS exceeds MRR (grossProfit <= 0) → no positive contribution → fallback.
const negMargins = computeMargins({ revenue: 100, variableCogs: 200, infraMonthly: infra, periodDays: 30 });
const negTarget = computeBreakEvenTarget({ infraMonthly: infra, grossProfit: negMargins.grossProfit, payingTotal: 2 });
assert(negTarget === BREAK_EVEN_SUBS, `grossProfit<=0 with payers → fallback ${BREAK_EVEN_SUBS} (got ${negTarget})`);

console.log(`\n${passed} checks passed`);

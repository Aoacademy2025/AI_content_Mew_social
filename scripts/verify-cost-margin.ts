// Verify cost-rate config + cost/margin calc lib (Task 1).
// Pure-function tests need NO DB.
// For getCostRates() default test, use a throwaway SQLite:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-cost-margin.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-cost-margin.db?connection_limit=1" npx tsx scripts/verify-cost-margin.ts
import { prisma } from "../src/lib/prisma";
import {
  computeMrr,
  computeCogs,
  computeMargins,
  getCostRates,
  BREAK_EVEN_SUBS,
  COST_DEFAULTS,
} from "../src/lib/cost-rates";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

function near(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) < tol;
}

async function main() {
  // ── computeMrr ─────────────────────────────────────────────────────────────
  const mrr = computeMrr({ pro: 2, business: 1 }, { pro: 599, business: 990 });
  assert(mrr === 2188, `computeMrr(pro=2,biz=1,p=599/990) === 2188 (got ${mrr})`);

  // ── computeCogs ─────────────────────────────────────────────────────────────
  const cogs = computeCogs({
    managedMinutes: 100,
    imageCounts: { gpt1k: 10, nano1k: 5, gpt2k: 0, nano2k: 0 },
    rates: COST_DEFAULTS,
  });
  assert(near(cogs.tts, 70), `computeCogs: tts = 70 (got ${cogs.tts})`);
  // 10*1.05 + 5*1.4 = 10.5 + 7 = 17.5
  assert(near(cogs.image, 17.5), `computeCogs: image = 17.5 (got ${cogs.image})`);
  assert(cogs.video === 0, `computeCogs: video = 0 (got ${cogs.video})`);
  assert(near(cogs.total, 87.5), `computeCogs: total = 87.5 (got ${cogs.total})`);

  // ── computeMargins ─────────────────────────────────────────────────────────
  const margins = computeMargins({
    revenue: 2188,
    variableCogs: 87.5,
    infraMonthly: 2600,
    periodDays: 30,
  });
  assert(near(margins.grossProfit, 2100.5), `computeMargins: grossProfit = 2100.5 (got ${margins.grossProfit})`);
  // 2100.5/2188*100 ≈ 96.0
  assert(near(margins.grossMarginPct, 96.0, 0.1), `computeMargins: grossMarginPct ≈ 96.0 (got ${margins.grossMarginPct.toFixed(2)})`);
  // 87.5/2188*100 ≈ 4.0
  assert(near(margins.aiCostPct, 4.0, 0.1), `computeMargins: aiCostPct ≈ 4.0 (got ${margins.aiCostPct.toFixed(2)})`);
  // infraProrated = 2600 * (30/30) = 2600
  assert(near(margins.infraProrated, 2600), `computeMargins: infraProrated = 2600 (got ${margins.infraProrated})`);
  // netProfit = 2100.5 - 2600 = -499.5
  assert(near(margins.netProfit, -499.5), `computeMargins: netProfit = -499.5 (got ${margins.netProfit})`);

  // ── revenue = 0 → no NaN/divide-by-zero ────────────────────────────────────
  const zeroRevMargins = computeMargins({
    revenue: 0,
    variableCogs: 0,
    infraMonthly: 2600,
    periodDays: 30,
  });
  assert(zeroRevMargins.grossMarginPct === 0, `revenue=0: grossMarginPct = 0 (got ${zeroRevMargins.grossMarginPct})`);
  assert(zeroRevMargins.aiCostPct === 0, `revenue=0: aiCostPct = 0 (got ${zeroRevMargins.aiCostPct})`);
  assert(!isNaN(zeroRevMargins.grossMarginPct), `revenue=0: grossMarginPct is not NaN`);
  assert(!isNaN(zeroRevMargins.aiCostPct), `revenue=0: aiCostPct is not NaN`);

  // ── BREAK_EVEN_SUBS ────────────────────────────────────────────────────────
  assert(BREAK_EVEN_SUBS === 14, `BREAK_EVEN_SUBS === 14 (got ${BREAK_EVEN_SUBS})`);

  // ── getCostRates() returns DEFAULTS when SiteConfig empty ─────────────────
  // Clean SiteConfig for cost keys
  await prisma.siteConfig.deleteMany({
    where: { key: { startsWith: "cost_" } },
  });
  await prisma.siteConfig.deleteMany({
    where: { key: "fx_baht_per_usd" },
  });

  const rates = await getCostRates();
  assert(rates.renderPerMinute === 0.7, `getCostRates: renderPerMinute = 0.7 (got ${rates.renderPerMinute})`);
  assert(rates.imageGpt1k === 1.05, `getCostRates: imageGpt1k = 1.05 (got ${rates.imageGpt1k})`);
  assert(rates.imageNano1k === 1.4, `getCostRates: imageNano1k = 1.4 (got ${rates.imageNano1k})`);
  assert(rates.imageGpt2k === 1.75, `getCostRates: imageGpt2k = 1.75 (got ${rates.imageGpt2k})`);
  assert(rates.imageNano2k === 2.1, `getCostRates: imageNano2k = 2.1 (got ${rates.imageNano2k})`);
  assert(rates.videoSeedance5s === 3.06, `getCostRates: videoSeedance5s = 3.06 (got ${rates.videoSeedance5s})`);
  assert(rates.infraMonthly === 2600, `getCostRates: infraMonthly = 2600 (got ${rates.infraMonthly})`);
  assert(rates.fxBahtPerUsd === 35, `getCostRates: fxBahtPerUsd = 35 (got ${rates.fxBahtPerUsd})`);

  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} COST/MARGIN CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

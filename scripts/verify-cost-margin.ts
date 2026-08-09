// Verify cost-rate config + cost/margin calc lib (Task 1).
// Pure-function tests need NO DB.
// For getCostRates() default test, use a throwaway SQLite:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-cost-margin.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-cost-margin.db?connection_limit=1" npx tsx scripts/verify-cost-margin.ts
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import {
  computeMrr,
  computeCogs,
  computeMargins,
  getCostRates,
  BREAK_EVEN_SUBS,
  COST_DEFAULTS,
} from "../src/lib/cost-rates";
import {
  aiImageCostBucket,
  aiImageJobIdFromAction,
  aiImageLedgerActionWhere,
} from "../src/lib/ai-image-ledger-report";

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
  // ── Ledger action namespace + durable model attribution ──────────────────
  assert(
    JSON.stringify(aiImageLedgerActionWhere("spend"))
      === JSON.stringify({ OR: [{ action: "ai-image" }, { action: { startsWith: "ai-image:" } }] }),
    "AI-image spend query includes legacy exact + durable ai-image:<jobId> actions",
  );
  assert(
    JSON.stringify(aiImageLedgerActionWhere("refund"))
      === JSON.stringify({ OR: [{ action: "ai-image-refund" }, { action: { startsWith: "ai-image-refund:" } }] }),
    "AI-image refund query includes legacy exact + durable ai-image-refund:<jobId> actions",
  );
  assert(aiImageJobIdFromAction("ai-image:job_123") === "job_123", "spend action extracts durable image job id");
  assert(aiImageJobIdFromAction("ai-image-refund:job_123") === "job_123", "refund action extracts durable image job id");
  assert(aiImageJobIdFromAction("ai-image") === null, "legacy exact action has no durable job id");
  assert(
    aiImageCostBucket({ model: "z-image-turbo", delta: -2 }) === "hero1k",
    "Z-Image 2-credit job is attributed to Hero/RunPod, not mislabeled as Flux",
  );
  assert(
    aiImageCostBucket({ model: null, delta: -2 }) === "flux1k",
    "legacy 2-credit row without a job retains the historical Flux fallback",
  );
  const routeSource = readFileSync("src/app/api/admin/costs/route.ts", "utf8");
  assert(
    routeSource.includes('...aiImageLedgerActionWhere("spend")')
      && routeSource.includes('...aiImageLedgerActionWhere("refund")'),
    "Admin Cost/Margin route uses the namespace-aware filters for spend and refund queries",
  );
  assert(
    routeSource.includes("prisma.aiGenerationJob.findMany")
      && routeSource.includes("imageJobModels"),
    "Admin Cost/Margin route joins durable jobs for real model attribution",
  );
  const ledgerUser = await prisma.user.create({
    data: { name: "Cost Ledger Verify", email: "cost-ledger-verify@example.invalid" },
  });
  await prisma.creditLedger.createMany({
    data: [
      { userId: ledgerUser.id, delta: -3, kind: "spend", action: "ai-image", balanceAfter: 20 },
      { userId: ledgerUser.id, delta: -2, kind: "spend", action: "ai-image:durable_job", balanceAfter: 18 },
      { userId: ledgerUser.id, delta: -2, kind: "spend", action: "minute:other", balanceAfter: 16 },
    ],
  });
  const matchedSpendRows = await prisma.creditLedger.findMany({
    where: { kind: "spend", ...aiImageLedgerActionWhere("spend") },
  });
  assert(matchedSpendRows.length === 2, "Prisma filter returns both legacy and durable AI-image spends, excluding unrelated spend");
  await prisma.user.delete({ where: { id: ledgerUser.id } });

  // ── computeMrr ─────────────────────────────────────────────────────────────
  const mrr = computeMrr({ pro: 2, business: 1 }, { pro: 599, business: 990 });
  assert(mrr === 2188, `computeMrr(pro=2,biz=1,p=599/990) === 2188 (got ${mrr})`);

  // ── computeCogs ─────────────────────────────────────────────────────────────
  const cogs = computeCogs({
    managedMinutes: 100,
    imageCounts: { hero1k: 10, flux1k: 0, gpt1k: 10, nano1k: 5, gpt2k: 0, nano2k: 0 },
    rates: COST_DEFAULTS,
  });
  assert(near(cogs.tts, 70), `computeCogs: tts = 70 (got ${cogs.tts})`);
  // Hero 10*0.20 + GPT 10*1.08 + Nano 5*1.44 = 2 + 10.8 + 7.2 = 20.0
  assert(near(cogs.image, 20.0), `computeCogs: image = 20.0 (got ${cogs.image})`);
  assert(cogs.video === 0, `computeCogs: video = 0 (got ${cogs.video})`);
  assert(near(cogs.total, 90.0), `computeCogs: total = 90.0 (got ${cogs.total})`);

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
  assert(rates.imageHero1k === 0.2, `getCostRates: imageHero1k = 0.2 (got ${rates.imageHero1k})`);
  assert(rates.imageFlux1k === 0.9, `getCostRates: imageFlux1k = 0.9 (got ${rates.imageFlux1k})`);
  assert(rates.imageGpt1k === 1.08, `getCostRates: imageGpt1k = 1.08 (got ${rates.imageGpt1k})`);
  assert(rates.imageNano1k === 1.44, `getCostRates: imageNano1k = 1.44 (got ${rates.imageNano1k})`);
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

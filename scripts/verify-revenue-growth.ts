import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeRevenuePeriod, type RevenueCashEvent, type RevenueReceiptEvent } from "../src/lib/revenue-growth";
import { buildRevenueGrowthOpportunityPlan } from "../src/lib/revenue-growth-opportunities";

const date = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const cashEvents: RevenueCashEvent[] = [
  { at: date("2026-07-15"), amountBaht: 500, refundedBaht: 0, source: "stripe" },
  { at: date("2026-08-10"), amountBaht: 1_000, refundedBaht: 0, source: "stripe" },
  { at: date("2026-08-18"), amountBaht: 0, refundedBaht: 100, source: "stripe" },
  { at: date("2026-08-12"), amountBaht: 300, refundedBaht: 0, source: "stripe" },
  { at: date("2026-08-20"), amountBaht: 200, refundedBaht: 0, source: "manual" },
];
const receipts: RevenueReceiptEvent[] = [
  { at: date("2026-07-15"), amountBaht: 500, source: "studio", customerKey: "old@example.test" },
  { at: date("2026-08-10"), amountBaht: 700, source: "studio", customerKey: "old@example.test" },
  { at: date("2026-08-10"), amountBaht: 300, source: "credit", customerKey: "credit@example.test" },
  { at: date("2026-08-12"), amountBaht: 300, source: "bundle", customerKey: "bundle@example.test" },
  { at: date("2026-08-20"), amountBaht: 200, source: "manual", customerKey: "manual@example.test" },
];

const result = summarizeRevenuePeriod({ now: date("2026-08-31"), days: 30, cashEvents, receipts });
assert.equal(result.currentGross, 1_400, "gross cash is Stripe charges net refunds + audited manual receipts");
assert.equal(result.previousGross, 500);
assert.equal(Math.round(result.changePct ?? 0), 180);
assert.equal(result.stripeGross, 1_300);
assert.equal(result.refunds, 100);
assert.equal(result.manual, 200);
assert.equal(result.mix.studio, 700);
assert.equal(result.mix.bundle, 300);
assert.equal(result.mix.credit, 300);
assert.equal(result.mix.manual, 200);
assert.equal(result.mix.reconciliation, 0, "product ledger reconciles to the cash truth");
assert.equal(result.newPayers, 3);
assert.equal(result.repeatPayers, 1);
assert.equal(result.trend.reduce((sum, row) => sum + row.current, 0), result.currentGross);
assert.ok(result.trend.some((row) => row.current < 0), "a refund is shown on the day cash left, not rewritten onto the charge date");

const growthPlan = buildRevenueGrowthOpportunityPlan({
  activeCreators: 13,
  activePayingCustomers: 22,
  videoCreators: 11,
  imageCreators: 12,
  prepaidMonthlyEquivalent: 3_100,
  activeMonthlyValue: 9_117,
  brollFeatureRequests: 1,
  faceConsistencyRequests: 0,
});
assert.equal(growthPlan.opportunities[0]?.id, "broll-control", "B-roll demand + video usage is the first product bet");
assert.match(growthPlan.opportunities[0]?.evidence ?? "", /11\/13.*Feature request 1/u);
assert.equal(growthPlan.opportunities.find((item) => item.id === "return-loop")?.confidence, "สูง", "MAPC gap is a high-confidence retention signal");
assert.equal(growthPlan.opportunities.find((item) => item.id === "face-lock")?.confidence, "ต่ำ", "image usage alone cannot be presented as proven Face Lock demand");
assert.match(growthPlan.opportunities.find((item) => item.id === "prepaid-renewal")?.evidence ?? "", /34%/u);

const server = readFileSync("src/lib/revenue-growth.server.ts", "utf8");
const page = readFileSync("src/components/admin/revenue-growth-dashboard.tsx", "utf8");
const nav = readFileSync("src/components/layout/sidebar.tsx", "utf8");
assert.doesNotMatch(server, /balance_transaction|application_fee|processing_fee/i, "fees must never enter the gross-cash data path");
assert.match(page, /North Star · MAPC/);
assert.match(page, /เป้ารอบนี้/);
assert.match(page, /มุมประชุม/);
assert.match(page, /function TermTip/);
assert.match(page, /ถ้าจะโตแบบก้าวกระโดด ทำอะไรต่อ/);
assert.match(page, /var\(--ui-card-bg\)/, "Revenue page must use the shared system surface tokens");
assert.match(page, /#8B5CF6/, "Revenue page must use the product violet accent");
assert.doesNotMatch(page, /#0b0f0d|#75d69a|Bai Jamjuree/, "the detached green editorial theme must not return");
assert.match(server, /supportTicket\.findMany/, "feature recommendations must include support demand signals");
assert.match(nav, /href: "\/admin\/revenue"/);

console.log("verify-revenue-growth: PASS cash truth + system CI + evidence-ranked growth bets");

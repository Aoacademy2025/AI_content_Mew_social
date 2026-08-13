import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeLifetimeCash } from "../src/lib/revenue-cash";

const insights = readFileSync("src/app/(dashboard)/admin/insights/page.tsx", "utf8");
const revenuePanel = readFileSync("src/components/admin/cost-margin-panel.tsx", "utf8");
const costsRoute = readFileSync("src/app/api/admin/costs/route.ts", "utf8");

assert.match(
  insights,
  /fontFamily:\s*['"]Noto Sans Thai['"]|fontFamily:\s*['"]'Noto Sans Thai'/,
  "Insights must use a Thai-capable UI font instead of the latin-only Inter fallback",
);
assert.ok(
  (insights.match(/leading-\[1\.35\]/g) ?? []).length >= 2,
  "both large Thai headings need a 1.35 line-height so marks are not cropped",
);
const mapcSectionClass = insights.match(
  /<section className="([^"]*)" aria-labelledby="mapc-heading">/,
)?.[1];
assert.ok(mapcSectionClass, "the MAPC section must remain directly identifiable");
const mapcClasses = new Set(mapcSectionClass.split(/\s+/));
assert.ok(
  mapcClasses.has("overflow-visible") && mapcClasses.has("px-1") && mapcClasses.has("sm:px-2"),
  "the MAPC section needs visible overflow and inline breathing room so Thai glyph edges are not clipped",
);
assert.ok(
  mapcClasses.has("border") && !mapcClasses.has("border-y"),
  "the MAPC section must draw a complete four-sided frame instead of looking cropped at the left and right edges",
);
assert.match(
  insights,
  /สมาชิกที่ต่ออายุอยู่ตอนนี้[\s\S]*northStar\.activeRecurringPayers/,
  "the MAPC denominator must be labelled as the recurring subset, not all cash payers",
);
assert.match(
  revenuePanel,
  /ลูกค้าจ่ายเงินจริงทั้งหมดตอนนี้[\s\S]*cu\.payingTotal/,
  "the 14-person active cash-paying total needs an explicit all-current-payers label",
);
assert.match(
  revenuePanel,
  /รายได้รวมสะสม[\s\S]*cash\.allTimeTotal/,
  "the revenue panel must show all-time recorded cash separately from MRR",
);
assert.match(
  revenuePanel,
  /ต้นทุนเส้นทางที่ใช้งานจริง[\s\S]*MetricHelp/,
  "the active RunPod route cost needs plain Thai guidance for its specialized metric",
);
assert.match(
  revenuePanel,
  /ทุกครั้งที่ส่งงานให้ผู้ให้บริการ \(attempt\)[\s\S]*การลองใหม่ \(retry\)[\s\S]*คืนเครดิต[\s\S]*settle หมายถึง/,
  "the RunPod cost tooltip must define attempts and settlement while explaining retry/refund treatment",
);
assert.match(
  costsRoute,
  /allTimeTotal/,
  "the costs API must return the all-time cash total",
);
assert.doesNotMatch(
  costsRoute,
  /PACK_CREDIT_TO_BAHT|creditPurchaseRows/,
  "admin CreditLedger grants must not be inferred as cash or double-count a credit-pack Payment",
);
assert.match(
  costsRoute,
  /p\.note === "credits"/,
  "credit-pack cash must come from its authoritative PAID Payment row",
);

const cash = summarizeLifetimeCash([
  { amount: 100_000, amountRefunded: 25_000, currency: "thb", paid: true, status: "succeeded" },
  { amount: 59_900, amountRefunded: 0, currency: "thb", paid: true, status: "succeeded" },
  { amount: 99_900, amountRefunded: 0, currency: "thb", paid: false, status: "failed" },
  { amount: 5_000, amountRefunded: 0, currency: "usd", paid: true, status: "succeeded" },
], 12_300);
assert.deepEqual(cash, {
  total: 1_472,
  stripeNet: 1_349,
  manual: 123,
  refunds: 250,
  successfulCharges: 2,
  ignoredNonThbCharges: 1,
});

console.log("verify-admin-insights-revenue-clarity: PASS");

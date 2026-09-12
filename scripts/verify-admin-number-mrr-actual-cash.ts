// MRR means money customers actually paid — never the tier LIST price.
//
// Audit A4 (2026-09-12), rows #15 / #16 / #18 / #40 / #43 / #45 / #60 / #95 / #96: a payer with
// no `monthlyRevenueByUser` entry fell through to `monthlyEquiv(tierPrice(prices, plan))`, so 11
// accounts who had paid ฿0 were priced at the ฿599/฿990 list price. That invented ฿6,389.33 of
// the ฿18,052.50 MRR and ฿6,389.33 of the ฿9,739.50 prepaid MRR, then flowed on into
// deferredRevenue (฿35,569.96), gross margin %, AI-cost % and the break-even target.
//
// The rule after this change: if we cannot say what a customer paid, we say ZERO. A dashboard
// that under-reports is recoverable; one that prices a ฿0 account at list is not.
//
// Two halves, both required:
//   A. the pure contract — a payer absent from the map contributes nothing anywhere, and the
//      list price is never consulted even when it is absurd;
//   B. the real DB path (`getRevenueCohorts` over a throwaway SQLite) — every money figure is
//      rebuilt from Payment.amount alone, with fixtures straddling Bangkok midnight and the
//      annual/monthly and recurring/prepaid cohort boundaries.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-admin-number-mrr-actual-cash.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only: erased at compile time, so the module is not loaded before DATABASE_URL is set.
import type { CohortUser } from "../src/lib/revenue-cohorts";

const dir = mkdtempSync(join(tmpdir(), "admin-number-mrr-cash-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`ok: ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

const DAY_MS = 86_400_000;
// Asia/Bangkok is UTC+7 all year: 16:59Z and 17:00Z on the same UTC day are the last minute of
// one Bangkok day and the first minute of the next.
const BEFORE_BKK_MIDNIGHT = new Date("2026-09-10T16:59:00.000Z"); // 2026-09-10 23:59 Bangkok
const AFTER_BKK_MIDNIGHT = new Date("2026-09-10T17:00:00.000Z"); // 2026-09-11 00:00 Bangkok
const NOW = new Date("2026-09-12T04:00:00.000Z");
const PREPAID_DAYS_LEFT = 180;
const PREPAID_EXPIRES_AT = new Date(NOW.getTime() + PREPAID_DAYS_LEFT * DAY_MS);
const FAR_FUTURE = new Date("2027-12-31T00:00:00.000Z");

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { computeRevenueCohorts, getRevenueCohorts } = await import("../src/lib/revenue-cohorts");

  // ── A. The pure contract: no known amount → no revenue ──────────────────────
  // An absurd list price makes any fallback impossible to miss.
  const ABSURD_PRICES = { pro: 99_999, business: 99_999 };
  const unpricedPayer: CohortUser = {
    id: "unpriced", email: "unpriced@example.test", plan: "PRO", role: "USER",
    subStatus: null, billingPeriod: "annual", planExpiresAt: PREPAID_EXPIRES_AT,
    trialStartedAt: null, trialEndsAt: null, stripeSubscriptionId: null,
  };
  const unpriced = computeRevenueCohorts(
    [unpricedPayer],
    new Set(["unpriced"]),
    ABSURD_PRICES,
    NOW,
    { monthlyRevenueByUser: new Map() },
  );
  check(unpriced.mrr === 0, "A1: a payer with no known amount adds nothing to MRR", `mrr=${unpriced.mrr}`);
  check(unpriced.directMrr === 0, "A2: …nor to Studio MRR", `directMrr=${unpriced.directMrr}`);
  check(unpriced.prepaidMrr === 0, "A3: …nor to prepaid MRR", `prepaidMrr=${unpriced.prepaidMrr}`);
  check(unpriced.recurringMrr === 0, "A4: …nor to recurring MRR", `recurringMrr=${unpriced.recurringMrr}`);
  check(unpriced.deferredRevenue === 0, "A5: …nor to the deferred obligation", `deferred=${unpriced.deferredRevenue}`);
  check(unpriced.arr === 0, "A6: …nor to ARR", `arr=${unpriced.arr}`);
  check(unpriced.mrrByTier.pro === 0, "A7: …nor to the per-tier MRR split", `pro=${unpriced.mrrByTier.pro}`);
  check(
    unpriced.prepaidExpiry.within90DaysMrr === 0,
    "A8: …nor to the revenue at stake in the prepaid cliff",
    `within90DaysMrr=${unpriced.prepaidExpiry.within90DaysMrr}`,
  );
  check(
    unpriced.payingTotal === 1,
    "A9: the person is still counted as a customer — only the invented price is dropped",
    `payingTotal=${unpriced.payingTotal}`,
  );

  const priced = computeRevenueCohorts(
    [unpricedPayer],
    new Set(["unpriced"]),
    ABSURD_PRICES,
    NOW,
    { monthlyRevenueByUser: new Map([["unpriced", 250]]) },
  );
  check(
    near(priced.mrr, 250),
    "A10: a payer WITH a known amount is priced at exactly that amount, never the list price",
    `mrr=${priced.mrr}`,
  );

  const canceling = computeRevenueCohorts(
    [{ ...unpricedPayer, id: "cancelling", email: "cancelling@example.test", subStatus: "canceled" }],
    new Set(["cancelling"]),
    ABSURD_PRICES,
    NOW,
    { monthlyRevenueByUser: new Map() },
  );
  check(
    canceling.payingCanceling === 1 && canceling.mrrAtRisk === 0,
    "A11: MRR at risk cannot exceed MRR — an unpriced canceller risks ฿0",
    `payingCanceling=${canceling.payingCanceling} mrrAtRisk=${canceling.mrrAtRisk}`,
  );

  // ── B. The real DB path ─────────────────────────────────────────────────────
  await prisma.user.createMany({
    data: [
      // Founding annual: paid ฿2,995 for a year. List price would say ฿499.17/month.
      {
        id: "annual-founding", name: "annual-founding", email: "annual-founding@example.test",
        plan: "PRO", billingPeriod: "annual", planExpiresAt: PREPAID_EXPIRES_AT,
      },
      // Live monthly subscription at the ฿599 list price — the one case where actual == list.
      {
        id: "monthly-sub", name: "monthly-sub", email: "monthly-sub@example.test",
        plan: "PRO", billingPeriod: "monthly", planExpiresAt: FAR_FUTURE,
        subStatus: "active", stripeSubscriptionId: "sub_live",
      },
      // Entitled PRO whose only plan payment is ฿0 — must price at nothing, anywhere.
      {
        id: "zero-only", name: "zero-only", email: "zero-only@example.test",
        plan: "PRO", billingPeriod: "monthly", planExpiresAt: FAR_FUTURE,
      },
    ],
  });
  await prisma.payment.createMany({
    data: [
      {
        id: "p-annual", userId: "annual-founding", stripeSessionId: "s-annual", plan: "PRO",
        amount: 299_500, status: "PAID", periodDays: 365,
        createdAt: BEFORE_BKK_MIDNIGHT, paidAt: BEFORE_BKK_MIDNIGHT,
      },
      {
        id: "p-monthly", userId: "monthly-sub", stripeSessionId: "s-monthly", plan: "PRO",
        amount: 59_900, status: "PAID", periodDays: 30,
        createdAt: AFTER_BKK_MIDNIGHT, paidAt: AFTER_BKK_MIDNIGHT,
      },
      {
        id: "p-zero", userId: "zero-only", stripeSessionId: "s-zero", plan: "PRO",
        amount: 0, status: "PAID", periodDays: 30,
        createdAt: AFTER_BKK_MIDNIGHT, paidAt: AFTER_BKK_MIDNIGHT,
      },
    ],
  });

  const cohorts = await getRevenueCohorts(NOW);
  const annualMonthly = 2_995 / 12; // what they actually paid, spread over the year
  check(
    near(cohorts.mrr, 599 + annualMonthly),
    "B1: MRR is the sum of what customers actually paid",
    `mrr=${cohorts.mrr.toFixed(2)} (expected ${(599 + annualMonthly).toFixed(2)})`,
  );
  check(
    near(cohorts.recurringMrr, 599) && near(cohorts.prepaidMrr, annualMonthly),
    "B2: the recurring/prepaid split carries the same real amounts",
    `recurring=${cohorts.recurringMrr.toFixed(2)} prepaid=${cohorts.prepaidMrr.toFixed(2)}`,
  );
  const expectedDeferred = annualMonthly * 12 * (PREPAID_DAYS_LEFT / 365);
  check(
    near(cohorts.deferredRevenue, expectedDeferred),
    "B3: the deferred obligation is straight-lined from real cash, not list price",
    `deferred=${cohorts.deferredRevenue.toFixed(2)} (expected ${expectedDeferred.toFixed(2)})`,
  );
  check(
    near(cohorts.arr, 599 * 12),
    "B4: ARR still annualises the recurring half only",
    `arr=${cohorts.arr.toFixed(2)}`,
  );
  check(
    cohorts.payingTotal === 2,
    "B5: the ฿0 account is not a customer and therefore prices nothing",
    `payingTotal=${cohorts.payingTotal}`,
  );
  check(
    cohorts.mrr < 599 + (599 * 10) / 12 + 599,
    "B6: regression guard — MRR is below the all-list-price figure the old fallback produced",
    `mrr=${cohorts.mrr.toFixed(2)} vs list-price ${(599 + (599 * 10) / 12 + 599).toFixed(2)}`,
  );

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} ok, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });

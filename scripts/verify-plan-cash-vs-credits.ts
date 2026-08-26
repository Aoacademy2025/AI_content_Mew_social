// MRR must price customers by what they actually paid, and a credit pack is not a plan.
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-plan-cash-vs-credits.ts
//
// Two defects found on prod 2026-08-27, both in how PAID rows were read:
//   1. A 199฿ credit top-up made its buyer a "paying customer" and priced them into MRR at
//      the full 599฿/month tier, though they had never bought a plan.
//   2. MRR used the tier LIST price, so a Founding annual buyer paying 2,995฿/year (250฿/mo)
//      was counted at 599 × 10 / 12 = 499฿. Across thirteen payers that inflated Studio MRR
//      by ~3,565฿/month — about 28% of the reported figure.
import {
  computeRevenueCohorts,
  summarizePlanCash,
  type CohortUser,
  type PlanCashRow,
} from "../src/lib/revenue-cohorts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

// ── A. Credit packs are cash, but never plan cash ──
const day = (n: number) => new Date(2026, 0, n);
const rows: PlanCashRow[] = [
  { userId: "u-credit-only", amount: 19_900, note: "credits", periodDays: 0, createdAt: day(1) },
  { userId: "u-annual-founding", amount: 299_500, note: null, periodDays: 365, createdAt: day(2) },
  { userId: "u-monthly", amount: 59_900, note: null, periodDays: 30, createdAt: day(3) },
  // A customer who paid monthly first, then converted to an annual term.
  { userId: "u-converted", amount: 59_900, note: null, periodDays: 30, createdAt: day(4) },
  { userId: "u-converted", amount: 299_500, note: null, periodDays: 365, createdAt: day(9) },
  // A plan payer who also bought credits later.
  { userId: "u-monthly", amount: 49_900, note: "credits", periodDays: 0, createdAt: day(10) },
];
const cash = summarizePlanCash(rows);

check("A1: a credit-only buyer is NOT a plan payer", !cash.paidUserIds.has("u-credit-only"));
check("A2: they contribute no MRR at all", cash.monthlyRevenueByUser.get("u-credit-only") === undefined);
check("A3: plan payers are still counted", cash.paidUserIds.has("u-annual-founding") && cash.paidUserIds.has("u-monthly"));
check("A4: credit revenue is reported separately", near(cash.creditRevenue, 199 + 499), `${cash.creditRevenue}`);
check("A5: credit buyers are counted as people, not rows", cash.creditBuyers === 2, `${cash.creditBuyers}`);

// ── B. Monthly-equivalent comes from real cash ──
check("B1: an annual term is spread over twelve months", near(cash.monthlyRevenueByUser.get("u-annual-founding")!, 2995 / 12));
check("B2: a monthly term is taken as-is", near(cash.monthlyRevenueByUser.get("u-monthly")!, 599));
check(
  "B3: after converting monthly → annual, the live term wins",
  near(cash.monthlyRevenueByUser.get("u-converted")!, 2995 / 12),
  `${cash.monthlyRevenueByUser.get("u-converted")}`,
);
check("B4: a credit pack never raises a plan payer's MRR", near(cash.monthlyRevenueByUser.get("u-monthly")!, 599));

// ── C. End to end through the cohort computation ──
const future = new Date(Date.now() + 200 * 24 * 3600 * 1000);
const users: CohortUser[] = [
  {
    id: "u-annual-founding", email: "founder@example.test", plan: "PRO", role: "USER",
    subStatus: null, billingPeriod: "annual", planExpiresAt: future,
    trialStartedAt: null, trialEndsAt: null, stripeSubscriptionId: null,
    bundleAccessExpiresAt: null, bundleStatus: null, bundlePrimary: false,
    bundleBillingPeriod: null, bundleAmountThb: null,
  },
  {
    id: "u-credit-only", email: "credits@example.test", plan: "PRO", role: "USER",
    subStatus: null, billingPeriod: null, planExpiresAt: future,
    trialStartedAt: null, trialEndsAt: null, stripeSubscriptionId: null,
    bundleAccessExpiresAt: null, bundleStatus: null, bundlePrimary: false,
    bundleBillingPeriod: null, bundleAmountThb: null,
  },
];
const prices = { pro: 599, business: 990 };

const fixed = computeRevenueCohorts(users, cash.paidUserIds, prices, new Date(), {
  monthlyRevenueByUser: cash.monthlyRevenueByUser,
});
check("C1: the founding annual buyer is priced at what they paid", near(fixed.mrr, 2995 / 12), `mrr=${fixed.mrr}`);
check("C2: the credit-only buyer adds nothing to MRR", near(fixed.mrr, 2995 / 12));
check("C3: only the plan payer counts as paying", fixed.payingTotal === 1, `${fixed.payingTotal}`);

// The old behaviour, for contrast: list price, and credits treated as plan cash.
const legacy = computeRevenueCohorts(
  users,
  new Set(["u-annual-founding", "u-credit-only"]),
  prices,
  new Date(),
);
check(
  "C4: the fix genuinely lowers MRR versus the list-price behaviour",
  legacy.mrr > fixed.mrr,
  `legacy=${Math.round(legacy.mrr)} fixed=${Math.round(fixed.mrr)}`,
);
check(
  "C5: no map supplied → previous list-price behaviour is preserved",
  near(legacy.mrr, (599 * 10) / 12 + 599),
  `${legacy.mrr}`,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

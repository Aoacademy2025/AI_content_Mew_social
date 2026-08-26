// ARR must annualise only what actually recurs.
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-arr-revenue-shape.ts
//
// On prod 2026-08-27 the revenue split was: 8 Stripe subscriptions (4,219฿/month, and the
// only thing that bills again on its own) against 12 customers who bought a one-time annual
// term (3,101฿/month amortised, 32,883฿ of it not yet delivered). Reporting one blended
// 7,319฿ "MRR" and multiplying by 12 would claim a 87,828฿ run rate from customers who have
// already paid and will simply stop — eleven of the twelve inside a single quarter of 2027.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeRevenueCohorts, type CohortUser } from "../src/lib/revenue-cohorts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

const now = new Date("2026-08-27T00:00:00Z");
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000);
const base = {
  role: "USER", trialStartedAt: null, trialEndsAt: null,
  bundleAccessExpiresAt: null, bundleStatus: null, bundlePrimary: false,
  bundleBillingPeriod: null, bundleAmountThb: null,
} as const;

const users: CohortUser[] = [
  // Recurring: a live Stripe subscription, monthly.
  { ...base, id: "sub-monthly", email: "sub@x.test", plan: "PRO", subStatus: "active",
    billingPeriod: "monthly", planExpiresAt: inDays(20), stripeSubscriptionId: "sub_1" },
  // Prepaid: paid once for a year, no subscription. Half the term still to run.
  { ...base, id: "prepaid-annual", email: "prepaid@x.test", plan: "PRO", subStatus: null,
    billingPeriod: "annual", planExpiresAt: inDays(182), stripeSubscriptionId: null },
  // Prepaid and about to lapse — the cliff this panel exists to show.
  { ...base, id: "prepaid-soon", email: "soon@x.test", plan: "PRO", subStatus: null,
    billingPeriod: "annual", planExpiresAt: inDays(45), stripeSubscriptionId: null },
];
const paid = new Set(users.map((u) => u.id));
const monthlyRevenueByUser = new Map([
  ["sub-monthly", 599],
  ["prepaid-annual", 2995 / 12],
  ["prepaid-soon", 2995 / 12],
]);
const c = computeRevenueCohorts(users, paid, { pro: 599, business: 990 }, now, { monthlyRevenueByUser });

// ── A. The split ──
check("A1: only the subscription counts as recurring", near(c.recurringMrr, 599), `${c.recurringMrr}`);
check("A2: both one-time terms count as prepaid", near(c.prepaidMrr, (2995 / 12) * 2), `${c.prepaidMrr}`);
check("A3: the two halves still add up to Studio MRR", near(c.recurringMrr + c.prepaidMrr, c.directMrr));

// ── B. ARR annualises recurring ONLY ──
check("B1: ARR is recurring × 12", near(c.arr, 599 * 12), `${c.arr}`);
check(
  "B2: ARR is NOT the blended MRR × 12 — that is the number this guards against",
  !near(c.arr, c.directMrr * 12, 10),
  `arr=${Math.round(c.arr)} blended×12=${Math.round(c.directMrr * 12)}`,
);
check("B3: with no subscriptions at all, ARR is zero, not the prepaid run rate", (() => {
  const only = computeRevenueCohorts(users.slice(1), new Set(["prepaid-annual", "prepaid-soon"]),
    { pro: 599, business: 990 }, now, { monthlyRevenueByUser });
  return only.arr === 0 && only.prepaidMrr > 0;
})());

// ── C. Deferred revenue — cash owed as service ──
// prepaid-annual has 182/365 of a 2,995฿ term left; prepaid-soon has 45/365.
check(
  "C1: deferred is the undelivered share of each term",
  near(c.deferredRevenue, 2995 * (182 / 365) + 2995 * (45 / 365), 2),
  `${Math.round(c.deferredRevenue)}`,
);
check("C2: a subscription contributes no deferred revenue", (() => {
  const subOnly = computeRevenueCohorts(users.slice(0, 1), new Set(["sub-monthly"]),
    { pro: 599, business: 990 }, now, { monthlyRevenueByUser });
  return subOnly.deferredRevenue === 0;
})());
check("C3: deferred never exceeds what was collected", c.deferredRevenue <= 2995 * 2);

// ── D. The cliff ──
check("D1: the nearest expiry is reported", c.prepaidExpiry.nextAt?.toISOString().slice(0, 10) === inDays(45).toISOString().slice(0, 10));
check("D2: only the term ending inside 90 days is flagged", c.prepaidExpiry.within90Days === 1, `${c.prepaidExpiry.within90Days}`);
check("D3: the revenue at stake in 90 days is reported", near(c.prepaidExpiry.within90DaysMrr, 2995 / 12));
check("D4: prepaid customers are counted", c.prepaidExpiry.customers === 2, `${c.prepaidExpiry.customers}`);
check("D5: the expiry window is reported oldest → newest", (c.prepaidExpiry.firstMonth ?? "") <= (c.prepaidExpiry.lastMonth ?? ""));

// ── E. A Bundle customer who ALSO subscribes to Studio still counts as recurring ──
// The first version read the combined entitlement classification, which returns "BUNDLE"
// whenever an active Bundle exists — so this customer's live, auto-renewing Studio
// subscription was booked as a one-time prepaid term: out of ARR, given a fabricated
// deferred figure, and shown in the "does not auto-renew" cliff banner.
const dual: CohortUser[] = [{
  ...base,
  id: "dual", email: "dual@x.test", plan: "PRO", subStatus: "active",
  billingPeriod: "monthly", planExpiresAt: inDays(20), stripeSubscriptionId: "sub_dual",
  bundleStatus: "ACTIVE", bundleAccessExpiresAt: inDays(200),
  bundleBillingPeriod: "annual", bundleAmountThb: 12_000,
}];
const d = computeRevenueCohorts(dual, new Set(["dual"]), { pro: 599, business: 990 }, now, {
  monthlyRevenueByUser: new Map([["dual", 599]]),
});
check("E1: a Bundle+subscription customer counts as recurring", near(d.recurringMrr, 599), `${d.recurringMrr}`);
check("E2: …and NOT as prepaid", d.prepaidMrr === 0, `${d.prepaidMrr}`);
check("E3: …so their subscription reaches ARR", near(d.arr, 599 * 12), `${d.arr}`);
check("E4: …and no deferred obligation is invented for them", d.deferredRevenue === 0, `${d.deferredRevenue}`);
check("E5: …and they never appear in the expiry cliff", d.prepaidExpiry.customers === 0, `${d.prepaidExpiry.customers}`);

// ── F. A prepaid payer with no expiry date must not produce a blank cliff banner ──
// PERMANENT_OR_MANUAL entitlements have planExpiresAt = null, so they count as prepaid but
// contribute no month. The banner is gated on firstMonth for exactly this reason.
const permanent = computeRevenueCohorts(
  [{ ...base, id: "perm", email: "perm@x.test", plan: "PRO", subStatus: null,
     billingPeriod: null, planExpiresAt: null, stripeSubscriptionId: null }],
  new Set(["perm"]), { pro: 599, business: 990 }, now,
  { monthlyRevenueByUser: new Map([["perm", 599]]) },
);
check("F1: a payer with no expiry adds no month to the window", permanent.prepaidExpiry.firstMonth === null);
check("F2: …and no deferred obligation", permanent.prepaidExpiry.customers >= 0 && permanent.deferredRevenue === 0);
const panel = readFileSync(join(process.cwd(), "src/components/admin/cost-margin-panel.tsx"), "utf8");
check(
  "F3: the cliff banner is gated on a real month, not just a customer count",
  /prepaidExpiry\.customers > 0 && cu\.prepaidExpiry\.firstMonth/.test(panel),
);

// ── G. Nothing existing moved ──
check("G1: paying total unchanged by the split", c.payingTotal === 3, `${c.payingTotal}`);
check("G2: blended MRR still reported for continuity", near(c.mrr, 599 + (2995 / 12) * 2));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

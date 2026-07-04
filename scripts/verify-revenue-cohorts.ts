// verify-revenue-cohorts.ts — proof that revenue cohorts reflect reality.
//
// Guards the bugs this work fixes (all confirmed against prod 2026-07-04):
//   1. Trials (plan=PRO, no payment) must NOT count as paying.
//   2. One-time/PromptPay annual payers (subStatus=null, TIMED_PLAN) MUST count as paying + MRR.
//   3. "Paying" is anchored on CASH (a PAID Payment), not entitlement — coupon/admin/comp users
//      have paid-plan access but are NOT revenue (they go to `comped`, split team/coupon/other).
//   4. Someone who paid before but lapsed to FREE is a churned payer (`lapsedPayers`), not free.
//
// Pure test (no DB). Run: npx tsx scripts/verify-revenue-cohorts.ts
import { computeRevenueCohorts, ANNUAL_PRICE_MONTHS, type CohortUser } from "../src/lib/revenue-cohorts";

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}
function approx(a: number, b: number) { return Math.abs(a - b) < 0.01; }

const now = new Date("2026-07-04T00:00:00Z");
const future = new Date("2026-12-31T00:00:00Z");
const past = new Date("2026-01-01T00:00:00Z");
const PRICES = { pro: 599, business: 990 };

function u(id: string, o: Partial<CohortUser>): CohortUser {
  return {
    id, email: `${id}@x.com`, plan: "FREE", role: "USER", subStatus: null, billingPeriod: null,
    planExpiresAt: null, trialStartedAt: null, trialEndsAt: null, stripeSubscriptionId: null, ...o,
  };
}

const users: CohortUser[] = [
  u("u1", { plan: "PRO", subStatus: "active", billingPeriod: "monthly", planExpiresAt: future, stripeSubscriptionId: "s1" }), // sub monthly PRO, cash
  u("u2", { plan: "BUSINESS", subStatus: "active", billingPeriod: "annual", planExpiresAt: future, stripeSubscriptionId: "s2" }), // sub annual BIZ, cash
  u("u3", { plan: "PRO", billingPeriod: "annual", planExpiresAt: future }), // PromptPay annual PRO (subStatus null), cash
  u("u4", { plan: "PRO", billingPeriod: "monthly", planExpiresAt: future }), // one-time monthly PRO, cash
  u("u5", { plan: "PRO", trialStartedAt: past, trialEndsAt: future }), // active trial (no cash)
  u("u6", { plan: "PRO", trialStartedAt: past, trialEndsAt: past }), // expired trial (no cash)
  u("u7", { plan: "PRO", planExpiresAt: past }), // expired timed plan (no cash)
  u("u8", { plan: "BUSINESS" }), // permanent/manual BIZ, no cash, not team/coupon → comped other
  u("u9", { plan: "FREE" }), // free
  u("u10", { plan: "PRO", email: "student@aoacademy.com", planExpiresAt: future }), // team comp (no cash)
  u("u11", { plan: "PRO", planExpiresAt: future }), // coupon comp (no cash) — in couponUserIds
  u("u12", { plan: "FREE" }), // paid before, now FREE → lapsed payer (cash)
  u("u13", { plan: "PRO", email: "founder@aoacademy.com", billingPeriod: "annual", planExpiresAt: future }), // team member who ALSO paid cash
];

const paidUserIds = new Set(["u1", "u2", "u3", "u4", "u12", "u13"]);
const couponUserIds = new Set(["u11"]);
const c = computeRevenueCohorts(users, paidUserIds, PRICES, now, { couponUserIds });

// ── Paying = cash-backed + currently entitled ────────────────────────────────
ok(c.payingTotal === 5, `payingTotal = 5 (cash + entitled) → ${c.payingTotal}`);
ok(c.paying.subMonthly === 1, `subMonthly = 1 → ${c.paying.subMonthly}`);
ok(c.paying.subAnnual === 1, `subAnnual = 1 → ${c.paying.subAnnual}`);
ok(c.paying.oneTimeMonthly === 1, `oneTimeMonthly = 1 → ${c.paying.oneTimeMonthly}`);
ok(c.paying.oneTimeAnnual === 2, `oneTimeAnnual = 2 (PromptPay annual + paying team member) → ${c.paying.oneTimeAnnual}`);
ok(c.payingByTier.pro === 4, `payingByTier.pro = 4 → ${c.payingByTier.pro}`);
ok(c.payingByTier.business === 1, `payingByTier.business = 1 → ${c.payingByTier.business}`);

// ── Not-revenue buckets ──────────────────────────────────────────────────────
ok(c.trialActive === 1, `trialActive = 1 (never paying) → ${c.trialActive}`);
ok(c.compedPaid === 3, `compedPaid = 3 (team + coupon + other) → ${c.compedPaid}`);
ok(c.comped.team === 1, `comped.team = 1 → ${c.comped.team}`);
ok(c.comped.coupon === 1, `comped.coupon = 1 → ${c.comped.coupon}`);
ok(c.comped.other === 1, `comped.other = 1 → ${c.comped.other}`);
ok(c.internalTeam === 2, `internalTeam = 2 (@aoacademy, incl. the one who paid) → ${c.internalTeam}`);
ok(c.lapsedPayers === 1, `lapsedPayers = 1 (paid then reverted to FREE) → ${c.lapsedPayers}`);
ok(c.expiredTrial === 1, `expiredTrial = 1 → ${c.expiredTrial}`);
ok(c.expiredPlan === 1, `expiredPlan = 1 → ${c.expiredPlan}`);
ok(c.free === 1, `free = 1 → ${c.free}`);
ok(c.breakEvenSubs === 5, `breakEvenSubs = payingTotal = 5 → ${c.breakEvenSubs}`);

// ── MRR (annual normalized to 10/12 of monthly, active cash payers only) ──────
const annualPro = (599 * ANNUAL_PRICE_MONTHS) / 12; // 499.1667
const annualBiz = (990 * ANNUAL_PRICE_MONTHS) / 12; // 825
const expectedMrr = 599 /*u1*/ + annualBiz /*u2*/ + annualPro /*u3*/ + 599 /*u4*/ + annualPro /*u13*/;
ok(approx(c.mrr, expectedMrr), `mrr = ${expectedMrr.toFixed(2)} (annual normalized) → got ${c.mrr.toFixed(2)}`);
ok(approx(c.mrrByTier.business, annualBiz), `mrrByTier.business = ${annualBiz} → ${c.mrrByTier.business.toFixed(2)}`);

// ── Regression guards ────────────────────────────────────────────────────────
ok(c.payingTotal !== 8, "comped (team/coupon/other) are NOT counted as paying");
ok(c.trialActive !== 0 && c.compedPaid !== 0, "trials and comps exist and are kept out of revenue");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passed} ok, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

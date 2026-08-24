// Proof of the self-serve checkout guard (server-side enforcement of plan changes).
// Pure logic — no DB needed:
//   npx tsx scripts/verify-plan-change.ts
import {
  checkoutAllowed,
  isFoundingAnnualConversionEligible,
  paidPlanCardMode,
} from "../src/lib/plan-change";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const now = new Date("2026-06-26T00:00:00Z");
const future = new Date("2026-07-10T00:00:00Z");
const past = new Date("2026-06-01T00:00:00Z");

// FREE user — normal upgrade funnel
assert(checkoutAllowed({ plan: "FREE", subStatus: null, trialEndsAt: null }, "PRO", now).allowed === true, "FREE → PRO allowed");
assert(checkoutAllowed({ plan: "FREE", subStatus: null, trialEndsAt: null }, "BUSINESS", now).allowed === true, "FREE → BUSINESS allowed");

// Trial user (plan=PRO, active trial, no sub) — must be able to convert to any paid tier
assert(checkoutAllowed({ plan: "PRO", subStatus: null, trialEndsAt: future }, "PRO", now).allowed === true, "active trial → PRO allowed (self-convert)");
assert(checkoutAllowed({ plan: "PRO", subStatus: null, trialEndsAt: future }, "BUSINESS", now).allowed === true, "active trial → BUSINESS allowed");

// THE bug from the screenshot: BUSINESS subscriber must NOT be able to checkout PRO (downgrade-pay)
const bizSub = checkoutAllowed({ plan: "BUSINESS", subStatus: "active", trialEndsAt: null }, "PRO", now);
assert(bizSub.allowed === false && !bizSub.allowed && bizSub.reason === "active_sub", "BUSINESS active-sub → PRO BLOCKED (active_sub → portal)");

// Active subscriber re-buying / cross-upgrading via checkout is blocked (no duplicate sub)
const proSubUp = checkoutAllowed({ plan: "PRO", subStatus: "active", trialEndsAt: null }, "BUSINESS", now);
assert(proSubUp.allowed === false, "PRO active-sub → BUSINESS BLOCKED via checkout (must use portal — no double-sub)");
const proSubSame = checkoutAllowed({ plan: "PRO", subStatus: "active", trialEndsAt: null }, "PRO", now);
assert(proSubSame.allowed === false, "PRO active-sub → PRO BLOCKED (no duplicate subscription)");

// One-time / manual paid (no active sub): block paying for a LOWER tier, allow same/higher
const bizOneTime = checkoutAllowed({ plan: "BUSINESS", subStatus: null, trialEndsAt: null }, "PRO", now);
assert(bizOneTime.allowed === false && !bizOneTime.allowed && bizOneTime.reason === "downgrade", "BUSINESS one-time → PRO BLOCKED (downgrade)");
assert(checkoutAllowed({ plan: "PRO", subStatus: null, trialEndsAt: null }, "BUSINESS", now).allowed === true, "PRO one-time → BUSINESS allowed (upgrade, additive)");
assert(checkoutAllowed({ plan: "PRO", subStatus: null, trialEndsAt: null }, "PRO", now).allowed === true, "PRO one-time → PRO allowed (renew/extend)");

// An active one-time term can be extended by another one-time payment, but a
// card subscription would start billing immediately and overlap/erase prepaid time.
const timedCard = checkoutAllowed(
  { plan: "PRO", subStatus: null, trialEndsAt: null, planExpiresAt: future, hasQualifyingCashPayment: true },
  "PRO",
  now,
  { recurring: true },
);
assert(!timedCard.allowed && timedCard.reason === "active_timed_plan",
  "active PromptPay/timed plan → card subscription BLOCKED until expiry");
assert(checkoutAllowed(
  { plan: "PRO", subStatus: null, trialEndsAt: null, planExpiresAt: future, hasQualifyingCashPayment: false },
  "PRO",
  now,
  { recurring: true },
).allowed === true, "GRANT/promo timed PRO can convert to monthly without waiting for expiry");
assert(checkoutAllowed(
  { plan: "PRO", subStatus: null, trialEndsAt: null, planExpiresAt: future },
  "PRO",
  now,
  { recurring: false },
).allowed === true, "active PromptPay/timed plan → PromptPay renewal remains additive");
assert(checkoutAllowed(
  { plan: "PRO", subStatus: null, trialEndsAt: null, planExpiresAt: past },
  "PRO",
  now,
  { recurring: true },
).allowed === true, "expired timed plan → card subscription allowed");

// Expired trial (trialEndsAt in past, plan still PRO, no sub) → treated as PRO rank, not FREE.
// A still-PRO row with an expired trial is mid-downgrade; buying PRO again is fine (allowed).
assert(checkoutAllowed({ plan: "PRO", subStatus: null, trialEndsAt: past }, "PRO", now).allowed === true, "expired-trial PRO → PRO allowed");

// Pricing-page presentation must mirror the checkout rules without mistaking every
// PRO account for an active paid subscription.
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: true }, "PRO") === "purchase", "signup-trial PRO stays purchasable");
assert(paidPlanCardMode({
  currentPlan: "PRO", subStatus: null, isTrialPlan: true, planExpiresAt: future, paymentMethod: "card",
}, "BUSINESS", "monthly", now) === "purchase", "active PRO trial can convert directly to BUSINESS by card");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "PRO") === "renew", "granted/one-time PRO can renew PRO");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: "active", isTrialPlan: false }, "PRO") === "current", "active PRO cannot duplicate PRO");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: "active", isTrialPlan: false }, "BUSINESS") === "manage", "active subscription changes via Billing");
assert(paidPlanCardMode({ currentPlan: "BUSINESS", subStatus: null, isTrialPlan: false }, "PRO") === "downgrade", "BUSINESS cannot pay to downgrade");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "BUSINESS") === "purchase", "non-subscription PRO can upgrade");
assert(paidPlanCardMode({
  currentPlan: "PRO", subStatus: null, isTrialPlan: false, planExpiresAt: future, paymentMethod: "card",
}, "PRO", "monthly", now) === "wait", "pricing blocks card while a timed plan still has prepaid days");
assert(paidPlanCardMode({
  currentPlan: "PRO", subStatus: null, isTrialPlan: false, planExpiresAt: future, paymentMethod: "promptpay",
}, "PRO", "annual", now) === "renew", "pricing still offers additive PromptPay renewal for a timed plan");

// An active monthly subscriber selecting the same tier's annual card is not on
// the "current" product. The existing subscription must be changed in place so
// Stripe can show the Founding discount and unused-month credit before confirm.
const periodAwareMode = paidPlanCardMode as unknown as (
  state: { currentPlan: string; subStatus: string | null; isTrialPlan: boolean; billingPeriod: string | null },
  cardPlan: string,
  cardPeriod: "monthly" | "annual",
) => ReturnType<typeof paidPlanCardMode>;
assert(
  periodAwareMode(
    { currentPlan: "PRO", subStatus: "active", isTrialPlan: false, billingPeriod: "monthly" },
    "PRO",
    "annual",
  ) === "manage",
  "active monthly PRO → annual PRO is a subscription change, not current",
);
assert(
  periodAwareMode(
    { currentPlan: "PRO", subStatus: "active", isTrialPlan: false, billingPeriod: "monthly" },
    "PRO",
    "monthly",
  ) === "current",
  "active monthly PRO → monthly PRO remains current",
);

const foundingCandidate = {
  currentPlan: "PRO",
  targetPlan: "PRO",
  subStatus: "active",
  billingPeriod: "monthly",
  selectedPeriod: "annual" as const,
  paymentMethod: "card" as const,
  foundingActive: true,
};
assert(isFoundingAnnualConversionEligible(foundingCandidate), "active monthly PRO can convert to Founding PRO annual by card");
assert(isFoundingAnnualConversionEligible({ ...foundingCandidate, targetPlan: "BUSINESS" }), "active monthly PRO can upgrade to Founding BUSINESS annual");
assert(!isFoundingAnnualConversionEligible({ ...foundingCandidate, currentPlan: "BUSINESS", targetPlan: "PRO" }), "Founding conversion never downgrades BUSINESS → PRO");
assert(!isFoundingAnnualConversionEligible({ ...foundingCandidate, paymentMethod: "promptpay" }), "active subscription cannot overlap a PromptPay annual purchase");
assert(!isFoundingAnnualConversionEligible({ ...foundingCandidate, billingPeriod: "annual" }), "existing annual subscription is not converted again");
assert(!isFoundingAnnualConversionEligible({ ...foundingCandidate, foundingActive: false }), "sold-out Founding offer cannot start conversion");

console.log(`\n✅ ALL ${passed} PLAN-CHANGE GUARD CHECKS PASSED`);

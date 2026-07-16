// Proof of the self-serve checkout guard (server-side enforcement of plan changes).
// Pure logic — no DB needed:
//   npx tsx scripts/verify-plan-change.ts
import { checkoutAllowed, paidPlanCardMode } from "../src/lib/plan-change";

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

// Expired trial (trialEndsAt in past, plan still PRO, no sub) → treated as PRO rank, not FREE.
// A still-PRO row with an expired trial is mid-downgrade; buying PRO again is fine (allowed).
assert(checkoutAllowed({ plan: "PRO", subStatus: null, trialEndsAt: past }, "PRO", now).allowed === true, "expired-trial PRO → PRO allowed");

// Pricing-page presentation must mirror the checkout rules without mistaking every
// PRO account for an active paid subscription.
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: true }, "PRO") === "purchase", "signup-trial PRO stays purchasable");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "PRO") === "renew", "granted/one-time PRO can renew PRO");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: "active", isTrialPlan: false }, "PRO") === "current", "active PRO cannot duplicate PRO");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: "active", isTrialPlan: false }, "BUSINESS") === "manage", "active subscription changes via Billing");
assert(paidPlanCardMode({ currentPlan: "BUSINESS", subStatus: null, isTrialPlan: false }, "PRO") === "downgrade", "BUSINESS cannot pay to downgrade");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "BUSINESS") === "purchase", "non-subscription PRO can upgrade");

console.log(`\n✅ ALL ${passed} PLAN-CHANGE GUARD CHECKS PASSED`);

// Pure proof that recurring Stripe prices, rather than stale DB state, define
// the plan/billing period and that Stripe's item period end is authoritative.
//   npx tsx scripts/verify-stripe-subscription-entitlement.ts
import { resolveRecurringEntitlement } from "../src/lib/stripe-subscription-entitlement";

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) { console.error("❌ " + message); process.exit(1); }
  console.log("✓ " + message);
  passed++;
}

const catalog = [
  { priceId: "price_pro_month", plan: "PRO" as const, billingPeriod: "monthly" as const },
  { priceId: "price_pro_year", plan: "PRO" as const, billingPeriod: "annual" as const },
  { priceId: "price_business_month", plan: "BUSINESS" as const, billingPeriod: "monthly" as const },
  { priceId: "price_business_year", plan: "BUSINESS" as const, billingPeriod: "annual" as const },
];

const annualPeriodEnd = 1_810_000_000;
const annual = resolveRecurringEntitlement({
  items: [{ priceId: "price_pro_year", currentPeriodEnd: annualPeriodEnd }],
}, catalog);
assert(annual?.plan === "PRO", "annual PRO price maps to PRO");
assert(annual?.billingPeriod === "annual", "annual PRO price maps to annual billing");
assert(annual?.periodEnd.getTime() === annualPeriodEnd * 1000, "Stripe item current_period_end is the exact entitlement end");

const upgraded = resolveRecurringEntitlement({
  items: [{ priceId: "price_business_year", currentPeriodEnd: annualPeriodEnd }],
}, catalog);
assert(upgraded?.plan === "BUSINESS" && upgraded.billingPeriod === "annual", "annual BUSINESS price changes tier and period together");

assert(resolveRecurringEntitlement({
  items: [{ priceId: "price_unknown", currentPeriodEnd: annualPeriodEnd }],
}, catalog) === null, "unknown recurring price fails closed");
assert(resolveRecurringEntitlement({
  items: [
    { priceId: "price_pro_year", currentPeriodEnd: annualPeriodEnd },
    { priceId: "price_business_year", currentPeriodEnd: annualPeriodEnd },
  ],
}, catalog) === null, "multi-item subscription is unsupported");
assert(resolveRecurringEntitlement({
  items: [{ priceId: "price_pro_year", currentPeriodEnd: 0 }],
}, catalog) === null, "missing Stripe period end fails closed");

console.log(`\n✅ ALL ${passed} STRIPE SUBSCRIPTION ENTITLEMENT CHECKS PASSED`);

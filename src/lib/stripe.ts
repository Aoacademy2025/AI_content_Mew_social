import Stripe from "stripe";
import { storageDaysForPlan } from "@/lib/plan-limits";

// Lazy proxy — avoids "Neither apiKey nor config.authenticator provided"
// errors at build time when STRIPE_SECRET_KEY isn't set.
// Real Stripe is constructed on first use inside route handlers (runtime),
// where the env var is guaranteed to be loaded.
let _stripe: Stripe | null = null;
let _stripeKey: string | null = null;

export function resetStripeClient() {
  _stripe = null;
  _stripeKey = null;
}

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Configure it in .env (or VPS env) before calling Stripe.",
    );
  }
  // Rebuild client if key changed (e.g. Admin UI updated it at runtime)
  if (_stripe && _stripeKey === key) return _stripe;
  _stripe = new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
  _stripeKey = key;
  return _stripe;
}

// Proxy: any property/method access goes through getStripe()
// so import { stripe } from "@/lib/stripe" still works unchanged.
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const real = getStripe();
    const val = (real as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(real) : val;
  },
});

// Retention (storage days) is the single source of truth in plan-limits.ts.
// Update there to change how long videos stay before auto-delete.
export const PLANS = {
  PRO: {
    name: "Pro",
    thb: 599,
    clips: 100,
    maxMin: 6,
    retention: storageDaysForPlan("PRO"),
    // legacy (current one-time checkout/webhook use these until Phase 2b/2c migrate to resolvePrice)
    periodDays: 30,
    get priceId() { return process.env.STRIPE_PRICE_PRO_MONTHLY ?? ""; },
    // Phase 2 — dual pricing (card subscription monthly/annual + PromptPay annual one-time)
    monthly:       { get priceId() { return process.env.STRIPE_PRICE_PRO_MONTHLY ?? ""; }, periodDays: 30,  recurring: true },
    annual:        { get priceId() { return process.env.STRIPE_PRICE_PRO_ANNUAL ?? ""; },  periodDays: 365, recurring: true },
    annualOnetime: { get priceId() { return process.env.STRIPE_PRICE_PRO_ANNUAL_ONETIME ?? ""; }, periodDays: 365, recurring: false },
  },
  BUSINESS: {
    name: "Business",
    thb: 990,
    clips: 300,
    maxMin: 10,
    retention: storageDaysForPlan("BUSINESS"),
    periodDays: 30,
    get priceId() { return process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? ""; },
    monthly:       { get priceId() { return process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? ""; }, periodDays: 30,  recurring: true },
    annual:        { get priceId() { return process.env.STRIPE_PRICE_BUSINESS_ANNUAL ?? ""; },  periodDays: 365, recurring: true },
    annualOnetime: { get priceId() { return process.env.STRIPE_PRICE_BUSINESS_ANNUAL_ONETIME ?? ""; }, periodDays: 365, recurring: false },
  },
} as const;

export type PlanKey = keyof typeof PLANS;
export type BillingPeriod = "monthly" | "annual";

/**
 * Pick the Stripe price + period for a checkout.
 * - monthly  → card subscription only (recurring)
 * - annual   → card subscription (recurring) OR PromptPay one-time
 */
export function resolvePrice(plan: PlanKey, period: BillingPeriod, method: "card" | "promptpay") {
  const p = PLANS[plan];
  if (period === "monthly") return p.monthly;
  return method === "promptpay" ? p.annualOnetime : p.annual;
}

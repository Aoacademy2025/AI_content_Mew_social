import Stripe from "stripe";
import { storageDaysForPlan } from "@/lib/plan-limits";

// Lazy proxy — avoids "Neither apiKey nor config.authenticator provided"
// errors at build time when STRIPE_SECRET_KEY isn't set.
// Real Stripe is constructed on first use inside route handlers (runtime),
// where the env var is guaranteed to be loaded.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Configure it in .env (or VPS env) before calling Stripe.",
    );
  }
  _stripe = new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
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
    periodDays: 30,
    priceId: process.env.STRIPE_PRICE_PRO_MONTHLY ?? "",
    clips: 100,
    maxMin: 6,
    retention: storageDaysForPlan("PRO"),
  },
  BUSINESS: {
    name: "Business",
    thb: 990,
    periodDays: 30,
    priceId: process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? "",
    clips: 300,
    maxMin: 10,
    retention: storageDaysForPlan("BUSINESS"),
  },
} as const;

export type PlanKey = keyof typeof PLANS;

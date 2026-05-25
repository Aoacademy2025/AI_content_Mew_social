import Stripe from "stripe";
import { storageDaysForPlan } from "@/lib/plan-limits";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-04-22.dahlia",
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

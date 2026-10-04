import { ensureStripeConfig } from "@/lib/load-stripe-config";

/**
 * PromptPay 30-day prepaid term for the monthly plans (ADR 0066,
 * docs/plans/2026-10-04-promptpay-monthly.md).
 *
 * This file is the SINGLE place the `PROMPTPAY_MONTHLY` flag is read. It is a
 * server env var with no NEXT_PUBLIC_ twin: server pages compute the answers
 * below and pass them to client components as props (the
 * PRESERVE_TRIAL_ON_CONVERT pattern). Flag off → every caller must behave
 * exactly as it did before this feature.
 */

export const PROMPTPAY_MONTHLY_FLAG = "PROMPTPAY_MONTHLY";

type Env = Record<string, string | undefined>;
type PaidTier = "PRO" | "BUSINESS";

/** Same env names `PLANS[tier].monthlyOnetime.priceId` reads (src/lib/stripe.ts). */
const MONTHLY_ONETIME_PRICE_ENV: Record<PaidTier, string> = {
  PRO: "STRIPE_PRICE_PRO_MONTHLY_ONETIME",
  BUSINESS: "STRIPE_PRICE_BUSINESS_MONTHLY_ONETIME",
};

function isPaidTier(plan: unknown): plan is PaidTier {
  return plan === "PRO" || plan === "BUSINESS";
}

/** The one place the flag is read. */
export function promptpayMonthlyEnabled(env: Env = process.env): boolean {
  return env[PROMPTPAY_MONTHLY_FLAG] === "1";
}

/**
 * "Offered" for a tier = flag on AND that tier's monthly one-time Stripe price
 * is configured. Flag off returns false immediately, before any config/DB read,
 * so surfaces that ask (e.g. the marketing homepage) pay nothing for it.
 *
 * `deps` exists for tests; production callers pass only the plan.
 */
export async function promptpayMonthlyOffered(
  plan: string,
  deps: { env?: Env; ensureConfig?: () => Promise<void> } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!promptpayMonthlyEnabled(env)) return false;
  if (!isPaidTier(plan)) return false;
  // Price ids can live only in SiteConfig (pasted in /admin); load them first.
  await (deps.ensureConfig ?? ensureStripeConfig)();
  return (env[MONTHLY_ONETIME_PRICE_ENV[plan]] ?? "") !== "";
}

export type CancelReturnParams = {
  plan?: "PRO" | "BUSINESS";
  period?: "monthly" | "annual";
  method?: "card" | "promptpay";
};

type SearchParamsInput =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function readParam(searchParams: SearchParamsInput, key: string): string | undefined {
  if (searchParams instanceof URLSearchParams) {
    const all = searchParams.getAll(key);
    return all.length === 1 ? all[0] : undefined;
  }
  const value = Object.prototype.hasOwnProperty.call(searchParams, key) ? searchParams[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

/**
 * Whitelist for the cancel-return query (`/pricing?payment=cancelled&plan=…&period=…&method=…`).
 * Each param is judged on its own and must match exactly; anything else —
 * other values, different case, a repeated param — is dropped as undefined.
 * These values are reflected into the UI and into a checkout call, so nothing
 * outside the whitelist may pass.
 */
export function parseCancelReturnParams(searchParams: SearchParamsInput): CancelReturnParams {
  return {
    plan: pick(readParam(searchParams, "plan"), ["PRO", "BUSINESS"] as const),
    period: pick(readParam(searchParams, "period"), ["monthly", "annual"] as const),
    method: pick(readParam(searchParams, "method"), ["card", "promptpay"] as const),
  };
}

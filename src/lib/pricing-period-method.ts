// Pure UI-decision helpers for PromptPay monthly on the pricing surfaces (ADR 0066,
// docs/plans/2026-10-04-promptpay-monthly.md, Task 2). No I/O: the server resolves
// `monthlyOffered` (promptpayMonthlyOffered per tier) and `promptpayMonthlyEnabled`
// (the flag) once, and passes both down as props/ctx so these can be unit-tested
// without Stripe, Prisma, or React.

export type PaidTier = "PRO" | "BUSINESS";
export type Period = "monthly" | "annual";
export type PaymentMethod = "card" | "promptpay";

export type MonthlyOffered = Record<PaidTier, boolean>;

export type PromptpayCtx = {
  /** `promptpayMonthlyEnabled()` — the server-only flag, resolved once on the server. */
  promptpayMonthlyEnabled: boolean;
  /** `{ PRO: await promptpayMonthlyOffered("PRO"), BUSINESS: await promptpayMonthlyOffered("BUSINESS") }`. */
  monthlyOffered: MonthlyOffered;
};

/** True when at least one paid tier's monthly PromptPay term is offered. */
export function monthlyPromptpayAvailable(monthlyOffered: MonthlyOffered): boolean {
  return monthlyOffered.PRO || monthlyOffered.BUSINESS;
}

/**
 * Whether PromptPay is "offered" for a whole period, independent of a specific tier.
 * Monthly depends on at least one tier's one-time price being configured (the flag
 * alone isn't enough — Task 1's `promptpayMonthlyOffered`). Annual's one-time price
 * is the pre-existing, un-gated feature, so annual counts as offered whenever the
 * PROMPTPAY_MONTHLY flag itself is on (this plan's new annual behaviors, e.g. the
 * cancel banner, are gated by the flag; the annual price itself is not).
 */
export function periodPromptpayOffered(period: Period, ctx: PromptpayCtx): boolean {
  return period === "monthly" ? monthlyPromptpayAvailable(ctx.monthlyOffered) : ctx.promptpayMonthlyEnabled;
}

/**
 * The method actually usable for a SPECIFIC tier on the monthly period. Mirrors the
 * server's `resolveCheckoutSelection` coercion (monthly+promptpay -> card when not
 * offered for that tier) so the card note and the checkout call never disagree.
 */
export function resolveMonthlyMethodForTier(
  selected: PaymentMethod,
  tier: PaidTier,
  monthlyOffered: MonthlyOffered,
): PaymentMethod {
  return selected === "promptpay" && monthlyOffered[tier] ? "promptpay" : "card";
}

/**
 * Should a cancelled-session return show the PromptPay one-click banner (Copy)?
 * Only when the abandoned session was card, and PromptPay is offered for that
 * EXACT plan + period (monthly: that tier's own price; annual: the flag).
 */
export function cancelBannerOffered(
  params: { plan?: PaidTier; period?: Period; method?: PaymentMethod },
  ctx: PromptpayCtx,
): boolean {
  if (!params.plan || !params.period || params.method !== "card") return false;
  return params.period === "monthly" ? ctx.monthlyOffered[params.plan] : ctx.promptpayMonthlyEnabled;
}

/**
 * Should the page preselect PromptPay for `period` from an explicit `?method=promptpay`
 * link (e.g. the past-due banner)? Only when PromptPay is actually offered for that
 * period. Generic over period on purpose — see `seedMethodFromCancelReturn` below,
 * which is the one callers actually use for both monthly and annual state seeding.
 */
export function shouldPreselectPromptpay(
  params: { period?: Period; method?: PaymentMethod },
  ctx: PromptpayCtx,
): boolean {
  if (params.method !== "promptpay" || !params.period) return false;
  return periodPromptpayOffered(params.period, ctx);
}

/**
 * Seed a period's selected payment method (monthly's `monthlyMethod`, or annual's
 * `method`) from an explicit, whitelisted `cancelReturn` param — e.g. a past-due or
 * renewal link's `?method=promptpay`/`?method=card` — falling back to `defaultMethod`
 * (today's own default-selection logic for that period, unchanged) whenever the
 * override does not apply.
 *
 * Session ruling reconciling "Annual keeps today's default logic" with Task 4's
 * annual links: that line describes the DEFAULT when no explicit `method` param is
 * given. An explicit whitelisted `method` overrides that default on the exact period
 * it targets (monthly or annual) — it never leaks to the other period.
 *
 * The whole override is itself "under the flag": with `promptpayMonthlyEnabled`
 * false, `method` is ignored on every period exactly as today, including an explicit
 * `method=card` (which would be a no-op today anyway, but we gate it identically for
 * one predictable rule rather than two).
 */
export function seedMethodFromCancelReturn(
  period: Period,
  cancelReturn: { period?: Period; method?: PaymentMethod },
  ctx: PromptpayCtx,
  defaultMethod: PaymentMethod,
): PaymentMethod {
  if (!ctx.promptpayMonthlyEnabled || cancelReturn.period !== period || !cancelReturn.method) {
    return defaultMethod;
  }
  if (cancelReturn.method === "card") return "card";
  return periodPromptpayOffered(period, ctx) ? "promptpay" : defaultMethod;
}

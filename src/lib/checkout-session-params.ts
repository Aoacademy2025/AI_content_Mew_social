import type Stripe from "stripe";
import { resolvePrice, type BillingPeriod, type PlanKey } from "@/lib/stripe";
import { studioProductSlug } from "@/lib/affiliate-ref";

/**
 * Pure builders for POST /api/payments/checkout. The route does the I/O (auth,
 * DB, cookies, Stripe calls) and wires these; everything that decides WHAT is
 * sold lives here so scripts/verify-promptpay-monthly.ts can prove it without
 * Stripe or a Next.js route module.
 */

export type CheckoutMethod = "card" | "promptpay";

export type CheckoutSelectionInput = {
  plan: PlanKey;
  period: BillingPeriod;
  /** Raw `method` from the request body; anything other than "promptpay" means card. */
  requestedMethod: unknown;
  /**
   * `await promptpayMonthlyOffered(plan)` — false whenever PROMPTPAY_MONTHLY is
   * off or this tier's monthly one-time price is not configured.
   */
  monthlyPromptpayOffered: boolean;
};

export type CheckoutSelection = {
  method: CheckoutMethod;
  priceCfg: ReturnType<typeof resolvePrice>;
  /** card monthly/annual → subscription · PromptPay (monthly 30-day / annual) → one-time */
  isSub: boolean;
};

/**
 * Which price is being bought, and how.
 *
 * Monthly PromptPay is a one-time 30-day term (ADR 0066) and is sold only when
 * offered. When it is not offered a monthly+promptpay request is coerced to
 * card — exactly the previous behaviour, since PromptPay cannot back a
 * recurring subscription.
 */
export function resolveCheckoutSelection(input: CheckoutSelectionInput): CheckoutSelection {
  const requested: CheckoutMethod = input.requestedMethod === "promptpay" ? "promptpay" : "card";
  const method: CheckoutMethod =
    input.period === "monthly" && requested === "promptpay" && !input.monthlyPromptpayOffered ? "card" : requested;
  const priceCfg = resolvePrice(input.plan, input.period, method);
  return { method, priceCfg, isSub: priceCfg.recurring };
}

export type CheckoutSessionParamsInput = CheckoutSelectionInput & {
  /** `promptpayMonthlyEnabled()` — gates the cancel-return params. */
  promptpayMonthlyEnabled: boolean;
  userId: string;
  customerId: string;
  /** Canonical app origin (never the caller's Origin header). */
  origin: string;
  appliedPromotionCode: string | null;
  appliedCouponId: string | null;
  /** A Founding seat was claimed for this session. */
  isFounding: boolean;
  /** A confirmed Founding member upgrading tier reuses their seat (HERO-61). */
  isFoundingMemberUpgrade: boolean;
  /** Sanitized affiliate ref code, or null. */
  refCode: string | null;
  /** Unix SECONDS for `subscription_data.trial_end` (#348), or null. */
  stripeTrialEnd: number | null;
  /** Epoch ms used for `expires_at`; the route passes Date.now(). */
  nowMs: number;
};

/**
 * Where a cancelled Checkout returns to.
 *
 * Flag off → today's URL, byte for byte. Flag on → it names the session the
 * customer abandoned (plan / period / effective method) so /pricing can offer a
 * one-click PromptPay checkout for the same purchase. A monthly session of a
 * tier whose monthly PromptPay is NOT offered keeps today's URL: that tier
 * behaves as flag off for monthly PromptPay, and there is nothing to offer.
 * The values are enums the route already validated; /pricing still whitelists
 * them on read (parseCancelReturnParams).
 */
function cancelUrl(input: CheckoutSessionParamsInput, method: CheckoutMethod): string {
  const base = `${input.origin}/pricing?payment=cancelled`;
  const describesSession =
    input.promptpayMonthlyEnabled && (input.period === "annual" || input.monthlyPromptpayOffered);
  if (!describesSession) return base;
  const plan = encodeURIComponent(input.plan);
  const period = encodeURIComponent(input.period);
  return `${base}&plan=${plan}&period=${period}&method=${encodeURIComponent(method)}`;
}

/**
 * The `stripe.checkout.sessions.create` argument. With PROMPTPAY_MONTHLY off
 * this is the exact object the route built before this feature, for every
 * request (verify-promptpay-monthly.ts diffs it against a frozen copy).
 */
export function buildCheckoutSessionParams(input: CheckoutSessionParamsInput): Stripe.Checkout.SessionCreateParams {
  const { plan, period, userId, customerId, origin } = input;
  const { method, priceCfg, isSub } = resolveCheckoutSelection(input);
  const { appliedPromotionCode, appliedCouponId, isFounding, isFoundingMemberUpgrade } = input;

  // ── Affiliate attribution ──
  // Tags the Stripe session (+ subscription) so the hero-affiliate webhook can attribute
  // the initial payment AND every renewal invoice. Empty when there's no ref → no-op.
  // A PromptPay monthly term carries the same product id as card monthly.
  const affiliateMeta: Record<string, string> = input.refCode
    ? { ref_code: input.refCode, product_id: studioProductSlug(plan, period), ha_brand: "hero-ai" }
    : {};

  return {
    mode: isSub ? "subscription" : "payment",
    customer: customerId,
    payment_method_types: method === "promptpay" ? ["promptpay"] : ["card"],
    line_items: [{ price: priceCfg.priceId, quantity: 1 }],
    ...(appliedPromotionCode ? { discounts: [{ promotion_code: appliedPromotionCode }] } : {}),
    metadata: {
      userId, plan, period, periodDays: String(priceCfg.periodDays), method,
      ...(appliedCouponId ? { couponId: appliedCouponId } : {}),
      ...(isFounding ? { founding: "1" } : {}),
      ...(isFoundingMemberUpgrade ? { founding: "member" } : {}),
      ...affiliateMeta,
    },
    ...(isSub
      ? {
          subscription_data: {
            metadata: { userId, plan, period, ...affiliateMeta },
            // #348: carry the unused free-trial days into Stripe. The card is
            // still collected now (payment_method_collection stays default);
            // the FIRST charge happens at trial_end. Null whenever the trial
            // is absent, already converted, the flag is off, or fewer than
            // 48h remain (Stripe rejects a nearer trial_end).
            ...(input.stripeTrialEnd ? { trial_end: input.stripeTrialEnd } : {}),
          },
          // bound how long a founding seat is held even for subscription sessions
          ...(isFounding ? { expires_at: Math.floor(input.nowMs / 1000) + 30 * 60 } : {}),
        }
      : { expires_at: Math.floor(input.nowMs / 1000) + 30 * 60 }), // one-time session expires in 30 min
    // The result page confirms this exact, authenticated checkout against
    // our webhook-backed Payment row before it claims that access is ready.
    success_url: `${origin}/settings?tab=billing&payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl(input, method),
  };
}

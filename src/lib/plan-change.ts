// Single source of truth for "can this user self-serve checkout for `requestedPlan`?".
// Used by the checkout API (enforcement) and mirrored by the pricing page (display gating).

export const PLAN_RANK: Record<string, number> = { FREE: 0, PRO: 1, BUSINESS: 2 };

export type PlanChangeState = {
  plan: string;
  subStatus: string | null;
  trialEndsAt: Date | null;
  planExpiresAt?: Date | null;
};

export type CheckoutDecision =
  | { allowed: true }
  | { allowed: false; reason: "active_sub" | "active_timed_plan" | "downgrade" };

export type PaidPlanCardMode = "purchase" | "renew" | "current" | "manage" | "wait" | "downgrade";

export type FoundingAnnualConversionState = {
  currentPlan: string;
  targetPlan: string;
  subStatus: string | null;
  billingPeriod: string | null;
  selectedPeriod: "monthly" | "annual";
  paymentMethod: "card" | "promptpay";
  foundingActive: boolean;
};

/**
 * Whether Pricing may offer the dedicated in-place Stripe conversion. PromptPay
 * remains a separate one-time purchase and must never overlap an active card
 * subscription. The API repeats the subscription and rank checks server-side.
 */
export function isFoundingAnnualConversionEligible(
  state: FoundingAnnualConversionState,
): boolean {
  return state.foundingActive
    && state.subStatus === "active"
    && state.billingPeriod === "monthly"
    && state.selectedPeriod === "annual"
    && state.paymentMethod === "card"
    && (PLAN_RANK[state.targetPlan] ?? 0) >= (PLAN_RANK[state.currentPlan] ?? 0);
}

/**
 * Classify the CTA shown for a paid tier on the Pricing page.
 * Checkout authorization still belongs to `checkoutAllowed`; this function keeps
 * presentation aligned without treating a temporary/manual PRO grant as a Stripe sub.
 */
export function paidPlanCardMode(
  state: {
    currentPlan: string;
    subStatus: string | null;
    isTrialPlan: boolean;
    billingPeriod?: string | null;
    planExpiresAt?: Date | null;
    paymentMethod?: "card" | "promptpay";
  },
  cardPlan: string,
  cardPeriod?: "monthly" | "annual",
  now: Date = new Date(),
): PaidPlanCardMode {
  if (state.isTrialPlan) return "purchase";
  if (state.subStatus === "active") {
    if (cardPlan === state.currentPlan) {
      if (state.billingPeriod && cardPeriod && state.billingPeriod !== cardPeriod) return "manage";
      return "current";
    }
    return "manage";
  }
  if ((PLAN_RANK[cardPlan] ?? 0) < (PLAN_RANK[state.currentPlan] ?? 0)) return "downgrade";
  const recurring = cardPeriod === "monthly" || state.paymentMethod === "card";
  if (recurring && state.planExpiresAt && state.planExpiresAt > now) return "wait";
  if (cardPlan === state.currentPlan) {
    if (cardPlan === "PRO" && state.subStatus !== "active") return "renew";
    return "current";
  }
  return "purchase";
}

/**
 * Decide whether a self-serve Checkout for `requestedPlan` is allowed.
 *  - Active subscriber → blocked (`active_sub`): any tier change must go through the Stripe
 *    billing portal so the existing subscription is swapped/prorated, not duplicated (double-billing).
 *  - Paid one-time/manual user (no active sub) → blocked from paying for a strictly LOWER tier
 *    (`downgrade`): paying to downgrade is never intended.
 *  - FREE user or an active (unconverted) trial → allowed: this is the normal upgrade funnel.
 */
export function checkoutAllowed(
  state: PlanChangeState,
  requestedPlan: string,
  now: Date = new Date(),
  options: { recurring?: boolean } = {},
): CheckoutDecision {
  if (state.subStatus === "active") return { allowed: false, reason: "active_sub" };
  const onActiveTrial = !!state.trialEndsAt && state.trialEndsAt > now;
  const currentRank = onActiveTrial ? 0 : (PLAN_RANK[state.plan] ?? 0);
  if ((PLAN_RANK[requestedPlan] ?? 0) < currentRank) return { allowed: false, reason: "downgrade" };
  // A new card subscription starts billing now. Do not let it overlap an
  // existing one-time term: Stripe's calendar period would either erase the
  // prepaid expiry or charge for months the user already owns. PromptPay
  // one-time renewal remains additive and is intentionally allowed.
  if (options.recurring && !onActiveTrial && state.planExpiresAt && state.planExpiresAt > now) {
    return { allowed: false, reason: "active_timed_plan" };
  }
  return { allowed: true };
}

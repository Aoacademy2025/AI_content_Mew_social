// Single source of truth for "can this user self-serve checkout for `requestedPlan`?".
// Used by the checkout API (enforcement) and mirrored by the pricing page (display gating).

export const PLAN_RANK: Record<string, number> = { FREE: 0, PRO: 1, BUSINESS: 2 };

export type PlanChangeState = {
  plan: string;
  subStatus: string | null;
  trialEndsAt: Date | null;
};

export type CheckoutDecision =
  | { allowed: true }
  | { allowed: false; reason: "active_sub" | "downgrade" };

export type PaidPlanCardMode = "purchase" | "renew" | "current" | "manage" | "downgrade";

/**
 * Classify the CTA shown for a paid tier on the Pricing page.
 * Checkout authorization still belongs to `checkoutAllowed`; this function keeps
 * presentation aligned without treating a temporary/manual PRO grant as a Stripe sub.
 */
export function paidPlanCardMode(
  state: { currentPlan: string; subStatus: string | null; isTrialPlan: boolean },
  cardPlan: string,
): PaidPlanCardMode {
  if (state.isTrialPlan) return "purchase";
  if (cardPlan === state.currentPlan) {
    if (cardPlan === "PRO" && state.subStatus !== "active") return "renew";
    return "current";
  }
  if (state.subStatus === "active") return "manage";
  if ((PLAN_RANK[cardPlan] ?? 0) < (PLAN_RANK[state.currentPlan] ?? 0)) return "downgrade";
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
  now: Date = new Date()
): CheckoutDecision {
  if (state.subStatus === "active") return { allowed: false, reason: "active_sub" };
  const onActiveTrial = !!state.trialEndsAt && state.trialEndsAt > now;
  const currentRank = onActiveTrial ? 0 : (PLAN_RANK[state.plan] ?? 0);
  if ((PLAN_RANK[requestedPlan] ?? 0) < currentRank) return { allowed: false, reason: "downgrade" };
  return { allowed: true };
}

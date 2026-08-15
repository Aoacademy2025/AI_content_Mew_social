import { PLAN_RANK } from "@/lib/plan-change";

export type FoundingAnnualPlan = "PRO" | "BUSINESS";

export type FoundingAnnualConversionUser = {
  id: string;
  plan: string;
  billingPeriod: string | null;
  subStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type FoundingAnnualSubscription = {
  id: string;
  customerId: string;
  status: string;
  items: Array<{ id: string; priceId: string; quantity: number }>;
};

export type FoundingAnnualPortalSessionParams = {
  customer: string;
  configuration: string;
  returnUrl: string;
  afterCompletionUrl: string;
  subscription: string;
  items: Array<{ id: string; price: string; quantity: number }>;
  discounts: Array<{ promotion_code: string }>;
};

export type FoundingAnnualConversionDeps = {
  retrieveSubscription: (subscriptionId: string) => Promise<FoundingAnnualSubscription>;
  claimSeat: (userId: string) => Promise<{
    couponId: string;
    stripePromotionCodeId: string;
  } | null>;
  createPortalSession: (params: FoundingAnnualPortalSessionParams) => Promise<{
    id: string;
    url: string | null;
  }>;
  attachReservation: (userId: string, sessionId: string) => Promise<void>;
  releaseUnattachedSeat: (couponId: string) => Promise<void>;
};

export class FoundingAnnualConversionError extends Error {
  constructor(
    public readonly code:
      | "NOT_ACTIVE_MONTHLY"
      | "MISSING_STRIPE_SUBSCRIPTION"
      | "INVALID_PLAN_CHANGE"
      | "UNSUPPORTED_SUBSCRIPTION"
      | "SOLD_OUT"
      | "PORTAL_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "FoundingAnnualConversionError";
  }
}

/**
 * Build one Stripe-hosted confirmation flow that updates the existing card
 * subscription in place. Stripe owns the invoice preview, unused-month credit,
 * payment failure handling and 3DS; this service owns eligibility and the
 * Founding seat lifecycle around that external boundary.
 */
export async function createFoundingAnnualPortalSession(input: {
  user: FoundingAnnualConversionUser;
  requestedPlan: FoundingAnnualPlan;
  currentMonthlyPriceId: string;
  annualPriceId: string;
  portalConfigurationId: string;
  origin: string;
  deps: FoundingAnnualConversionDeps;
}): Promise<{ sessionId: string; url: string }> {
  const { user, requestedPlan, deps } = input;
  if (user.subStatus !== "active" || user.billingPeriod !== "monthly") {
    throw new FoundingAnnualConversionError(
      "NOT_ACTIVE_MONTHLY",
      "Founding annual conversion requires an active monthly card subscription",
    );
  }
  if (!user.stripeCustomerId || !user.stripeSubscriptionId) {
    throw new FoundingAnnualConversionError(
      "MISSING_STRIPE_SUBSCRIPTION",
      "Stripe customer or subscription is missing",
    );
  }
  if (
    (user.plan !== "PRO" && user.plan !== "BUSINESS")
    || (PLAN_RANK[requestedPlan] ?? 0) < (PLAN_RANK[user.plan] ?? 0)
  ) {
    throw new FoundingAnnualConversionError(
      "INVALID_PLAN_CHANGE",
      "Founding conversion cannot downgrade the active plan",
    );
  }

  const subscription = await deps.retrieveSubscription(user.stripeSubscriptionId);
  const item = subscription.items[0];
  if (
    subscription.id !== user.stripeSubscriptionId
    || subscription.customerId !== user.stripeCustomerId
    || subscription.status !== "active"
    || subscription.items.length !== 1
    || !item
    || !input.currentMonthlyPriceId
    || item.priceId !== input.currentMonthlyPriceId
  ) {
    throw new FoundingAnnualConversionError(
      "UNSUPPORTED_SUBSCRIPTION",
      "The existing subscription cannot be converted automatically",
    );
  }

  const claim = await deps.claimSeat(user.id);
  if (!claim) {
    throw new FoundingAnnualConversionError("SOLD_OUT", "Founding offer is unavailable");
  }

  try {
    const portal = await deps.createPortalSession({
      customer: user.stripeCustomerId,
      configuration: input.portalConfigurationId,
      returnUrl: `${input.origin}/pricing`,
      afterCompletionUrl: `${input.origin}/settings?tab=billing&founding=success`,
      subscription: subscription.id,
      items: [{ id: item.id, price: input.annualPriceId, quantity: item.quantity }],
      discounts: [{ promotion_code: claim.stripePromotionCodeId }],
    });
    if (!portal.url) {
      throw new FoundingAnnualConversionError("PORTAL_UNAVAILABLE", "Stripe portal returned no URL");
    }
    await deps.attachReservation(user.id, portal.id);
    return { sessionId: portal.id, url: portal.url };
  } catch (error) {
    await deps.releaseUnattachedSeat(claim.couponId).catch(() => {});
    throw error;
  }
}

export type RecurringPlan = "PRO" | "BUSINESS";
export type RecurringBillingPeriod = "monthly" | "annual";

export type RecurringPriceDefinition = {
  priceId: string;
  plan: RecurringPlan;
  billingPeriod: RecurringBillingPeriod;
};

export type StripeSubscriptionSnapshot = {
  items: Array<{ priceId: string; currentPeriodEnd: number }>;
};

export type RecurringEntitlement = {
  plan: RecurringPlan;
  billingPeriod: RecurringBillingPeriod;
  periodEnd: Date;
  priceId: string;
};

/** Build the allowlisted recurring-price catalog hydrated by ensureStripeConfig. */
export function recurringPriceCatalogFromEnv(
  env: Record<string, string | undefined> = process.env,
): RecurringPriceDefinition[] {
  const definitions: Array<[string | undefined, RecurringPlan, RecurringBillingPeriod]> = [
    [env.STRIPE_PRICE_PRO_MONTHLY, "PRO", "monthly"],
    [env.STRIPE_PRICE_PRO_ANNUAL, "PRO", "annual"],
    [env.STRIPE_PRICE_BUSINESS_MONTHLY, "BUSINESS", "monthly"],
    [env.STRIPE_PRICE_BUSINESS_ANNUAL, "BUSINESS", "annual"],
  ];
  return definitions.flatMap(([priceId, plan, billingPeriod]) =>
    priceId ? [{ priceId, plan, billingPeriod }] : [],
  );
}

/**
 * Resolve app entitlement from the exact recurring Price on Stripe. A paid
 * invoice must never extend access using a stale plan/billingPeriod stored in
 * our DB. Only the supported single-item subscription shape is accepted.
 */
export function resolveRecurringEntitlement(
  subscription: StripeSubscriptionSnapshot,
  catalog: RecurringPriceDefinition[],
): RecurringEntitlement | null {
  if (subscription.items.length !== 1) return null;
  const item = subscription.items[0];
  if (!item || !Number.isInteger(item.currentPeriodEnd) || item.currentPeriodEnd <= 0) return null;

  const matches = catalog.filter((definition) => definition.priceId === item.priceId);
  if (matches.length !== 1) return null;
  const match = matches[0];
  return {
    ...match,
    priceId: item.priceId,
    periodEnd: new Date(item.currentPeriodEnd * 1000),
  };
}

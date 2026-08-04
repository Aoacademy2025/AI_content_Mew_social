export type FoundingPortalPrice = {
  id: string;
  productId: string;
  active: boolean;
  currency: string;
  recurringInterval: "day" | "week" | "month" | "year" | null;
  recurringIntervalCount: number | null;
};

export type FoundingPortalPriceSet = {
  proMonthly: FoundingPortalPrice;
  proAnnual: FoundingPortalPrice;
  businessMonthly: FoundingPortalPrice;
  businessAnnual: FoundingPortalPrice;
};

export type FoundingPortalSubscriptionUpdate = {
  enabled: true;
  default_allowed_updates: ["price", "promotion_code"];
  billing_cycle_anchor: "now";
  proration_behavior: "always_invoice";
  products: Array<{
    product: string;
    prices: [string, string];
    adjustable_quantity: { enabled: false };
  }>;
};

function assertPrice(
  label: string,
  price: FoundingPortalPrice,
  expectedInterval: "month" | "year",
) {
  if (!price.id || !price.productId) throw new Error(`${label}: missing Stripe price/product id`);
  if (!price.active) throw new Error(`${label}: Stripe price is inactive`);
  if (price.currency.toLowerCase() !== "thb") throw new Error(`${label}: Stripe price must use THB`);
  if (price.recurringInterval !== expectedInterval || price.recurringIntervalCount !== 1) {
    throw new Error(`${label}: expected a 1 ${expectedInterval} recurring interval`);
  }
}

/**
 * Validate the four live recurring prices and build the narrow Portal feature
 * configuration used only by the Founding monthly → annual deep link.
 */
export function buildFoundingAnnualPortalConfig(
  prices: FoundingPortalPriceSet,
): FoundingPortalSubscriptionUpdate {
  assertPrice("PRO monthly", prices.proMonthly, "month");
  assertPrice("PRO annual", prices.proAnnual, "year");
  assertPrice("BUSINESS monthly", prices.businessMonthly, "month");
  assertPrice("BUSINESS annual", prices.businessAnnual, "year");

  if (prices.proMonthly.productId !== prices.proAnnual.productId) {
    throw new Error("PRO monthly and annual prices must belong to the same Stripe product");
  }
  if (prices.businessMonthly.productId !== prices.businessAnnual.productId) {
    throw new Error("BUSINESS monthly and annual prices must belong to the same Stripe product");
  }
  if (prices.proMonthly.productId === prices.businessMonthly.productId) {
    throw new Error("PRO and BUSINESS must use distinct Stripe products");
  }
  const priceIds = Object.values(prices).map((price) => price.id);
  if (new Set(priceIds).size !== priceIds.length) {
    throw new Error("Founding Portal prices must be four distinct Stripe prices");
  }

  return {
    enabled: true,
    default_allowed_updates: ["price", "promotion_code"],
    billing_cycle_anchor: "now",
    proration_behavior: "always_invoice",
    products: [
      {
        product: prices.proMonthly.productId,
        prices: [prices.proMonthly.id, prices.proAnnual.id],
        adjustable_quantity: { enabled: false },
      },
      {
        product: prices.businessMonthly.productId,
        prices: [prices.businessMonthly.id, prices.businessAnnual.id],
        adjustable_quantity: { enabled: false },
      },
    ],
  };
}

import {
  buildFoundingAnnualPortalConfig,
  buildFoundingAnnualPortalFeatures,
} from "../src/lib/founding-annual-portal-config";

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) { console.error("❌ " + message); process.exit(1); }
  console.log("✓ " + message);
  passed++;
}

const price = (id: string, productId: string, recurringInterval: "month" | "year") => ({
  id,
  productId,
  active: true,
  currency: "thb",
  recurringInterval,
  recurringIntervalCount: 1,
});

const config = buildFoundingAnnualPortalConfig({
  proMonthly: price("price_pro_month", "prod_pro", "month"),
  proAnnual: price("price_pro_year", "prod_pro", "year"),
  businessMonthly: price("price_business_month", "prod_business", "month"),
  businessAnnual: price("price_business_year", "prod_business", "year"),
});

assert(config.enabled, "subscription updates are enabled");
assert(config.billing_cycle_anchor === "now", "conversion starts a fresh annual cycle immediately");
assert(config.proration_behavior === "always_invoice", "unused monthly credit is invoiced immediately with annual charge");
assert(
  config.default_allowed_updates.length === 2
    && config.default_allowed_updates.includes("price")
    && config.default_allowed_updates.includes("promotion_code"),
  "portal permits the target price and server-supplied Founding promotion code",
);
assert(config.products.length === 2, "PRO and BUSINESS products are allowlisted");
assert(config.products[0].prices.includes("price_pro_month") && config.products[0].prices.includes("price_pro_year"), "PRO monthly and annual prices share one portal product");

const features = buildFoundingAnnualPortalFeatures({
  proMonthly: price("price_pro_month", "prod_pro", "month"),
  proAnnual: price("price_pro_year", "prod_pro", "year"),
  businessMonthly: price("price_business_month", "prod_business", "month"),
  businessAnnual: price("price_business_year", "prod_business", "year"),
});
assert(features.payment_method_update.enabled, "Stripe-required payment method update is enabled");
assert(features.subscription_update.proration_behavior === "always_invoice", "Founding subscription update remains configured");

let rejectedWrongInterval = false;
try {
  buildFoundingAnnualPortalConfig({
    proMonthly: price("price_pro_month", "prod_pro", "year"),
    proAnnual: price("price_pro_year", "prod_pro", "year"),
    businessMonthly: price("price_business_month", "prod_business", "month"),
    businessAnnual: price("price_business_year", "prod_business", "year"),
  });
} catch { rejectedWrongInterval = true; }
assert(rejectedWrongInterval, "misconfigured Stripe intervals fail closed");

console.log(`\n✅ ALL ${passed} FOUNDING PORTAL CONFIG CHECKS PASSED`);

/**
 * Provision the dedicated Stripe Billing Portal configuration used by the
 * Founding monthly → annual deep link.
 *
 * Dry-run (read-only): npx tsx scripts/configure-founding-annual-portal.ts
 * Apply:               npx tsx scripts/configure-founding-annual-portal.ts --apply
 */
import "dotenv/config";

import {
  buildFoundingAnnualPortalConfig,
  type FoundingPortalPrice,
} from "../src/lib/founding-annual-portal-config";
import { ensureStripeConfig } from "../src/lib/load-stripe-config";
import { prisma } from "../src/lib/prisma";
import { stripe } from "../src/lib/stripe";

const CONFIG_KEY = "stripe_portal_founding_annual_config";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function loadPrice(id: string): Promise<FoundingPortalPrice> {
  const price = await stripe.prices.retrieve(id);
  const productId = typeof price.product === "string" ? price.product : price.product.id;
  return {
    id: price.id,
    productId,
    active: price.active,
    currency: price.currency,
    recurringInterval: price.recurring?.interval ?? null,
    recurringIntervalCount: price.recurring?.interval_count ?? null,
  };
}

async function main() {
  await ensureStripeConfig();
  const priceIds = {
    proMonthly: requiredEnv("STRIPE_PRICE_PRO_MONTHLY"),
    proAnnual: requiredEnv("STRIPE_PRICE_PRO_ANNUAL"),
    businessMonthly: requiredEnv("STRIPE_PRICE_BUSINESS_MONTHLY"),
    businessAnnual: requiredEnv("STRIPE_PRICE_BUSINESS_ANNUAL"),
  };
  const [proMonthly, proAnnual, businessMonthly, businessAnnual] = await Promise.all([
    loadPrice(priceIds.proMonthly),
    loadPrice(priceIds.proAnnual),
    loadPrice(priceIds.businessMonthly),
    loadPrice(priceIds.businessAnnual),
  ]);
  const subscriptionUpdate = buildFoundingAnnualPortalConfig({
    proMonthly,
    proAnnual,
    businessMonthly,
    businessAnnual,
  });

  const existingId = process.env.STRIPE_PORTAL_FOUNDING_ANNUAL_CONFIG_ID ?? null;
  console.log(JSON.stringify({
    mode: process.argv.includes("--apply") ? "apply" : "dry-run",
    existingConfigurationId: existingId,
    subscriptionUpdate,
  }, null, 2));

  if (!process.argv.includes("--apply")) {
    console.log("Dry-run only. Re-run with --apply to create/update Stripe and save the configuration id.");
    return;
  }

  const common = {
    name: "MewSocial Founding annual conversion",
    features: { subscription_update: subscriptionUpdate },
    metadata: { purpose: "founding_annual_conversion", managed_by: "configure-founding-annual-portal" },
  } as const;
  const configuration = existingId
    ? await stripe.billingPortal.configurations.update(existingId, { ...common, active: true })
    : await stripe.billingPortal.configurations.create({
        ...common,
        ...(process.env.NEXTAUTH_URL
          ? { default_return_url: `${process.env.NEXTAUTH_URL.replace(/\/$/, "")}/pricing` }
          : {}),
      });

  await prisma.siteConfig.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: configuration.id },
    update: { value: configuration.id },
  });
  console.log(`Configured ${configuration.id} and saved SiteConfig[${CONFIG_KEY}].`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

import { prisma } from "@/lib/prisma";
import { resetStripeClient } from "@/lib/stripe";

const DB_KEYS = [
  { db: "stripe_secret_key", env: "STRIPE_SECRET_KEY" },
  { db: "stripe_webhook_secret", env: "STRIPE_WEBHOOK_SECRET" },
  { db: "stripe_price_pro", env: "STRIPE_PRICE_PRO_MONTHLY" },
  { db: "stripe_price_business", env: "STRIPE_PRICE_BUSINESS_MONTHLY" },
  // Phase 2 — annual + one-time prices
  { db: "stripe_price_pro_annual", env: "STRIPE_PRICE_PRO_ANNUAL" },
  { db: "stripe_price_pro_annual_onetime", env: "STRIPE_PRICE_PRO_ANNUAL_ONETIME" },
  { db: "stripe_price_business_annual", env: "STRIPE_PRICE_BUSINESS_ANNUAL" },
  { db: "stripe_price_business_annual_onetime", env: "STRIPE_PRICE_BUSINESS_ANNUAL_ONETIME" },
];

/**
 * Reads any missing Stripe keys from SiteConfig DB into process.env.
 * Skips DB query if all keys are already set in env.
 */
export async function ensureStripeConfig() {
  const missing = DB_KEYS.filter(k => !process.env[k.env]);
  if (missing.length === 0) return;

  const rows = await prisma.siteConfig.findMany({
    where: { key: { in: missing.map(k => k.db) } },
    select: { key: true, value: true },
  }).catch(() => [] as { key: string; value: string }[]);

  let changed = false;
  for (const { db, env } of missing) {
    const row = rows.find(r => r.key === db);
    if (row?.value) {
      process.env[env] = row.value;
      changed = true;
    }
  }

  if (changed) resetStripeClient();
}

import { prisma } from "@/lib/prisma";
import { resetStripeClient } from "@/lib/stripe";

let loaded = false;

/**
 * On first call, reads Stripe keys from SiteConfig DB into process.env
 * so that Admin UI saves survive a server restart without editing .env.
 */
export async function ensureStripeConfig() {
  if (loaded) return;
  loaded = true;

  const keys = [
    { db: "stripe_secret_key", env: "STRIPE_SECRET_KEY" },
    { db: "stripe_webhook_secret", env: "STRIPE_WEBHOOK_SECRET" },
    { db: "stripe_price_pro", env: "STRIPE_PRICE_PRO_MONTHLY" },
    { db: "stripe_price_business", env: "STRIPE_PRICE_BUSINESS_MONTHLY" },
  ];

  const rows = await prisma.siteConfig.findMany({
    where: { key: { in: keys.map(k => k.db) } },
    select: { key: true, value: true },
  }).catch(() => [] as { key: string; value: string }[]);

  let changed = false;
  for (const { db, env } of keys) {
    const row = rows.find(r => r.key === db);
    if (row?.value && row.value !== process.env[env]) {
      process.env[env] = row.value;
      changed = true;
    }
  }

  if (changed) resetStripeClient();
}

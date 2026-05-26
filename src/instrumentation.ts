export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { prisma } = await import("@/lib/prisma");
    const { resetStripeClient } = await import("@/lib/stripe");

    const keys = [
      { db: "stripe_secret_key", env: "STRIPE_SECRET_KEY" },
      { db: "stripe_webhook_secret", env: "STRIPE_WEBHOOK_SECRET" },
      { db: "stripe_price_pro", env: "STRIPE_PRICE_PRO_MONTHLY" },
      { db: "stripe_price_business", env: "STRIPE_PRICE_BUSINESS_MONTHLY" },
    ];

    try {
      const rows = await prisma.siteConfig.findMany({
        where: { key: { in: keys.map(k => k.db) } },
        select: { key: true, value: true },
      });

      let changed = false;
      for (const { db, env } of keys) {
        const row = rows.find(r => r.key === db);
        if (row?.value && !process.env[env]) {
          process.env[env] = row.value;
          changed = true;
        }
      }

      if (changed) {
        resetStripeClient();
        console.log("[instrumentation] Loaded Stripe config from DB");
      }
    } catch (e) {
      console.error("[instrumentation] Failed to load Stripe config from DB:", e);
    }
  }
}

/**
 * Create the missing Payment rows for subscription renewals already charged by Stripe.
 *
 * Only the FIRST charge of a subscription ever produced a Payment row — it arrives through
 * `checkout.session.completed`. Renewals arrive as `invoice.paid`, which extended the plan
 * correctly but wrote no row, so a customer's renewals were missing from Settings → billing
 * history (which reads this table). Prod carried seven such charges worth 7,041.95฿.
 *
 * The webhook now writes the row going forward; this repairs the ones already collected.
 * Lifetime revenue is unaffected either way — revenue-cash.ts reads Stripe's charge ledger.
 *
 * Each row is keyed on the invoice id via the unique `stripeSessionId` column, so re-running
 * is safe. DRY RUN by default.
 *
 *   npx tsx scripts/backfill-renewal-payments.ts
 *   npx tsx scripts/backfill-renewal-payments.ts --apply
 */
import { PrismaClient, type Plan } from "@prisma/client";
import Stripe from "stripe";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();
const RENEWAL_PAYMENT_NOTE = "renewal";

async function main() {
  const cfg = await prisma.siteConfig.findFirst({ where: { key: "stripe_secret_key" } });
  if (!cfg?.value) throw new Error("stripe_secret_key missing from SiteConfig");
  const stripe = new Stripe(cfg.value);

  const known = new Set(
    (await prisma.payment.findMany({ select: { stripeSessionId: true } })).map((r) => r.stripeSessionId),
  );

  let created = 0, skipped = 0, unmatched = 0, totalSatang = 0;
  for await (const invoice of stripe.invoices.list({ status: "paid", limit: 100 })) {
    const amount = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
    if (amount <= 0 || !invoice.id) continue;
    // `subscription_create` is the first charge — that one already has a checkout row.
    if (invoice.billing_reason === "subscription_create") { skipped++; continue; }
    if (known.has(invoice.id)) { skipped++; continue; }

    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    const user = customerId
      ? await prisma.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true, email: true, plan: true, billingPeriod: true } })
      : null;
    if (!user) {
      // Never invent an owner for money we cannot attribute — report it instead.
      unmatched++;
      console.log(`  ? ${invoice.id} ${amount / 100}฿ — no user for customer ${customerId ?? "(none)"}`);
      continue;
    }

    const periodDays = user.billingPeriod === "annual" ? 365 : 30;
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : new Date(invoice.created * 1000);
    console.log(`  ${apply ? "→" : "·"} ${user.email} ${paidAt.toISOString().slice(0, 10)} ${amount / 100}฿ ${invoice.id}`);
    totalSatang += amount;
    if (apply) {
      try {
        await prisma.payment.create({
          data: {
            userId: user.id,
            stripeSessionId: invoice.id,
            stripePaymentIntent: typeof (invoice as { payment_intent?: unknown }).payment_intent === "string"
              ? (invoice as { payment_intent: string }).payment_intent
              : undefined,
            plan: user.plan as Plan,
            amount,
            currency: "thb",
            status: "PAID",
            periodDays,
            paidAt,
            createdAt: paidAt,
            note: RENEWAL_PAYMENT_NOTE,
          },
        });
        created++;
      } catch (error) {
        console.log(`    already recorded, skip (${(error as { code?: string }).code ?? error})`);
      }
    }
  }

  console.log(`\nmissing=${apply ? created : totalSatang > 0 ? "see above" : 0}  skipped=${skipped}  unmatched=${unmatched}  value=${totalSatang / 100}฿`);
  console.log(apply ? `APPLIED: ${created} renewal row(s) created.` : "DRY RUN — no writes. Re-run with --apply.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

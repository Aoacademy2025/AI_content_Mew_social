/**
 * Backfill Payment.amount to what Stripe actually charged.
 *
 * Rows created before 2026-08-07 recorded the plan's LIST price instead of the settled
 * amount, so every founding buyer looks like they paid double what they did — on prod the
 * DB total reads 75,058฿ against Stripe's 50,384฿. `activatePaidCheckout` has written
 * `s.amount_total` since 66922af6/b6baef57 (2026-08-07), so this is a one-time data repair,
 * not a code fix: rows after that date already agree and are left untouched.
 *
 * Revenue reporting does NOT read this column — `revenue-cash.ts` sums Stripe's own charge
 * history — so nothing user-visible moves. What this fixes is the coupon report and any
 * future reader that trusts the column.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   npx tsx scripts/backfill-payment-amount-from-stripe.ts
 *   npx tsx scripts/backfill-payment-amount-from-stripe.ts --apply
 */
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

async function main() {
  const cfg = await prisma.siteConfig.findFirst({ where: { key: "stripe_secret_key" } });
  if (!cfg?.value) throw new Error("stripe_secret_key missing from SiteConfig");
  const stripe = new Stripe(cfg.value);

  const rows = await prisma.payment.findMany({
    where: { status: "PAID" },
    select: { id: true, userId: true, amount: true, stripeSessionId: true, stripePaymentIntent: true, createdAt: true, manual: true },
    orderBy: { createdAt: "asc" },
  });

  let checked = 0, drift = 0, repaired = 0, unresolved = 0, driftSatang = 0;
  for (const row of rows) {
    if (row.manual) continue; // admin-entered rows already hold the real figure
    let settled: number | null = null;

    // The Checkout Session is authoritative for what the customer was asked to pay:
    // amount_total is post-discount. Fall back to the PaymentIntent when the session
    // has aged out of Stripe's retention.
    if (row.stripeSessionId?.startsWith("cs_")) {
      const session = await stripe.checkout.sessions.retrieve(row.stripeSessionId).catch(() => null);
      if (typeof session?.amount_total === "number") settled = session.amount_total;
    }
    if (settled === null && row.stripePaymentIntent) {
      const pi = await stripe.paymentIntents.retrieve(row.stripePaymentIntent).catch(() => null);
      if (typeof pi?.amount_received === "number" && pi.amount_received > 0) settled = pi.amount_received;
    }

    checked++;
    if (settled === null) {
      // Rows with no Stripe object (e.g. the hand-made `manual_fou…` session id) cannot be
      // proven from Stripe. Reported, never guessed at.
      unresolved++;
      console.log(`  ? ${row.id} ${row.stripeSessionId?.slice(0, 14)} — no Stripe record, left as ${row.amount / 100}฿`);
      continue;
    }
    if (settled === row.amount) continue;

    drift++;
    driftSatang += row.amount - settled;
    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true } });
    console.log(`  ${apply ? "→" : "·"} ${user?.email} ${row.createdAt.toISOString().slice(0, 10)}  ${row.amount / 100}฿ → ${settled / 100}฿`);
    if (apply) {
      await prisma.payment.update({ where: { id: row.id }, data: { amount: settled } });
      repaired++;
    }
  }

  console.log(`\nchecked=${checked}  drift=${drift}  unresolved=${unresolved}  overstated_by=${driftSatang / 100}฿`);
  console.log(apply ? `APPLIED: ${repaired} row(s) updated.` : "DRY RUN — no writes. Re-run with --apply to repair.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

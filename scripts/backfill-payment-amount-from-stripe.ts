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
 * Two more repairs live here because they are the same concern — making the Payment ledger
 * state what actually happened:
 *
 *   --void-test    Soft-void PAID rows whose Stripe session id starts with `cs_test_`.
 *                  Prod carries eight of them on the internal info.aoacademy account from
 *                  2026-05-26: test-mode money that was never collected, yet counted as a
 *                  paying customer (revenue-cohorts treats ANY PAID row as "has paid cash",
 *                  which is why the all-time payer count reads 24 = 23 real + 1 internal).
 *                  VOIDED keeps the audit row and drops it from the PAID cohorts.
 *
 *   --flag-manual <session-id>   Mark ONE hand-made row as an off-Stripe receipt. This is
 *                  deliberately one id at a time: `manual: true` feeds real cash into
 *                  revenue-cash.server.ts, so each row has to be a payment someone confirms
 *                  actually arrived. Never inferred, never bulk-applied.
 *
 * DRY RUN by default; every mode needs --apply to write.
 *
 *   npx tsx scripts/backfill-payment-amount-from-stripe.ts
 *   npx tsx scripts/backfill-payment-amount-from-stripe.ts --apply
 *   npx tsx scripts/backfill-payment-amount-from-stripe.ts --void-test --apply
 *   npx tsx scripts/backfill-payment-amount-from-stripe.ts --flag-manual manual-ext-fou… --apply
 */
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const argv = process.argv.slice(2);

/**
 * Argument parsing is strict on purpose. The default branch of this tool WRITES — it repairs
 * `Payment.amount` across every drifting row — so anything it fails to understand must stop
 * the run rather than fall through to that default. A mistyped `--void-tests`, or a
 * `--flag-manual` whose session id was forgotten, previously ran the amount backfill instead
 * of the mode the operator asked for.
 */
const KNOWN_FLAGS = new Set(["--apply", "--void-test", "--flag-manual"]);

function die(message: string): never {
  console.error(`refusing to run: ${message}`);
  process.exit(2);
}

const apply = argv.includes("--apply");
const voidTest = argv.includes("--void-test");
const flagManualIndex = argv.indexOf("--flag-manual");
const flagManualSession = flagManualIndex >= 0 ? argv[flagManualIndex + 1] ?? null : null;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  // The value that follows --flag-manual is data, not a flag.
  if (flagManualIndex >= 0 && i === flagManualIndex + 1) continue;
  if (!KNOWN_FLAGS.has(arg)) die(`unrecognised argument "${arg}"`);
}
if (flagManualIndex >= 0 && (!flagManualSession || flagManualSession.startsWith("--"))) {
  die("--flag-manual needs a Stripe session id (e.g. --flag-manual manual-ext-founder-xxxx)");
}
if (voidTest && flagManualIndex >= 0) {
  die("--void-test and --flag-manual are separate repairs; run them one at a time");
}

const prisma = new PrismaClient();

/** Soft-void test-mode rows. Scoped to `cs_test_` — a live session id can never match. */
async function voidTestModeRows() {
  const rows = await prisma.payment.findMany({
    where: { status: "PAID", stripeSessionId: { startsWith: "cs_test_" } },
    select: { id: true, userId: true, amount: true, stripeSessionId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) { console.log("no test-mode PAID rows"); return; }
  let total = 0;
  for (const row of rows) {
    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true } });
    total += row.amount;
    console.log(`  ${apply ? "→" : "·"} ${user?.email} ${row.createdAt.toISOString().slice(0, 10)} ${row.amount / 100}฿ ${row.stripeSessionId.slice(0, 14)}`);
    if (apply) await prisma.payment.update({ where: { id: row.id }, data: { status: "VOIDED" } });
  }
  console.log(`\n${rows.length} test-mode row(s), ${total / 100}฿ of money that never arrived.`);
  console.log(apply ? "APPLIED: voided." : "DRY RUN — no writes.");
}

/** Flag ONE hand-made row as off-Stripe cash. */
async function flagManual(sessionId: string) {
  const row = await prisma.payment.findUnique({
    where: { stripeSessionId: sessionId },
    select: {
      id: true, userId: true, amount: true, status: true, manual: true,
      stripeSessionId: true, stripePaymentIntent: true,
    },
  });
  if (!row) { console.log(`no Payment row with stripeSessionId=${sessionId}`); return; }
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true } });
  if (row.manual) { console.log(`already flagged manual: ${user?.email} ${row.amount / 100}฿`); return; }
  if (row.status !== "PAID") { console.log(`refusing: status is ${row.status}, not PAID`); return; }
  // `manual: true` means "cash that arrived OUTSIDE Stripe". revenue-cash.server.ts adds the
  // manual sum to Stripe's own charge ledger, so flagging a Stripe-backed row would count the
  // same money twice, permanently and invisibly. It would also hide the row from the amount
  // repair for ever (`if (row.manual) continue`), pinning any pre-2026-08-07 list price in
  // place. Genuine off-Stripe rows are hand-made and never carry a Stripe id.
  if (row.stripeSessionId.startsWith("cs_") || row.stripePaymentIntent) {
    console.log(
      `refusing: ${sessionId} is backed by Stripe — flagging it manual would double-count that payment`,
    );
    return;
  }
  console.log(`  ${apply ? "→" : "·"} ${user?.email} ${row.amount / 100}฿ → manual: true (counts as off-Stripe cash)`);
  if (apply) await prisma.payment.update({ where: { id: row.id }, data: { manual: true } });
  console.log(apply ? "APPLIED." : "DRY RUN — no writes.");
}

async function main() {
  if (voidTest) return voidTestModeRows();
  if (flagManualSession) return flagManual(flagManualSession);

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

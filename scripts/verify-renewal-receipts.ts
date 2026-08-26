// A subscription renewal must leave a receipt the customer can see.
// Run: npx tsx scripts/verify-renewal-receipts.ts
//
// Only the FIRST charge of a subscription produced a Payment row — it arrives through
// checkout.session.completed. Renewals arrive as invoice.paid, which extended the plan
// correctly but wrote nothing, so Settings → billing history (which reads Payment) showed
// the customer no renewal receipts at all. Prod carried seven such charges (7,041.95฿);
// four belong to Studio customers and are backfilled, the rest are Hero AI Bundle, a
// separate product with its own ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const webhook = read("src/app/api/payments/webhook/route.ts");
const backfill = read("scripts/backfill-renewal-payments.ts");
const history = read("src/app/api/payments/history/route.ts");

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── A. The renewal row is written, from settled money ──
const renewalBlock = webhook.slice(webhook.indexOf('if (event.type === "invoice.paid")'));
check("A1: invoice.paid creates a Payment row", renewalBlock.includes("prisma.payment.create"));
check(
  "A2: the amount is what Stripe settled, not a list price",
  renewalBlock.includes("inv.amount_paid"),
);
check(
  "A3: a zero-amount invoice writes nothing",
  /renewalSatang\s*>\s*0/.test(renewalBlock),
);
check("A4: the row is tagged as a renewal", renewalBlock.includes("RENEWAL_PAYMENT_NOTE"));
check(
  "A5: the term length follows the entitlement, not a guess",
  /entitlement\.billingPeriod === "annual" \? 365 : 30/.test(renewalBlock),
);

// ── B. Idempotency — a webhook retry must not double-write ──
check(
  "B1: the row is keyed on the invoice id (unique column ⇒ idempotent)",
  /stripeSessionId:\s*inv\.id/.test(renewalBlock),
);
check(
  "B2: a duplicate is swallowed, not thrown",
  renewalBlock.includes("already recorded (retry), skip"),
);
check(
  "B3: writing the receipt never blocks the entitlement update",
  renewalBlock.indexOf("prisma.user.update") < renewalBlock.indexOf("prisma.payment.create"),
);

// ── C. The customer can actually see it ──
check("C1: billing history reads the Payment table", history.includes("prisma.payment.findMany"));
check(
  "C2: history filters on amount > 0, which a renewal row satisfies",
  history.includes("amount: { gt: 0 }"),
);

// ── D. The backfill repairs the past without inventing anything ──
check("D1: dry run is the default", backfill.includes('argv.includes("--apply")') || backfill.includes('includes("--apply")'));
check(
  "D2: the first charge of a subscription is skipped (it already has a row)",
  backfill.includes('billing_reason === "subscription_create"'),
);
check("D3: an invoice already recorded is skipped", backfill.includes("known.has(invoice.id)"));
check(
  "D4: an unattributable invoice is reported, never assigned to someone",
  backfill.includes("no user for customer") && !/user\s*=\s*users\[0\]/.test(backfill),
);
check("D5: it keys on the same invoice id as the webhook", backfill.includes("stripeSessionId: invoice.id"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

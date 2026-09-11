/**
 * HERO-22 + HERO-23 — say what actually happened to a customer's money.
 *
 * Two ways the billing surface told a customer something untrue.
 *
 * HERO-22: the only control in Settings that said ยกเลิก sat on a pending payment row and
 * reported "ยกเลิกการชำระเงินแล้ว". It voids that one unpaid row and never touches the
 * subscription, which keeps renewing. With no cancel control anywhere else in the product,
 * it was the thing a customer looking to cancel would find and press.
 *
 * HERO-23: nothing in the app ever wrote `REFUNDED`, although the settings page has rendered
 * that status as "คืนเงิน" all along, so a refunded charge kept reading "ชำระแล้ว" to the
 * customer and to support. Confirmed on 2026-09-11, when a refund issued through Stripe left
 * the row at PAID.
 *
 * Pure: no DB, no network, no React. Run with `npx tsx scripts/verify-billing-copy-and-refund.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

const settings = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf-8");
const webhook = fs.readFileSync("src/app/api/payments/webhook/route.ts", "utf-8");

// ── HERO-22: the pending-payment control names the pending payment ───────────

assert.ok(
  !settings.includes('toast.success("ยกเลิกการชำระเงินแล้ว")'),
  "the toast that read as a cancelled subscription must not come back",
);
assert.ok(
  /toast\.success\("[^"]*ไม่กระทบการต่ออายุ[^"]*"\)/.test(settings),
  "the toast must say the subscription is unaffected",
);
const buttonLabel = settings.match(/<XCircle className="h-3\.5 w-3\.5" strokeWidth=\{2\} \/>\s*\n\s*([^\n<]+)/);
assert.ok(buttonLabel, "the pending-payment button must still exist");
assert.equal(
  buttonLabel![1].trim(),
  "ทิ้งรายการนี้",
  "the button must name the row it drops, never be a bare ยกเลิก",
);
assert.ok(
  settings.includes("/api/payments/cancel") === false || !settings.includes("cancel-subscription\", {"),
  "the pending-payment control must not have been rewired to the subscription route",
);

// ── HERO-23: a refund is recorded, and a partial refund is not overstated ────

assert.ok(webhook.includes('event.type === "charge.refunded"'), "the webhook must handle the refund event");
assert.ok(
  webhook.includes('const REFUNDED_PAYMENT_STATUS = "REFUNDED"'),
  "the status written must be the one the settings page renders",
);
assert.ok(
  /REFUNDED: *\{ *label: *"คืนเงิน"/.test(settings),
  "the settings page must still render that status, or the webhook would write a value nothing displays",
);
assert.ok(
  webhook.includes("const full = total > 0 && refunded >= total"),
  "a refund must only count as full when Stripe says the whole charge came back",
);
assert.ok(
  /\.\.\.\(full \? \{ status: REFUNDED_PAYMENT_STATUS \} : \{\}\)/.test(webhook),
  "a partial refund must leave the row PAID rather than claim the customer was made whole",
);
assert.ok(
  webhook.includes("stripePaymentIntent: paymentIntent") && webhook.includes("stripeSessionId: invoiceId"),
  "both row shapes must be matched: a checkout row carries the payment intent, a renewal row the invoice id",
);
assert.ok(
  webhook.includes("row.note?.includes(stamp) ? row.note"),
  "a repeated event must not stack the same note twice",
);

// The history endpoint must keep showing a refunded row rather than filtering it away.
const history = fs.readFileSync("src/app/api/payments/history/route.ts", "utf-8");
assert.ok(
  !history.includes('status: "REFUNDED"') || history.includes("NOT"),
  "billing history must not exclude refunded rows",
);
assert.ok(
  history.includes('NOT: { status: "FAILED", paidAt: null }'),
  "the history filter is what lets a REFUNDED row through; a change here needs this test updated",
);

console.log("verify-billing-copy-and-refund: OK");

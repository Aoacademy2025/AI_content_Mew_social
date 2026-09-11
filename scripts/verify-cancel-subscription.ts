/**
 * HERO-24 — cancelling inside the product must be possible, quiet, and honest.
 *
 * Before this, a subscriber had no cancel control anywhere in the app. The only route out
 * was an outbound button reading "จัดการการสมัคร / วิธีชำระเงิน", and the nearest thing that
 * said ยกเลิก cancelled one unpaid payment row instead. A customer who went looking for a
 * cancel button in September 2026 ended up charged and asking for a refund.
 *
 * These assertions pin the three things that make the new control trustworthy: it shows only
 * when there is something to cancel, it reads Stripe's answer rather than assuming one, and
 * it is not the payment-row cancel wearing a new name.
 *
 * Pure: no DB, no network, no React. Run with `npx tsx scripts/verify-cancel-subscription.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  hasScheduledCancellation,
  readStripeSchedule,
  stripeShowsSchedule,
} from "../src/lib/subscription-cancellation";

const PERIOD_END = 1_791_526_114; // 2026-10-09T06:08:34Z

// ── Reading Stripe's answer, in both shapes ───────────────────────────────────

assert.equal(
  stripeShowsSchedule({ cancel_at_period_end: false, cancel_at: PERIOD_END }),
  true,
  "a cancel_at date is a scheduled cancellation even with the legacy boolean false — the only shape production returns",
);
assert.equal(
  stripeShowsSchedule({ cancel_at_period_end: true, cancel_at: null }),
  true,
  "the legacy boolean alone is still a scheduled cancellation",
);
assert.equal(
  stripeShowsSchedule({ cancel_at_period_end: false, cancel_at: null }),
  false,
  "nothing scheduled must read as nothing scheduled, or the route would report a success that never happened",
);
assert.equal(stripeShowsSchedule(null), false, "a missing subscription must fail closed");

assert.equal(
  readStripeSchedule({ cancel_at_period_end: false, cancel_at: PERIOD_END }).cancelAt?.toISOString(),
  "2026-10-09T06:08:34.000Z",
  "the stored date must be Stripe's cancel_at, converted from seconds",
);
assert.equal(
  readStripeSchedule({ cancel_at_period_end: true, cancel_at: null }).cancelAtPeriodEnd,
  true,
  "the stored boolean must mirror Stripe's",
);

// ── The route: send, read back, fall back, refuse ─────────────────────────────

const route = fs.readFileSync("src/app/api/payments/cancel-subscription/route.ts", "utf-8");
assert.ok(route.includes("cancel_at_period_end: true"), "the route must ask Stripe to cancel at period end");
assert.ok(
  route.includes("cancel_at: end"),
  "it must fall back to writing cancel_at, because this Stripe account does not return the boolean",
);
assert.ok(
  /if \(!stripeShowsSchedule\(sub as never\)\) \{\s*return NextResponse\.json\(/.test(route),
  "it must refuse to report success while Stripe shows no schedule",
);
assert.ok(
  route.includes("cancelAtPeriodEnd: schedule.cancelAtPeriodEnd") && route.includes("cancelAt: schedule.cancelAt"),
  "the database must mirror what Stripe returned, not an optimistic write",
);
assert.ok(
  route.includes("stripeShowsSchedule(current as never)"),
  "a second press on an already-scheduled cancellation must not be sent to Stripe again",
);

// The payment-row cancel is a different thing and must stay different.
const paymentCancel = fs.readFileSync("src/app/api/payments/cancel/route.ts", "utf-8");
assert.ok(
  !paymentCancel.includes("subscriptions.update") && !paymentCancel.includes("subscriptions.cancel"),
  "/api/payments/cancel voids one payment row and must never touch a subscription",
);

// ── The control: quiet, conditional, confirmed ───────────────────────────────

const link = fs.readFileSync("src/components/settings/cancel-subscription-link.tsx", "utf-8");
assert.ok(
  link.includes("if (!state?.hasStripeSubscription) return null"),
  "no subscription means no cancel control",
);
assert.ok(
  link.includes("if (hasScheduledCancellation(state)) return null"),
  "once a cancellation is scheduled the notice and its undo take over; the two must never show together",
);
assert.ok(link.includes("setConfirming(true)"), "a stray click must not cancel a plan");
assert.ok(!/confirm\(/.test(link), "confirmation must not use a blocking browser dialog");
assert.ok(!/bg-red|background: ?\"?hsl\(0 /.test(link), "the control is deliberately not a red button");
assert.ok(!link.includes("VIOLET_GRAD"), "the control must not carry the primary-action treatment");
assert.ok(link.includes("fetchMe(true)"), "the end date must appear immediately after cancelling, not on the next reload");

const settings = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf-8");
assert.ok(settings.includes("<CancelSubscriptionLink />"), "the control must be rendered in Settings");
assert.ok(
  settings.indexOf("<ManageSubscriptionButton />") < settings.indexOf("<CancelSubscriptionLink />"),
  "it sits under the manage button, not above it",
);

console.log("verify-cancel-subscription: OK");

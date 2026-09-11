/**
 * HERO-20 — a scheduled cancellation must be visible, and undoing one must be true.
 *
 * Production evidence on 2026-09-11: of the 23 accounts holding a Stripe
 * subscription, `cancelAtPeriodEnd` was false for every single one, while 7 of
 * them carried a non-null `cancelAt` equal to their `planExpiresAt`. Those 7 had
 * genuinely scheduled a cancellation. Stripe reports the schedule as a date, and
 * the settings banner gated on the boolean, so no customer who cancelled was ever
 * shown a confirmation, an end date, or a way to undo it. One of them read the
 * dunning retry that collected the already-open invoice as "I cancelled and was
 * charged anyway" and asked for a refund.
 *
 * Pure: no DB, no network, no React. Run with `npx tsx scripts/verify-subscription-cancellation-visible.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cancellationDateLabel,
  hasScheduledCancellation,
  scheduledCancellationAt,
} from "../src/lib/subscription-cancellation";

const NOW = Date.parse("2026-09-11T06:00:00.000Z");
const FUTURE = "2026-10-09T06:08:34.000Z";
const PAST = "2026-09-01T06:08:34.000Z";

// ── The shape production actually produces ────────────────────────────────────

const productionShape = {
  cancelAtPeriodEnd: false,
  cancelAt: FUTURE,
  hasStripeSubscription: true,
};

assert.equal(
  hasScheduledCancellation(productionShape, NOW),
  true,
  "a cancel_at date with the legacy boolean false is the ONLY shape production has ever produced — it must show",
);
assert.equal(
  scheduledCancellationAt(productionShape, NOW)?.toISOString(),
  FUTURE,
  "the end date shown to the customer must be Stripe's cancel_at",
);
assert.match(
  cancellationDateLabel(productionShape, NOW),
  /[ก-๙]/,
  "the end date must be rendered in Thai",
);

// ── The legacy shape must keep working ────────────────────────────────────────

assert.equal(
  hasScheduledCancellation({ cancelAtPeriodEnd: true, cancelAt: null, hasStripeSubscription: true }, NOW),
  true,
  "the legacy boolean-only shape must still show the banner",
);
assert.equal(
  cancellationDateLabel({ cancelAtPeriodEnd: true, cancelAt: null, hasStripeSubscription: true }, NOW),
  "สิ้นรอบบิล",
  "with no date from Stripe the copy must fall back instead of printing an invalid date",
);

// ── Nothing scheduled, and states that must NOT claim one ─────────────────────

assert.equal(
  hasScheduledCancellation({ cancelAtPeriodEnd: false, cancelAt: null, hasStripeSubscription: true }, NOW),
  false,
  "an ordinary auto-renewing subscriber must see nothing",
);
assert.equal(
  hasScheduledCancellation({ cancelAtPeriodEnd: false, cancelAt: PAST, hasStripeSubscription: true }, NOW),
  false,
  "a cancel_at already in the past has lapsed — never offer to undo it",
);
assert.equal(
  hasScheduledCancellation({ cancelAtPeriodEnd: true, cancelAt: FUTURE, hasStripeSubscription: false }, NOW),
  false,
  "with no Stripe subscription left there is nothing to undo",
);
assert.equal(hasScheduledCancellation(null, NOW), false, "a missing /api/user/me response must not render the banner");
assert.equal(hasScheduledCancellation({ cancelAt: "not-a-date", hasStripeSubscription: true }, NOW), false, "an unparseable date must fail closed");

// ── The banner must read both shapes through the shared helper ────────────────

const banner = fs.readFileSync("src/components/settings/reactivate-banner.tsx", "utf-8");
assert.ok(
  !banner.includes("if (!state?.cancelAtPeriodEnd) return null"),
  "the boolean-only gate is the defect — it must not come back",
);
assert.ok(
  banner.includes("hasScheduledCancellation(state)"),
  "the banner must gate on the shared reader",
);
assert.ok(
  banner.includes("cancellationDateLabel(state)"),
  "the end date must come from the shared reader too, so gate and copy cannot disagree",
);

// ── Undoing a cancellation must be verified against Stripe ────────────────────

const route = fs.readFileSync("src/app/api/payments/reactivate/route.ts", "utf-8");
assert.ok(
  route.includes("cancel_at: null"),
  "clearing only cancel_at_period_end can leave the real schedule in place",
);
assert.ok(
  route.includes("cancel_at_period_end: false"),
  "the legacy parameter must still be cleared for accounts on the older shape",
);
assert.ok(
  /if \(cancelAtPeriodEnd \|\| cancelAt\)/.test(route),
  "the route must refuse to report success while Stripe still shows a schedule",
);
assert.ok(
  !/data: \{ cancelAtPeriodEnd: false, cancelAt: null,/.test(route),
  "the database must mirror what Stripe returned, not an optimistic clear",
);

console.log("verify-subscription-cancellation-visible: OK");

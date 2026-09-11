/**
 * HERO-20 — one definition of "this subscription is scheduled to end".
 *
 * Stripe reports a scheduled cancellation two ways. The legacy shape is the
 * boolean `cancel_at_period_end`; the current shape is a `cancel_at` timestamp.
 * Production has only ever produced the second: on 2026-09-11 every one of the
 * 23 accounts with a Stripe subscription had `cancelAtPeriodEnd = false`, while
 * 7 of them carried a `cancelAt` equal to their `planExpiresAt` — real, scheduled
 * cancellations. Anything that gated on the boolean alone was therefore dead
 * code in production, which is how a cancelling customer could be shown no
 * confirmation at all and conclude the cancellation had not registered.
 *
 * Read either shape, here, and nowhere else.
 */

export interface CancellationState {
  /** Stripe's legacy boolean, mirrored from the webhook. */
  cancelAtPeriodEnd?: boolean | null;
  /** Stripe's `cancel_at`, mirrored from the webhook. ISO string over the wire. */
  cancelAt?: string | Date | null;
  /**
   * Whether a Stripe subscription still exists. `customer.subscription.deleted`
   * clears the id together with both cancellation fields, so a missing id means
   * the cancellation has already happened and there is nothing left to undo.
   * `/api/user/me` exposes this as `hasStripeSubscription`; the id itself never
   * reaches the browser.
   */
  hasStripeSubscription?: boolean | null;
}

function toTime(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The moment the plan lapses, or null when nothing is scheduled.
 *
 * Returns null for a `cancelAt` already in the past: the subscription has
 * lapsed and the `customer.subscription.deleted` webhook simply has not landed
 * yet, so offering to undo it would be a lie.
 */
export function scheduledCancellationAt(
  state: CancellationState | null | undefined,
  now: number = Date.now(),
): Date | null {
  if (!state) return null;
  if (state.hasStripeSubscription === false) return null;
  const at = toTime(state.cancelAt);
  if (at !== null && at > now) return new Date(at);
  return null;
}

/**
 * True whenever the customer has a cancellation pending, including the legacy
 * boolean-only shape where Stripe gives us no date to show.
 */
export function hasScheduledCancellation(
  state: CancellationState | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!state) return false;
  if (state.hasStripeSubscription === false) return false;
  if (state.cancelAtPeriodEnd === true) return true;
  return scheduledCancellationAt(state, now) !== null;
}

/** Thai date for the banner, or a wording that works when Stripe gave no date. */
export function cancellationDateLabel(
  state: CancellationState | null | undefined,
  now: number = Date.now(),
): string {
  const at = scheduledCancellationAt(state, now);
  if (!at) return "สิ้นรอบบิล";
  return at.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
}

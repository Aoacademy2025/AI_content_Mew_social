import type { Prisma } from "@prisma/client";

/**
 * #348 — keep the remaining free-trial days when a customer converts mid-trial.
 *
 * Before this module, converting on trial day 2 threw days 3–7 away twice over:
 *  - a card subscription was created with no `trial_end`, so Stripe charged
 *    immediately and started the paid period from `now`;
 *  - a one-time/PromptPay term extended from `now` (checkout-plan-activation.ts
 *    deliberately forced `base = now` for an unconverted trial).
 *
 * This file is the SINGLE SOURCE for the flag, the arithmetic, and the customer
 * copy, so a page can never promise something the billing code does not do.
 * Everything is off unless `PRESERVE_TRIAL_ON_CONVERT=1`, and every helper below
 * returns exactly today's answer when the flag is off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const PRESERVE_TRIAL_ON_CONVERT_FLAG = "PRESERVE_TRIAL_ON_CONVERT";

/**
 * Stripe rejects `subscription_data.trial_end` that is less than 48 hours in the
 * future. A customer on the last day of the trial therefore cannot have it
 * carried into Stripe; that case falls back to today's behaviour (charge now,
 * period starts now) rather than inventing a different, more expensive path
 * such as `billing_cycle_anchor` proration.
 */
export const STRIPE_MIN_TRIAL_END_LEAD_MS = 48 * 60 * 60 * 1000;

/**
 * `Payment.note` marker for the ฿0 PAID row a trial-preserving subscription
 * checkout writes (Stripe reports `amount_total: 0` while the subscription is
 * `trialing` — no money has moved yet). The row itself is NOT optional: it is
 * the idempotency belt in activatePaidCheckout and the durable plan-payment
 * evidence `paid-equivalent-entitlement.server.ts` reads. The note exists so
 * that row is identifiable as "committed, not yet charged".
 */
export const TRIAL_PRESERVED_PAYMENT_NOTE = "trial_preserved";

/** The one place the flag is read. */
export function preserveTrialOnConvertEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PRESERVE_TRIAL_ON_CONVERT_FLAG] === "1";
}

export type TrialConvertState = {
  trialEndsAt?: Date | null;
  subStatus?: string | null;
};

/**
 * The existing definition of "still on the free trial and has not paid yet",
 * lifted out of checkout-plan-activation.ts verbatim so both call sites agree.
 */
export function onUnconvertedTrial(state: TrialConvertState, now: Date): boolean {
  return !!state.trialEndsAt && state.trialEndsAt > now && state.subStatus !== "active";
}

/** Whole days left on an active trial, floored at 0. Mirrors trialStatus() in trial.ts. */
export function trialDaysLeft(trialEndsAt: Date | null | undefined, now: Date): number {
  if (!trialEndsAt) return 0;
  const ms = trialEndsAt.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

export type TrialPreservationInput = TrialConvertState & {
  /** True for a card subscription checkout, false for one-time / PromptPay. */
  recurring: boolean;
  now: Date;
  /** Defaults to the env flag; passed explicitly by tests and by client surfaces. */
  enabled?: boolean;
};

export type TrialPreservationReason =
  | "flag_off"
  | "not_on_trial"
  | "preserved"
  | "trial_end_too_close";

export type TrialPreservation = {
  onTrial: boolean;
  trialDaysLeft: number;
  /** True when the remaining trial days really do survive this checkout. */
  preserved: boolean;
  /** Unix SECONDS for Stripe `subscription_data.trial_end`; null when not applicable. */
  stripeTrialEnd: number | null;
  /** Date a one-time term extends from. `now` whenever the trial is not preserved. */
  termBase: Date;
  reason: TrialPreservationReason;
};

/**
 * Single decision consumed by the checkout route (Stripe params) and by
 * activatePaidCheckout (term arithmetic). Pure: no env read when `enabled` is
 * passed, no Stripe call, no DB.
 */
export function resolveTrialPreservation(input: TrialPreservationInput): TrialPreservation {
  const enabled = input.enabled ?? preserveTrialOnConvertEnabled();
  const onTrial = onUnconvertedTrial(input, input.now);
  const daysLeft = onTrial ? trialDaysLeft(input.trialEndsAt, input.now) : 0;
  const notPreserved = (reason: TrialPreservationReason): TrialPreservation => ({
    onTrial,
    trialDaysLeft: daysLeft,
    preserved: false,
    stripeTrialEnd: null,
    termBase: input.now,
    reason,
  });

  if (!enabled) return notPreserved("flag_off");
  if (!onTrial) return notPreserved("not_on_trial");

  const trialEndsAt = input.trialEndsAt as Date;
  if (input.recurring) {
    // Stripe's own 48h floor. Below it we keep today's behaviour rather than
    // sending a timestamp the API would reject and fail the whole checkout.
    if (trialEndsAt.getTime() - input.now.getTime() < STRIPE_MIN_TRIAL_END_LEAD_MS) {
      return notPreserved("trial_end_too_close");
    }
    return {
      onTrial,
      trialDaysLeft: daysLeft,
      preserved: true,
      stripeTrialEnd: Math.floor(trialEndsAt.getTime() / 1000),
      // Recurring access always ends at Stripe's item current_period_end (which
      // IS the trial end while the subscription is trialing), so termBase is
      // informational for this branch.
      termBase: trialEndsAt,
      reason: "preserved",
    };
  }

  // One-time / PromptPay: the unused trial days are folded into the paid term.
  return {
    onTrial,
    trialDaysLeft: daysLeft,
    preserved: true,
    stripeTrialEnd: null,
    termBase: trialEndsAt,
    reason: "preserved",
  };
}

/**
 * Map Stripe's subscription status onto the `subStatus` we store.
 *
 * Only `trialing` is newly representable, and only behind the flag. Every other
 * Stripe status keeps storing "active" exactly as before — widening that would
 * silently change entitlement for `past_due` / `incomplete` subscriptions,
 * which is a different decision and not this issue's.
 */
export function storedSubscriptionStatus(
  stripeStatus: string | null | undefined,
  preserveTrial: boolean,
): string {
  if (preserveTrial && stripeStatus === "trialing") return "trialing";
  return "active";
}

/**
 * "This Stripe subscription is live — never downgrade it, never let a second one
 * be started on top of it."
 *
 * `trialing` means the customer has converted and has a card on file; Stripe
 * charges at trial end and `invoice.paid` then moves us to "active". Between the
 * trial end and that webhook the row looks expired to the revert crons, which is
 * exactly the window this predicate closes.
 *
 * `preserveTrial` is always explicit — this helper is imported by client
 * components too, where a server-only env var is not readable.
 */
export function hasLiveStripeSubscription(
  state: {
    subStatus?: string | null;
    stripeSubscriptionId?: string | null;
    /** Browser-safe form of the same evidence — the id itself never leaves the server. */
    hasStripeSubscription?: boolean;
  },
  preserveTrial: boolean,
): boolean {
  if (state.subStatus === "active") return true;
  const subscriptionPresent = state.hasStripeSubscription === true || !!state.stripeSubscriptionId;
  return preserveTrial && state.subStatus === "trialing" && subscriptionPresent;
}

/**
 * Prisma `where` fragment that excludes the rows `hasLiveStripeSubscription`
 * protects. Spreadable into the revert queries; `{}` when the flag is off, so
 * those queries stay byte-identical.
 */
export function excludeLiveTrialingSubscriptionWhere(preserveTrial: boolean): Prisma.UserWhereInput {
  if (!preserveTrial) return {};
  return { NOT: { AND: [{ stripeSubscriptionId: { not: null } }, { subStatus: "trialing" }] } };
}

// ── Customer copy ───────────────────────────────────────────────────────────
// Both strings live here so the promise and the billing behaviour cannot drift.
// `firstClipConvertTrialLine` (PR #347) should call trialConvertPromiseLine()
// once that branch lands instead of hard-coding either sentence.

/** Shown only when the flag is ON — the behaviour above makes it true. */
export const PRESERVE_TRIAL_CONVERT_LINE =
  "สมัครวันนี้ไม่เสียวันทดลอง — เริ่มคิดรอบหลังทดลองหมด";

/** Today's honest wording: converting restarts the term and ends the trial. */
export const FORFEIT_TRIAL_CONVERT_LINE =
  "สมัครวันนี้เริ่มรอบใหม่ทันที (วันทดลองที่เหลือจะสิ้นสุด)";

export function trialConvertPromiseLine(preserveTrial: boolean): string {
  return preserveTrial ? PRESERVE_TRIAL_CONVERT_LINE : FORFEIT_TRIAL_CONVERT_LINE;
}

import type { Plan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { usageWindowForPlan } from "@/lib/usage-limits";
import {
  onUnconvertedTrial,
  preserveTrialOnConvertEnabled,
  resolveTrialPreservation,
  storedSubscriptionStatus,
} from "@/lib/preserve-trial";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PaidCheckoutActivationInput = {
  sessionId: string;
  userId: string;
  plan: string;
  billingPeriod: string | null | undefined;
  periodDays: number;
  mode: string | null | undefined;
  subscriptionId?: string | null;
  paymentIntentId?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  /** Stripe's authoritative current_period_end for subscription checkouts. */
  entitlementExpiresAt?: Date | null;
  /**
   * Stripe's reported subscription status (#348). Only "trialing" changes what we
   * store, and only when PRESERVE_TRIAL_ON_CONVERT=1 — anything else (including
   * undefined) keeps storing "active" exactly as before.
   */
  subscriptionStatus?: string | null;
  /** Optional `Payment.note` marker — tags the ฿0 row of a preserved trial. */
  paymentNote?: string | null;
};

export type PaidCheckoutActivationResult =
  | { activated: true; newExpiry: Date }
  | { activated: false; reason: "already_paid" };

/**
 * Is this Checkout Session settled enough to activate?
 *
 * `paid` is the ordinary card/PromptPay answer. `no_payment_required` with a ฿0
 * total is the OTHER legitimate settled shape: a 100%-discount session, and —
 * since #348 — a subscription that starts in Stripe's `trialing` state, where the
 * card is collected now and the first charge lands at trial end. A trialing
 * subscription is therefore NOT "unpaid"; it is a committed customer.
 *
 * Lives here (not in the webhook route) so it is testable without importing a
 * Next.js route module.
 */
export function checkoutPaymentSettled(session: {
  payment_status?: string | null;
  amount_total?: number | null;
}): boolean {
  return session.payment_status === "paid"
    || (session.payment_status === "no_payment_required" && session.amount_total === 0);
}

function paidPlan(value: string): value is "PRO" | "BUSINESS" {
  return value === "PRO" || value === "BUSINESS";
}

function checkoutPeriod(value: string | null | undefined, periodDays: number): "monthly" | "annual" {
  if (value === "monthly" || value === "annual") return value;
  return periodDays >= 365 ? "annual" : "monthly";
}

/**
 * Commit the money-backed entitlement and its PAID Payment marker together.
 * The Payment upsert is intentional: a verified Stripe payment must never
 * leave the user with an active plan but no durable plan-payment row, because
 * paid feature gates and revenue reconciliation depend on that evidence.
 */
export async function activatePaidCheckout(
  input: PaidCheckoutActivationInput,
  now: Date = new Date(),
): Promise<PaidCheckoutActivationResult> {
  if (!input.sessionId || !input.userId) throw new Error("Paid checkout is missing its identity");
  if (!paidPlan(input.plan)) throw new Error(`Unsupported paid plan: ${input.plan}`);
  if (!Number.isInteger(input.periodDays) || input.periodDays <= 0 || input.periodDays > 3660) {
    throw new Error(`Invalid paid period: ${input.periodDays}`);
  }

  const billingPeriod = checkoutPeriod(input.billingPeriod, input.periodDays);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findUnique({
      where: { stripeSessionId: input.sessionId },
      select: { status: true, userId: true },
    });
    if (existing && existing.userId !== input.userId) {
      throw new Error(`Paid checkout owner mismatch: ${input.sessionId}`);
    }
    if (existing?.status === "PAID") return { activated: false as const, reason: "already_paid" as const };

    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { planExpiresAt: true, trialEndsAt: true, subStatus: true },
    });
    if (!user) throw new Error(`Paid checkout user not found: ${input.userId}`);

    const exactExpiry = input.entitlementExpiresAt;
    if (input.mode === "subscription" && !exactExpiry) {
      throw new Error("Subscription checkout is missing Stripe period end");
    }
    if (exactExpiry && (
      !Number.isFinite(exactExpiry.getTime())
      || exactExpiry <= now
      || exactExpiry.getTime() > now.getTime() + 3660 * DAY_MS
    )) {
      throw new Error("Invalid Stripe entitlement period end");
    }

    // Stripe defines recurring periods (calendar months/years), so subscription
    // access ends at its exact item current_period_end. Only one-time purchases
    // use the later-of-now/current-expiry extension rule.
    const preserveTrial = preserveTrialOnConvertEnabled();
    const onTrial = onUnconvertedTrial(user, now);
    // #348: a one-time / PromptPay term bought DURING an unconverted trial keeps
    // the unused trial days — the paid term starts where the trial would have
    // ended instead of overwriting it. `preserved` is false whenever the flag is
    // off, so the base below is then identical to the previous rule.
    const preservation = resolveTrialPreservation({
      trialEndsAt: user.trialEndsAt,
      subStatus: user.subStatus,
      recurring: false,
      now,
      enabled: preserveTrial,
    });

    let newExpiry: Date;
    if (exactExpiry) {
      newExpiry = new Date(exactExpiry);
    } else {
      const base = preservation.preserved
        ? preservation.termBase
        : !onTrial && user.planExpiresAt && user.planExpiresAt > now
          ? user.planExpiresAt
          : now;
      newExpiry = new Date(base.getTime() + input.periodDays * DAY_MS);
    }

    await tx.user.update({
      where: { id: input.userId },
      data: {
        plan: input.plan as Plan,
        planExpiresAt: newExpiry,
        ...usageWindowForPlan(input.plan, now),
        // The trial is superseded here in BOTH paths: a preserved one-time term
        // already contains the unused days (base = trialEndsAt above), and a
        // preserved card subscription hands the remaining days to Stripe as
        // `trial_end`, which then owns them. Clearing keeps every trial-display
        // surface (banner, sidebar, /pricing band, plan-change guard) honest for
        // a customer who has now converted.
        // TODO(#344): once User.trialEndedAt exists, stamp it here with the
        // superseded `user.trialEndsAt` so the cohort date is not destroyed.
        trialEndsAt: null,
        billingPeriod,
        ...(input.mode === "subscription" && input.subscriptionId
          ? {
              stripeSubscriptionId: input.subscriptionId,
              subStatus: storedSubscriptionStatus(input.subscriptionStatus, preserveTrial),
            }
          : {}),
      },
    });

    const amountTotal = input.amountTotal;
    if (!Number.isInteger(amountTotal) || (amountTotal ?? -1) < 0) {
      throw new Error("Paid checkout is missing its verified amount");
    }
    const currency = input.currency?.trim().toLowerCase();
    if (!currency || !/^[a-z]{3}$/.test(currency)) {
      throw new Error("Paid checkout is missing its verified currency");
    }

    const paymentData = {
      userId: input.userId,
      plan: input.plan as Plan,
      amount: amountTotal as number,
      currency,
      status: "PAID" as const,
      periodDays: input.periodDays,
      stripePaymentIntent: input.paymentIntentId || null,
      paidAt: now,
      note: input.paymentNote || null,
    } satisfies Omit<Prisma.PaymentUncheckedCreateInput, "id" | "stripeSessionId">;

    await tx.payment.upsert({
      where: { stripeSessionId: input.sessionId },
      create: { stripeSessionId: input.sessionId, ...paymentData },
      update: {
        plan: input.plan as Plan,
        amount: amountTotal as number,
        currency,
        status: "PAID",
        periodDays: input.periodDays,
        stripePaymentIntent: input.paymentIntentId || undefined,
        paidAt: now,
        note: input.paymentNote || undefined,
      },
    });

    return { activated: true as const, newExpiry };
  });
}

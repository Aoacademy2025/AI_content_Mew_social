import { prisma } from "@/lib/prisma";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { usageWindowForPlan } from "@/lib/usage-limits";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PaidPlan = "PRO" | "BUSINESS";

export type MarkPaidInput = {
  plan: PaidPlan;
  /** Term length in days — 365 annual, 30 monthly. */
  periodDays: number;
  /** Term start (default now); expiry = from + periodDays. Pass the real payment date
   *  for an off-Stripe customer so the year is measured from when they actually paid. */
  from?: Date;
  /** Informational only ("annual" | "monthly"); mirrors the Stripe-path field. */
  billingPeriod?: "annual" | "monthly" | null;
};

export type MarkPaidResult = { planExpiresAt: Date };

/**
 * Convert a user to a manually-paid (bank-transfer / off-Stripe) TIMED plan.
 *
 * Why this exists: the admin plan dropdown only flips `plan` (and on this branch nulls
 * `planExpiresAt`/`trialEndsAt`), and re-selecting the plan a trial user already holds
 * (trial = PRO) is a UI no-op — so there was no way to convert a trial/manual customer
 * into a proper paid term. Without clearing the trial flags, `classifyEntitlement`
 * keeps seeing an unconverted trial and auto-DOWNGRADES the paying customer to FREE at
 * `trialEndsAt` (any usage check / page load triggers it — not just the cron).
 *
 * This sets a real expiry and CLEARS `trialEndsAt`, so the classifier treats the user as
 * TIMED_PLAN → KEEP until expiry. `subStatus` is intentionally left untouched (null for a
 * bank-transfer user): there's no Stripe subscription to renew, so renewal is the team's
 * manual action at expiry. `trialStartedAt` is also left set (the one-trial-per-user guard
 * is never cleared — a converted user can't reclaim a second free trial).
 */
export async function markUserPaid(userId: string, input: MarkPaidInput): Promise<MarkPaidResult> {
  const from = input.from ?? new Date();
  const planExpiresAt = new Date(from.getTime() + input.periodDays * DAY_MS);
  await prisma.user.update({
    where: { id: userId },
    data: {
      plan: input.plan,
      planExpiresAt,
      trialEndsAt: null,
      billingPeriod: input.billingPeriod ?? null,
      // usage window starts NOW (the 30-day quota cycle), independent of the term start.
      ...usageWindowForPlan(input.plan),
    },
  });
  await extendVideoExpiryForPlan(userId, input.plan).catch(() => {});
  return { planExpiresAt };
}

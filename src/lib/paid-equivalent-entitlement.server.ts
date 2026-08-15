import "server-only";

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type PaidEquivalentPlan = "PRO" | "BUSINESS";
export type PaidEquivalentSource =
  | "subscription"
  | "paid_term"
  | "bundle"
  | "grant_coupon"
  | "administrator_grant"
  | "none";

export type PaidEquivalentDecision = {
  canUsePaidFeatures: boolean;
  effectivePlan: "FREE" | PaidEquivalentPlan;
  source: PaidEquivalentSource;
  expiresAt: Date | null;
  cashBacked: boolean;
  recurring: boolean;
  reason:
    | "eligible"
    | "no_qualifying_evidence"
    | "suspended"
    | "user_not_found";
};

export type PaidEquivalentEvidence = {
  user: {
    plan: string;
    suspended: boolean;
    planExpiresAt: Date | null;
    stripeSubscriptionId: string | null;
    subStatus: string | null;
    bundleGrantId: string | null;
    bundleSubscriptionId: string | null;
    bundleAccessExpiresAt: Date | null;
    bundleStatus: string | null;
    bundleAmountThb: number | null;
  };
  payments: readonly {
    plan: string;
    status: string;
    periodDays: number;
    paidAt?: Date | null;
    createdAt?: Date;
  }[];
  couponRedemptions: readonly {
    redeemedAt: Date;
    outcome?: string;
    entitlementPlan?: string | null;
    entitlementStartsAt?: Date | null;
    entitlementExpiresAt?: Date | null;
    coupon: {
      type: string;
      plan: string;
      durationDays: number;
    };
  }[];
  administratorGrants: readonly {
    plan: string;
    reason: string;
    startsAt: Date;
    expiresAt: Date | null;
    permanent: boolean;
    revokedAt: Date | null;
  }[];
};

type Candidate = {
  plan: PaidEquivalentPlan;
  source: Exclude<PaidEquivalentSource, "none">;
  expiresAt: Date | null;
  cashBacked: boolean;
  recurring: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const SOURCE_PRECEDENCE: Record<Exclude<PaidEquivalentSource, "none">, number> = {
  subscription: 5,
  paid_term: 4,
  bundle: 3,
  grant_coupon: 2,
  administrator_grant: 1,
};

export function isPaidEquivalentPlan(value: string): value is PaidEquivalentPlan {
  return value === "PRO" || value === "BUSINESS";
}

function planStrength(plan: PaidEquivalentPlan): number {
  return plan === "BUSINESS" ? 2 : 1;
}

function expiryStrength(expiresAt: Date | null): number {
  return expiresAt ? expiresAt.getTime() : Number.POSITIVE_INFINITY;
}

function chooseCandidate(candidates: Candidate[]): Candidate | null {
  return candidates.sort((left, right) =>
    planStrength(right.plan) - planStrength(left.plan)
    || expiryStrength(right.expiresAt) - expiryStrength(left.expiresAt)
    || SOURCE_PRECEDENCE[right.source] - SOURCE_PRECEDENCE[left.source]
  )[0] ?? null;
}

function denied(reason: PaidEquivalentDecision["reason"]): PaidEquivalentDecision {
  return {
    canUsePaidFeatures: false,
    effectivePlan: "FREE",
    source: "none",
    expiresAt: null,
    cashBacked: false,
    recurring: false,
    reason,
  };
}

/**
 * Pure commercial decision. A stored PRO/BUSINESS label is never sufficient:
 * every candidate below carries durable source evidence. This function is
 * exported so the full matrix can be verified without mocking Prisma.
 */
export function decidePaidEquivalentEntitlement(
  evidence: PaidEquivalentEvidence,
  now: Date = new Date(),
): PaidEquivalentDecision {
  if (evidence.user.suspended) return denied("suspended");

  const candidates: Candidate[] = [];
  const planPayments = evidence.payments.filter(
    (payment) => payment.status === "PAID" && payment.periodDays > 0
      && isPaidEquivalentPlan(payment.plan),
  );
  const latestPlanPayment = [...planPayments].sort((left, right) =>
    (right.paidAt ?? right.createdAt ?? new Date(0)).getTime()
      - (left.paidAt ?? left.createdAt ?? new Date(0)).getTime()
  )[0];

  if (
    latestPlanPayment
    && evidence.user.stripeSubscriptionId
    && evidence.user.subStatus === "active"
    && evidence.user.planExpiresAt
    && evidence.user.planExpiresAt > now
  ) {
    candidates.push({
      plan: latestPlanPayment.plan as PaidEquivalentPlan,
      source: "subscription",
      expiresAt: evidence.user.planExpiresAt,
      cashBacked: true,
      recurring: true,
    });
  }

  if (evidence.user.planExpiresAt && evidence.user.planExpiresAt > now) {
    if (latestPlanPayment) {
      candidates.push({
        // planExpiresAt describes the currently-materialized term. Pair it with
        // the latest plan payment only; an older BUSINESS purchase must not
        // silently upgrade a later PRO renewal.
        plan: latestPlanPayment.plan as PaidEquivalentPlan,
        source: "paid_term",
        expiresAt: evidence.user.planExpiresAt,
        cashBacked: true,
        recurring: false,
      });
    }
  }

  if (
    evidence.user.bundleStatus === "ACTIVE"
    && evidence.user.bundleGrantId
    && evidence.user.bundleAccessExpiresAt
    && evidence.user.bundleAccessExpiresAt > now
    && (evidence.user.bundleAmountThb ?? 0) > 0
  ) {
    candidates.push({
      // The current Bundle contract grants Studio PRO. User.plan can contain a
      // stronger overlay (for example an Administrator Grant), so it is not
      // safe evidence that the Bundle itself is BUSINESS.
      plan: "PRO",
      source: "bundle",
      expiresAt: evidence.user.bundleAccessExpiresAt,
      cashBacked: true,
      recurring: Boolean(evidence.user.bundleSubscriptionId),
    });
  }

  for (const redemption of evidence.couponRedemptions) {
    if (redemption.coupon.type !== "GRANT") continue;
    const durable = redemption.outcome && redemption.outcome !== "LEGACY";
    const plan = durable ? redemption.entitlementPlan : redemption.coupon.plan;
    if (!plan || !isPaidEquivalentPlan(plan)) continue;
    const startsAt = durable ? redemption.entitlementStartsAt : redemption.redeemedAt;
    if (!startsAt || startsAt > now) continue;
    const expiresAt = durable
      ? redemption.entitlementExpiresAt ?? null
      : redemption.coupon.durationDays > 0
        ? new Date(redemption.redeemedAt.getTime() + redemption.coupon.durationDays * DAY_MS)
        : null;
    if (expiresAt && expiresAt <= now) continue;
    candidates.push({
      plan,
      source: "grant_coupon",
      expiresAt,
      cashBacked: false,
      recurring: false,
    });
  }

  for (const grant of evidence.administratorGrants) {
    if (
      grant.revokedAt
      || grant.startsAt > now
      || !isPaidEquivalentPlan(grant.plan)
      || !grant.reason.trim()
      || (grant.permanent ? grant.expiresAt !== null : !grant.expiresAt || grant.expiresAt <= now)
    ) continue;
    candidates.push({
      plan: grant.plan,
      source: "administrator_grant",
      expiresAt: grant.expiresAt,
      cashBacked: false,
      recurring: false,
    });
  }

  const selected = chooseCandidate(candidates);
  if (!selected) return denied("no_qualifying_evidence");
  return {
    canUsePaidFeatures: true,
    effectivePlan: selected.plan,
    source: selected.source,
    expiresAt: selected.expiresAt,
    // Preserve the user's commercial relationship when a stronger coupon or
    // grant overlays an otherwise-valid paid subscription.
    cashBacked: candidates.some((candidate) => candidate.cashBacked),
    recurring: candidates.some((candidate) => candidate.recurring),
    reason: "eligible",
  };
}

export async function resolvePaidEquivalentEntitlement(
  userId: string,
  now: Date = new Date(),
): Promise<PaidEquivalentDecision> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      plan: true,
      suspended: true,
      planExpiresAt: true,
      stripeSubscriptionId: true,
      subStatus: true,
      bundleGrantId: true,
      bundleSubscriptionId: true,
      bundleAccessExpiresAt: true,
      bundleStatus: true,
      bundleAmountThb: true,
      payments: {
        where: { status: "PAID", periodDays: { gt: 0 } },
        orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
        select: { plan: true, status: true, periodDays: true, paidAt: true, createdAt: true },
      },
      couponRedemptions: {
        where: { coupon: { type: "GRANT" } },
        select: {
          redeemedAt: true,
          outcome: true,
          entitlementPlan: true,
          entitlementStartsAt: true,
          entitlementExpiresAt: true,
          coupon: { select: { type: true, plan: true, durationDays: true } },
        },
      },
      administratorGrants: {
        select: {
          plan: true,
          reason: true,
          startsAt: true,
          expiresAt: true,
          permanent: true,
          revokedAt: true,
        },
      },
    },
  });
  if (!user) return denied("user_not_found");
  return decidePaidEquivalentEntitlement({
    user,
    payments: user.payments,
    couponRedemptions: user.couponRedemptions,
    administratorGrants: user.administratorGrants,
  }, now);
}

export function paidEquivalentPlanAsPrisma(plan: PaidEquivalentPlan): Plan {
  return plan;
}

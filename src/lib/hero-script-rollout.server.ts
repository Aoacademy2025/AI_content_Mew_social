import type { User } from "@prisma/client";
import { classifyEntitlement, type EntitlementDecision } from "@/lib/entitlements";
import { isHeroScriptAllowedUser } from "@/lib/hero-script-access";
import { prisma } from "@/lib/prisma";

export type HeroScriptCohort = "internal" | "paid" | "coupon" | "trial" | "free" | "preview";

export type HeroScriptRolloutFlags = {
  paidEnabled: boolean;
  publicPreview: boolean;
  trialPercent: number;
  freePercent: number;
};

export type HeroScriptAccessDecision = {
  canUse: boolean;
  canPreview: boolean;
  cohort: HeroScriptCohort;
  effectivePlan: string;
  entitlementSource: EntitlementDecision["source"];
};

export function rolloutPercent(raw: string | null | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

/** Deterministic 0..99 bucket. Stable across requests and deploys, with a
 *  per-rollout salt so trial/free cohorts do not select the same accounts. */
export function heroScriptRolloutBucket(subject: string, salt: string): number {
  let hash = 2166136261;
  const value = `${salt}:${subject}`;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function heroScriptRolloutFlags(env: NodeJS.ProcessEnv = process.env): HeroScriptRolloutFlags {
  return {
    paidEnabled: env.HERO_SCRIPT_PAID_ENABLED === "1",
    publicPreview: env.HERO_SCRIPT_PUBLIC_PREVIEW === "1",
    trialPercent: rolloutPercent(env.HERO_SCRIPT_TRIAL_PERCENT),
    freePercent: rolloutPercent(env.HERO_SCRIPT_FREE_PERCENT),
  };
}

export function decideHeroScriptAccess(input: {
  userId: string;
  internal: boolean;
  cashPaid: boolean;
  activeGrantCoupon?: boolean;
  entitlement: EntitlementDecision;
  flags: HeroScriptRolloutFlags;
}): HeroScriptAccessDecision {
  const { userId, internal, cashPaid, activeGrantCoupon = false, entitlement, flags } = input;
  const base = {
    effectivePlan: entitlement.effectivePlan,
    entitlementSource: entitlement.source,
  };

  // Owner/team beta stays the operational backdoor regardless of public flags.
  if (internal) return { ...base, canUse: true, canPreview: true, cohort: "internal" };

  const paidEntitlement =
    entitlement.source === "SUBSCRIPTION" ||
    entitlement.source === "TIMED_PLAN" ||
    entitlement.source === "PERMANENT_OR_MANUAL";
  if (flags.paidEnabled && cashPaid && paidEntitlement) {
    return { ...base, canUse: true, canPreview: true, cohort: "paid" };
  }
  if (flags.paidEnabled && activeGrantCoupon && paidEntitlement) {
    return { ...base, canUse: true, canPreview: true, cohort: "coupon" };
  }

  if (
    entitlement.source === "TRIAL" &&
    heroScriptRolloutBucket(userId, "trial") < flags.trialPercent
  ) {
    return { ...base, canUse: true, canPreview: true, cohort: "trial" };
  }

  if (
    entitlement.effectivePlan === "FREE" &&
    heroScriptRolloutBucket(userId, "free") < flags.freePercent
  ) {
    return { ...base, canUse: true, canPreview: true, cohort: "free" };
  }

  return {
    ...base,
    canUse: false,
    canPreview: flags.publicPreview,
    cohort: "preview",
  };
}

type GrantCouponRedemption = {
  redeemedAt: Date;
  coupon: { type: string; plan: string; durationDays: number };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A historical redemption is not a permanent backdoor: a timed coupon only
 *  counts during its own redeemedAt + durationDays window. durationDays <= 0
 *  is the existing permanent-GRANT contract. */
export function hasActiveGrantCoupon(
  redemptions: readonly GrantCouponRedemption[],
  effectivePlan: string,
  now: Date,
): boolean {
  return redemptions.some((redemption) => {
    if (redemption.coupon.type !== "GRANT" || redemption.coupon.plan !== effectivePlan) return false;
    if (redemption.coupon.durationDays <= 0) return true;
    return redemption.redeemedAt.getTime() + redemption.coupon.durationDays * DAY_MS > now.getTime();
  });
}

/** Resolve the production access decision. A paid plan alone is deliberately
 *  insufficient: trials and unrelated manual PRO accounts also carry plan=PRO.
 *  Full access requires either money-backed plan evidence or an active GRANT
 *  coupon (student/workshop access) matching the current paid-tier entitlement. */
export async function resolveHeroScriptAccess(user: User): Promise<HeroScriptAccessDecision> {
  const now = new Date();
  const entitlement = classifyEntitlement(user, now);
  const internal = isHeroScriptAllowedUser(user);
  const paidEntitlement =
    entitlement.source === "SUBSCRIPTION" ||
    entitlement.source === "TIMED_PLAN" ||
    entitlement.source === "PERMANENT_OR_MANUAL";

  let cashPaid = false;
  let activeGrantCoupon = false;
  if (!internal && paidEntitlement) {
    const planPayment = await prisma.payment.findFirst({
      // A credit-pack purchase is also recorded as PAID for revenue reporting,
      // but it is not a plan/subscription purchase and must never unlock this
      // paid-plan feature for an unrelated comped PRO account.
      where: { userId: user.id, status: "PAID", periodDays: { gt: 0 } },
      select: { id: true },
    });
    cashPaid = !!planPayment;

    // Preserve the existing one-query paid-user hot path. Coupon lookup is only
    // needed for comped paid-tier users who lack money-backed plan evidence.
    if (!cashPaid) {
      const couponRedemptions = await prisma.couponRedemption.findMany({
        where: {
          userId: user.id,
          coupon: { type: "GRANT", plan: entitlement.effectivePlan as "PRO" | "BUSINESS" },
        },
        select: {
          redeemedAt: true,
          coupon: { select: { type: true, plan: true, durationDays: true } },
        },
      });
      activeGrantCoupon = hasActiveGrantCoupon(couponRedemptions, entitlement.effectivePlan, now);
    }
  }

  return decideHeroScriptAccess({
    userId: user.id,
    internal,
    cashPaid,
    activeGrantCoupon,
    entitlement,
    flags: heroScriptRolloutFlags(),
  });
}

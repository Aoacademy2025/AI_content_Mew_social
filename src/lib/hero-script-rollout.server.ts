import type { User } from "@prisma/client";
import { classifyEntitlement, type EntitlementDecision } from "@/lib/entitlements";
import { isHeroScriptAllowedUser } from "@/lib/hero-script-access";
import { prisma } from "@/lib/prisma";

export type HeroScriptCohort = "internal" | "paid" | "trial" | "free" | "preview";

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
  entitlement: EntitlementDecision;
  flags: HeroScriptRolloutFlags;
}): HeroScriptAccessDecision {
  const { userId, internal, cashPaid, entitlement, flags } = input;
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

/** Resolve the production access decision. A paid plan alone is deliberately
 *  insufficient: trials and comped PRO accounts also carry plan=PRO. We match
 *  the Revenue dashboard's money-backed definition by requiring an active
 *  entitlement plus at least one completed PAID Payment. */
export async function resolveHeroScriptAccess(user: User): Promise<HeroScriptAccessDecision> {
  const entitlement = classifyEntitlement(user);
  const internal = isHeroScriptAllowedUser(user);
  const paidEntitlement =
    entitlement.source === "SUBSCRIPTION" ||
    entitlement.source === "TIMED_PLAN" ||
    entitlement.source === "PERMANENT_OR_MANUAL";

  let cashPaid = false;
  if (!internal && paidEntitlement) {
    cashPaid = !!(await prisma.payment.findFirst({
      where: { userId: user.id, status: "PAID" },
      select: { id: true },
    }));
  }

  return decideHeroScriptAccess({
    userId: user.id,
    internal,
    cashPaid,
    entitlement,
    flags: heroScriptRolloutFlags(),
  });
}

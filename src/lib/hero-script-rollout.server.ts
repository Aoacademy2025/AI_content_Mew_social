import "server-only";

import type { User } from "@prisma/client";
import { isHeroScriptAllowedUser } from "@/lib/hero-script-access";
import {
  resolvePaidEquivalentEntitlement,
  type PaidEquivalentDecision,
} from "@/lib/paid-equivalent-entitlement.server";

export type HeroScriptCohort = "internal" | "paid" | "coupon" | "bundle" | "grant" | "preview" | "trial" | "free";

export type HeroScriptRolloutFlags = {
  paidEnabled: boolean;
  publicPreview: boolean;
  /** Deprecated percentage rollout; bounded Conversion Trial sample uses `conversionTrial` + `trialSampleEnabled`. */
  trialPercent: number;
  /** Deprecated and intentionally ignored: Free never generates. */
  freePercent: number;
  /** HERO-131: bounded 3-script sample quota during active 7-day Conversion Trial (default true unless `=== "0"`). */
  trialSampleEnabled?: boolean;
};

export type HeroScriptAccessDecision = {
  canUse: boolean;
  canPreview: boolean;
  cohort: HeroScriptCohort;
  mode: "internal" | "paid" | "preview";
  effectivePlan: PaidEquivalentDecision["effectivePlan"];
  entitlementSource: PaidEquivalentDecision["source"];
  reason: "eligible" | "feature_off" | "payment_required" | "suspended";
};

export function rolloutPercent(raw: string | null | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

export function heroScriptRolloutBucket(subject: string, salt: string): number {
  let hash = 2166136261;
  const value = `${salt}:${subject}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
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
    trialSampleEnabled: env.HERO_SCRIPT_TRIAL_SAMPLE_ENABLED !== "0",
  };
}

export function decideHeroScriptAccess(input: {
  internal: boolean;
  suspended?: boolean;
  conversionTrial?: boolean;
  paidEquivalent: PaidEquivalentDecision;
  flags: HeroScriptRolloutFlags;
}): HeroScriptAccessDecision {
  const { internal, suspended = false, conversionTrial = false, paidEquivalent, flags } = input;
  const base = {
    effectivePlan: paidEquivalent.effectivePlan,
    entitlementSource: paidEquivalent.source,
  };
  if (suspended || paidEquivalent.reason === "suspended") {
    return { ...base, canUse: false, canPreview: true, cohort: "preview", mode: "preview", reason: "suspended" };
  }
  if (internal) {
    return { ...base, canUse: true, canPreview: true, cohort: "internal", mode: "internal", reason: "eligible" };
  }
  if (!flags.paidEnabled) {
    return { ...base, canUse: false, canPreview: true, cohort: "preview", mode: "preview", reason: "feature_off" };
  }
  if (paidEquivalent.canUsePaidFeatures) {
    const cohort: HeroScriptCohort = paidEquivalent.source === "grant_coupon"
      ? "coupon"
      : paidEquivalent.source === "bundle"
        ? "bundle"
        : paidEquivalent.source === "administrator_grant"
          ? "grant"
          : "paid";
    return { ...base, canUse: true, canPreview: true, cohort, mode: "paid", reason: "eligible" };
  }
  if (conversionTrial && flags.trialSampleEnabled !== false) {
    return {
      ...base,
      canUse: true,
      canPreview: true,
      cohort: "trial",
      mode: "paid",
      reason: "eligible",
    };
  }
  return {
    ...base,
    canUse: false,
    // Script is a paid feature, but its locked product preview is part of the
    // upgrade path for every signed-in customer.
    canPreview: true,
    cohort: "preview",
    mode: "preview",
    reason: "payment_required",
  };
}

export async function resolveHeroScriptAccess(user: User, now: Date = new Date()): Promise<HeroScriptAccessDecision> {
  const paidEquivalent = await resolvePaidEquivalentEntitlement(user.id);
  const conversionTrial =
    !user.suspended
    && !paidEquivalent.canUsePaidFeatures
    && Boolean(
      user.trialStartedAt
      && user.trialStartedAt <= now
      && user.trialEndsAt
      && user.trialEndsAt > now,
    );
  return decideHeroScriptAccess({
    internal: user.role === "ADMIN" || isHeroScriptAllowedUser(user),
    suspended: user.suspended,
    conversionTrial,
    paidEquivalent,
    flags: heroScriptRolloutFlags(),
  });
}

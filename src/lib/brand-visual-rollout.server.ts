import "server-only";

import type { User } from "@prisma/client";
import { resolvePaidEquivalentEntitlement, type PaidEquivalentDecision } from "@/lib/paid-equivalent-entitlement.server";

export type BrandVisualRolloutPercent = 0 | 10 | 50 | 100;
export type BrandVisualRolloutFlags = {
  enabled: boolean;
  percent: BrandVisualRolloutPercent;
  startedAt: Date | null;
  testEmails: Set<string>;
};
export type BrandVisualAccessDecision = {
  canUse: boolean;
  cohort: "off" | "internal" | "not-entitled" | "rollout-wait" | "treatment-10" | "treatment-50" | "treatment-100";
  mode: "internal" | "paid" | "preview" | "rollout_wait";
  reason: "feature_off" | "eligible" | "payment_required" | "rollout_wait" | "suspended";
  bucket: number | null;
  entitlementSource: PaidEquivalentDecision["source"];
};

const PRODUCT_OWNER_EMAIL = "duckyhero@gmail.com";

function values(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}
function rolloutPercent(raw: string | undefined): BrandVisualRolloutPercent {
  const number = Number(raw);
  return number === 10 || number === 50 || number === 100 ? number : 0;
}
function rolloutDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) ? value : null;
}
export function brandVisualRolloutFlags(env: NodeJS.ProcessEnv = process.env): BrandVisualRolloutFlags {
  return {
    enabled: env.BRAND_VISUAL_SYSTEM_ENABLED === "1",
    percent: rolloutPercent(env.BRAND_VISUAL_ROLLOUT_PERCENT),
    startedAt: rolloutDate(env.BRAND_VISUAL_ROLLOUT_STARTED_AT),
    testEmails: values(env.BRAND_VISUAL_TEST_EMAILS),
  };
}
export function brandVisualRolloutBucket(userId: string): number {
  let hash = 2166136261;
  const value = `brand-visual-v1:${userId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function decideBrandVisualAccess(
  actor: { id: string; email?: string | null; role?: string | null; suspended?: boolean | null },
  paidEquivalent: Pick<PaidEquivalentDecision, "canUsePaidFeatures" | "source">,
  flags = brandVisualRolloutFlags(),
): BrandVisualAccessDecision {
  const base = { entitlementSource: paidEquivalent.source };
  if (!flags.enabled) return { ...base, canUse: false, cohort: "off", mode: "preview", reason: "feature_off", bucket: null };
  if (actor.suspended) return { ...base, canUse: false, cohort: "not-entitled", mode: "preview", reason: "suspended", bucket: null };
  const email = actor.email?.trim().toLowerCase() ?? "";
  if (actor.role === "ADMIN" || email === PRODUCT_OWNER_EMAIL || flags.testEmails.has(email)) {
    return { ...base, canUse: true, cohort: "internal", mode: "internal", reason: "eligible", bucket: null };
  }
  if (!paidEquivalent.canUsePaidFeatures) {
    return { ...base, canUse: false, cohort: "not-entitled", mode: "preview", reason: "payment_required", bucket: null };
  }
  const bucket = brandVisualRolloutBucket(actor.id);
  if (!flags.startedAt || flags.percent === 0 || bucket >= flags.percent) {
    return { ...base, canUse: false, cohort: "rollout-wait", mode: "rollout_wait", reason: "rollout_wait", bucket };
  }
  return {
    ...base,
    canUse: true,
    cohort: `treatment-${flags.percent}`,
    mode: "paid",
    reason: "eligible",
    bucket,
  };
}

export async function resolveBrandVisualAccess(user: User): Promise<BrandVisualAccessDecision> {
  const paidEquivalent = await resolvePaidEquivalentEntitlement(user.id);
  return decideBrandVisualAccess(user, paidEquivalent);
}

export async function resolveBrandVisualAccessByUserId(
  actor: { id: string; email?: string | null; role?: string | null; suspended?: boolean | null },
): Promise<BrandVisualAccessDecision> {
  const paidEquivalent = await resolvePaidEquivalentEntitlement(actor.id);
  return decideBrandVisualAccess(actor, paidEquivalent);
}

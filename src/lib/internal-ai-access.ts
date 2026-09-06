import type { User } from "@prisma/client";
import type { PaidEquivalentDecision } from "@/lib/paid-equivalent-entitlement.server";
import type { StarterAiImageAllowanceStatus } from "@/lib/starter-ai-image-allowance.server";

/**
 * Private beta access for GPU-backed features that are not ready for customers.
 *
 * Keep this server-side and fail closed. Environment values only ADD testers to
 * the two product-owner defaults; they never remove the original team access.
 */
const HERO_AI_OWNER_EMAIL = "duckyhero@gmail.com";
const HERO_AI_TEAM_DOMAIN = "aoacademy.co";
const DEFAULT_ALLOWED_EMAILS = [HERO_AI_OWNER_EMAIL];
const DEFAULT_ALLOWED_DOMAINS = [HERO_AI_TEAM_DOMAIN];

function commaSeparatedValues(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizedDomains(value: string | undefined): Set<string> {
  return new Set([
    ...DEFAULT_ALLOWED_DOMAINS,
    ...commaSeparatedValues(value),
  ].map((domain) => domain.replace(/^@/, "")));
}

/** Exact-email or exact-domain match; `evil-aoacademy.co` never qualifies. */
export function isInternalAiTesterEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;

  const allowedEmails = new Set([
    ...DEFAULT_ALLOWED_EMAILS,
    ...commaSeparatedValues(process.env.INTERNAL_AI_ALLOWED_EMAILS),
  ]);
  if (allowedEmails.has(normalized)) return true;

  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return false;
  return normalizedDomains(process.env.INTERNAL_AI_ALLOWED_DOMAINS).has(normalized.slice(separator + 1));
}

export function isInternalAiTester(
  actor: { email?: string | null } | null | undefined,
): boolean {
  return isInternalAiTesterEmail(actor?.email);
}

/** Fixed product-owner cohort. Unlike the broader internal tooling allowlist,
 * Hero Editor access must never be expanded by environment configuration. */
function isHeroAiProductOwnerEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === HERO_AI_OWNER_EMAIL) return true;

  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return false;
  return normalized.slice(separator + 1) === HERO_AI_TEAM_DOMAIN;
}

/**
 * Product-owner rollout for Hero AI Image and Hero AI Voice inside the Video
 * Editor. This is deliberately a separate policy from the private AI Studio:
 * every administrator may exercise the editor beta, while the two named team
 * cohorts remain eligible even when their account role is not ADMIN.
 */
export function isHeroAiBetaUser(
  actor: { email?: string | null; role?: string | null } | null | undefined,
): boolean {
  return actor?.role === "ADMIN" || isHeroAiProductOwnerEmail(actor?.email);
}

/** Feature rollout helper: internal testers receive the beta before a public flag
 * opens. Authorization-sensitive callers must still apply their feature-specific
 * plan, credit and provider checks after this coarse rollout gate. */
export function isInternalAiBetaEnabledFor(
  actor: { email?: string | null } | null | undefined,
  publicEnabled = false,
): boolean {
  return publicEnabled || isInternalAiTester(actor);
}

/**
 * Public-launch eligibility for Hero AI Image — the ONE gate shared by all three
 * entry points (Hero-only b-roll mode, AutoMix "ai" slots, per-window regen).
 * The internal beta cohort (`isHeroAiBetaUser`) always passes, same as today.
 * `HERO_AI_IMAGE_PUBLIC=1` opens only server-proven Paid-Equivalent access and
 * the active seven-day Conversion Trial allowance. Raw plan labels and Brand
 * Visual rollout membership do not manufacture Hero Image entitlement.
 *
 * Trial is deliberately separate from paid: it has at most eight delivered
 * images, uses no recurring grant, and becomes preview-only on expiry or
 * exhaustion. Omitting the server decisions fails closed.
 */
export type HeroAiImageAccessDecision = {
  canUse: boolean;
  canPreview: boolean;
  mode: "internal" | "paid" | "trial" | "preview";
  source: PaidEquivalentDecision["source"] | "conversion_trial" | "internal";
  effectivePlan: PaidEquivalentDecision["effectivePlan"];
  reason: "eligible" | "feature_off" | "payment_required" | "allowance_exhausted" | "trial_expired" | "suspended";
  remainingTrialImages: number;
};

/** Pure helper retained for route-policy tests. Callers must pass the server
 * decisions; omitting them fails closed for non-internal accounts. */
export function isHeroAiImageEligible(
  actor: {
    id?: string;
    email?: string | null;
    role?: string | null;
    plan?: string | null;
    suspended?: boolean | null;
    trialEndsAt?: Date | null;
    createdAt?: Date;
  } | null | undefined,
  context?: {
    paidEquivalent?: PaidEquivalentDecision;
    trialAllowance?: StarterAiImageAllowanceStatus;
  },
): boolean {
  if (actor?.suspended) return false;
  if (isHeroAiBetaUser(actor)) return true;
  if (process.env.HERO_AI_IMAGE_PUBLIC !== "1") return false;
  return Boolean(
    context?.paidEquivalent?.canUsePaidFeatures
    || (context?.trialAllowance?.eligible && context.trialAllowance.remainingImages > 0)
  );
}

export async function resolveHeroAiImageAccess(
  user: Pick<User, "id" | "email" | "role" | "plan" | "suspended" | "trialStartedAt">,
): Promise<HeroAiImageAccessDecision> {
  if (user.suspended) {
    return {
      canUse: false, canPreview: true, mode: "preview", source: "internal",
      effectivePlan: "FREE", reason: "suspended", remainingTrialImages: 0,
    };
  }
  if (isHeroAiBetaUser(user)) {
    return {
      canUse: true, canPreview: true, mode: "internal", source: "internal",
      effectivePlan: user.plan === "BUSINESS" ? "BUSINESS" : "PRO", reason: "eligible", remainingTrialImages: 0,
    };
  }
  // Keep the pure tester predicates importable by policy verifiers and
  // standalone workers without eagerly initializing Prisma/server-only image
  // entitlement modules. The database-backed branch loads them only on use.
  const [
    { resolvePaidEquivalentEntitlement },
    { getStarterAiImageAllowanceStatus },
  ] = await Promise.all([
    import("@/lib/paid-equivalent-entitlement.server"),
    import("@/lib/starter-ai-image-allowance.server"),
  ]);
  const paidEquivalent = await resolvePaidEquivalentEntitlement(user.id);
  const allowance = await getStarterAiImageAllowanceStatus(user.id);
  if (process.env.HERO_AI_IMAGE_PUBLIC !== "1") {
    return {
      canUse: false, canPreview: true, mode: "preview", source: paidEquivalent.source,
      effectivePlan: paidEquivalent.effectivePlan, reason: "feature_off", remainingTrialImages: allowance.remainingImages,
    };
  }
  if (paidEquivalent.canUsePaidFeatures) {
    return {
      canUse: true, canPreview: true, mode: "paid", source: paidEquivalent.source,
      effectivePlan: paidEquivalent.effectivePlan, reason: "eligible", remainingTrialImages: allowance.remainingImages,
    };
  }
  if (allowance.eligible) {
    return {
      canUse: allowance.remainingImages > 0,
      canPreview: true,
      mode: "trial",
      source: "conversion_trial",
      effectivePlan: "FREE",
      reason: allowance.remainingImages > 0 ? "eligible" : "allowance_exhausted",
      remainingTrialImages: allowance.remainingImages,
    };
  }
  return {
    canUse: false,
    canPreview: true,
    mode: "preview",
    source: "none",
    effectivePlan: "FREE",
    reason: user.trialStartedAt ? "trial_expired" : "payment_required",
    remainingTrialImages: allowance.remainingImages,
  };
}

/** Shared 403 payload for a plan-gated Hero AI Image request once the public
 * flag is live but the actor's plan doesn't qualify (FREE). Kept as one literal
 * so the three entry points can never drift on copy or the upgrade link. */
export const HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE = {
  status: 403 as const,
  body: {
    error: "plan_required" as const,
    message: "Hero AI Image ใช้ได้กับสมาชิก PRO/BUSINESS — อัปเกรดเพื่อปลดล็อกทันที",
    upgradeUrl: "/pricing" as const,
  },
};

export const HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE = {
  status: 403 as const,
  body: {
    error: "trial_allowance_exhausted" as const,
    message: "คุณใช้สิทธิ์ทดลอง Hero AI Image ครบ 8 ภาพแล้ว — อัปเกรดเพื่อสร้างต่อ",
    upgradeUrl: "/pricing" as const,
    remainingImages: 0 as const,
  },
};

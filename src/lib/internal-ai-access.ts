import { decideBrandVisualAccess } from "@/lib/brand-visual-rollout.server";

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
 * Brand Visual treatment accounts are admitted as an activation cohort even
 * when they are Free; their eight-image Starter Allowance is the hard spend
 * boundary. Outside that experiment, `HERO_AI_IMAGE_PUBLIC=1` retains the
 * existing PRO/BUSINESS launch behavior.
 *
 * Active-trial accounts are intentionally included here: `grantTrial` (trial.ts)
 * sets `plan: "PRO"` for the trial period. Starter settlement separately checks
 * payment evidence, so an unconverted trial continues to consume the same
 * signup-anchored allowance after reverting to Free and is never issued credits.
 *
 * Both public paths fail closed: the legacy public flag must equal "1", while
 * the Brand Visual path must pass its own master flag and stable cohort policy.
 */
export function isHeroAiImageEligible(
  actor: {
    id?: string;
    email?: string | null;
    role?: string | null;
    plan?: string | null;
    trialEndsAt?: Date | null;
    createdAt?: Date;
  } | null | undefined,
): boolean {
  if (isHeroAiBetaUser(actor)) return true;
  if (actor?.id && actor.createdAt && decideBrandVisualAccess({
    id: actor.id,
    email: actor.email,
    role: actor.role,
    createdAt: actor.createdAt,
  }).canUse) return true;
  if (process.env.HERO_AI_IMAGE_PUBLIC !== "1") return false;
  return actor?.plan === "PRO" || actor?.plan === "BUSINESS";
}

/** Shared 403 payload for a plan-gated Hero AI Image request once the public
 * flag is live but the actor's plan doesn't qualify (FREE). Kept as one literal
 * so the three entry points can never drift on copy or the upgrade link. */
export const HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE = {
  status: 403 as const,
  body: {
    error: "plan_required" as const,
    message: "Hero AI Image ใช้ได้กับแผน PRO/BUSINESS — อัปเกรดเพื่อใช้งาน",
    upgradeUrl: "/pricing" as const,
  },
};

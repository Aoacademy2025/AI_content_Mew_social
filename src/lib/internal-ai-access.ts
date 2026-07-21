/**
 * Private beta access for GPU-backed features that are not ready for customers.
 *
 * Keep this server-side and fail closed. Environment values only ADD testers to
 * the two product-owner defaults; they never remove the original team access.
 */
const DEFAULT_ALLOWED_EMAILS = ["duckyhero@gmail.com"];
const DEFAULT_ALLOWED_DOMAINS = ["aoacademy.co"];

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

/**
 * Product-owner rollout for Hero AI Image and Hero AI Voice inside the Video
 * Editor. This is deliberately a separate policy from the private AI Studio:
 * every administrator may exercise the editor beta, while the two named team
 * cohorts remain eligible even when their account role is not ADMIN.
 */
export function isHeroAiBetaUser(
  actor: { email?: string | null; role?: string | null } | null | undefined,
): boolean {
  return actor?.role === "ADMIN" || isInternalAiTester(actor);
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

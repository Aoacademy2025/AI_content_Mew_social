// Affiliate ref-code plumbing shared by middleware, auth lazy-create, and checkout.
export const AFF_COOKIE = "aff_ref";
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function sanitizeRefCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    // keep raw if not URI-encoded
  }
  return REF_RE.test(v) ? v : null;
}

export function studioProductSlug(plan: string, period: string): string {
  return `hero-studio-${plan.toLowerCase()}-${period.toLowerCase()}`;
}

// hero-script-access.ts — internal-beta account allowlist for the "เขียนสคริปต์
// AI" feature (Hero Script v1 post-review amendment, 2026-07-31, requested by
// Mew after the initial build was reviewed).
//
// Fail-closed like this project's other managed/beta gates (ADR 0003): an
// empty/unset HERO_SCRIPT_ALLOWED_EMAILS locks the feature for EVERYONE,
// including the product owner — the env must be set explicitly per
// environment (see docs/plans/2026-07-31-hero-script-v1.md, "Post-review
// amendments" for the prod value requirement).
//
// Kept dependency-free (no Prisma/Clerk imports) so it is safe to import from
// API routes, server components/layouts, AND the sidebar's server-fed props.

/**
 * Does `email` satisfy one entry of the comma-separated allowlist?
 *
 * - Comparison is case-insensitive throughout.
 * - An entry starting with "@" is an ANCHORED DOMAIN match against the
 *   email's domain (the part after the last "@") — never a raw string
 *   suffix, which would be bypassable (e.g. "@aoacademy" naively matching
 *   "attacker@evilaoacademy"). The domain must be EXACTLY the entry domain,
 *   or a real subdomain of it (ends with ".<entry>").
 *   Deliberately NO "starts-with" / TLD-agnostic fallback: that branch was
 *   found to be its own unanchored bypass — with entry "@aoacademy",
 *   "attacker@aoacademy.evilhacker.io" would satisfy a naive
 *   `startsWith("aoacademy.")` check, since anyone who owns ANY domain can
 *   prefix it with "aoacademy.". The consequence is deliberate: allowlist
 *   entries must be exact emails or FULL domains including the TLD — a
 *   TLD-less entry like "@aoacademy" matches ONLY the literal domain
 *   "aoacademy" (and its subdomains), never "aoacademy.com" etc.
 * - Any other entry is an EXACT email match.
 * - Malformed entries (blank after trim, or a bare "@" with nothing after
 *   it) never match anything — they're silently skipped, not an error.
 */
export function isHeroScriptAllowedEmail(
  email: string | null | undefined,
  allowlistEnv: string | undefined,
): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return false;

  const entries = (allowlistEnv ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  for (const entry of entries) {
    if (entry.startsWith("@")) {
      const entryDomain = entry.slice(1);
      if (!entryDomain) continue;

      const atIdx = normalizedEmail.lastIndexOf("@");
      if (atIdx < 0) continue;
      const emailDomain = normalizedEmail.slice(atIdx + 1);

      if (emailDomain === entryDomain || emailDomain.endsWith("." + entryDomain)) {
        return true;
      }
    } else if (entry === normalizedEmail) {
      return true;
    }
  }
  return false;
}

/** Convenience wrapper: reads HERO_SCRIPT_ALLOWED_EMAILS + an actor-like object's email. */
export function isHeroScriptAllowedUser(
  actor: { email?: string | null } | null | undefined,
): boolean {
  return isHeroScriptAllowedEmail(actor?.email, process.env.HERO_SCRIPT_ALLOWED_EMAILS);
}

// Shared 403 payload for the 11 hero-script API routes (see requireHeroScriptUser
// in hero-script.server.ts) — one definition instead of 11 copy-pasted literals.
export const HERO_SCRIPT_LOCKED_CODE = "FEATURE_LOCKED";
export const HERO_SCRIPT_LOCKED_MESSAGE = "ฟีเจอร์นี้ยังอยู่ในช่วงทดสอบภายใน";

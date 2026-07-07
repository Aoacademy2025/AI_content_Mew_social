import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { grantTrial, TRIAL_DAYS_PUBLIC } from "@/lib/trial";
import { syncUserEntitlement } from "@/lib/entitlements";
import { resolveServiceActor } from "@/lib/mcp/service-actor";

// ── Admin trust root (SEC-11 hardening) ──────────────────────────────────────
// ADMIN is granted ONLY from an email Clerk has VERIFIED as the account's PRIMARY,
// and only when that email is on the explicit ADMIN_EMAILS allowlist OR the legacy
// internal @aoacademy.co domain. Two invariants keep this safe:
//   1. Verified-primary-only: an attacker who merely attaches an *unverified*
//      @aoacademy.co address to their Clerk account cannot escalate. (The old code
//      read emailAddresses[0] with no verification/primary check — that was the hole.)
//   2. Upgrade-only: this path never demotes. A row whose role is already ADMIN
//      (e.g. the owner, set manually via /admin, or an explicit seed) is returned
//      untouched, so tightening the predicate cannot lock an existing admin out.
const ADMIN_EMAIL_DOMAIN = "@aoacademy.co";

function adminEmailAllowlist(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** True if this email qualifies for ADMIN by allowlist or internal domain (case-insensitive). */
function emailQualifiesForAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  return adminEmailAllowlist().has(normalized) || normalized.endsWith(ADMIN_EMAIL_DOMAIN);
}

/**
 * Resolve a Clerk account's PRIMARY email and whether it should grant ADMIN.
 * Keys off primaryEmailAddressId (like the clerk-webhook) — NOT emailAddresses[0] — and
 * requires that primary email to be Clerk-verified before it can grant ADMIN.
 */
function resolveClerkIdentity(
  clerkUser: NonNullable<Awaited<ReturnType<typeof currentUser>>>
): { email: string | undefined; grantsAdmin: boolean } {
  const primary =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId) ??
    clerkUser.emailAddresses[0];
  const email = primary?.emailAddress;
  const primaryVerified = primary?.verification?.status === "verified";
  return { email, grantsAdmin: primaryVerified && emailQualifiesForAdmin(email) };
}

/**
 * Get the current authenticated user from Prisma (server-side, Clerk-based).
 * - Looks up by clerkId first (fast path)
 * - Falls back to email match (for users migrated from NextAuth)
 * - Auto-creates Prisma row for brand-new Clerk signups
 */
export async function getCurrentUser(): Promise<User | null> {
  // Additive: internal service calls (MCP orchestrator) act as a given user via a
  // server-only secret header. Browsers can't set it → the Clerk path below is unchanged.
  const serviceActor = await resolveServiceActor();
  if (serviceActor) return serviceActor;

  const { userId } = await auth();
  if (!userId) return null;

  // Fast path: already linked
  let user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (user) {
    // Upgrade-only ADMIN grant for an already-linked row (rows created before the admin rule,
    // or before an ADMIN_EMAILS entry was added). Keyed on the STORED email — which is always
    // the Clerk verified-primary (written by the webhook + the hardened slow-path below), so no
    // Clerk round-trip is needed on this hot path. Never demotes.
    if (user.role !== "ADMIN" && emailQualifiesForAdmin(user.email)) {
      user = await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    }
    const synced = await syncUserEntitlement(user.id);
    if (synced?.changed) {
      return prisma.user.findUnique({ where: { id: user.id } }) as Promise<User | null>;
    }
    return user;
  }

  // Slow path: match by email (existing NextAuth user)
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  // Use the VERIFIED PRIMARY email (matches clerk-webhook) — not emailAddresses[0]. `email` is
  // used for row storage/matching; `isAdminEmail` gates the ADMIN grant and is true only when
  // that primary email is Clerk-verified AND allowlisted / internal-domain.
  const { email, grantsAdmin: isAdminEmail } = resolveClerkIdentity(clerkUser);
  if (!email) return null;

  user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    // Link clerkId and upgrade to ADMIN only if the verified-primary email qualifies (allowlist/domain)
    const linked = await prisma.user.update({
      where: { id: user.id },
      data: {
        clerkId: userId,
        ...(isAdminEmail && user.role !== "ADMIN" ? { role: "ADMIN" } : {}),
      },
    });
    const synced = await syncUserEntitlement(linked.id);
    if (synced?.changed) {
      return prisma.user.findUnique({ where: { id: linked.id } }) as Promise<User | null>;
    }
    return linked;
  }

  // New user — create Prisma record + start their 7-day PRO trial.
  // Race-safe: a brand-new user's first page load fires several authed API calls at
  // once (e.g. /api/user/me + /api/user/api-keys/status); they all reach here and try
  // to create the same row. The first wins; the rest hit a P2002 unique violation
  // (email/clerkId) — recover by reusing the row the winner just created instead of
  // surfacing a 500.
  let created: User;
  try {
    created = await prisma.user.create({
      data: {
        clerkId: userId,
        name:
          `${clerkUser.firstName ?? ""} ${clerkUser.lastName ?? ""}`.trim() ||
          email.split("@")[0],
        email,
        image: clerkUser.imageUrl ?? null,
        ...(isAdminEmail ? { role: "ADMIN" } : {}),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // A concurrent request created this user first — use theirs (it created the row
      // with our clerkId + email, and runs grantTrial itself).
      const existing =
        (await prisma.user.findUnique({ where: { clerkId: userId } })) ??
        (await prisma.user.findUnique({ where: { email } }));
      if (existing) return existing;
    }
    throw e;
  }
  await grantTrial(created.id, TRIAL_DAYS_PUBLIC); // idempotent if the webhook already granted
  return prisma.user.findUnique({ where: { id: created.id } }) as Promise<typeof created>;
}

/**
 * Like getCurrentUser() but throws 401 if not authenticated.
 * Use inside API route handlers.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

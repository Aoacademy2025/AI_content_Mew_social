import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { grantTrial, TRIAL_DAYS_PUBLIC } from "@/lib/trial";
import { syncUserEntitlement, classifyEntitlement } from "@/lib/entitlements";
import { resolveServiceActor } from "@/lib/mcp/service-actor";
import { AFF_COOKIE, sanitizeRefCode } from "@/lib/affiliate-ref";
import {
  assertHeroVoiceCanaryIsolatedEnvironment,
  resolveHeroVoiceCanarySessionUser,
} from "@/lib/hero-voice-canary-auth.server";
import {
  ensureHeroVoiceCanaryReadReady,
  runHeroVoiceCanarySerializedMutation,
} from "@/lib/hero-voice-deletion-coordinator.server";

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
 * STAB-4 backstop (defense-in-depth against a stopped/401ing trial-expiry cron).
 * Runs on the row we're about to return: if it STILL shows a paid plan whose entitlement
 * has lapsed (expired trial or expired timed plan, no active subscription), demote it to
 * FREE inline before returning — so an expired trial can never keep PRO just because the
 * cron isn't running.
 *
 * Rules are NOT duplicated here: `classifyEntitlement` is the single source of the
 * downgrade decision (it returns KEEP for active subscribers and still-valid trials/timed
 * plans, and REVIEW — never DOWNGRADE — for comped/manual paid rows with no expiry), and
 * persistence reuses `syncUserEntitlement`. In the normal flow syncUserEntitlement() has
 * already demoted the row upstream, so classifyEntitlement returns KEEP here and this is a
 * pure in-memory no-op (no DB round-trip); it only does extra work in the anomaly where
 * that upstream persist did not land — which is exactly the leak STAB-4 must close.
 */
async function demoteLapsedPaidPlan(user: User | null): Promise<User | null> {
  if (!user || user.plan === "FREE") return user;
  if (classifyEntitlement(user).action !== "DOWNGRADE") return user;
  const synced = await syncUserEntitlement(user.id);
  if (synced?.changed) {
    return (await prisma.user.findUnique({ where: { id: user.id } })) ?? user;
  }
  return user;
}

/**
 * Get the current authenticated user from Prisma (server-side, Clerk-based).
 * - Looks up by clerkId first (fast path)
 * - Falls back to email match (for users migrated from NextAuth)
 * - Auto-creates Prisma row for brand-new Clerk signups
 */
async function getCurrentUserForClerkId(userId: string): Promise<User | null> {
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
    return demoteLapsedPaidPlan(user); // STAB-4 backstop (no-op unless the sync above missed a lapse)
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
    return demoteLapsedPaidPlan(linked); // STAB-4 backstop (no-op unless the sync above missed a lapse)
  }

  // New user — create Prisma record + start their 7-day PRO trial.
  // Race-safe: a brand-new user's first page load fires several authed API calls at
  // once (e.g. /api/user/me + /api/user/api-keys/status); they all reach here and try
  // to create the same row. The first wins; the rest hit a P2002 unique violation
  // (email/clerkId) — recover by reusing the row the winner just created instead of
  // surfacing a 500.
  // Stamp the affiliate ref ONCE, at first sign-in — read from the aff_ref cookie set by
  // the middleware (logged-in ?ref=) or the tracking script (anonymous). Written only here;
  // never updated later, by design.
  let affiliateRefCode: string | null = null;
  try {
    const jar = await cookies();
    affiliateRefCode = sanitizeRefCode(jar.get(AFF_COOKIE)?.value);
  } catch {
    // outside request scope (service actor path) — no stamp
  }

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
        ...(affiliateRefCode ? { affiliateRefCode } : {}),
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
  // A Bundle may have been bought before this Clerk account existed. The
  // email-backed grant is claimed here so the first dashboard response is PRO.
  await syncUserEntitlement(created.id);
  return prisma.user.findUnique({ where: { id: created.id } }) as Promise<typeof created>;
}

export async function getCurrentUser(): Promise<User | null> {
  // The marked evaluator has its own Clerk authority and prebootstrapped user.
  // Authenticate there before ordinary service actors, lazy user creation,
  // role/entitlement sync, or trial grants can run.
  if (process.env.HERO_VOICE_CANARY_EXECUTION_MODE === "1") {
    try {
      assertHeroVoiceCanaryIsolatedEnvironment({ requireAuthAttestation: true });
      await ensureHeroVoiceCanaryReadReady();
      return await resolveHeroVoiceCanarySessionUser(await auth());
    } catch {
      return null;
    }
  }
  const deletionStartup = await ensureHeroVoiceCanaryReadReady();
  // Additive: internal service calls (MCP orchestrator) act as a given user via a
  // server-only secret header. Browsers can't set it → the Clerk path below is unchanged.
  const serviceActor = await resolveServiceActor();
  if (serviceActor) return serviceActor;

  const { userId } = await auth();
  if (!userId) return null;

  // A failed canary recovery permits only an existing-row auth read. It cannot
  // link/create users, grant a trial, sync entitlements, or change an admin role.
  if (deletionStartup.mode === "read_only") {
    return prisma.user.findUnique({ where: { clerkId: userId } });
  }

  // Existing-user entitlement/role sync and brand-new Clerk bootstrap can write
  // owner rows, so they share the same coordinator boundary as generation and
  // review mutations. An account delete cannot race a local user recreation.
  return runHeroVoiceCanarySerializedMutation(() => getCurrentUserForClerkId(userId));
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

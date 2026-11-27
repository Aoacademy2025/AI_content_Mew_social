import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaid } from "@/lib/plan-limits";
import { resolveEffectiveEntitlement } from "@/lib/entitlements";
import { isMcpPatToken, resolveMcpToken } from "@/lib/mcp/token";

export { isMcpPatToken };

export type McpPrincipal = {
  userId: string;
  plan: string; // raw stored plan
  effectivePlan: string; // after Paid-Equivalent + entitlement classification
  user: User;
};

/**
 * Resolve a bearer PAT to a principal with its CURRENT effective plan.
 * null when the token is invalid/revoked/expired or the user is gone.
 * Does NOT enforce plan — the per-tool guard does, so we can return a friendly
 * upsell instead of a bare 401 for downgraded-but-authenticated users.
 */
export async function resolveMcpPrincipal(token: string | undefined | null): Promise<McpPrincipal | null> {
  const resolved = await resolveMcpToken(token, { includeUser: true });
  if (!resolved) return null;
  const user = resolved.user !== undefined
    ? resolved.user
    : await prisma.user.findUnique({ where: { id: resolved.userId } });
  if (!user) return null;
  return principalFromUser(user);
}

/** Build a principal (plan/effectivePlan) from a loaded Prisma user. */
export async function principalFromUser(user: User, now: Date = new Date()): Promise<McpPrincipal> {
  const entitlement = await resolveEffectiveEntitlement(user, now);
  return { userId: user.id, plan: user.plan, effectivePlan: entitlement.effectivePlan, user };
}

/** Resolve a principal from a Clerk user id — for OAuth-authenticated requests (desktop app). */
export async function resolveMcpPrincipalByClerkId(clerkId: string | null | undefined): Promise<McpPrincipal | null> {
  if (!clerkId) return null;
  const user = await prisma.user.findUnique({ where: { clerkId } });
  if (!user) return null;
  return principalFromUser(user);
}

/** Whether a principal's current effective plan may use member MCP tools. */
export function mcpAccessAllowed(effectivePlan: string): boolean {
  return isPaid(effectivePlan); // PRO | BUSINESS
}

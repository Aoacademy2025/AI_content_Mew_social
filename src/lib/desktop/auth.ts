import { resolveMcpPrincipal, resolveMcpPrincipalByClerkId, type McpPrincipal } from "@/lib/mcp/auth";
import { verifyClerkOAuthAccessToken } from "@/lib/mcp/clerk-token";

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1];
}

/**
 * Resolve the caller of a desktop API request.
 * Tries a Clerk OAuth access token first (same Clerk verification as MCP),
 * then an MCP PAT. Returns null when neither authenticates.
 */
export async function resolveDesktopPrincipal(req: Request): Promise<McpPrincipal | null> {
  const token = bearerToken(req);
  const clerkUserId = await verifyClerkOAuthAccessToken(token);
  if (clerkUserId) {
    const principal = await resolveMcpPrincipalByClerkId(clerkUserId);
    if (principal) return principal;
  }
  return resolveMcpPrincipal(token);
}

type ClerkOAuthVerifier = (bearerToken?: string) => Promise<string | null>;

/**
 * Verify a Clerk OAuth access token and return the Clerk user id.
 * Same verification the MCP handler used inline before this extract:
 * `auth({ acceptsToken: "oauth_token" })` then `verifyClerkToken`.
 * null when the token is missing, invalid, expired, or not a Clerk OAuth token.
 *
 * Clerk packages are imported inside the live path so verify scripts can stub
 * this helper without loading `@clerk/mcp-tools/next` (not exported under Node).
 */
async function verifyClerkOAuthAccessTokenLive(bearerToken?: string): Promise<string | null> {
  try {
    const { auth } = await import("@clerk/nextjs/server");
    const { verifyClerkToken } = await import("@clerk/mcp-tools/next");
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const verified = await verifyClerkToken(clerkAuth, bearerToken);
    if (verified) {
      return (verified.extra as { userId?: string } | undefined)?.userId ?? verified.clientId ?? null;
    }
  } catch {
    // not a valid Clerk OAuth token → caller falls through
  }
  return null;
}

let verifierOverride: ClerkOAuthVerifier | null = null;

export async function verifyClerkOAuthAccessToken(bearerToken?: string): Promise<string | null> {
  return (verifierOverride ?? verifyClerkOAuthAccessTokenLive)(bearerToken);
}

/** Test-only. Requires DESKTOP_SESSION_VERIFY=1. Never used by production routes. */
export function setClerkOAuthAccessTokenVerifierForTests(fn: ClerkOAuthVerifier | null): void {
  if (process.env.DESKTOP_SESSION_VERIFY !== "1") {
    throw new Error("Clerk OAuth verifier override requires DESKTOP_SESSION_VERIFY=1");
  }
  verifierOverride = fn;
}

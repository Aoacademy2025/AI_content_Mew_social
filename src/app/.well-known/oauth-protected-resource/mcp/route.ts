// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
// Tells MCP clients (Claude desktop app) which authorization server (Clerk) issues
// valid tokens. The MCP route's 401 WWW-Authenticate points here (resourceMetadataPath).
import { protectedResourceHandlerClerk, metadataCorsOptionsRequestHandler } from "@clerk/mcp-tools/next";

export const runtime = "nodejs";

const baseHandler = protectedResourceHandlerClerk({ scopes_supported: ["email", "profile"] });

// Behind a reverse proxy, Next's `request.url` uses the internal bind host (localhost:3000),
// so the Clerk helper would advertise the wrong `resource`. Use a TRUSTED server-side origin
// (env MCP_PUBLIC_ORIGIN, e.g. https://studio.heroaiengine.com) — NOT the client-spoofable
// Host / X-Forwarded-Host header. Falls back to the request origin for local dev (no proxy).
export function GET(req: Request): Response {
  const publicOrigin = process.env.MCP_PUBLIC_ORIGIN?.replace(/\/$/, "");
  if (!publicOrigin) return baseHandler(req);
  return baseHandler(new Request(`${publicOrigin}/.well-known/oauth-protected-resource/mcp`));
}

export const OPTIONS = metadataCorsOptionsRequestHandler();

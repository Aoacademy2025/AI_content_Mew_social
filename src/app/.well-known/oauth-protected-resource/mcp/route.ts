// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
// Tells MCP clients (Claude desktop app) which authorization server (Clerk) issues
// valid tokens. The MCP route's 401 WWW-Authenticate points here (resourceMetadataPath).
import { protectedResourceHandlerClerk, metadataCorsOptionsRequestHandler } from "@clerk/mcp-tools/next";

export const runtime = "nodejs";

const baseHandler = protectedResourceHandlerClerk({ scopes_supported: ["email", "profile"] });

// Behind Nginx, Next's `request.url` uses the internal bind host (localhost:3000), so the
// Clerk helper would advertise the wrong `resource`. Rebuild the URL from the forwarded/Host
// header (Nginx sets `Host`) so the resource is the real public origin.
export function GET(req: Request): Response {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return baseHandler(req);
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(/:$/, "");
  return baseHandler(new Request(`${proto}://${host}/.well-known/oauth-protected-resource/mcp`));
}

export const OPTIONS = metadataCorsOptionsRequestHandler();

// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
// Tells MCP clients (Claude desktop app) which authorization server (Clerk) issues
// valid tokens. The MCP route's 401 WWW-Authenticate points here (resourceMetadataPath).
import { protectedResourceHandlerClerk, metadataCorsOptionsRequestHandler } from "@clerk/mcp-tools/next";

export const runtime = "nodejs";

export const GET = protectedResourceHandlerClerk({ scopes_supported: ["email", "profile"] });
export const OPTIONS = metadataCorsOptionsRequestHandler();

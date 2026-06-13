// OAuth 2.0 Authorization Server Metadata (RFC 8414) proxied from Clerk — still expected
// by clients implementing the older MCP auth spec. Points discovery at Clerk's AS.
import { authServerMetadataHandlerClerk, metadataCorsOptionsRequestHandler } from "@clerk/mcp-tools/next";

export const runtime = "nodejs";

export const GET = authServerMetadataHandlerClerk();
export const OPTIONS = metadataCorsOptionsRequestHandler();

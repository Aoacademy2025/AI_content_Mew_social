import { quoteBrowserOwner } from "@/lib/mcp/video-quote-browser-auth.server";
import { createQuoteHttpHandlers } from "@/lib/mcp/video-quote-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST } = createQuoteHttpHandlers(quoteBrowserOwner);

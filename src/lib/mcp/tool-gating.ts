import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { mcpEditorProjectEnabledFor } from "@/lib/mcp/chain-export";
import { recordToolCall, isInBandError } from "@/lib/mcp/audit";

/**
 * Task 4 spike (full writeup: docs/plans/reports/2026-10-03-mcp-edit-before-export/task-4.md).
 *
 * The stateless MCP route (`src/app/api/[transport]/route.ts`) builds a brand new
 * `McpServer` on every HTTP POST — mcp-handler's `initializeServer(server)` factory
 * call — but that factory receives only `server`, never the request or its
 * verified auth. Per-principal tool registration is possible anyway:
 * `src/lib/mcp/request-principal.ts` threads the already-verified `McpPrincipal`
 * into the factory through an `AsyncLocalStorage` set once inside `verifyToken`,
 * so by the time the factory calls `registerGatedTool` the real principal for
 * THIS request is already in hand — no second auth/DB lookup, negligible added
 * latency (measured in task-4.md).
 *
 * `registerGatedTool` simply never calls `server.registerTool()` for an
 * unentitled principal. That is what keeps the tool out of `tools/list` (G1):
 * the SDK's own list handler (`McpServer.setToolRequestHandlers`, in
 * `@modelcontextprotocol/sdk/server/mcp.js`) enumerates `_registeredTools`
 * directly, so an unregistered name is invisible with no extra filtering code —
 * there is no path to ever shipping "listed but refused".
 *
 * The one gap that leaves: a direct `tools/call` of that (unregistered) name
 * would otherwise hit the SDK's own generic `McpError("Tool X not found")` — a
 * bare protocol-level error that never reaches our envelope/audit code at all.
 * `installFeatureGateCallInterceptor` closes it by wrapping the low-level
 * `tools/call` handler once per server, so a *known* gated name gets the G14
 * envelope instead, while every other call — every existing tool, and any gated
 * tool this principal IS entitled to — is forwarded completely unmodified to the
 * exact handler the SDK already installed.
 *
 * That wrap reads `server.server._requestHandlers` — a plain (TS-soft-private,
 * not a hard `#field`) `Map` on the `Server` instance the SDK itself exposes for
 * "advanced usage ... setting custom request handlers" (its own doc comment on
 * `McpServer.server`). It is the only way to *capture* the already-installed
 * default handler rather than discard it: `Server.setRequestHandler` refuses to
 * overwrite an existing handler for the same method, and the SDK does not
 * otherwise expose a getter. If an SDK upgrade ever renames or removes this
 * field, `scripts/verify-mcp-tool-gating.ts` fails loudly (the thrown Error
 * below, or a failed assertion) — never a silent "every call let through".
 */

export type GatingPrincipal = Pick<McpPrincipal, "userId" | "user"> | null | undefined;

type RegisterToolConfig = Parameters<McpServer["registerTool"]>[1];
type RegisterToolCallback = Parameters<McpServer["registerTool"]>[2];

const CALL_TOOL_METHOD = "tools/call";

const FEATURE_NOT_ENABLED_MESSAGE =
  "ฟีเจอร์นี้ยังไม่เปิดให้ใช้งานสำหรับบัญชีนี้ในตอนนี้ — ลองใหม่อีกครั้งภายหลัง";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function featureNotEnabledEnvelope(next: string) {
  return {
    error: "feature_not_enabled" as const,
    code: "feature_not_enabled" as const,
    message: FEATURE_NOT_ENABLED_MESSAGE,
    next,
  };
}

type RawToolCallHandler = (request: unknown, extra: unknown) => unknown;
type LowLevelServer = { _requestHandlers: Map<string, RawToolCallHandler> };

// Per-server (one per POST — see module doc) bookkeeping: which gated names THIS
// request hid, each mapped to its own "what to call next" hint, plus whether the
// tools/call interceptor has already been installed for that server.
const hiddenToolNames = new WeakMap<LowLevelServer, Map<string, string>>();
const interceptorInstalled = new WeakSet<LowLevelServer>();

function hiddenNamesFor(lowServer: LowLevelServer): Map<string, string> {
  let map = hiddenToolNames.get(lowServer);
  if (!map) {
    map = new Map();
    hiddenToolNames.set(lowServer, map);
  }
  return map;
}

function installFeatureGateCallInterceptor(lowServer: LowLevelServer, principal: GatingPrincipal) {
  if (interceptorInstalled.has(lowServer)) return;
  interceptorInstalled.add(lowServer);

  const original = lowServer._requestHandlers.get(CALL_TOOL_METHOD);
  if (!original) {
    // registerGatedTool only ever runs after route.ts registers the base tools
    // (registerTool() -> setToolRequestHandlers() installs the default tools/call
    // handler on the FIRST ever registration), so a real handler always exists by
    // the time any tool is hidden. If that ordering ever changes, fail loudly
    // instead of silently granting every unregistered name a free pass through
    // to the SDK's generic "tool not found".
    throw new Error(
      "registerGatedTool: no tools/call handler installed yet — register at least one real tool before any gated tool",
    );
  }

  lowServer._requestHandlers.set(CALL_TOOL_METHOD, async (request, extra) => {
    const name = (request as { params?: { name?: string } } | undefined)?.params?.name;
    const next = name ? hiddenNamesFor(lowServer).get(name) : undefined;
    if (name && next !== undefined) {
      const started = Date.now();
      const envelope = featureNotEnabledEnvelope(next);
      await recordToolCall({
        userId: principal?.userId ?? null,
        toolName: name,
        status: isInBandError(envelope) ? "error" : "ok",
        durationMs: Date.now() - started,
      });
      return text(envelope);
    }
    return original(request, extra);
  });
}

/**
 * Registers `name` on `server` only when `principal` passes
 * `mcpEditorProjectEnabledFor` — the same beta/flag gate as Agent-created
 * Projects (ADR 0063/0064, flag `MCP_EDITOR_PROJECT_PUBLIC`). For an unentitled
 * principal the tool is never added to the server at all: absent from
 * `tools/list` with no extra filtering, and a direct `tools/call` of that exact
 * name gets the G14 envelope `{error, code, message, next}` — audited through
 * the same `recordToolCall`/`isInBandError` path as every other tool — instead
 * of the SDK's generic "tool not found".
 */
export function registerGatedTool(
  server: McpServer,
  principal: GatingPrincipal,
  name: string,
  def: RegisterToolConfig,
  handler: RegisterToolCallback,
  opts: { next: string },
): void {
  if (principal?.user && mcpEditorProjectEnabledFor(principal.user)) {
    server.registerTool(name, def, handler);
    return;
  }
  const lowServer = server.server as unknown as LowLevelServer;
  installFeatureGateCallInterceptor(lowServer, principal);
  hiddenNamesFor(lowServer).set(name, opts.next);
}

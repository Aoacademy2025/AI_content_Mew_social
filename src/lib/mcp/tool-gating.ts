import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { mcpEditorProjectEnabledFor } from "@/lib/mcp/chain-export";
import { recordToolCall } from "@/lib/mcp/audit";

/**
 * Per-principal MCP tool gating (Task 4 spike: docs/plans/reports/2026-10-03-mcp-edit-before-export/task-4.md;
 * wired into the live route by Task 6).
 *
 * The stateless MCP route (`src/app/api/[transport]/route.ts`) builds a brand new
 * `McpServer` on every HTTP POST — mcp-handler's `initializeServer(server)` factory
 * call — but that factory receives only `server`, never the request or its
 * verified auth. The route bridges that gap with `src/lib/mcp/request-principal.ts`:
 * its exported GET/POST/DELETE run inside `runWithRequestPrincipalSlot`, its
 * `verifyToken` calls `setRequestPrincipal` once it has resolved the bearer token,
 * and the factory reads `getRequestPrincipal()` and passes it here. So the real,
 * already-verified principal for THIS request decides what is registered — no
 * second auth/DB lookup.
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
 * envelope (audited as `denied`, like the plan guard's refusals) instead, while
 * every other call — every existing tool, and any gated tool this principal IS
 * entitled to — is forwarded completely unmodified to the exact handler the SDK
 * already installed.
 *
 * Registration order does not matter: if no tool has been registered yet, the
 * interceptor first asks the SDK to install its default tools handlers
 * (`setToolRequestHandlers`, idempotent — the same call `registerTool` makes).
 *
 * The wrap reads `server.server._requestHandlers` — a plain (TS-soft-private,
 * not a hard `#field`) `Map` on the `Server` instance the SDK itself exposes for
 * "advanced usage ... setting custom request handlers" (its own doc comment on
 * `McpServer.server`). It is the only way to *capture* the already-installed
 * default handler rather than discard it: `Server.setRequestHandler` refuses to
 * overwrite an existing handler for the same method, and the SDK does not
 * otherwise expose a getter. `mcpSdkGatingShapeProblem` checks that shape; if an
 * SDK upgrade ever changes it, the hidden tool degrades to "not registered" (the
 * SDK's generic not-found error — still never listed, never runnable) with one
 * console warning, the request keeps working, and
 * `scripts/verify-mcp-tool-gating.ts` fails loudly in CI.
 */

export type GatingPrincipal = Pick<McpPrincipal, "userId" | "user"> | null | undefined;

/** `McpServer.registerTool`'s config for a flat zod input shape (`Parameters<>` of the generic
 *  overloaded method collapses to `never`, so the shape is spelled out). */
type GatedToolConfig<InputArgs extends ZodRawShape> = {
  title?: string;
  description?: string;
  inputSchema: InputArgs;
};

const CALL_TOOL_METHOD = "tools/call";

const FEATURE_NOT_ENABLED_MESSAGE =
  "ฟีเจอร์นี้ยังไม่เปิดให้ใช้งานสำหรับบัญชีนี้ในตอนนี้ — ลองใหม่อีกครั้งภายหลัง";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

/** The G14 refusal for a beta-gated capability (gated tools, and create_video_job's exportMode). */
export function featureNotEnabledEnvelope(next: string) {
  return {
    error: "feature_not_enabled" as const,
    code: "feature_not_enabled" as const,
    message: FEATURE_NOT_ENABLED_MESSAGE,
    next,
  };
}

type RawToolCallHandler = (request: unknown, extra: unknown) => unknown;
type LowLevelServer = { _requestHandlers: Map<string, RawToolCallHandler> };
type ToolHandlerInstaller = { setToolRequestHandlers?: () => void };

/**
 * null when `server` has the SDK internals the interceptor relies on; otherwise a short
 * description of what changed. Exported for the verify script's SDK shape guard.
 */
export function mcpSdkGatingShapeProblem(server: McpServer): string | null {
  const lowServer = (server as unknown as { server?: unknown }).server as Partial<LowLevelServer> | undefined;
  if (!lowServer || !(lowServer._requestHandlers instanceof Map)) {
    return "server.server._requestHandlers is not a Map";
  }
  if (typeof (server as unknown as ToolHandlerInstaller).setToolRequestHandlers !== "function") {
    return "McpServer.setToolRequestHandlers is not a function";
  }
  return null;
}

let shapeWarningLogged = false;

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

function installFeatureGateCallInterceptor(server: McpServer, lowServer: LowLevelServer, principal: GatingPrincipal) {
  if (interceptorInstalled.has(lowServer)) return;

  if (!lowServer._requestHandlers.has(CALL_TOOL_METHOD)) {
    // No real tool registered yet on this server: install the SDK's default tools/list +
    // tools/call handlers first (idempotent; exactly what the first registerTool() does).
    (server as unknown as Required<ToolHandlerInstaller>).setToolRequestHandlers();
  }
  const original = lowServer._requestHandlers.get(CALL_TOOL_METHOD);
  if (!original) {
    // Unreachable with SDK 1.26 (setToolRequestHandlers always installs tools/call). Never
    // install a wrapper that would forward to nothing.
    throw new Error("registerGatedTool: the SDK did not install a tools/call handler");
  }
  interceptorInstalled.add(lowServer);

  lowServer._requestHandlers.set(CALL_TOOL_METHOD, async (request, extra) => {
    const params = (request as { params?: { name?: string; arguments?: unknown } } | undefined)?.params;
    const name = params?.name;
    const next = name ? hiddenNamesFor(lowServer).get(name) : undefined;
    if (name && next !== undefined) {
      const started = Date.now();
      const userAgent = ((extra as { authInfo?: { extra?: { userAgent?: unknown } } } | undefined)
        ?.authInfo?.extra?.userAgent);
      await recordToolCall({
        userId: principal?.userId ?? null,
        toolName: name,
        // A gate refusal is an access decision, audited like the plan guard's refusals.
        status: "denied",
        durationMs: Date.now() - started,
        requestJson: params?.arguments,
        userAgent: typeof userAgent === "string" ? userAgent : null,
      });
      return text(featureNotEnabledEnvelope(next));
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
 * `recordToolCall` with status `denied` — instead of the SDK's generic
 * "tool not found". Safe to call before or after any
 * `server.registerTool()`.
 */
export function registerGatedTool<InputArgs extends ZodRawShape>(
  server: McpServer,
  principal: GatingPrincipal,
  name: string,
  def: GatedToolConfig<InputArgs>,
  handler: ToolCallback<InputArgs>,
  opts: { next: string },
): void {
  if (principal?.user && mcpEditorProjectEnabledFor(principal.user)) {
    server.registerTool(name, def, handler);
    return;
  }
  const shapeProblem = mcpSdkGatingShapeProblem(server);
  if (shapeProblem) {
    // Fail closed without breaking the request: the tool stays unregistered (never listed,
    // never runnable); only the friendly envelope is lost until the SDK shape is handled.
    if (!shapeWarningLogged) {
      shapeWarningLogged = true;
      console.warn(`[mcp-tool-gating] SDK shape changed (${shapeProblem}); gated tools fall back to not-found`);
    }
    return;
  }
  const lowServer = server.server as unknown as LowLevelServer;
  installFeatureGateCallInterceptor(server, lowServer, principal);
  hiddenNamesFor(lowServer).set(name, opts.next);
}

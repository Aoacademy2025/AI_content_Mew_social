import { AsyncLocalStorage } from "node:async_hooks";
import type { McpPrincipal } from "@/lib/mcp/auth";

/**
 * The verified `McpPrincipal` of the current MCP request, for code that runs where the
 * request is not in scope (Task 4 spike: docs/plans/reports/2026-10-03-mcp-edit-before-export/task-4.md;
 * wired into the live route by Task 6).
 *
 * mcp-handler builds a brand new `McpServer` on every POST to the stateless MCP route and
 * calls its factory as `initializeServer(server)` — the factory gets only the `server`
 * argument, never the request or its verified auth. `src/app/api/[transport]/route.ts`
 * threads the already-resolved principal through this AsyncLocalStorage instead of
 * re-verifying the token a second time:
 *
 *   1. The exported GET/POST/DELETE handlers wrap the real handler in
 *      `runWithRequestPrincipalSlot`.
 *   2. `verifyToken` (called once per request by `withMcpAuth`, before the factory runs)
 *      calls `setRequestPrincipal` with the principal it resolved (PAT or Clerk OAuth).
 *   3. The server factory calls `getRequestPrincipal()` — later in the SAME request's async
 *      chain, so the store set in step 2 is still current — and hands it to
 *      `registerGatedTool` (tool-gating.ts), which decides per request which tools exist.
 *
 * No second DB lookup, no change to what gets authenticated — this is pure plumbing for a
 * value that already exists by the time the factory needs it. A request whose token did not
 * verify never reaches the factory (`withMcpAuth` answers 401 first).
 */
const principalSlot = new AsyncLocalStorage<{ principal: McpPrincipal | null }>();

export async function runWithRequestPrincipalSlot<T>(fn: () => Promise<T>): Promise<T> {
  return principalSlot.run({ principal: null }, fn);
}

/** Called once per request, from verifyToken, right after it resolves (or fails to resolve) a principal. */
export function setRequestPrincipal(principal: McpPrincipal | null): void {
  const store = principalSlot.getStore();
  if (store) store.principal = principal;
}

/** Read inside the per-request server factory. `null` outside a `runWithRequestPrincipalSlot` call (e.g. in a test that builds a server directly — such a caller passes its own principal to `registerGatedTool` instead). */
export function getRequestPrincipal(): McpPrincipal | null {
  return principalSlot.getStore()?.principal ?? null;
}

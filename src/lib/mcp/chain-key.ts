/**
 * T8 (ADR 0063): the idempotency-key namespace of the server-chained MCP export.
 *
 * Zero-import leaf so the web jobs route can refuse a caller-supplied chain key without
 * pulling the chain module (and its render/editor dependencies) into the route — and so the
 * editor runtime harness can load the real module instead of a hand-written mock.
 *
 * T5 (ADR 0064, G7): a Held Preview's later jobs are keyed per Pending Edit Draft revision —
 * `mcp-export:<rootJobId>:<draftRevision>` and `mcp-rerender:<rootJobId>:<draftRevision>` — so
 * a second export of the same root (a newer draft) is a new row, while a retry of the same
 * revision collides on the unique `(userId, idempotencyKey)` index and replays.
 */
export const MCP_CHAIN_IDEMPOTENCY_PREFIX = "mcp-chain:";
export const MCP_EXPORT_IDEMPOTENCY_PREFIX = "mcp-export:";
export const MCP_RERENDER_IDEMPOTENCY_PREFIX = "mcp-rerender:";

const RESERVED_PREFIXES = [
  MCP_CHAIN_IDEMPOTENCY_PREFIX,
  MCP_EXPORT_IDEMPOTENCY_PREFIX,
  MCP_RERENDER_IDEMPOTENCY_PREFIX,
] as const;

export function mcpChainExportKey(previewJobId: string): string {
  return `${MCP_CHAIN_IDEMPOTENCY_PREFIX}${previewJobId}`;
}

function draftRevisionPart(draftRevision: number): string {
  if (!Number.isSafeInteger(draftRevision) || draftRevision < 0) {
    throw new Error("draftRevision must be a non-negative integer");
  }
  return String(draftRevision);
}

/** The export of a Held Preview's draft at `draftRevision`. */
export function mcpExportKey(rootJobId: string, draftRevision: number): string {
  return `${MCP_EXPORT_IDEMPOTENCY_PREFIX}${rootJobId}:${draftRevisionPart(draftRevision)}`;
}

/** The B-roll re-render of a Held Preview's draft at `draftRevision`. */
export function mcpRerenderKey(rootJobId: string, draftRevision: number): string {
  return `${MCP_RERENDER_IDEMPOTENCY_PREFIX}${rootJobId}:${draftRevisionPart(draftRevision)}`;
}

/** Caller-supplied keys (MCP or web) may never claim any of the server's MCP namespaces. */
export function isReservedMcpChainIdempotencyKey(key: unknown): boolean {
  return typeof key === "string" && RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

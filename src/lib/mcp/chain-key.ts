/**
 * T8 (ADR 0063): the idempotency-key namespace of the server-chained MCP export.
 *
 * Zero-import leaf so the web jobs route can refuse a caller-supplied chain key without
 * pulling the chain module (and its render/editor dependencies) into the route — and so the
 * editor runtime harness can load the real module instead of a hand-written mock.
 */
export const MCP_CHAIN_IDEMPOTENCY_PREFIX = "mcp-chain:";

export function mcpChainExportKey(previewJobId: string): string {
  return `${MCP_CHAIN_IDEMPOTENCY_PREFIX}${previewJobId}`;
}

/** Caller-supplied keys (MCP or web) may never claim the server's chain namespace. */
export function isReservedMcpChainIdempotencyKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith(MCP_CHAIN_IDEMPOTENCY_PREFIX);
}

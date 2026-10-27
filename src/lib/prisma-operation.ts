import { AsyncLocalStorage } from "node:async_hooks";

// Static allowlist only: never accept identifiers, SQL, or request values as labels.
const OPERATIONS = [
  "credits.materializeBalance",
  "credits.resetMonthlyGranted",
  "entitlements.activateCouponTerm",
  "telemetry.recordEvent",
  "telemetry.recordOnce",
  "telemetry.recordBatch",
  "mcp.recordToolCall",
  "mcp.pruneToolCallAudit",
] as const;
export type PrismaOperation = typeof OPERATIONS[number];

// Next can bundle callers separately from the module that installs the Prisma wrapper.
const KEY = Symbol.for("heroai.prisma.operation");
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<PrismaOperation | undefined> | undefined>;
const context = holder[KEY] ??= new AsyncLocalStorage<PrismaOperation | undefined>();

export function withPrismaOperation<T>(operation: PrismaOperation, run: () => T): T {
  // Fail closed for untyped JS callers too, without changing the operation's result.
  const safe = OPERATIONS.includes(operation) ? operation : undefined;
  return context.run(safe, run);
}

export function currentPrismaOperation(): PrismaOperation | undefined {
  return context.getStore();
}

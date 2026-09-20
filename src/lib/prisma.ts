import { PrismaClient } from "@prisma/client";
import {
  slowTransactionThresholdMsFromEnv,
  sqliteBusyTimeoutSecondsFromEnv,
  sqliteCacheSizeKibFromEnv,
  transactionOptionsFromEnv,
  withSqliteConnectionParams,
} from "@/lib/prisma-options";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const isNewClient = !globalForPrisma.prisma;

const busyTimeoutSec = sqliteBusyTimeoutSecondsFromEnv();
const cacheSizeKib = sqliteCacheSizeKibFromEnv();
// Only override the datasource when there is a URL to override it with: an
// empty string is not a valid datasourceUrl, and a missing DATABASE_URL must
// keep behaving exactly as before (Prisma resolves it from schema.prisma and
// raises its own error).
const rawDatabaseUrl = process.env.DATABASE_URL ?? "";
const datasourceUrl = rawDatabaseUrl
  ? withSqliteConnectionParams(rawDatabaseUrl, { busyTimeoutSec })
  : undefined;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // SQLite serialises writers. Prisma's defaults (maxWait 2000 / timeout
    // 5000) give a queueing writer almost no room, so on production ordinary
    // lock waits surfaced as 26-53 request failures a day ("Transaction
    // already closed … timeout for this transaction was 5000 ms") on a box
    // nowhere near saturated. Wait for the lock instead of failing the
    // request. Tunable: PRISMA_TX_MAX_WAIT_MS / PRISMA_TX_TIMEOUT_MS.
    transactionOptions: transactionOptionsFromEnv(),
    // socket_timeout appended to the URL is the one timeout that reaches EVERY
    // pooled connection (see the PRAGMA note below).
    ...(datasourceUrl ? { datasourceUrl } : {}),
  });

if (isNewClient) {
  // SQLite returns SQLITE_BUSY ("database is locked") when a write can't get
  // the lock within busy_timeout. With WAL enabled (one-time
  // `PRAGMA journal_mode=WAL` per DB file — docs/ops/ops-guardrails-runbook.md §2)
  // a generous busy_timeout makes writers wait instead of erroring. This is the
  // prerequisite for the Phase 2 render worker, a second process sharing this
  // DB file (the worker sets it natively via better-sqlite3, which has NO
  // default). Prisma's own SQLite connector defaults busy_timeout to 5000ms
  // per connection (verified on Prisma 6.19.2), but that default is
  // undocumented — set it explicitly so it can never silently regress.
  // busy_timeout is per-connection and NOT persistent, so this PRAGMA is
  // belt-and-braces: it reaches only the pooled connection that executes it.
  // `socket_timeout=<sec>` on the datasource URL above is what covers every
  // connection Prisma opens. Tunable: SQLITE_BUSY_TIMEOUT_SEC.
  // cache_size rides along: a negative value is KiB, and SQLite's 2 MB default
  // is far too small for a 489 MB database — a query that keeps re-reading
  // pages from the OS holds its place in the writer queue for longer.
  // Tunable: SQLITE_CACHE_SIZE_KIB.
  // NOTE: $queryRawUnsafe, NOT $executeRawUnsafe — SQLite PRAGMA assignment
  // returns a row, and Prisma's executeRaw rejects row-returning statements
  // ("Execute returned results, which is not allowed in SQLite.").
  // Fire-and-forget so module load can never throw.
  prisma
    .$queryRawUnsafe(`PRAGMA busy_timeout = ${busyTimeoutSec * 1000}`)
    .catch((e) => console.warn("[prisma] could not set busy_timeout:", e));
  prisma
    .$queryRawUnsafe(`PRAGMA cache_size = -${cacheSizeKib}`)
    .catch((e) => console.warn("[prisma] could not set cache_size:", e));
}

// HERO-10. This measures elapsed time around Prisma's transaction call, which
// includes time waiting to start; it is not a SQLite write-lock duration. The
// source below narrows investigation to the transaction invocation without
// claiming that invocation is the lock holder.
//
// Log-only, and the timer is a Date.now() pair around a call that already
// awaits the database. Set PRISMA_SLOW_TX_MS=0 to remove it entirely.
const slowTransactionMs = slowTransactionThresholdMsFromEnv();

export function slowTransactionSourceFromStack(stack: string): string {
  for (const line of stack.split("\n").slice(1)) {
    const location = line.match(/(.+):(\d+):\d+\)?$/);
    if (!location) continue;

    const file = location[1];
    const nextAppStart = file.lastIndexOf("/.next/server/app/");
    if (nextAppStart >= 0) {
      return `${file.slice(nextAppStart + "/.next/server/".length)}:${location[2]}`;
    }

    const sourceStart = Math.max(file.lastIndexOf("/src/"), file.lastIndexOf("/scripts/"));
    if (sourceStart < 0) continue;

    const source = file.slice(sourceStart + 1);
    if (source !== "src/lib/prisma.ts") return `${source}:${location[2]}`;
  }

  return "unknown";
}

function slowTransactionSource(): string {
  return slowTransactionSourceFromStack(new Error().stack ?? "");
}

if (isNewClient && slowTransactionMs > 0) {
  type TransactionFn = (...args: unknown[]) => Promise<unknown>;
  const runTransaction = prisma.$transaction.bind(prisma) as TransactionFn;
  let sequence = 0;

  (prisma as unknown as { $transaction: TransactionFn }).$transaction = async (
    ...args: unknown[]
  ) => {
    const id = (sequence += 1);
    const source = slowTransactionSource();
    const startedAt = Date.now();
    try {
      return await runTransaction(...args);
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= slowTransactionMs) {
        // No arguments, SQL, model names or row data — only a static source
        // location and elapsed call time for correlation with timestamped logs.
        console.warn(`[prisma-slow-tx] #${id} elapsed ${elapsedMs}ms source=${source}`);
      }
    }
  };
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

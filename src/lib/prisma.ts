import { availableParallelism } from "node:os";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  slowTransactionThresholdMsFromEnv,
  sqliteBusyTimeoutSecondsFromEnv,
  sqliteCacheSizeKibFromEnv,
  sqliteConnectionLimitFromEnv,
  transactionOptionsFromEnv,
  transactionSerializationEnabledFromEnv,
  withSqliteConnectionParams,
} from "@/lib/prisma-options";
import { TransactionQueue, type TransactionSlot } from "@/lib/prisma-transaction-queue";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const isNewClient = !globalForPrisma.prisma;

const busyTimeoutSec = sqliteBusyTimeoutSecondsFromEnv();
const cacheSizeKib = sqliteCacheSizeKibFromEnv();
const transactionOptions = transactionOptionsFromEnv();
// HERO-70: never more pooled SQLite connections than the query engine has worker threads
// (see sqliteConnectionLimitFromEnv). An operator-supplied connection_limit still wins.
const connectionLimit = sqliteConnectionLimitFromEnv(process.env, availableParallelism());
// Only override the datasource when there is a URL to override it with: an
// empty string is not a valid datasourceUrl, and a missing DATABASE_URL must
// keep behaving exactly as before (Prisma resolves it from schema.prisma and
// raises its own error).
const rawDatabaseUrl = process.env.DATABASE_URL ?? "";
const datasourceUrl = rawDatabaseUrl
  ? withSqliteConnectionParams(rawDatabaseUrl, { busyTimeoutSec, connectionLimit })
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
    transactionOptions,
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

// HERO-70. Every Prisma transaction on SQLite opens with BEGIN IMMEDIATE, so only one can be
// past BEGIN at a time. Make this process's transactions take turns in one FIFO line on the JS
// side instead of racing inside the query engine, where each loser sleeps an engine worker
// thread in SQLite's busy handler — enough of those and the lock holder cannot run its COMMIT,
// which stalled production in 20 s (busy_timeout) steps. See prisma-transaction-queue.ts.
//
// - Covers interactive AND batch transactions: both take the writer lock at BEGIN, so a
//   read-only/write split would serialize nothing less.
// - Waiting in the line counts against the transaction's maxWait (per-call option, else the
//   client default): past it the call rejects with P2028, the same "unable to start" Prisma
//   gives, and the callback never runs — nothing was written, so it is safe to report.
// - A transaction awaited INSIDE another transaction's callback through the global client can
//   never start (the outer one holds the writer lock). Today it fails after busy_timeout; in the
//   line it fails after maxWait instead. Pass `tx` down rather than nesting.
// - A callback that never settles: Prisma closes the transaction at `timeout`, but the JS
//   promise stays pending, so the line moves on `timeout` ms after the callback was entered.
// - Process-wide (one line on globalThis even if a bundle evaluates this module twice).
//   Other processes are unaffected: the SQLite lock still orders them, as before.
// Off switch: PRISMA_TX_SERIALIZE=0.
const serializeTransactions = transactionSerializationEnabledFromEnv();
const TRANSACTION_QUEUE_KEY = Symbol.for("heroai.prisma.transactionQueue");

function processTransactionQueue(): TransactionQueue {
  const holder = globalThis as unknown as Record<symbol, TransactionQueue | undefined>;
  return (holder[TRANSACTION_QUEUE_KEY] ??= new TransactionQueue());
}

function queueTimeoutError(queuedMs: number, maxWaitMs: number): Error {
  return new Prisma.PrismaClientKnownRequestError(
    `Transaction API error: Unable to start a transaction in the given time. Waited ${queuedMs} ms in this process's transaction queue (maxWait ${maxWaitMs} ms).`,
    { code: "P2028", clientVersion: Prisma.prismaVersion.client },
  );
}

function positiveMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// HERO-10. This measures elapsed time around Prisma's transaction call. For an
// interactive transaction it also separates time before Prisma invokes the
// callback from time executing the callback. Neither phase is a SQLite
// write-lock duration: the callback can itself wait on its first write, and a
// pre-callback delay can be connection-pool scheduling. The source narrows
// investigation to the invocation without claiming that it is the lock holder.
// HERO-70 adds `queueMs` (time waiting in this process's transaction line) and
// `ahead` (transactions in front of it when it arrived: the holder plus earlier
// waiters). `beforeCallbackMs` starts after the line, so it is engine time only:
// pool, BEGIN IMMEDIATE and its busy wait.
//
// Log-only, and the timer is a Date.now() pair around a call that already
// awaits the database. Set PRISMA_SLOW_TX_MS=0 to remove it entirely.
const slowTransactionMs = slowTransactionThresholdMsFromEnv();

export function slowTransactionSourceFromStack(stack: string): string {
  for (const line of stack.split("\n").slice(1)) {
    const location = line.match(/(.+):(\d+):(\d+)\)?$/);
    if (!location) continue;

    const file = location[1];
    const nextAppStart = file.lastIndexOf("/.next/server/app/");
    if (nextAppStart >= 0) {
      return `${file.slice(nextAppStart + "/.next/server/".length)}:${location[2]}:${location[3]}`;
    }

    const sourceStart = Math.max(file.lastIndexOf("/src/"), file.lastIndexOf("/scripts/"));
    if (sourceStart < 0) continue;

    const source = file.slice(sourceStart + 1);
    if (source !== "src/lib/prisma.ts") return `${source}:${location[2]}:${location[3]}`;
  }

  return "unknown";
}

type TransactionFn = (...args: unknown[]) => Promise<unknown>;
type TransactionCallback = (...args: unknown[]) => Promise<unknown>;

function slowTransactionSource(stackBoundary: TransactionFn): string {
  const error = new Error();
  // Next bundles this wrapper into the route that first initializes the shared
  // client. Remove that frame so source names the later transaction caller.
  Error.captureStackTrace(error, stackBoundary);
  return slowTransactionSourceFromStack(error.stack ?? "");
}

// The queue replaces the wait each transaction used to do inside BEGIN IMMEDIATE, which
// lasted up to busy_timeout. When another process holds the writer lock, the head of the
// queue sits in BEGIN for that long, so the default queue budget must cover it — otherwise
// every transaction behind it fails at maxWait where it used to commit. A per-call maxWait
// still wins.
const defaultQueueWaitMs = Math.max(transactionOptions.maxWait, busyTimeoutSec * 1000);

if (isNewClient && (slowTransactionMs > 0 || serializeTransactions)) {
  const runTransaction = prisma.$transaction.bind(prisma) as TransactionFn;
  const queue = serializeTransactions ? processTransactionQueue() : undefined;
  let sequence = 0;

  const wrappedTransaction: TransactionFn = async (
    ...args: unknown[]
  ) => {
    const id = (sequence += 1);
    const source = slowTransactionMs > 0 ? slowTransactionSource(wrappedTransaction) : "";
    const startedAt = Date.now();
    const callback = typeof args[0] === "function"
      ? args[0] as TransactionCallback
      : undefined;
    const options = (args[1] !== null && typeof args[1] === "object" ? args[1] : {}) as {
      maxWait?: unknown;
      timeout?: unknown;
    };
    const ahead = queue ? queue.depth() : 0;
    let slot: TransactionSlot | undefined;
    let acquiredAt: number | undefined;
    let callbackStartedAt: number | undefined;
    let callbackMs = 0;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (queue) {
        const maxWaitMs = positiveMs(options.maxWait, defaultQueueWaitMs);
        slot = await queue.acquire(maxWaitMs, (queuedMs) => queueTimeoutError(queuedMs, maxWaitMs));
      }
      acquiredAt = Date.now();
      const timeoutMs = positiveMs(options.timeout, transactionOptions.timeout);
      const transactionArgs = callback
        ? [async function (this: unknown, ...callbackArgs: unknown[]) {
            callbackStartedAt = Date.now();
            if (slot) {
              // Prisma has closed the transaction by now even if this callback never settles.
              // Cleared in `finally` whenever the call settles. Not unref'd: a waiter may depend on it.
              releaseTimer = setTimeout(slot.release, timeoutMs);
            }
            try {
              return await Reflect.apply(callback, this, callbackArgs);
            } finally {
              callbackMs = Date.now() - callbackStartedAt;
            }
          }, ...args.slice(1)]
        : args;
      return await runTransaction(...transactionArgs);
    } finally {
      clearTimeout(releaseTimer);
      slot?.release();
      const endedAt = Date.now();
      const elapsedMs = endedAt - startedAt;
      if (slowTransactionMs > 0 && elapsedMs >= slowTransactionMs) {
        // No arguments, SQL, model names or row data — only static provenance
        // and numeric phase durations for correlation with timestamped logs.
        const engineStartedAt = acquiredAt ?? endedAt;
        const queued = `queueMs=${engineStartedAt - startedAt} ahead=${ahead}`;
        const phases = callback
          ? `kind=interactive ${queued} beforeCallbackMs=${(callbackStartedAt ?? endedAt) - engineStartedAt} callbackMs=${callbackMs} callbackEntered=${callbackStartedAt === undefined ? 0 : 1}`
          : `kind=batch ${queued}`;
        try {
          console.warn(`[prisma-slow-tx] #${id} elapsed ${elapsedMs}ms source=${source} ${phases}`);
        } catch {
          // Diagnostics must never change transaction results or exceptions.
        }
      }
    }
  };
  (prisma as unknown as { $transaction: TransactionFn }).$transaction = wrappedTransaction;
}

// Cached in production too: the connection_limit cap above assumes one client per process,
// and a module evaluated twice (e.g. instrumentation plus a route bundle) must not open a
// second pool on the same engine workers.
globalForPrisma.prisma = prisma;

import { availableParallelism } from "node:os";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  slowQueryThresholdMsFromEnv,
  slowTransactionThresholdMsFromEnv,
  sqliteBusyTimeoutSecondsFromEnv,
  sqliteCacheSizeKibFromEnv,
  sqliteConnectionLimitFromEnv,
  transactionOptionsFromEnv,
  transactionSerializationEnabledFromEnv,
  withSqliteConnectionParams,
} from "@/lib/prisma-options";
import { TransactionQueue, type TransactionSlot } from "@/lib/prisma-transaction-queue";

// Cross-process correlation (ops batch 2026-10-12): every `[prisma-slow-tx]` /
// `[prisma-slow-query]` line names the process that logged it, so a stall that spans
// ai-content, mcp-video-worker, render-worker and the story-film worker can be lined up by
// timestamp. PM2 sets `process.env.name` to the app name (ecosystem.config.js `name:`); a
// script run directly with tsx (no PM2) falls back to `process.title`.
function processLabel(): string {
  return process.env.name ?? process.title;
}

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
          console.warn(`[prisma-slow-tx] #${id} elapsed ${elapsedMs}ms proc=${processLabel()} pid=${process.pid} source=${source} ${phases}`);
        } catch {
          // Diagnostics must never change transaction results or exceptions.
        }
      }
    }
  };
  (prisma as unknown as { $transaction: TransactionFn }).$transaction = wrappedTransaction;
}

// Ops batch 2026-10-12: a single Prisma call (a plain model method, or $queryRaw /
// $executeRaw) that took at least this long — complements `[prisma-slow-tx]` above, which
// only measures a whole $transaction(...) call. Log-only, labeled `model.method` (or
// `raw.$method`), never the SQL text, bound parameters, or row values. Set
// PRISMA_SLOW_QUERY_MS=0 to remove it entirely.
//
// Measured with Date.now() around the ACTUAL call — but NOT by replacing its returned value,
// unlike an earlier version of this change. Two mechanisms were tried and rejected first:
// 1. Prisma's own `log: [{emit:"event", level:"query"}]` + `$on("query", ...)`: the event's
//    `duration` never includes SQLite busy-wait time. Reproduced with an external `sqlite3
//    BEGIN IMMEDIATE` holding the file lock for 650ms: the awaited call took the full 650ms+,
//    the event fired with `duration: 0`.
// 2. A client extension (`$extends({ query: { $allOperations } })`), Prisma's own officially
//    supported "wrap every call" hook: same result — `await query(args)` inside the hook
//    resolved in a few ms while the actual caller's await took 650ms+. Lock-wait on SQLite
//    happens below whatever either instrumentation point measures.
// The only span that reliably includes it is the real call as application code makes it, so
// this wraps the model delegates (prisma.user, ...) and the raw-query methods directly.
//
// CORRECTION (same day): the first version of this wrapper called `.then()` on the real
// PrismaPromise ITSELF, eagerly, right after creating it — "only subscribing a side-effect,
// returning the exact reference". That was wrong: Prisma's PrismaPromise (see
// node_modules/@prisma/client/runtime/library.js, the `Ro()` factory) is lazy — `then`,
// `catch` and `finally` all call a shared `o()` that runs the query and caches the result in a
// closure variable, but ONLY when called with no transaction-batch marker. `$transaction([a,
// b])` never calls `.then()` on its elements — it calls `a.requestTransaction({kind:"batch",
// ...})` instead, which is a SEPARATE, UNCACHED branch of that same `o()`: `s.kind !== "itx"`
// skips the cache entirely and runs the query again. So eagerly calling `.then()` at wrap time
// (a) ran every query standalone the instant it was constructed, outside any transaction it
// was about to be placed in — then `requestTransaction` ran it a SECOND time, for real, inside
// the batch, and (b) made an unawaited/never-touched call execute anyway, which Prisma's own
// laziness promises it never will. Real call sites that build a batch array (and would have
// silently double-run): src/lib/grant-coupon-entitlement.ts, src/lib/project-look.server.ts,
// src/lib/hero-script-library.server.ts.
//
// The fix: never touch the real promise ourselves. Return a Proxy that forwards every property
// — `requestTransaction`, `Symbol.toStringTag` ("PrismaPromise", which `$transaction([...])`'s
// own validation checks before accepting an element), `spec` — completely untouched, so the
// batch path is exactly Prisma's own code, unobserved (its timing is `[prisma-slow-tx]`'s job,
// not this one's). Only `then`/`catch`/`finally` are intercepted, and only to do two things
// at the moment the CALLER actually invokes one of them (never before): record `startedAt`,
// and forward to the real method. The caller invoking any of those three is itself the one and
// only signal that this is a plain top-level await, not a batch element — `requestTransaction`
// is how a batch element runs instead, and this proxy never calls it. See
// verify-prisma-slow-query.ts for the batch-exactly-once and never-touched-never-runs cases.
const slowQueryMs = slowQueryThresholdMsFromEnv();

function logSlowQueryIfNeeded(label: string, startedAt: number) {
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < slowQueryMs) return;
  try {
    console.warn(
      `[prisma-slow-query] ms=${elapsedMs} proc=${processLabel()} pid=${process.pid} startedAt=${new Date(startedAt).toISOString()} op=${label}`,
    );
  } catch {
    // Diagnostics must never throw past the call they are observing.
  }
}

const PRISMA_PROMISE_SETTLE_METHODS = new Set(["then", "catch", "finally"]);

/** Wraps the PrismaPromise `target` already produced by a real call, for logging only.
 *  Forwards EVERY property untouched (requestTransaction, Symbol.toStringTag, spec, ...) so
 *  `$transaction([a, b])` sees exactly the object Prisma itself made — this proxy never calls
 *  `.then()`/`.catch()`/`.finally()` on it itself, only the caller's own eventual call does,
 *  which is the only moment real execution should start. */
function wrapPrismaPromiseForLogging<T>(target: T, label: string): T {
  let startedAt: number | undefined;
  let subscribed = false;
  return new Proxy(target as unknown as object, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop !== "string" || !PRISMA_PROMISE_SETTLE_METHODS.has(prop) || typeof value !== "function") {
        return value;
      }
      const original = value as (...a: unknown[]) => unknown;
      return function (this: unknown, ...args: unknown[]) {
        if (startedAt === undefined) startedAt = Date.now();
        if (!subscribed) {
          subscribed = true;
          // A second `.then()` subscribed purely for logging. Safe to add here — unlike
          // adding it eagerly at wrap time — because the caller has already proven, by
          // calling then/catch/finally themselves, that this is the plain (non-batch) path;
          // a second subscription on that same path reuses Prisma's own cached result rather
          // than re-running the query (see the correction note above `slowQueryMs`).
          (obj as unknown as Promise<unknown>).then(
            () => logSlowQueryIfNeeded(label, startedAt!),
            () => logSlowQueryIfNeeded(label, startedAt!),
          );
        }
        return original.apply(obj, args);
      };
    },
  }) as T;
}

/** True for a model delegate (prisma.user, prisma.renderJob, ...): an object whose own
 *  methods are plain model-CRUD calls. Every model delegate has a `findFirst` function, which
 *  tells one apart from any other client property without hard-coding the model list from
 *  prisma/schema.prisma. */
function isModelDelegate(value: unknown): value is Record<string, (...args: unknown[]) => unknown> {
  return (
    !!value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).findFirst === "function"
  );
}

function wrapDelegate(delegate: Record<string, (...args: unknown[]) => unknown>, modelName: string) {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        const prismaPromise = value.apply(target, args);
        return wrapPrismaPromiseForLogging(prismaPromise, `${modelName}.${prop}`);
      };
    },
  });
}

const RAW_QUERY_METHODS = ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"] as const;

if (isNewClient && slowQueryMs > 0) {
  const client = prisma as unknown as Record<string, unknown>;
  for (const prop of Object.keys(client)) {
    if (prop.startsWith("$") || prop.startsWith("_") || prop === "constructor") continue;
    const value = client[prop];
    if (isModelDelegate(value)) client[prop] = wrapDelegate(value, prop);
  }
  for (const method of RAW_QUERY_METHODS) {
    const original = client[method] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") continue;
    client[method] = function (this: unknown, ...args: unknown[]) {
      const prismaPromise = original.apply(prisma, args);
      return wrapPrismaPromiseForLogging(prismaPromise, `raw.${method}`);
    };
  }
}

// Cached in production too: the connection_limit cap above assumes one client per process,
// and a module evaluated twice (e.g. instrumentation plus a route bundle) must not open a
// second pool on the same engine workers.
globalForPrisma.prisma = prisma;

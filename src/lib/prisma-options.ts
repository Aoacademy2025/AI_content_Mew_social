/**
 * prisma-options.ts — how long a query may QUEUE on the single SQLite writer.
 *
 * SQLite serialises writers. Under WAL a reader never blocks, but two writers
 * take turns, and a transaction that reads and then writes has to re-acquire
 * the lock at upgrade time. Prisma's defaults give that queue almost no room:
 * an interactive transaction waits 2s to start and must finish within 5s, and
 * the driver gives up on a busy socket after 5s. On production (2026-09-05 →
 * 09-08) that turned ordinary lock waits into 26-53 request failures a day
 * ("Transaction already closed … timeout for this transaction was 5000 ms",
 * "Socket timeout") on a box with load ≤ 3.6 and 26 GB RAM free. The write
 * VOLUME is tiny; the BUDGETS were the problem.
 *
 * So: wait longer instead of failing. Every number here is a queueing budget,
 * not a workload limit, and every one is env-tunable so the VPS can be retuned
 * without a redeploy.
 *
 * Deliberately pure — no Prisma import, no I/O, and no logging of any kind:
 * the connection string it rewrites can carry credentials.
 */

/** Prisma's own defaults are maxWait 2000 / timeout 5000. */
const TX_MAX_WAIT_DEFAULT_MS = 10_000;
const TX_TIMEOUT_DEFAULT_MS = 30_000;
const TX_MIN_MS = 1_000;
const TX_MAX_MS = 120_000;

/** SQLite `busy_timeout` / Prisma `socket_timeout`, in seconds. */
const BUSY_TIMEOUT_DEFAULT_SEC = 20;
const BUSY_TIMEOUT_MIN_SEC = 1;
const BUSY_TIMEOUT_MAX_SEC = 120;

/**
 * SQLite page cache for the connection, in KiB (`PRAGMA cache_size = -KiB`).
 * The default is 2 MB against a 489 MB database, so a routine query re-reads
 * pages from the OS while holding its place in the writer queue.
 */
export const SQLITE_CACHE_SIZE_KIB = 65_536;
const CACHE_SIZE_MIN_KIB = 2_048;
const CACHE_SIZE_MAX_KIB = 524_288;

export type EnvLike = Record<string, string | undefined>;

/** Strict base-10 integers only. "10s", "1e5", "12.5" and "" are typos, not
 *  values: a typo must fall back to the default, never coerce to something
 *  smaller than the budget it was meant to raise. */
const INTEGER_PATTERN = /^[+-]?\d+$/;

function clampedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!INTEGER_PATTERN.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export type PrismaTransactionOptions = {
  /** ms a transaction may wait for a slot before Prisma gives up starting it. */
  maxWait: number;
  /** ms an interactive transaction may stay open before Prisma closes it. */
  timeout: number;
};

/** Budgets for `new PrismaClient({ transactionOptions })`.
 *  Env: `PRISMA_TX_MAX_WAIT_MS`, `PRISMA_TX_TIMEOUT_MS` (clamped 1s-120s). */
export function transactionOptionsFromEnv(env: EnvLike = process.env): PrismaTransactionOptions {
  return {
    maxWait: clampedInt(env.PRISMA_TX_MAX_WAIT_MS, TX_MAX_WAIT_DEFAULT_MS, TX_MIN_MS, TX_MAX_MS),
    timeout: clampedInt(env.PRISMA_TX_TIMEOUT_MS, TX_TIMEOUT_DEFAULT_MS, TX_MIN_MS, TX_MAX_MS),
  };
}

/** Seconds a writer waits for the SQLite lock before erroring.
 *  Env: `SQLITE_BUSY_TIMEOUT_SEC` (clamped 1-120). */
export function sqliteBusyTimeoutSecondsFromEnv(env: EnvLike = process.env): number {
  return clampedInt(
    env.SQLITE_BUSY_TIMEOUT_SEC,
    BUSY_TIMEOUT_DEFAULT_SEC,
    BUSY_TIMEOUT_MIN_SEC,
    BUSY_TIMEOUT_MAX_SEC,
  );
}

/** Page cache in KiB. Env: `SQLITE_CACHE_SIZE_KIB` (clamped 2 MB-512 MB). */
export function sqliteCacheSizeKibFromEnv(env: EnvLike = process.env): number {
  return clampedInt(
    env.SQLITE_CACHE_SIZE_KIB,
    SQLITE_CACHE_SIZE_KIB,
    CACHE_SIZE_MIN_KIB,
    CACHE_SIZE_MAX_KIB,
  );
}

/**
 * Add `socket_timeout` to a SQLite connection string.
 *
 * `PRAGMA busy_timeout` is per-connection and non-persistent, so setting it
 * once at client init only ever reaches the ONE pooled connection that ran it.
 * `socket_timeout` on the URL is applied to every connection Prisma opens —
 * that is the setting that actually covers production traffic.
 *
 * Non-`file:` URLs are returned unchanged, and an operator-supplied
 * `socket_timeout` always wins. Never logs its argument.
 */
export function withSqliteConnectionParams(
  url: string,
  options: { busyTimeoutSec: number },
): string {
  if (!url.startsWith("file:")) return url;
  if (url.includes("socket_timeout=")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}socket_timeout=${options.busyTimeoutSec}`;
}

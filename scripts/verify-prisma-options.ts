import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * HERO-10 track 1 — the pure knobs that decide how long a query is allowed to
 * QUEUE on the single SQLite writer before Prisma gives up on it.
 *
 * Production evidence (2026-09-05 → 09-08): 26-53 "Transaction already closed
 * … timeout for this transaction was 5000 ms" / "Socket timeout" errors PER DAY
 * on a box that is nowhere near saturated. The writes are tiny; the waits are
 * what exceed the default budgets. These helpers are pure so the budgets can be
 * asserted without a database and re-tuned from the environment on the VPS
 * without a redeploy.
 */

async function main() {
  const {
    SQLITE_CACHE_SIZE_KIB,
    slowTransactionThresholdMsFromEnv,
    sqliteBusyTimeoutSecondsFromEnv,
    sqliteCacheSizeKibFromEnv,
    transactionOptionsFromEnv,
    withSqliteConnectionParams,
  } = await import("../src/lib/prisma-options");

  // ---- interactive-transaction budgets -------------------------------
  assert.deepEqual(
    transactionOptionsFromEnv({}),
    { maxWait: 10_000, timeout: 30_000 },
    "defaults give a contended writer 10s to get IN and 30s to finish, not Prisma's 2s/5s",
  );
  assert.deepEqual(
    transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: "4000", PRISMA_TX_TIMEOUT_MS: "45000" }),
    { maxWait: 4_000, timeout: 45_000 },
    "both budgets are tunable from the environment",
  );
  assert.deepEqual(
    transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: "  8000  " }),
    { maxWait: 8_000, timeout: 30_000 },
    "surrounding whitespace is tolerated; the untouched knob keeps its default",
  );

  // clamping — a knob may never be set to a value that reintroduces the bug
  // (too small) or wedges a request forever (too large).
  assert.equal(transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: "1" }).maxWait, 1_000, "clamped up to 1000ms");
  assert.equal(transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: "0" }).maxWait, 1_000, "zero clamps up");
  assert.equal(transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: "-9000" }).maxWait, 1_000, "negatives clamp up");
  assert.equal(
    transactionOptionsFromEnv({ PRISMA_TX_TIMEOUT_MS: "999999" }).timeout,
    120_000,
    "clamped down to 120000ms",
  );

  // garbage is ignored, never coerced — a typo must not silently halve a budget
  for (const garbage of ["", "   ", "abc", "10s", "NaN", "1e5", "12.5", "Infinity"]) {
    assert.deepEqual(
      transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: garbage, PRISMA_TX_TIMEOUT_MS: garbage }),
      { maxWait: 10_000, timeout: 30_000 },
      `garbage value ${JSON.stringify(garbage)} falls back to the default budgets`,
    );
  }
  assert.deepEqual(
    transactionOptionsFromEnv({ PRISMA_TX_MAX_WAIT_MS: undefined, PRISMA_TX_TIMEOUT_MS: undefined }),
    { maxWait: 10_000, timeout: 30_000 },
    "an unset variable is not garbage — it is simply the default",
  );

  // ---- SQLite busy_timeout (seconds) ---------------------------------
  assert.equal(sqliteBusyTimeoutSecondsFromEnv({}), 20, "a writer waits 20s for the lock by default");
  assert.equal(sqliteBusyTimeoutSecondsFromEnv({ SQLITE_BUSY_TIMEOUT_SEC: "45" }), 45);
  assert.equal(sqliteBusyTimeoutSecondsFromEnv({ SQLITE_BUSY_TIMEOUT_SEC: "0" }), 1, "clamped up to 1s");
  assert.equal(sqliteBusyTimeoutSecondsFromEnv({ SQLITE_BUSY_TIMEOUT_SEC: "600" }), 120, "clamped down to 120s");
  assert.equal(sqliteBusyTimeoutSecondsFromEnv({ SQLITE_BUSY_TIMEOUT_SEC: "twenty" }), 20, "garbage falls back");

  // ---- SQLite page cache (KiB) ---------------------------------------
  assert.equal(SQLITE_CACHE_SIZE_KIB, 65_536, "64 MB of page cache for a 489 MB database");
  assert.equal(sqliteCacheSizeKibFromEnv({}), 65_536);
  assert.equal(sqliteCacheSizeKibFromEnv({ SQLITE_CACHE_SIZE_KIB: "131072" }), 131_072);
  assert.equal(sqliteCacheSizeKibFromEnv({ SQLITE_CACHE_SIZE_KIB: "512" }), 2_048, "clamped up to 2 MB");
  assert.equal(sqliteCacheSizeKibFromEnv({ SQLITE_CACHE_SIZE_KIB: "9999999" }), 524_288, "clamped down to 512 MB");
  assert.equal(sqliteCacheSizeKibFromEnv({ SQLITE_CACHE_SIZE_KIB: "lots" }), 65_536, "garbage falls back");

  // ---- connection-string parameter -----------------------------------
  // busy_timeout set through a PRAGMA only reaches the ONE pooled connection
  // that ran it. socket_timeout on the URL is what applies to every connection
  // Prisma opens, so this is the setting that actually covers production.
  assert.equal(
    withSqliteConnectionParams("file:./dev.db", { busyTimeoutSec: 20 }),
    "file:./dev.db?socket_timeout=20",
    "a bare file URL gets the parameter with '?'",
  );
  assert.equal(
    withSqliteConnectionParams("file:/abs/db?connection_limit=1", { busyTimeoutSec: 20 }),
    "file:/abs/db?connection_limit=1&socket_timeout=20",
    "an existing query string is preserved and extended with '&'",
  );
  assert.equal(
    withSqliteConnectionParams("file:/abs/db?socket_timeout=5", { busyTimeoutSec: 20 }),
    "file:/abs/db?socket_timeout=5",
    "an operator-supplied socket_timeout wins — we never overwrite it",
  );
  assert.equal(
    withSqliteConnectionParams("postgresql://user:pw@host:5432/db", { busyTimeoutSec: 20 }),
    "postgresql://user:pw@host:5432/db",
    "a non-SQLite URL is returned byte-for-byte unchanged",
  );
  assert.equal(
    withSqliteConnectionParams("", { busyTimeoutSec: 20 }),
    "",
    "an empty DATABASE_URL is passed through so the client behaves exactly as before",
  );
  {
    const once = withSqliteConnectionParams("file:./dev.db", { busyTimeoutSec: 30 });
    assert.equal(
      withSqliteConnectionParams(once, { busyTimeoutSec: 30 }),
      once,
      "applying the helper twice is a no-op — a hot-reloaded client cannot stack parameters",
    );
  }
  assert.equal(
    withSqliteConnectionParams("file:/abs/db?x=socket_timeout=1", { busyTimeoutSec: 20 }),
    "file:/abs/db?x=socket_timeout=1",
    "the already-set check is a substring match on the parameter, deliberately conservative",
  );

  // ---- slow-transaction threshold (HERO-10 lock visibility) ----------
  assert.equal(
    slowTransactionThresholdMsFromEnv({}),
    2_000,
    "the default must be high enough that a healthy transaction never logs",
  );
  assert.equal(
    slowTransactionThresholdMsFromEnv({ PRISMA_SLOW_TX_MS: "0" }),
    0,
    "0 must be honoured — it is the switch that removes the timer entirely",
  );
  assert.equal(
    slowTransactionThresholdMsFromEnv({ PRISMA_SLOW_TX_MS: "5000" }),
    5_000,
    "an operator value is used as given",
  );
  assert.equal(
    slowTransactionThresholdMsFromEnv({ PRISMA_SLOW_TX_MS: "-1" }),
    0,
    "negative clamps to off, never to a threshold that logs every transaction",
  );
  assert.equal(
    slowTransactionThresholdMsFromEnv({ PRISMA_SLOW_TX_MS: "2s" }),
    2_000,
    "a typo falls back to the default rather than coercing",
  );
  assert.equal(
    slowTransactionThresholdMsFromEnv({ PRISMA_SLOW_TX_MS: "999999999" }),
    600_000,
    "an absurd value clamps to the ceiling",
  );

  // The instrumentation stays log-only and never prints row data.
  {
    const client = readFileSync(join(process.cwd(), "src/lib/prisma.ts"), "utf8");
    assert.match(
      client,
      /\[prisma-slow-tx\]/,
      "prisma.ts must carry the marker the runbook greps for",
    );
    assert.doesNotMatch(
      client,
      /console\.(warn|log|error)\([^)]*\bargs\b/,
      "the timer must never log transaction arguments",
    );
  }

  // ---- pm2 gives every log line a timestamp --------------------------
  {
    const ecosystem = readFileSync(join(process.cwd(), "ecosystem.config.js"), "utf8");
    assert.match(
      ecosystem,
      /log_date_format/,
      "without a timestamp per line, a failure cannot be joined to its cause",
    );
    // ecosystem.config.js is CommonJS, so an ESM import lands on `default`.
    const loaded = await import("../ecosystem.config.js");
    const apps = ((loaded as { default?: { apps?: unknown } }).default ?? loaded)
      .apps as { name?: string; log_date_format?: string }[] | undefined;
    assert(Array.isArray(apps) && apps.length > 0, "ecosystem must expose apps");
    for (const app of apps) {
      assert.equal(
        app.log_date_format,
        "YYYY-MM-DDTHH:mm:ss.SSSZ",
        `every pm2 app needs timestamped logs, including ${app.name ?? "an unnamed app"}`,
      );
    }
  }

  // ---- the URL is a secret: this module must never print it ----------
  const source = readFileSync(join(process.cwd(), "src/lib/prisma-options.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /console\.|process\.stdout|process\.stderr/,
    "prisma-options must never log — the connection string can carry credentials",
  );

  console.log("verify-prisma-options: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import "./register-server-only-node.mjs";

/**
 * HERO-10 — the slow-transaction timer must actually fire with the static
 * source that invoked it. The marker measures elapsed transaction-call time,
 * not SQLite write-lock ownership, so the source is evidence for investigation
 * rather than a claim that it is the holder.
 *
 * Runs against a throwaway SQLite database; see `verify:prisma-slow-tx` for the
 * `prisma db push` that creates it.
 */

// Prisma client startup can take a few hundred milliseconds on a fresh
// throwaway database. Keep the fast-control comfortably above that overhead.
const THRESHOLD_MS = 1_000;

type SlowTransactionDiagnostic = {
  kind: "interactive" | "batch";
  beforeCallbackMs?: number;
  callbackMs?: number;
  callbackEntered?: 0 | 1;
  totalMs: number;
  source: string;
};

type BundledPhaseFindings = {
  contention: SlowTransactionDiagnostic[];
  callbackWork: SlowTransactionDiagnostic;
};

function parseDiagnostic(line: string): SlowTransactionDiagnostic {
  const interactive = line.match(
    /^\[prisma-slow-tx\] #\d+ elapsed (\d+)ms source=(\S+) kind=interactive beforeCallbackMs=(\d+) callbackMs=(\d+) callbackEntered=([01])$/,
  );
  if (interactive) {
    return {
      kind: "interactive",
      totalMs: Number(interactive[1]),
      source: interactive[2],
      beforeCallbackMs: Number(interactive[3]),
      callbackMs: Number(interactive[4]),
      callbackEntered: Number(interactive[5]) as 0 | 1,
    };
  }

  const batch = line.match(
    /^\[prisma-slow-tx\] #\d+ elapsed (\d+)ms source=(\S+) kind=batch$/,
  );
  assert(batch, `unexpected diagnostic shape: ${line}`);
  return {
    kind: "batch",
    totalMs: Number(batch[1]),
    source: batch[2],
  };
}

async function waitForLock(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for SQLite lock")), 2_000);
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("LOCKED")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`sqlite lock process exited early (${code})`)));
  });
}

async function verifyBundledCallerPhases(
  warnings: string[],
  heldMs: number,
): Promise<BundledPhaseFindings> {
  const bundleRoot = mkdtempSync(join(process.cwd(), ".prisma-slow-tx-bundle-"));
  const installerPath = join(bundleRoot, ".next/server/app/(dashboard)/pricing/page.js");
  const firstCallerPath = join(bundleRoot, ".next/server/app/api/fixture-balance-a/route.js");
  const secondCallerPath = join(bundleRoot, ".next/server/app/api/fixture-balance-b/route.js");
  mkdirSync(join(installerPath, ".."), { recursive: true });
  mkdirSync(join(firstCallerPath, ".."), { recursive: true });
  mkdirSync(join(secondCallerPath, ".."), { recursive: true });

  const common = {
    bundle: true,
    format: "cjs" as const,
    packages: "external" as const,
    platform: "node" as const,
    sourcemap: false,
    tsconfig: join(process.cwd(), "tsconfig.json"),
  };

  try {
    await build({
      ...common,
      entryPoints: ["scripts/fixtures/prisma-slow-tx-installer.ts"],
      outfile: installerPath,
    });
    await build({
      ...common,
      entryPoints: ["scripts/fixtures/prisma-slow-tx-caller.ts"],
      outfile: firstCallerPath,
    });
    await build({
      ...common,
      entryPoints: ["scripts/fixtures/prisma-slow-tx-caller.ts"],
      outfile: secondCallerPath,
    });

    const require = createRequire(import.meta.url);
    const installer = require(installerPath) as { prisma: PrismaClient };
    const firstCaller = require(firstCallerPath) as {
      readBalance(userId: string): Promise<{ total: number }>;
      runSlowCallback<T>(delayMs: number, result: T): Promise<T>;
    };
    const secondCaller = require(secondCallerPath) as {
      readBalance(userId: string): Promise<{ total: number }>;
    };
    await installer.prisma.user.createMany({
      data: [
        { id: "slow-tx-caller-a", name: "Slow Tx A", email: "slow-tx-caller-a@example.invalid" },
        { id: "slow-tx-caller-b", name: "Slow Tx B", email: "slow-tx-caller-b@example.invalid" },
      ],
    });
    await installer.prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");

    const databaseUrl = process.env.DATABASE_URL ?? "";
    assert.match(databaseUrl, /^file:\/tmp\/heroai-slow-tx\.db\?connection_limit=1$/);
    const lock = spawn("sqlite3", [databaseUrl.slice("file:".length).split("?")[0]], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    lock.stdin.write("PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=1000;\nBEGIN IMMEDIATE;\n.print LOCKED\n");
    await waitForLock(lock);

    warnings.length = 0;
    const balances = Promise.all([
      firstCaller.readBalance("slow-tx-caller-a"),
      secondCaller.readBalance("slow-tx-caller-b"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    lock.stdin.end("ROLLBACK;\n.quit\n");
    assert.deepEqual((await balances).map((balance) => balance.total), [0, 0]);

    assert.equal(warnings.length, 2, `expected two bundled warnings, got ${warnings.length}`);
    const diagnostics = warnings.map(parseDiagnostic);
    assert(diagnostics.every((diagnostic) => diagnostic.kind === "interactive"));
    assert(
      diagnostics.every((diagnostic) => (diagnostic.beforeCallbackMs ?? 0) >= THRESHOLD_MS),
      `the real bundled callers must record delayed callback entry: ${JSON.stringify(diagnostics)}`,
    );
    const sources = diagnostics.map((diagnostic) => diagnostic.source).sort();
    assert.match(sources[0] ?? "", /^app\/api\/fixture-balance-a\/route\.js:\d+:\d+$/);
    assert.match(sources[1] ?? "", /^app\/api\/fixture-balance-b\/route\.js:\d+:\d+$/);
    assert.equal(
      await installer.prisma.creditBalance.count({
        where: { userId: { in: ["slow-tx-caller-a", "slow-tx-caller-b"] } },
      }),
      2,
      "both real balance callers must materialize their zero balance after contention",
    );

    warnings.length = 0;
    const returned = { marker: "bundled-return-identity" };
    assert.equal(
      await firstCaller.runSlowCallback(heldMs, returned),
      returned,
      "the independently bundled callback must preserve return identity",
    );
    assert.equal(warnings.length, 1, "the slow bundled callback must log once");
    const callbackWork = parseDiagnostic(warnings[0]);
    assert.equal(callbackWork.kind, "interactive");
    assert(callbackWork.callbackMs! >= heldMs);
    assert(callbackWork.beforeCallbackMs! < THRESHOLD_MS);
    await installer.prisma.$disconnect();
    return { contention: diagnostics, callbackWork };
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}

async function main() {
  assert.equal(
    process.env.PRISMA_SLOW_TX_MS,
    String(THRESHOLD_MS),
    "the threshold is read once at module import, so it must be set before it",
  );
  assert(
    process.env.DATABASE_URL?.includes("slow-tx"),
    "refusing to run against anything but the throwaway database",
  );

  const warnings: string[] = [];
  const allWarnings: string[] = [];
  const realWarn = console.warn;
  const captureWarn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    // prisma.ts also fires PRAGMA warnings on a fresh database. Only the timer's
    // own lines are under test; anything else is passed through untouched.
    if (line.startsWith("[prisma-slow-tx]")) {
      warnings.push(line);
      allWarnings.push(line);
    }
    else realWarn(...args);
  };
  console.warn = captureWarn;

  try {
    const { prisma, slowTransactionSourceFromStack } = await import("../src/lib/prisma");

    // Next production stack frames point into the release's `.next/server/app`
    // bundle. Keep that route-relative location while discarding its absolute
    // deployment path and any non-source wrapper frames.
    assert.equal(
      slowTransactionSourceFromStack([
        "Error",
        "    at wrappedTransaction (/var/www/ai-content/.next/server/chunks/891.js:1:10)",
        "    at handler (/var/www/ai-content/.next/server/app/api/videos/route.js:1:42)",
      ].join("\n")),
      "app/api/videos/route.js:1:42",
      "a bundled Next route keeps the generated column without its absolute path",
    );

    // A transaction that finishes well inside the threshold stays silent, so
    // healthy traffic does not drown the signal.
    await prisma.$transaction(async (tx) => {
      await tx.user.count();
    });
    assert.deepEqual(warnings, [], "a fast transaction must not log");

    // A transaction that exceeds the threshold is reported with a static,
    // data-free callsite. It still measures elapsed call time, not lock time.
    const heldMs = THRESHOLD_MS + 250;
    await prisma.$transaction(async (tx) => {
      await tx.user.count();
      await new Promise((resolve) => setTimeout(resolve, heldMs));
    });

    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    const line = warnings[0];
    const slowCallback = parseDiagnostic(line);
    assert.equal(slowCallback.kind, "interactive");
    assert.equal(slowCallback.callbackEntered, 1);
    assert(slowCallback.callbackMs! >= heldMs, "the deliberate callback work must be measured inside callbackMs");
    assert(
      slowCallback.beforeCallbackMs! < THRESHOLD_MS,
      "an immediately entered callback must not be reported as pre-entry delay",
    );
    assert.match(slowCallback.source, /^(?:scripts\/verify-prisma-slow-tx\.ts:\d+:\d+|unknown)$/);
    const reported = slowCallback.totalMs;
    assert(
      reported >= heldMs,
      `reported ${reported}ms should cover the ${heldMs}ms spent in the transaction call`,
    );

    // The line carries no arguments, SQL, model names or row data.
    assert.doesNotMatch(line, /user|count|select|where|insert|update|delete/i, "the line must stay data-free");

    // Diagnostics run in finally: a slow rejected transaction keeps the exact
    // exception while still leaving one data-free provenance record.
    warnings.length = 0;
    const expected = new Error("expected transaction failure");
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.user.count();
        await new Promise((resolve) => setTimeout(resolve, heldMs));
        throw expected;
      }),
      (error) => error === expected,
      "instrumentation must preserve the transaction exception",
    );
    assert.equal(warnings.length, 1, "a slow rejected transaction must log once");
    const rejected = parseDiagnostic(warnings[0]);
    assert.equal(rejected.kind, "interactive");
    assert.equal(rejected.callbackEntered, 1);
    assert(rejected.callbackMs! >= heldMs);

    // A diagnostic sink failure is observational only and must not replace the
    // exact exception thrown by application code.
    const expectedWithBrokenLogger = new Error("expected failure with broken logger");
    console.warn = (...args: unknown[]) => {
      if (args.map(String).join(" ").startsWith("[prisma-slow-tx]")) {
        throw new Error("diagnostic sink unavailable");
      }
      realWarn(...args);
    };
    const returnedWithBrokenLogger = { marker: "broken-logger-return-identity" };
    assert.equal(
      await prisma.$transaction(async () => {
        await new Promise((resolve) => setTimeout(resolve, heldMs));
        return returnedWithBrokenLogger;
      }),
      returnedWithBrokenLogger,
      "diagnostic failures must not replace the callback result",
    );
    await assert.rejects(
      prisma.$transaction(async () => {
        await new Promise((resolve) => setTimeout(resolve, heldMs));
        throw expectedWithBrokenLogger;
      }),
      (error) => error === expectedWithBrokenLogger,
      "diagnostic failures must not replace the callback exception",
    );
    console.warn = captureWarn;

    // The wrapper must forward the callback's `this`, exact return identity,
    // and per-call timeout options.
    warnings.length = 0;
    const returned = { marker: "return-identity" };
    const rawClient = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let rawCallbackContext = "not-entered";
    await rawClient.$transaction(async function (tx) {
      rawCallbackContext = this === globalThis
        ? "global"
        : this === undefined ? "undefined" : "other";
      await tx.user.count();
    });
    await rawClient.$disconnect();
    let callbackContext = "not-entered";
    const actual = await prisma.$transaction(async function (tx) {
      callbackContext = this === globalThis
        ? "global"
        : this === undefined ? "undefined" : "other";
      await tx.user.count();
      return returned;
    });
    assert.equal(
      callbackContext,
      rawCallbackContext,
      "callback context must match an unwrapped Prisma client",
    );
    assert.equal(actual, returned, "callback return identity must stay unchanged");
    await assert.rejects(
      prisma.$transaction(async () => {
        await new Promise((resolve) => setTimeout(resolve, THRESHOLD_MS + 250));
      }, { timeout: THRESHOLD_MS + 100 }),
      "per-call timeout options must still reach Prisma",
    );

    // Occupy the one real Prisma/SQLite connection, then prove a second
    // interactive transaction can time out before its callback is entered.
    // This is callback-entry delay, not a claim about SQLite lock ownership.
    warnings.length = 0;
    let release!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const heldOpen = new Promise<void>((resolve) => { release = resolve; });
    const occupyingTransaction = prisma.$transaction(async (tx) => {
      await tx.user.count();
      markEntered();
      await heldOpen;
    }, { timeout: 5_000 });
    await entered;

    let timedOutCallbackEntered = false;
    await assert.rejects(
      prisma.$transaction(async () => {
        timedOutCallbackEntered = true;
      }, { maxWait: THRESHOLD_MS + 100, timeout: 5_000 }),
      "the queued transaction must hit its forwarded maxWait",
    );
    assert.equal(timedOutCallbackEntered, false, "timed-out callback must never be entered");
    assert.equal(warnings.length, 1, "timeout before entry must emit one diagnostic");
    const timedOut = parseDiagnostic(warnings[0]);
    assert.equal(timedOut.kind, "interactive");
    assert.equal(timedOut.callbackEntered, 0);
    assert.equal(timedOut.callbackMs, 0);
    assert(timedOut.beforeCallbackMs! >= THRESHOLD_MS);
    release();
    await occupyingTransaction;

    // The array form is instrumented too — it is how the batch call sites run.
    warnings.length = 0;
    const batchResult = await prisma.$transaction([prisma.user.count()]);
    assert.deepEqual(batchResult, [0], "array transaction results must stay unchanged");
    assert.deepEqual(warnings, [], "a fast array transaction must not log either");

    const databasePath = process.env.DATABASE_URL!
      .slice("file:".length)
      .split("?")[0];
    const arrayLock = spawn("sqlite3", [databasePath], { stdio: ["pipe", "pipe", "pipe"] });
    arrayLock.stdin.write("PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=1000;\nBEGIN IMMEDIATE;\n.print LOCKED\n");
    await waitForLock(arrayLock);
    warnings.length = 0;
    const slowBatch = prisma.$transaction([
      prisma.siteConfig.upsert({
        where: { key: "slow-tx-array-sentinel" },
        create: { key: "slow-tx-array-sentinel", value: "private-fixture-value" },
        update: { value: "private-fixture-value" },
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    arrayLock.stdin.end("ROLLBACK;\n.quit\n");
    assert.equal((await slowBatch)[0].value, "private-fixture-value");
    assert.equal(warnings.length, 1, "a slow array transaction must log once");
    const batchDiagnostic = parseDiagnostic(warnings[0]);
    assert.equal(batchDiagnostic.kind, "batch");
    assert(batchDiagnostic.totalMs >= heldMs);

    await prisma.$disconnect();
    delete (globalThis as typeof globalThis & { prisma?: unknown }).prisma;

    // Next bundles prisma.ts into every route, while development shares one
    // Prisma client through globalThis. Reproduce that topology with two real
    // bundles: pricing installs the wrapper, then a different route invokes a
    // slow transaction through that shared client. The warning must name the
    // invoking route, regardless of which bundle installed instrumentation.
    const bundled = await verifyBundledCallerPhases(warnings, heldMs);

    // With the threshold disabled the same real slow callback stays silent.
    const disabled = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fixtures/prisma-slow-tx-disabled.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PRISMA_SLOW_TX_MS: "0" },
        timeout: 5_000,
      },
    );
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    assert.match(disabled.stdout, /prisma-slow-tx-disabled: PASS/);
    assert.doesNotMatch(`${disabled.stdout}\n${disabled.stderr}`, /\[prisma-slow-tx\]/);

    // Exact diagnostic grammar plus bounded sentinel checks keep transaction
    // arguments and row content out of every emitted line.
    for (const line of allWarnings) {
      parseDiagnostic(line);
      for (const sentinel of [
        "slow-tx-caller-a",
        "slow-tx-caller-b",
        "slow-tx-caller-a@example.invalid",
        "slow-tx-caller-b@example.invalid",
        "slow-tx-array-sentinel",
        "private-fixture-value",
        "SELECT",
        "INSERT",
      ]) {
        assert(!line.includes(sentinel), `diagnostic leaked fixture content: ${sentinel}`);
      }
    }

    console.log("verify-prisma-slow-tx: phase findings", JSON.stringify({
      directCallback: {
        beforeCallbackMs: slowCallback.beforeCallbackMs,
        callbackMs: slowCallback.callbackMs,
        totalMs: slowCallback.totalMs,
      },
      timeoutBeforeEntry: {
        beforeCallbackMs: timedOut.beforeCallbackMs,
        callbackMs: timedOut.callbackMs,
        totalMs: timedOut.totalMs,
      },
      arrayTotalMs: batchDiagnostic.totalMs,
      bundledContention: bundled.contention.map((diagnostic) => ({
        beforeCallbackMs: diagnostic.beforeCallbackMs,
        callbackMs: diagnostic.callbackMs,
        totalMs: diagnostic.totalMs,
      })),
      bundledCallback: {
        beforeCallbackMs: bundled.callbackWork.beforeCallbackMs,
        callbackMs: bundled.callbackWork.callbackMs,
        totalMs: bundled.callbackWork.totalMs,
      },
    }));
  } finally {
    console.warn = realWarn;
  }

  console.log("verify-prisma-slow-tx: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

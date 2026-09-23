import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
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

async function verifyBundledOwnerAttribution(
  warnings: string[],
  heldMs: number,
): Promise<void> {
  const bundleRoot = mkdtempSync(join(process.cwd(), ".prisma-slow-tx-bundle-"));
  const installerPath = join(bundleRoot, ".next/server/app/(dashboard)/pricing/page.js");
  const firstOwnerPath = join(bundleRoot, ".next/server/app/api/fixture-balance-a/route.js");
  const secondOwnerPath = join(bundleRoot, ".next/server/app/api/fixture-balance-b/route.js");
  mkdirSync(join(installerPath, ".."), { recursive: true });
  mkdirSync(join(firstOwnerPath, ".."), { recursive: true });
  mkdirSync(join(secondOwnerPath, ".."), { recursive: true });

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
      entryPoints: ["scripts/fixtures/prisma-slow-tx-owner.ts"],
      outfile: firstOwnerPath,
    });
    await build({
      ...common,
      entryPoints: ["scripts/fixtures/prisma-slow-tx-owner.ts"],
      outfile: secondOwnerPath,
    });

    const require = createRequire(import.meta.url);
    const installer = require(installerPath) as { prisma: PrismaClient };
    const firstOwner = require(firstOwnerPath) as {
      readBalance(userId: string): Promise<{ total: number }>;
    };
    const secondOwner = require(secondOwnerPath) as {
      readBalance(userId: string): Promise<{ total: number }>;
    };
    await installer.prisma.user.createMany({
      data: [
        { id: "slow-tx-owner-a", name: "Slow Tx A", email: "slow-tx-owner-a@example.invalid" },
        { id: "slow-tx-owner-b", name: "Slow Tx B", email: "slow-tx-owner-b@example.invalid" },
      ],
    });
    await installer.prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");

    const databaseUrl = process.env.DATABASE_URL ?? "";
    assert.match(databaseUrl, /^file:\/tmp\/heroai-slow-tx\.db$/);
    const lock = spawn("sqlite3", [databaseUrl.slice("file:".length)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    lock.stdin.write("PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=1000;\nBEGIN IMMEDIATE;\n.print LOCKED\n");
    await waitForLock(lock);

    warnings.length = 0;
    const balances = Promise.all([
      firstOwner.readBalance("slow-tx-owner-a"),
      secondOwner.readBalance("slow-tx-owner-b"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    lock.stdin.end("ROLLBACK;\n.quit\n");
    assert.deepEqual((await balances).map((balance) => balance.total), [0, 0]);

    assert.equal(warnings.length, 2, `expected two bundled warnings, got ${warnings.length}`);
    const sources = warnings.map((line) => line.match(/source=(.+)$/)?.[1]).sort();
    assert.match(sources[0] ?? "", /^app\/api\/fixture-balance-a\/route\.js:\d+$/);
    assert.match(sources[1] ?? "", /^app\/api\/fixture-balance-b\/route\.js:\d+$/);
    assert.equal(
      await installer.prisma.creditBalance.count({
        where: { userId: { in: ["slow-tx-owner-a", "slow-tx-owner-b"] } },
      }),
      2,
      "both real balance owners must materialize their zero balance after contention",
    );
    await installer.prisma.$disconnect();
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
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    // prisma.ts also fires PRAGMA warnings on a fresh database. Only the timer's
    // own lines are under test; anything else is passed through untouched.
    if (line.startsWith("[prisma-slow-tx]")) warnings.push(line);
    else realWarn(...args);
  };

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
      "app/api/videos/route.js:1",
      "a bundled Next route remains useful provenance without its absolute path",
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
    assert.match(
      line,
      /^\[prisma-slow-tx\] #\d+ elapsed \d+ms source=(?:scripts\/verify-prisma-slow-tx\.ts:\d+|unknown)$/,
      `unexpected shape: ${line}`,
    );

    const reported = Number(line.match(/elapsed (\d+)ms/)?.[1]);
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
    assert.match(warnings[0], / source=(?:scripts\/verify-prisma-slow-tx\.ts:\d+|unknown)$/);

    // The array form is instrumented too — it is how the batch call sites run.
    warnings.length = 0;
    await prisma.$transaction([prisma.user.count()]);
    assert.deepEqual(warnings, [], "a fast array transaction must not log either");

    await prisma.$disconnect();
    delete (globalThis as typeof globalThis & { prisma?: unknown }).prisma;

    // Next bundles prisma.ts into every route, while development shares one
    // Prisma client through globalThis. Reproduce that topology with two real
    // bundles: pricing installs the wrapper, then a different route invokes a
    // slow transaction through that shared client. The warning must name the
    // invoking route, regardless of which bundle installed instrumentation.
    await verifyBundledOwnerAttribution(warnings, heldMs);
  } finally {
    console.warn = realWarn;
  }

  console.log("verify-prisma-slow-tx: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

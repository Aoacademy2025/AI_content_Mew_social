import assert from "node:assert/strict";

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
  } finally {
    console.warn = realWarn;
  }

  console.log("verify-prisma-slow-tx: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

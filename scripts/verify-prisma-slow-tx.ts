import assert from "node:assert/strict";

/**
 * HERO-10 — the slow-transaction timer must actually fire, because its whole
 * job is to produce the evidence that names the writer holding the SQLite lock.
 * Production loses ~11 writes a day to the 20 s socket timeout on a box with a
 * load average under 1, and the logs name only the victims.
 *
 * Runs against a throwaway SQLite database; see `verify:prisma-slow-tx` for the
 * `prisma db push` that creates it.
 */

const THRESHOLD_MS = 50;

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
    const { prisma } = await import("../src/lib/prisma");

    // A transaction that finishes well inside the threshold stays silent, so
    // healthy traffic does not drown the signal.
    await prisma.$transaction(async (tx) => {
      await tx.user.count();
    });
    assert.deepEqual(warnings, [], "a fast transaction must not log");

    // A transaction held past the threshold is reported.
    const heldMs = THRESHOLD_MS * 4;
    await prisma.$transaction(async (tx) => {
      await tx.user.count();
      await new Promise((resolve) => setTimeout(resolve, heldMs));
    });

    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    const line = warnings[0];
    assert.match(line, /^\[prisma-slow-tx\] #\d+ held \d+ms$/, `unexpected shape: ${line}`);

    const reported = Number(line.match(/held (\d+)ms/)?.[1]);
    assert(
      reported >= heldMs,
      `reported ${reported}ms should cover the ${heldMs}ms the transaction was open`,
    );

    // The line carries no arguments, no model names and no row data.
    assert.doesNotMatch(line, /user|count|select|where/i, "the line must stay data-free");

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

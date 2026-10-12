import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ops batch 2026-10-12 — the single-query slow-query timer (`[prisma-slow-query]`,
 * src/lib/prisma.ts) must actually fire for a statement that is held up by another process
 * holding the SQLite writer lock, must name this process and the exact model.method (never
 * query text, bound parameters or row values), must NOT fire for a statement run inside
 * $transaction (that is `[prisma-slow-tx]`'s job), and must be removable with
 * PRISMA_SLOW_QUERY_MS=0.
 *
 * Runs against a throwaway SQLite database; see `verify:prisma-slow-query` (package.json) for
 * the `prisma db push` that creates it.
 */

type SlowQueryDiagnostic = { ms: number; proc: string; pid: number; startedAt: string; op: string };

function parseDiagnostic(line: string): SlowQueryDiagnostic {
  const m = line.match(/^\[prisma-slow-query\] ms=(\d+) proc=(\S+) pid=(\d+) startedAt=(\S+) op=(\S+)$/);
  assert(m, `unexpected diagnostic shape: ${line}`);
  return { ms: Number(m[1]), proc: m[2], pid: Number(m[3]), startedAt: m[4], op: m[5] };
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

async function main() {
  assert.equal(
    process.env.PRISMA_SLOW_QUERY_MS,
    "500",
    "the threshold is read once at module import, so it must be set before it",
  );
  assert(
    process.env.DATABASE_URL?.includes("slow-query"),
    "refusing to run against anything but the throwaway database",
  );

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[prisma-slow-query]")) warnings.push(line);
    else if (!line.startsWith("[prisma-slow-tx]")) realWarn(...args);
  };

  try {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await prisma.user.create({
      data: { id: "slow-query-user", name: "Slow Query User", email: "slow-query-user@example.invalid" },
    });
    warnings.length = 0;

    // A fast call stays silent.
    await prisma.user.count();
    assert.deepEqual(warnings, [], "a fast query must not log");

    // Hold the SQLite writer lock from a second connection — a real second process, exactly
    // like the slow-tx test does — then issue a plain top-level write from this process. It
    // must block until the lock is released, which is exactly the stall this feature exists
    // to surface, and which Prisma's own `query` log event does NOT measure (see prisma.ts).
    const databasePath = process.env.DATABASE_URL!.slice("file:".length).split("?")[0];
    const heldMs = 650;
    const lock = spawn("sqlite3", [databasePath], { stdio: ["pipe", "pipe", "pipe"] });
    lock.stdin.write("PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=5000;\nBEGIN IMMEDIATE;\n.print LOCKED\n");
    await waitForLock(lock);

    const startedBefore = new Date();
    const slowWrite = prisma.user.updateMany({
      where: { id: "slow-query-user" },
      data: { name: "secret-row-value" },
    });
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    lock.stdin.end("ROLLBACK;\n.quit\n");
    await slowWrite;
    const finishedAfter = new Date();

    assert.equal(warnings.length, 1, `expected exactly one [prisma-slow-query] line, got ${warnings.length}: ${JSON.stringify(warnings)}`);
    const diagnostic = parseDiagnostic(warnings[0]);
    assert.equal(diagnostic.op, "user.updateMany", "the label names the exact model.method, not a guess from SQL text");
    assert(diagnostic.ms >= heldMs - 50, `reported ${diagnostic.ms}ms should cover the ~${heldMs}ms the lock was held`);
    assert.equal(diagnostic.proc, process.env.name ?? process.title);
    assert.equal(diagnostic.pid, process.pid);
    const startedAt = new Date(diagnostic.startedAt);
    assert(!Number.isNaN(startedAt.getTime()), "startedAt must be a valid ISO timestamp");
    assert(startedAt.getTime() >= startedBefore.getTime() - 100, "startedAt must not be before the write was issued");
    assert(startedAt.getTime() <= finishedAfter.getTime(), "startedAt must not be after the write finished");

    // No query text, bound parameters, or row content ever appear in the line.
    for (const sentinel of ["secret-row-value", "slow-query-user", "SELECT", "UPDATE", "WHERE", "email"]) {
      assert(!warnings[0].includes(sentinel), `diagnostic leaked fixture content: ${sentinel}`);
    }

    // A statement run INSIDE $transaction must not double-log here — `[prisma-slow-tx]`
    // already reports it, and `tx` is a separate client object this timer never wraps.
    warnings.length = 0;
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { id: "slow-query-user" }, data: { name: "inside-tx" } });
      await new Promise((resolve) => setTimeout(resolve, heldMs));
    });
    assert.deepEqual(warnings, [], "a slow statement run through `tx` must not produce a [prisma-slow-query] line");

    // $executeRawUnsafe is covered too, labeled raw.$executeRawUnsafe (never the SQL text).
    warnings.length = 0;
    const lock2 = spawn("sqlite3", [databasePath], { stdio: ["pipe", "pipe", "pipe"] });
    lock2.stdin.write("PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=5000;\nBEGIN IMMEDIATE;\n.print LOCKED\n");
    await waitForLock(lock2);
    const rawWrite = prisma.$executeRawUnsafe("UPDATE User SET name = 'raw-secret' WHERE id = 'slow-query-user'");
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    lock2.stdin.end("ROLLBACK;\n.quit\n");
    await rawWrite;
    assert.equal(warnings.length, 1, `expected exactly one line for the raw write, got ${warnings.length}`);
    assert.equal(parseDiagnostic(warnings[0]).op, "raw.$executeRawUnsafe");
    assert(!warnings[0].includes("raw-secret") && !warnings[0].includes("UPDATE"));

    await prisma.user.delete({ where: { id: "slow-query-user" } }).catch(() => {});
    await prisma.$disconnect();
  } finally {
    console.warn = realWarn;
  }

  // ---- off switch: PRISMA_SLOW_QUERY_MS=0 produces zero lines, even for a real stall ------
  const disabled = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fixtures/prisma-slow-query-disabled.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PRISMA_SLOW_QUERY_MS: "0" },
      timeout: 10_000,
    },
  );
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.match(disabled.stdout, /prisma-slow-query-disabled: PASS/);
  assert.doesNotMatch(`${disabled.stdout}\n${disabled.stderr}`, /\[prisma-slow-query\]/);

  // Instrumentation is documented, log-only, and never prints row data.
  {
    const client = readFileSync(join(process.cwd(), "src/lib/prisma.ts"), "utf8");
    assert.match(client, /\[prisma-slow-query\]/);
    assert.match(client, /PRISMA_SLOW_QUERY_MS/);
  }

  // ---- overhead: 300 fast calls, wrapping on vs. off, run as two separate processes ------
  function runOverheadFixture(slowQueryMs: string): number {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fixtures/prisma-slow-query-overhead.ts"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PRISMA_SLOW_QUERY_MS: slowQueryMs }, timeout: 20_000 },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const m = run.stdout.match(/OVERHEAD_TOTAL_MS=(\d+)/);
    assert(m, `overhead fixture did not print its total: ${run.stdout}`);
    return Number(m[1]);
  }
  const COUNT = 300;
  const withLogging = runOverheadFixture("5000"); // high threshold: never logs, isolates the wrap cost
  const withoutWrapping = runOverheadFixture("0"); // the off switch: no wrapping installed at all
  const perCallOverheadMs = (withLogging - withoutWrapping) / COUNT;
  console.log(
    `verify-prisma-slow-query: overhead over ${COUNT} calls — wrapped ${withLogging}ms, unwrapped ${withoutWrapping}ms, ~${perCallOverheadMs.toFixed(3)}ms/call`,
  );
  // A loose ceiling (not a tight budget): this only catches a gross regression (e.g. an
  // accidental O(n) scan per call), not normal process/timer noise on a shared dev machine.
  assert(perCallOverheadMs < 2, `per-call overhead ${perCallOverheadMs.toFixed(3)}ms looks too high for a Proxy get-trap + one .then() subscription`);

  console.log("verify-prisma-slow-query: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

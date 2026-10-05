// HERO-70 — concurrent SQLite transactions inside ONE Node process must not stall in
// busy_timeout-sized steps.
//
// Root cause (reproduced here): Prisma 6's SQLite connector runs every statement synchronously
// on a tokio worker thread of the query engine, and SQLite's busy handler SLEEPS that thread
// while it waits for the writer lock. Every Prisma transaction — interactive or batch, read-only
// or not — opens with `BEGIN IMMEDIATE`, so it waits for the writer lock at BEGIN. When the
// waiting statements occupy every worker thread (tokio defaults to one per CPU; Prisma's default
// pool is 2 × physical CPUs + 1, so there are always more connections than workers), the
// interactive transaction that HOLDS the lock cannot get a thread to run its next statement or
// its COMMIT. Nobody progresses until the waiters hit busy_timeout and fail (P1008); then the
// holder resumes. Production (4 vCPU, busy_timeout 20 s): ten concurrent create_upload_url calls
// stalled in 20 s steps and failed (2026-10-04; a P2028 at 30 s on 2026-10-05).
//
// Every scenario runs in its own child process (prisma.ts reads its env once, at import) against
// a copy of one throwaway WAL database, with TOKIO_WORKER_THREADS=4 so the engine has the
// production VPS's worker count on any machine, and busy_timeout lowered to 2 s so a stall is a
// 2 s step instead of 20 s.
//
//   default-pool       production DATABASE_URL shape (no connection_limit): concurrent
//                      issueUploadToken (N = 2, 3, 5, 10) and an interactive transaction racing
//                      six plain writes. Must never stall or fail.
//   large-pool-mutex   operator-forced connection_limit=9 (the 4-vCPU default pool size): the
//                      in-process transaction queue alone must keep issueUploadToken bursts
//                      fast. (Plain writes racing a transaction are reported, not asserted: that
//                      is what the pool cap covers, and the operator turned it off here.)
//   pool-cap-only      PRISMA_TX_SERIALIZE=0: the connection cap alone must keep both workloads
//                      fast.
//   queue              the queue's own contract: FIFO order, the slow-tx line's queueMs/ahead,
//                      per-call maxWait bounds the queue wait (P2028, callback never entered),
//                      a nested transaction awaited inside a callback fails fast instead of
//                      deadlocking, a callback that never settles releases the queue once
//                      Prisma's timeout has closed it, and batch transactions queue too.
//   (no database)      TransactionQueue unit contract: depth, maxWait rejection, idempotent
//                      release, FIFO hand-off past a waiter that gave up.
//
// Run: node --conditions=react-server --import tsx scripts/verify-sqlite-tx-contention.ts
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const CHILD_FLAG = "--tx-contention-child";
const BUSY_TIMEOUT_SEC = 2;
/** A concurrent burst must finish well inside one busy_timeout step. */
const STALL_BUDGET_MS = (BUSY_TIMEOUT_SEC * 1000) / 2;
const BURST_SIZES = [2, 3, 5, 10];
const MIXED_PLAIN_WRITES = 6;

type CallResult = { ms: number; ok: boolean; code?: string };
type Burst = { n: number; wallMs: number; calls: CallResult[] };
type ChildReport = {
  baselineMs?: number;
  bursts?: Burst[];
  mixed?: Burst[];
  queue?: Record<string, unknown>;
  slowTxLines?: string[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(fn: () => Promise<unknown>): Promise<CallResult> {
  const startedAt = Date.now();
  try {
    const value = await fn() as { ok?: boolean; code?: string } | undefined;
    if (value && typeof value === "object" && "ok" in value && value.ok === false) {
      return { ms: Date.now() - startedAt, ok: false, code: value.code };
    }
    return { ms: Date.now() - startedAt, ok: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ms: Date.now() - startedAt, ok: false, code: typeof code === "string" ? code : "THROWN" };
  }
}

// ── child ──────────────────────────────────────────────────────────────────────────────────

async function runChild(): Promise<void> {
  const workloads = (process.argv[3] ?? "").split(",");
  const slowTxLines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[prisma-slow-tx]")) slowTxLines.push(line);
    else realWarn(...args);
  };

  const { prisma } = await import("../src/lib/prisma");
  const imports = await import("../src/lib/media-import/imports");
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.user.create({ data: { id: "burst-user", name: "burst", email: "burst@example.invalid" } });
  for (let i = 0; i < MIXED_PLAIN_WRITES; i += 1) {
    await prisma.user.create({ data: { id: `plain-${i}`, name: `plain-${i}`, email: `plain-${i}@example.invalid` } });
  }
  const resetLinks = async () => {
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
  };
  const report: ChildReport = {};

  if (workloads.includes("bursts")) {
    // Sequential baseline: what ONE create_upload_url admission costs on this machine.
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) samples.push((await timed(() => imports.issueUploadToken("burst-user", "image"))).ms);
    report.baselineMs = samples.sort((a, b) => a - b)[2];
    report.bursts = [];
    for (const n of BURST_SIZES) {
      await resetLinks();
      const startedAt = Date.now();
      const calls = await Promise.all(Array.from({ length: n }, () => timed(() => imports.issueUploadToken("burst-user", "image"))));
      report.bursts.push({ n, wallMs: Date.now() - startedAt, calls });
    }
  }

  if (workloads.includes("mixed")) {
    // One interactive transaction that writes, yields to JS, and writes again, raced by plain
    // single-statement writes — the shape of fetch-stock's reservation increments.
    report.mixed = [];
    for (let round = 0; round < 2; round += 1) {
      const startedAt = Date.now();
      const calls = await Promise.all([
        timed(() => prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: "burst-user" }, data: { usageCount: { increment: 1 } } });
          await sleep(20);
          await tx.user.update({ where: { id: "burst-user" }, data: { usageCount: { increment: 1 } } });
        })),
        ...Array.from({ length: MIXED_PLAIN_WRITES }, (_, i) => timed(async () => {
          await sleep(5);
          return prisma.user.update({ where: { id: `plain-${i}` }, data: { usageCount: { increment: 1 } } });
        })),
      ]);
      report.mixed.push({ n: MIXED_PLAIN_WRITES + 1, wallMs: Date.now() - startedAt, calls });
    }
  }

  if (workloads.includes("queue")) {
    const queue: Record<string, unknown> = {};
    const bump = (id = "burst-user") => ({ where: { id }, data: { usageCount: { increment: 1 } } });

    // (a) FIFO + observability: one holder, three queued behind it.
    slowTxLines.length = 0;
    const order: string[] = [];
    const holder = prisma.$transaction(async (tx) => {
      await tx.user.update(bump());
      await sleep(400);
      order.push("holder");
    });
    await sleep(30);
    const queued = ["q1", "q2", "q3"].map(async (name, i) => {
      await sleep(i * 10);
      await prisma.$transaction(async (tx) => {
        await tx.user.update(bump());
        order.push(name);
      });
    });
    await Promise.all([holder, ...queued]);
    queue.fifoOrder = order;
    queue.fifoLines = [...slowTxLines];

    // (b) per-call maxWait bounds the wait in the queue; the callback is never entered.
    let enteredB = false;
    const holderB = prisma.$transaction(async (tx) => {
      await tx.user.update(bump());
      await sleep(700);
    });
    await sleep(30);
    queue.maxWait = await timed(() => prisma.$transaction(async () => { enteredB = true; }, { maxWait: 200 }));
    queue.maxWaitEntered = enteredB;
    queue.maxWaitHolder = await timed(() => holderB);

    // (c) a transaction awaited INSIDE another transaction's callback (a nested call through the
    // global client) cannot ever start: the outer one holds the writer lock. It must fail within
    // the queue's maxWait (PRISMA_TX_MAX_WAIT_MS=1000 in this child) and let the outer one commit.
    let innerError: string | undefined;
    queue.nested = await timed(() => prisma.$transaction(async (tx) => {
      await tx.user.update(bump());
      const inner = await timed(() => prisma.$transaction(async (innerTx) => innerTx.user.update(bump())));
      innerError = inner.ok ? "ok" : inner.code;
    }));
    queue.nestedInner = innerError;

    // (d) a callback that never settles: Prisma closes the transaction at `timeout`, so the queue
    // must let the next transaction in once that has passed instead of holding it forever.
    void prisma.$transaction(async (tx) => {
      await tx.user.update(bump());
      await new Promise(() => undefined);
    }, { timeout: 800 }).catch(() => undefined);
    await sleep(30);
    queue.afterHung = await timed(() => prisma.$transaction(async (tx) => tx.user.update(bump()), { maxWait: 3000 }));

    // (e) batch transactions also start with BEGIN IMMEDIATE, so they queue too.
    slowTxLines.length = 0;
    const holderE = prisma.$transaction(async (tx) => {
      await tx.user.update(bump());
      await sleep(400);
    });
    await sleep(30);
    queue.batch = await timed(() => prisma.$transaction([prisma.user.update(bump("plain-0"))]));
    await holderE;
    queue.batchLines = [...slowTxLines];
    report.queue = queue;
  }

  report.slowTxLines = slowTxLines;
  process.stdout.write(`RESULT ${JSON.stringify(report)}\n`);
  await prisma.$disconnect();
  process.exit(0);
}

// ── parent ─────────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function runScenario(
  dbTemplate: string,
  name: string,
  workloads: string[],
  urlSuffix: string,
  env: Record<string, string>,
): Promise<ChildReport> {
  const dbPath = path.join(path.dirname(dbTemplate), `${name}.db`);
  fs.copyFileSync(dbTemplate, dbPath);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `file:${dbPath}${urlSuffix}`,
    TOKIO_WORKER_THREADS: "4",
    SQLITE_BUSY_TIMEOUT_SEC: String(BUSY_TIMEOUT_SEC),
    PRISMA_SLOW_TX_MS: "0",
    ...env,
  };
  for (const key of ["PRISMA_TX_SERIALIZE", "PRISMA_TX_MAX_WAIT_MS", "PRISMA_TX_TIMEOUT_MS"]) {
    if (!(key in env)) delete childEnv[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", __filename, CHILD_FLAG, workloads.join(",")],
      { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("exit", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (code !== 0 || !line) return reject(new Error(`${name} child exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line.slice("RESULT ".length)) as ChildReport);
    });
  });
}

function summarize(burst: Burst): string {
  const fails = burst.calls.filter((c) => !c.ok);
  const max = Math.max(...burst.calls.map((c) => c.ms));
  const codes = [...new Set(fails.map((c) => c.code))].join("/");
  return `N=${burst.n} wall=${burst.wallMs}ms max=${max}ms failures=${fails.length}${codes ? ` (${codes})` : ""}`;
}

function assertNoStall(label: string, bursts: Burst[] | undefined): void {
  check(`${label}: ran`, !!bursts && bursts.length > 0);
  for (const burst of bursts ?? []) {
    console.log(`        ${label} ${summarize(burst)}`);
    const max = Math.max(...burst.calls.map((c) => c.ms));
    check(
      `${label} N=${burst.n}: every call succeeds, none waits a busy_timeout step (max ${max}ms < ${STALL_BUDGET_MS}ms)`,
      burst.calls.every((c) => c.ok) && max < STALL_BUDGET_MS,
      summarize(burst),
    );
  }
}

const SLOW_LINE = /^\[prisma-slow-tx\] #\d+ elapsed (\d+)ms source=\S+ kind=(interactive|batch) queueMs=(\d+) ahead=(\d+)(?: beforeCallbackMs=(\d+) callbackMs=(\d+) callbackEntered=([01]))?$/;

async function main(): Promise<void> {
  if (process.argv[2] === CHILD_FLAG) return runChild();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-tx-contention-"));
  const template = path.join(tmp, "template.db");
  execSync("npx prisma db push --skip-generate", {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: `file:${template}` },
  });

  console.log("\nA) production URL shape (no connection_limit), 4 engine workers, busy_timeout 2 s");
  const prod = await runScenario(template, "default-pool", ["bursts", "mixed"], "", {});
  console.log(`        baseline (one call, sequential) ${prod.baselineMs}ms`);
  assertNoStall("issueUploadToken burst", prod.bursts);
  assertNoStall("transaction + plain writes", prod.mixed);

  console.log("\nB) operator-forced connection_limit=9 (the 4-vCPU default pool): the queue alone");
  const large = await runScenario(template, "large-pool-mutex", ["bursts", "mixed"], "?connection_limit=9", {});
  assertNoStall("issueUploadToken burst", large.bursts);
  for (const burst of large.mixed ?? []) {
    console.log(`        (informational, not asserted) transaction + plain writes ${summarize(burst)}`);
  }

  console.log("\nC) PRISMA_TX_SERIALIZE=0: the connection cap alone");
  const capOnly = await runScenario(template, "pool-cap-only", ["bursts", "mixed"], "", { PRISMA_TX_SERIALIZE: "0" });
  assertNoStall("issueUploadToken burst", capOnly.bursts);
  assertNoStall("transaction + plain writes", capOnly.mixed);

  console.log("\nD) the in-process transaction queue");
  const q = (await runScenario(template, "queue", ["queue"], "", {
    PRISMA_SLOW_TX_MS: "150",
    PRISMA_TX_MAX_WAIT_MS: "1000",
  })).queue ?? {};
  check("FIFO: queued transactions commit in arrival order", JSON.stringify(q.fifoOrder) === JSON.stringify(["holder", "q1", "q2", "q3"]), JSON.stringify(q.fifoOrder));
  const fifo = ((q.fifoLines as string[] | undefined) ?? []).map((line) => line.match(SLOW_LINE));
  check("slow-tx lines carry queueMs and ahead (exact grammar)", fifo.length === 4 && fifo.every(Boolean), JSON.stringify(q.fifoLines));
  const aheads = fifo.map((m) => Number(m?.[4])).sort();
  check("ahead counts the holder plus earlier waiters: 0, 1, 2, 3", JSON.stringify(aheads) === "[0,1,2,3]", JSON.stringify(q.fifoLines));
  const queuedLines = fifo.filter((m) => Number(m?.[4]) > 0);
  check(
    "queue wait is logged apart from engine wait (queueMs ≥ 300, beforeCallbackMs < 150)",
    queuedLines.length === 3 && queuedLines.every((m) => Number(m?.[3]) >= 300 && Number(m?.[5]) < 150),
    JSON.stringify(q.fifoLines),
  );
  const maxWait = q.maxWait as CallResult | undefined;
  check(
    "per-call maxWait bounds the queue wait: P2028 after ~200 ms, callback never entered",
    !!maxWait && !maxWait.ok && maxWait.code === "P2028" && maxWait.ms >= 180 && maxWait.ms < 600 && q.maxWaitEntered === false,
    JSON.stringify({ maxWait, entered: q.maxWaitEntered }),
  );
  check("the holder is unaffected by a waiter giving up", (q.maxWaitHolder as CallResult | undefined)?.ok === true, JSON.stringify(q.maxWaitHolder));
  const nested = q.nested as CallResult | undefined;
  check(
    "nested transaction awaited inside a callback fails within maxWait (P2028), outer commits",
    q.nestedInner === "P2028" && nested?.ok === true && nested.ms < 2500,
    JSON.stringify({ inner: q.nestedInner, outer: nested }),
  );
  const afterHung = q.afterHung as CallResult | undefined;
  check(
    "a never-settling callback releases the queue after Prisma's timeout (800 ms)",
    afterHung?.ok === true && afterHung.ms >= 600 && afterHung.ms < 2500,
    JSON.stringify(afterHung),
  );
  const batch = q.batch as CallResult | undefined;
  const batchLine = ((q.batchLines as string[] | undefined) ?? []).map((line) => line.match(SLOW_LINE)).find((m) => m?.[2] === "batch");
  check(
    "batch transactions queue behind an interactive one (kind=batch ahead=1)",
    batch?.ok === true && batch.ms >= 300 && Number(batchLine?.[4]) === 1,
    JSON.stringify({ batch, lines: q.batchLines }),
  );

  console.log("\nE) TransactionQueue unit contract (no database)");
  {
    const { TransactionQueue } = await import("../src/lib/prisma-transaction-queue");
    const queue = new TransactionQueue();
    const timeoutError = (queuedMs: number) => Object.assign(new Error(`queued ${queuedMs}`), { code: "P2028" });
    const first = await queue.acquire(1000, timeoutError);
    check("an idle queue grants at once (queuedMs 0, depth 1)", first.queuedMs === 0 && queue.depth() === 1);
    const order: string[] = [];
    const second = queue.acquire(1000, timeoutError).then((slot) => { order.push("second"); return slot; });
    const gaveUp = queue.acquire(50, timeoutError).then(
      () => "granted",
      (error: { code?: string }) => error.code,
    );
    const third = queue.acquire(1000, timeoutError).then((slot) => { order.push("third"); return slot; });
    check("depth counts the holder and every waiter", queue.depth() === 4, String(queue.depth()));
    check("a waiter past maxWait is rejected with the supplied error", (await gaveUp) === "P2028");
    check("…and leaves the line", queue.depth() === 3, String(queue.depth()));
    first.release();
    first.release();
    const secondSlot = await second;
    check("release is idempotent: a double release does not admit two at once", queue.depth() === 2 && order.join() === "second", `${queue.depth()} ${order.join()}`);
    secondSlot.release();
    const thirdSlot = await third;
    check("FIFO hand-off skips the waiter that gave up", order.join() === "second,third");
    thirdSlot.release();
    check("the last release frees the slot", queue.depth() === 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nverify-sqlite-tx-contention: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

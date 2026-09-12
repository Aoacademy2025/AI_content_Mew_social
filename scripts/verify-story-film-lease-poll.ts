// Run with: npm run verify:story-film-lease-poll
//
// B6 row 2 — the story-film system worker polls `leaseStoryFilmGenerationJobs`
// every 4 s. Production measurement (A1 §A1.8 cause #2) counted ~21,600
// write-first interactive transactions a day from that poll against a 114-row
// table, plus 25 P1008 lease failures a day: SQLite takes the write lock at
// `BEGIN IMMEDIATE`, so an idle poll was queueing behind — and ahead of — real
// customer writes for nothing.
//
// What is under test here is ONLY the idle path. Which jobs get leased, and
// when, must not move: (b), (c) and (d) pin the leased row against a golden
// snapshot of the pre-change code on the same fixture, and (d2) pins the
// backend-agnostic requeue of expired leases.
//
// Query statements are counted for real: the test seeds `globalThis.prisma`
// with a client built with `log: [{ emit: "event", level: "query" }]` before
// `src/lib/prisma` is imported, so the module under test uses the instrumented
// client (src/lib/prisma.ts reuses `globalForPrisma.prisma` when it is set).
// Prisma emits `BEGIN IMMEDIATE` / `COMMIT` as query events on SQLite, which is
// what makes "no transaction was opened" an observable fact rather than a claim.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const testDir = mkdtempSync(join(tmpdir(), "story-film-lease-poll-"));
const databaseUrl = `file:${join(testDir, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok: ${message}`);
}

/** Statements that take (or hold) the SQLite write lock. */
const WRITE_OR_TX = /^\s*(BEGIN|INSERT|UPDATE|DELETE|COMMIT|ROLLBACK)/i;

const client = new PrismaClient({
  datasourceUrl: databaseUrl,
  log: [{ emit: "event", level: "query" }],
});
const statements: string[] = [];
// $on("query") is typed off the log options; this client declares the event.
(client as unknown as { $on: (e: "query", cb: (p: { query: string }) => void) => void })
  .$on("query", (payload) => statements.push(payload.query));
(globalThis as unknown as { prisma: PrismaClient }).prisma = client;

function record<T>(label: string) {
  statements.length = 0;
  return (value: T) => {
    const seen = [...statements];
    const writes = seen.filter((line) => WRITE_OR_TX.test(line));
    const reads = seen.filter((line) => !WRITE_OR_TX.test(line));
    console.log(`   [${label}] ${seen.length} statement(s), ${writes.length} write/tx`);
    return { value, seen, writes, reads };
  };
}

const NOW = new Date("2026-09-12T03:00:00.000Z");
const EARLIER = new Date(NOW.getTime() - 60_000);

/** Volatile columns normalised so the snapshot can be compared literally. */
function snapshot(job: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(job)) {
    if (["id", "projectId", "createdAt", "updatedAt"].includes(key)) continue;
    if (key === "leaseTokenHash") {
      out[key] = typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? "<sha256>" : value;
      continue;
    }
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

async function main() {
  const queue = await import("../src/lib/story-film-generation-queue.server");
  const { prisma } = await import("../src/lib/prisma");
  ok(prisma === client, "the module under test uses the instrumented client");

  try {
    const user = await prisma.user.create({
      data: { id: "lease-poll-user", name: "Poll", email: "lease-poll@example.com", plan: "BUSINESS" },
    });
    const makeProject = (id: string, status: string) => prisma.storyFilmProject.create({
      data: {
        id,
        userId: user.id,
        title: `Lease poll ${id}`,
        idempotencyKey: `lease-poll:${id}`,
        presentationMode: "faceless",
        narrativeSource: "เรื่องนี้ใช้ทดสอบว่า poll ที่ไม่มีงานต้องไม่เปิดทรานแซกชันเขียน",
        stage: "storyboard",
        revision: 3,
        generationEpoch: 2,
        awaitingApproval: false,
        status,
      },
    });
    const liveProject = await makeProject("lease-poll-live", "waiting_generation");
    const pausedProject = await makeProject("lease-poll-paused", "paused");

    const makeJob = (data: {
      id: string;
      projectId: string;
      kind?: string;
      providerBackend?: string;
      status?: string;
      availableAt?: Date;
      leaseExpiresAt?: Date | null;
      leaseOwner?: string | null;
      leaseTokenHash?: string | null;
    }) => prisma.storyFilmGenerationJob.create({
      data: {
        id: data.id,
        projectId: data.projectId,
        stage: "storyboard",
        projectRevision: 3,
        generationEpoch: 2,
        kind: data.kind ?? "storyboard_plan",
        providerBackend: data.providerBackend ?? "hero_text",
        payloadJson: JSON.stringify({ prompt: "storyboard" }),
        idempotencyKey: `lease-poll:${data.id}`,
        status: data.status ?? "queued",
        availableAt: data.availableAt ?? EARLIER,
        leaseExpiresAt: data.leaseExpiresAt ?? null,
        leaseOwner: data.leaseOwner ?? null,
        leaseTokenHash: data.leaseTokenHash ?? null,
      },
    });

    const poll = async (label: string, backends: Parameters<
      typeof queue.leaseStoryFilmGenerationJobs
    >[0]["providerBackends"] = ["hero_text", "hero_alignment", "hero_voice", "elevenlabs", "hero_render"]) => {
      const finish = record<Awaited<ReturnType<typeof queue.leaseStoryFilmGenerationJobs>>>(label);
      const leased = await queue.leaseStoryFilmGenerationJobs({
        workerId: "lease-poll-worker",
        providerBackends: backends,
        maxJobs: 2,
        now: NOW,
      });
      return finish(leased);
    };

    // ---- (a) an idle queue must not open a write transaction -------------
    const emptyPoll = await poll("a1 empty table");
    ok(emptyPoll.value.length === 0, "(a1) an empty queue leases nothing");
    assert.deepEqual(emptyPoll.writes, [], "(a1) an idle poll must issue no BEGIN and no write");
    passed += 1;
    console.log("ok: (a1) an idle poll on an empty table opens no write transaction");
    ok(emptyPoll.reads.length === 1, `(a1) exactly one cheap read, got ${emptyPoll.reads.length}`);

    // Same, with the table populated by work that is finished or already held:
    // a completed job, a needs_attention job, and a live (unexpired) lease.
    await makeJob({ id: "job-completed", projectId: liveProject.id, status: "completed" });
    await makeJob({ id: "job-attention", projectId: liveProject.id, status: "needs_attention" });
    await makeJob({
      id: "job-live-lease",
      projectId: liveProject.id,
      status: "running",
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
      leaseOwner: "someone-else",
      leaseTokenHash: "f".repeat(64),
    });
    // (d) the relation-filter predicate: a queued job whose project is paused
    // is invisible to the transaction today, so it must stay invisible to the
    // pre-check too — otherwise the poll opens a transaction that leases
    // nothing, which is the exact cost this change removes.
    await makeJob({ id: "job-paused-project", projectId: pausedProject.id });

    const busyIdlePoll = await poll("a2 populated but idle");
    ok(busyIdlePoll.value.length === 0, "(a2) finished/held/excluded rows lease nothing");
    assert.deepEqual(busyIdlePoll.writes, [], "(a2) an idle poll must issue no BEGIN and no write");
    passed += 1;
    console.log("ok: (a2)+(d) completed, held and paused-project rows open no write transaction");

    const pausedJobAfter = await prisma.storyFilmGenerationJob.findUnique({ where: { id: "job-paused-project" } });
    ok(pausedJobAfter?.status === "queued" && pausedJobAfter.leaseOwner === null,
      "(d) a job on a paused project is never leased");

    // ---- (b) one queued job is still leased within one poll --------------
    await makeJob({ id: "job-queued", projectId: liveProject.id });
    const leasingPoll = await poll("b queued job");
    ok(leasingPoll.value.length === 1 && leasingPoll.value[0].id === "job-queued",
      "(b) a queued job is leased within one poll");
    ok(leasingPoll.writes.length > 0, "(b) leasing still runs inside the write transaction");

    const leasedRow = await prisma.storyFilmGenerationJob.findUnique({ where: { id: "job-queued" } });
    assert(leasedRow);
    const golden = {
      stage: "storyboard",
      projectRevision: 3,
      generationEpoch: 2,
      kind: "storyboard_plan",
      providerBackend: "hero_text",
      sceneKey: null,
      payloadJson: JSON.stringify({ prompt: "storyboard" }),
      idempotencyKey: "lease-poll:job-queued",
      status: "leased",
      priority: 100,
      attemptCount: 0,
      technicalFailureCount: 0,
      providerJobId: null,
      leaseOwner: "lease-poll-worker",
      leaseTokenHash: "<sha256>",
      leaseExpiresAt: "2026-09-12T03:01:30.000Z",
      heartbeatAt: NOW.toISOString(),
      availableAt: EARLIER.toISOString(),
      submittedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    assert.deepEqual(snapshot(leasedRow), golden, "(b) the leased row must match the golden run");
    passed += 1;
    console.log("ok: (b) the leased row matches the pre-change golden snapshot");

    const returned = leasingPoll.value[0];
    ok(returned.status === "leased"
      && returned.leaseExpiresAt === golden.leaseExpiresAt
      && returned.resumeProviderJobId === null
      && returned.attemptCount === 0
      && typeof returned.leaseToken === "string" && returned.leaseToken.length >= 32
      && JSON.stringify(returned.payload) === golden.payloadJson,
      "(b) the returned lease carries the same token, payload and clock as before");

    // ---- (c) an expired lease is requeued and re-leased -------------------
    await prisma.storyFilmGenerationJob.update({
      where: { id: "job-queued" },
      data: { leaseExpiresAt: new Date(NOW.getTime() - 1_000), leaseOwner: "dead-worker" },
    });
    const requeuePoll = await poll("c expired lease");
    ok(requeuePoll.writes.length > 0, "(c) an expired lease still opens the write transaction");
    ok(requeuePoll.value.length === 1 && requeuePoll.value[0].id === "job-queued",
      "(c) an expired lease is requeued and re-leased in the same poll");
    const releasedRow = await prisma.storyFilmGenerationJob.findUnique({ where: { id: "job-queued" } });
    assert(releasedRow);
    assert.deepEqual(
      snapshot(releasedRow),
      { ...golden, availableAt: NOW.toISOString() },
      "(c) the re-leased row matches the golden run (availableAt reset by the requeue)",
    );
    passed += 1;
    console.log("ok: (c) the re-leased row matches the pre-change golden snapshot");

    // ---- (d2) the requeue predicate is backend-agnostic -------------------
    // `requeueExpiredLeases` is not scoped to the caller's backends, so a poll
    // for hero_* backends today rescues an expired grok/vidiq lease. The
    // pre-check must use that same unscoped predicate or those rows would sit
    // leased forever (this worker never polls grok_subscription or vidiq).
    await prisma.storyFilmGenerationJob.update({
      where: { id: "job-queued" },
      data: { status: "completed", leaseExpiresAt: null, leaseOwner: null, leaseTokenHash: null },
    });
    await makeJob({
      id: "job-foreign-expired",
      projectId: liveProject.id,
      kind: "scene_video",
      providerBackend: "grok_subscription",
      status: "running",
      leaseExpiresAt: new Date(NOW.getTime() - 5_000),
      leaseOwner: "grok-worker",
      leaseTokenHash: "a".repeat(64),
    });
    const foreignPoll = await poll("d2 foreign expired lease");
    ok(foreignPoll.value.length === 0, "(d2) a grok job is not leased by a hero_* poll");
    ok(foreignPoll.writes.length > 0, "(d2) the expired foreign lease still opens the transaction");
    const foreignRow = await prisma.storyFilmGenerationJob.findUnique({ where: { id: "job-foreign-expired" } });
    ok(foreignRow?.status === "queued"
      && foreignRow.leaseOwner === null
      && foreignRow.leaseTokenHash === null
      && foreignRow.leaseExpiresAt === null
      && foreignRow.availableAt.toISOString() === NOW.toISOString(),
      "(d2) an expired lease on an unpolled backend is still requeued");

    // And once it is queued (but on a backend this poll does not ask for), the
    // poll goes quiet again: no expired lease, no leasable candidate.
    const quietAgain = await poll("a3 idle after requeue");
    ok(quietAgain.value.length === 0, "(a3) nothing left to lease for hero_* backends");
    assert.deepEqual(quietAgain.writes, [], "(a3) the poll is write-free again");
    passed += 1;
    console.log("ok: (a3) the poll is write-free once the expired lease has been rescued");

    // A poll that does ask for that backend still leases it.
    const grokPoll = await poll("b2 grok poll", ["grok_subscription"]);
    ok(grokPoll.value.length === 1 && grokPoll.value[0].id === "job-foreign-expired",
      "(b2) the requeued job is leased by a poll that asks for its backend");
  } finally {
    await client.$disconnect();
    rmSync(testDir, { recursive: true, force: true });
  }

  console.log(`verify-story-film-lease-poll: ALL PASS (${passed} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Run with: npx tsx scripts/verify-editor-project-save-queue.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as saveQueueModule from "../src/lib/editor-project-save-queue";
import { decideEditorProjectBootstrap } from "../src/lib/editor-project-bootstrap";
import { parseEditorProjectRecoveryJournal } from "../src/lib/editor-project-recovery-journal";

type SaveStatus = "saving" | "saved" | "error";
type SaveEvent = { projectId: string; revision: number; status: SaveStatus };
type SaveContext = { revision: number; signal: AbortSignal };
type SaveOutcome =
  | { kind: "saved" }
  | { kind: "error" }
  | { kind: "ambiguous" }
  | { kind: "blocked" };
type SaveInput = {
  projectId: string;
  save: (context: SaveContext) => Promise<boolean | SaveOutcome>;
  reconcile?: (context: SaveContext) => Promise<SaveOutcome>;
  onBlocked?: (event: SaveEvent) => void;
  isActive?: () => boolean;
  onStatus?: (event: SaveEvent) => void;
};
type Queue = {
  seedRevision(projectId: string, revision: number): void;
  reserveRevisionAbove(projectId: string, observed: number): number;
  revisionWatermark(projectId: string): number;
  enqueue(input: SaveInput): number;
  whenIdle(projectId: string): Promise<void>;
  laneCount(): number;
};
type QueueFactory = (options?: {
  requestTimeoutMs?: number;
  scheduleTimeout?: (task: () => void, delayMs: number) => unknown;
  cancelTimeout?: (token: unknown) => void;
}) => Queue;

const createQueue = saveQueueModule.createEditorProjectSaveQueue as unknown as QueueFactory;

type ControlledCall = {
  projectId: string;
  draft: string;
  revision: number;
  signal: AbortSignal;
  complete(outcome: boolean | SaveOutcome): void;
  fail(error: Error): void;
};

function controlledSave(calls: ControlledCall[], projectId: string, draft: string) {
  return ({ revision, signal }: SaveContext) => new Promise<boolean | SaveOutcome>((resolve, reject) => {
    calls.push({ projectId, draft, revision, signal, complete: resolve, fail: reject });
  });
}

function fakeTimeouts() {
  let nextToken = 1;
  const scheduled = new Map<number, { task: () => void; delayMs: number }>();
  return {
    scheduleTimeout(task: () => void, delayMs: number) {
      const token = nextToken++;
      scheduled.set(token, { task, delayMs });
      return token;
    },
    cancelTimeout(token: unknown) {
      scheduled.delete(token as number);
    },
    runNext() {
      const next = scheduled.entries().next().value as [number, { task: () => void; delayMs: number }] | undefined;
      assert.ok(next, "expected a pending request timeout");
      scheduled.delete(next[0]);
      next[1].task();
      return next[1].delayMs;
    },
    size() { return scheduled.size; },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  {
    const queue = createQueue();
    assert.equal(typeof queue.seedRevision, "function", "queue exposes a server revision seed");
    assert.equal(typeof queue.reserveRevisionAbove, "function", "queue exposes conflict revision reservation");
    assert.equal(typeof queue.revisionWatermark, "function", "queue exposes its per-project watermark");
    assert.equal(queue.revisionWatermark("project-unseen"), 0, "an unseen project starts at revision zero");
    assert.equal(typeof queue.laneCount, "function", "queue exposes an eviction inspection seam");
    const calls: ControlledCall[] = [];
    const events: SaveEvent[] = [];
    queue.seedRevision("project-order", 7);
    const revisionA = queue.enqueue({
      projectId: "project-order",
      save: controlledSave(calls, "project-order", "A"),
      onStatus: (event) => events.push(event),
    });
    const revisionB = queue.enqueue({
      projectId: "project-order",
      save: controlledSave(calls, "project-order", "B"),
      onStatus: (event) => events.push(event),
    });
    assert.deepEqual([revisionA, revisionB], [8, 9], "revisions advance above the observed server revision");
    assert.equal(calls.length, 1, "B waits behind in-flight A");
    calls[0].complete(true);
    await nextTurn();
    assert.equal(calls[1].draft, "B");
    calls[1].complete(true);
    await queue.whenIdle("project-order");
    assert.deepEqual(
      events.map(({ revision, status }) => ({ revision, status })),
      [
        { revision: 8, status: "saving" },
        { revision: 9, status: "saving" },
        { revision: 9, status: "saved" },
      ],
      "only the latest revision publishes a terminal status",
    );
    assert.equal(queue.laneCount(), 0, "idle lane releases request and observer closures");

    assert.equal(
      queue.reserveRevisionAbove("project-conflict", 12),
      13,
      "conflict resolution reserves strictly above the displayed server revision",
    );
    assert.equal(queue.revisionWatermark("project-conflict"), 13);
    assert.equal(
      queue.reserveRevisionAbove("project-conflict", 9),
      14,
      "an older observation never lowers the existing project watermark",
    );

    const remountCalls: ControlledCall[] = [];
    const remountRevision = queue.enqueue({
      projectId: "project-order",
      save: controlledSave(remountCalls, "project-order", "remount"),
    });
    assert.equal(remountRevision, 10, "numeric watermark survives idle lane eviction");
    remountCalls[0].complete(true);
    await queue.whenIdle("project-order");
  }

  {
    const clock = fakeTimeouts();
    const queue = createQueue({
      requestTimeoutMs: 10_000,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
    });
    const events: SaveEvent[] = [];
    let lateReject: ((error: Error) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const calls: string[] = [];
    queue.enqueue({
      projectId: "project-timeout",
      save: ({ signal }) => {
        calls.push("A");
        firstSignal = signal;
        return new Promise<boolean>((_resolve, reject) => { lateReject = reject; });
      },
      onStatus: (event) => events.push(event),
    });
    const revisionB = queue.enqueue({
      projectId: "project-timeout",
      save: async () => {
        calls.push("B");
        return true;
      },
      onStatus: (event) => events.push(event),
    });
    assert.deepEqual(calls, ["A"]);
    assert.equal(clock.runNext(), 10_000, "the bounded request timeout releases A's lane");
    await queue.whenIdle("project-timeout");
    assert.equal(firstSignal?.aborted, true, "timed-out request receives an abort signal");
    assert.deepEqual(calls, ["A", "B"], "latest B starts after never-settling A times out");
    assert.deepEqual(events.at(-1), {
      projectId: "project-timeout",
      revision: revisionB,
      status: "saved",
    });
    assert.equal(clock.size(), 0, "completed latest save clears its timeout");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    lateReject?.(new Error("late server/network rejection after timeout"));
    await nextTurn();
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], "late timed-out promise rejection is consumed");
  }

  {
    const queue = createQueue();
    const phases: string[] = [];
    const events: SaveEvent[] = [];
    let finishReconcile!: (outcome: SaveOutcome) => void;
    const revisionA = queue.enqueue({
      projectId: "project-ambiguous",
      save: async () => {
        phases.push("save:A");
        return { kind: "ambiguous" };
      },
      reconcile: () => new Promise<SaveOutcome>((resolve) => {
        phases.push("reconcile:A");
        finishReconcile = resolve;
      }),
      onStatus: (event) => events.push(event),
    });
    const revisionB = queue.enqueue({
      projectId: "project-ambiguous",
      save: async () => {
        phases.push("save:B");
        return true;
      },
      onStatus: (event) => events.push(event),
    });
    await nextTurn();
    assert.deepEqual(
      phases,
      ["save:A", "reconcile:A"],
      "an ambiguous primary enters reconciliation before pending B starts",
    );
    finishReconcile({ kind: "saved" });
    await queue.whenIdle("project-ambiguous");
    assert.deepEqual(phases, ["save:A", "reconcile:A", "save:B"]);
    assert.deepEqual(
      events.map(({ revision, status }) => ({ revision, status })),
      [
        { revision: revisionA, status: "saving" },
        { revision: revisionB, status: "saving" },
        { revision: revisionB, status: "saved" },
      ],
      "reconciliation completes but only the latest UI status publishes",
    );
  }

  {
    const clock = fakeTimeouts();
    const queue = createQueue({
      requestTimeoutMs: 321,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
    });
    const phases: string[] = [];
    const events: SaveEvent[] = [];
    let primarySignal: AbortSignal | undefined;
    let reconcileSignal: AbortSignal | undefined;
    let lateResolve!: (outcome: boolean | SaveOutcome) => void;
    let finishReconcile!: (outcome: SaveOutcome) => void;
    queue.enqueue({
      projectId: "project-timeout-reconcile",
      save: ({ signal }) => new Promise<boolean | SaveOutcome>((resolve) => {
        phases.push("save:A");
        primarySignal = signal;
        lateResolve = resolve;
      }),
      reconcile: ({ signal }) => new Promise<SaveOutcome>((resolve) => {
        phases.push("reconcile:A");
        reconcileSignal = signal;
        finishReconcile = resolve;
      }),
      onStatus: (event) => events.push(event),
    });
    queue.enqueue({
      projectId: "project-timeout-reconcile",
      save: async () => {
        phases.push("save:B");
        return true;
      },
      onStatus: (event) => events.push(event),
    });
    assert.equal(clock.runNext(), 321);
    await nextTurn();
    assert.equal(primarySignal?.aborted, true, "primary timeout aborts the PATCH signal");
    assert.ok(reconcileSignal, "primary timeout invokes reconciliation");
    assert.notEqual(reconcileSignal, primarySignal, "reconciliation owns a fresh signal");
    assert.equal(reconcileSignal?.aborted, false, "fresh reconciliation signal starts un-aborted");
    assert.deepEqual(phases, ["save:A", "reconcile:A"], "B cannot start during reconciliation");
    finishReconcile({ kind: "saved" });
    await queue.whenIdle("project-timeout-reconcile");
    assert.deepEqual(phases, ["save:A", "reconcile:A", "save:B"]);
    const eventsBeforeLatePrimary = structuredClone(events);
    lateResolve({ kind: "saved" });
    await nextTurn();
    assert.deepEqual(events, eventsBeforeLatePrimary,
      "a late primary resolution cannot publish after reconciliation wins");
    assert.equal(clock.size(), 0, "both bounded phases clear their timer ownership");
  }

  {
    const queue = createQueue();
    const phases: string[] = [];
    queue.enqueue({
      projectId: "project-legacy-ambiguous",
      save: async () => {
        phases.push("save:A");
        return { kind: "ambiguous" };
      },
    });
    queue.enqueue({
      projectId: "project-legacy-ambiguous",
      save: async () => {
        phases.push("save:B");
        return true;
      },
    });
    await queue.whenIdle("project-legacy-ambiguous");
    assert.deepEqual(
      phases,
      ["save:A", "save:B"],
      "ambiguous without reconciliation preserves legacy error-and-continue behavior",
    );
  }

  {
    const clock = fakeTimeouts();
    const queue = createQueue({
      requestTimeoutMs: 456,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
    });
    const phases: string[] = [];
    const events: SaveEvent[] = [];
    const blockedEvents: SaveEvent[] = [];
    let reconcileSignal: AbortSignal | undefined;
    const onBlocked = (event: SaveEvent) => blockedEvents.push(event);
    queue.enqueue({
      projectId: "project-reconcile-timeout",
      save: async () => {
        phases.push("save:A");
        return { kind: "ambiguous" };
      },
      reconcile: ({ signal }) => new Promise<SaveOutcome>(() => {
        phases.push("reconcile:A");
        reconcileSignal = signal;
      }),
      onBlocked,
      onStatus: (event) => events.push(event),
    });
    const revisionB = queue.enqueue({
      projectId: "project-reconcile-timeout",
      save: async () => {
        phases.push("save:B");
        return true;
      },
      onBlocked,
      onStatus: (event) => events.push(event),
    });
    await nextTurn();
    assert.deepEqual(phases, ["save:A", "reconcile:A"]);
    assert.equal(clock.runNext(), 456, "reconciliation has its own bounded timeout");
    await queue.whenIdle("project-reconcile-timeout");
    assert.equal(reconcileSignal?.aborted, true, "reconciliation timeout aborts its signal");
    assert.deepEqual(phases, ["save:A", "reconcile:A"], "blocked reconciliation drops B");
    assert.deepEqual(blockedEvents, [{
      projectId: "project-reconcile-timeout",
      revision: revisionB,
      status: "error",
    }], "blocked reconciliation notifies active UI exactly once for the latest revision");
    assert.deepEqual(events.at(-1), blockedEvents[0], "blocked reconciliation publishes latest error");
    assert.equal(queue.revisionWatermark("project-reconcile-timeout"), revisionB,
      "blocking never lowers the allocated revision watermark");
    assert.equal(queue.laneCount(), 0, "blocked reconciliation releases idle waiters and evicts lane");
  }

  {
    const queue = createQueue();
    const phases: string[] = [];
    const events: SaveEvent[] = [];
    const blockedEvents: SaveEvent[] = [];
    const onBlocked = (event: SaveEvent) => blockedEvents.push(event);
    queue.enqueue({
      projectId: "project-direct-blocked",
      save: async () => {
        phases.push("save:A");
        return { kind: "blocked" };
      },
      onBlocked,
      onStatus: (event) => events.push(event),
    });
    const revisionB = queue.enqueue({
      projectId: "project-direct-blocked",
      save: async () => {
        phases.push("save:B");
        return true;
      },
      onBlocked,
      onStatus: (event) => events.push(event),
    });
    await queue.whenIdle("project-direct-blocked");
    assert.deepEqual(phases, ["save:A"], "a primary blocked outcome immediately drops pending work");
    assert.deepEqual(blockedEvents, [{
      projectId: "project-direct-blocked",
      revision: revisionB,
      status: "error",
    }]);
    assert.deepEqual(events.at(-1), blockedEvents[0]);
  }

  for (const reconcileFailure of ["error", "ambiguous", "blocked", "throw"] as const) {
    const queue = createQueue();
    const phases: string[] = [];
    let blockedCount = 0;
    queue.enqueue({
      projectId: `project-reconcile-${reconcileFailure}`,
      save: async () => {
        phases.push("save:A");
        return { kind: "ambiguous" };
      },
      reconcile: async () => {
        phases.push("reconcile:A");
        if (reconcileFailure === "throw") throw new Error("authoritative observation failed");
        return { kind: reconcileFailure };
      },
      onBlocked: () => { blockedCount += 1; },
    });
    queue.enqueue({
      projectId: `project-reconcile-${reconcileFailure}`,
      save: async () => {
        phases.push("save:B");
        return true;
      },
    });
    await queue.whenIdle(`project-reconcile-${reconcileFailure}`);
    assert.deepEqual(phases, ["save:A", "reconcile:A"],
      `reconciliation ${reconcileFailure} blocks and drops pending work`);
    assert.equal(blockedCount, 1, `reconciliation ${reconcileFailure} notifies exactly once`);
  }

  {
    const queue = createQueue();
    const events: SaveEvent[] = [];
    let getterReads = 0;
    const malformed = Object.defineProperty({}, "kind", {
      get() {
        getterReads += 1;
        return "saved";
      },
    });
    const revision = queue.enqueue({
      projectId: "project-malformed-outcome",
      save: async () => malformed as SaveOutcome,
      onStatus: (event) => events.push(event),
    });
    await queue.whenIdle("project-malformed-outcome");
    assert.equal(getterReads, 0, "normalization rejects an accessor outcome without invoking it");
    assert.deepEqual(events.at(-1), {
      projectId: "project-malformed-outcome",
      revision,
      status: "error",
    }, "malformed structured outcomes fail closed as an ordinary save error");
  }

  {
    const queue = createQueue();
    const persisted = new Map<string, string>();
    const calls: ControlledCall[] = [];
    const revisionA = queue.enqueue({
      projectId: "project-bootstrap",
      save: controlledSave(calls, "project-bootstrap", "A"),
    });
    const revisionB = queue.enqueue({
      projectId: "project-bootstrap",
      save: controlledSave(calls, "project-bootstrap", "B"),
    });
    let getCalls = 0;
    const remountBootstrap = (async () => {
      await queue.whenIdle("project-bootstrap");
      getCalls += 1;
      return persisted.get("project-bootstrap");
    })();
    await nextTurn();
    assert.equal(getCalls, 0, "remount GET waits while the existing save lane is active");
    persisted.set("project-bootstrap", "A");
    calls[0].complete(true);
    await nextTurn();
    assert.equal(getCalls, 0, "remount GET also waits for coalesced latest B");
    persisted.set("project-bootstrap", "B");
    calls[1].complete(true);
    assert.equal(await remountBootstrap, "B", "remount applies post-idle server B, never stale A");
    assert.deepEqual([revisionA, revisionB], [1, 2]);
  }

  {
    const queue = createQueue();
    const events: SaveEvent[] = [];
    const failedRevision = queue.enqueue({
      projectId: "project-retry",
      save: async () => false,
      onStatus: (event) => events.push(event),
    });
    await queue.whenIdle("project-retry");
    const retryRevision = queue.enqueue({
      projectId: "project-retry",
      save: async () => true,
      onStatus: (event) => events.push(event),
    });
    await queue.whenIdle("project-retry");
    assert.equal(retryRevision, failedRevision + 1, "retry allocates a newer durable revision");
    assert.deepEqual(events.at(-1), {
      projectId: "project-retry",
      revision: retryRevision,
      status: "saved",
    });
  }

  {
    const calls: ControlledCall[] = [];
    const queue = createQueue();
    queue.enqueue({
      projectId: "project-old",
      save: controlledSave(calls, "project-old", "old"),
    });
    queue.enqueue({
      projectId: "project-new",
      save: controlledSave(calls, "project-new", "new"),
    });
    assert.equal(calls.length, 2, "different project lanes never block each other");
    calls.find((call) => call.projectId === "project-new")!.complete(true);
    await queue.whenIdle("project-new");
    assert.equal(queue.laneCount(), 1, "new project can evict while old project remains active");
    calls.find((call) => call.projectId === "project-old")!.complete(true);
    await queue.whenIdle("project-old");
    assert.equal(queue.laneCount(), 0);
  }

  const projectId = "project-bootstrap";
  const journal = parseEditorProjectRecoveryJournal({
    version: 1,
    projectId,
    baseRevision: 4,
    editedAt: "2026-07-15T10:00:00.000Z",
    draft: { script: "trusted local" },
  }, projectId);
  assert.ok(journal, "the queue verifier imports the trusted journal contract");
  assert.deepEqual(decideEditorProjectBootstrap({
    projectId,
    serverRevision: 4,
    revisionWatermark: 4,
    journal,
  }), { kind: "resume-local", journal },
  "a post-idle GET at the trusted base revision resumes the journal");
  assert.equal(decideEditorProjectBootstrap({
    projectId,
    serverRevision: 5,
    revisionWatermark: 5,
    journal,
  }).kind, "conflict", "a newer post-idle server revision requires explicit resolution");

  const projectSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
    "utf8",
  );
  const serverLoadStart = projectSource.indexOf("if (existingProjectId) {");
  const serverLoadEnd = projectSource.indexOf("const hasLocalDraft =", serverLoadStart);
  assert.ok(serverLoadStart >= 0 && serverLoadEnd > serverLoadStart);
  const serverLoadSource = projectSource.slice(serverLoadStart, serverLoadEnd);
  const idleIndex = serverLoadSource.indexOf("await editorProjectSaveQueue.whenIdle(existingProjectId)");
  const getIndex = serverLoadSource.indexOf("await fetch(", idleIndex);
  const journalIndex = serverLoadSource.indexOf("readEditorProjectRecoveryJournal", getIndex);
  const decisionIndex = serverLoadSource.indexOf("decideEditorProjectBootstrap", journalIndex);
  const applyIndex = serverLoadSource.indexOf("applyDraft(serverCandidate.draft as V2Draft)");
  assert.ok(
    idleIndex >= 0
      && getIndex > idleIndex
      && journalIndex > getIndex
      && decisionIndex > journalIndex
      && applyIndex > getIndex,
    "bootstrap waits before GET, validates recovery, then safely applies a chosen draft",
  );
  assert.doesNotMatch(projectSource, /resolveEditorProjectBootstrap/,
    "hook no longer calls the temporary async bootstrap adapter");
  assert.match(serverLoadSource, /revisionWatermark:\s*editorProjectSaveQueue\.revisionWatermark/);
  assert.match(serverLoadSource, /seedRevision\(project\.id\s+as\s+string,\s*project\.draftRevision\)/);

  const autosaveStart = projectSource.indexOf("// Persist draft (debounce 1s)");
  const autosaveEnd = projectSource.indexOf("// ข้อมูลอวตาร", autosaveStart);
  const autosaveSource = projectSource.slice(autosaveStart, autosaveEnd);
  assert.match(projectSource, /editorProjectSaveQueue/, "hook uses the shared coordinator");
  assert.match(projectSource, /draftRevision:\s*revision/, "PATCH sends the allocated revision");
  assert.match(projectSource, /signal,/, "PATCH receives the queue AbortSignal");
  assert.match(autosaveSource, /setTimeout\(\(\) => \{[\s\S]*(?:buildDraft\(\)|latestDraftRef\.current)/,
    "latest draft is captured after 1s");
  assert.match(autosaveSource, /saveRevision\]\);/, "manual retry re-enters the latest-draft debounce");
  assert.doesNotMatch(autosaveSource, /\bfetch\(/, "effect cannot launch unordered PATCH directly");

  console.log("editor-project-save-queue: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

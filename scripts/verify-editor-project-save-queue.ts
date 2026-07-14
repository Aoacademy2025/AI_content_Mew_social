// Run with: npx tsx scripts/verify-editor-project-save-queue.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as saveQueueModule from "../src/lib/editor-project-save-queue";

type SaveStatus = "saving" | "saved" | "error";
type SaveEvent = { projectId: string; revision: number; status: SaveStatus };
type SaveContext = { revision: number; signal: AbortSignal };
type SaveInput = {
  projectId: string;
  save: (context: SaveContext) => Promise<boolean>;
  isActive?: () => boolean;
  onStatus?: (event: SaveEvent) => void;
};
type Queue = {
  seedRevision(projectId: string, revision: number): void;
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
  complete(ok: boolean): void;
  fail(error: Error): void;
};

function controlledSave(calls: ControlledCall[], projectId: string, draft: string) {
  return ({ revision, signal }: SaveContext) => new Promise<boolean>((resolve, reject) => {
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

type BootstrapProject = {
  id: string;
  draftRevision: number;
  draft?: Record<string, unknown> | null;
};

type BootstrapOutcome =
  | { kind: "server"; project: BootstrapProject }
  | { kind: "local"; project: BootstrapProject; draft: Record<string, unknown> }
  | { kind: "error"; recoveryDraft: Record<string, unknown> | null }
  | { kind: "missing" };

type ResolveBootstrap = (input: {
  projectId: string;
  localDraft: unknown;
  localDirty: boolean;
  revisionWatermark: number;
  loadProject: () => Promise<{ status: number; project?: unknown }>;
}) => Promise<BootstrapOutcome>;

async function main(): Promise<void> {
  {
    const queue = createQueue();
    assert.equal(typeof queue.seedRevision, "function", "queue exposes a server revision seed");
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

  const bootstrapPath = "../src/lib/editor-project-bootstrap";
  const bootstrapModule = await import(bootstrapPath).catch(() => null) as {
    resolveEditorProjectBootstrap?: ResolveBootstrap;
    isEditorProjectRecoveryDraft?: (value: unknown) => boolean;
  } | null;
  assert.ok(bootstrapModule, "bootstrap resolver module exists");
  assert.equal(
    typeof bootstrapModule.resolveEditorProjectBootstrap,
    "function",
    "bootstrap resolver is exported",
  );
  const resolveBootstrap = bootstrapModule.resolveEditorProjectBootstrap!;
  const isRecoveryDraft = bootstrapModule.isEditorProjectRecoveryDraft!;
  assert.equal(isRecoveryDraft({ script: "local" }), true);
  for (const invalid of [null, undefined, {}, [], "corrupt", 7]) {
    assert.equal(isRecoveryDraft(invalid), false, "missing/corrupt/empty recovery is rejected");
  }

  for (const lateAFirst of [true, false]) {
    const projectId = lateAFirst ? "project-late-a-first" : "project-late-a-last";
    const clock = fakeTimeouts();
    const queue = createQueue({
      requestTimeoutMs: 10_000,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
    });
    let server = { revision: 0, script: "server-old" };
    const persist = (revision: number, script: string) => {
      if (server.revision >= revision) return false;
      server = { revision, script };
      return true;
    };
    let completeLateA: (() => void) | undefined;
    const revisionA = queue.enqueue({
      projectId,
      save: ({ revision }) => new Promise<boolean>((resolve) => {
        completeLateA = () => resolve(persist(revision, "timed-out-A"));
      }),
    });
    assert.equal(revisionA, 1);
    clock.runNext();
    await queue.whenIdle(projectId);
    assert.equal(queue.revisionWatermark(projectId), 1, "timed-out revision remains unconfirmed locally");

    const outcome = await resolveBootstrap({
      projectId,
      localDraft: { script: "user-new" },
      localDirty: false,
      revisionWatermark: queue.revisionWatermark(projectId),
      loadProject: async () => ({
        status: 200,
        project: { id: projectId, draftRevision: server.revision, draft: { script: server.script } },
      }),
    });
    assert.equal(outcome.kind, "local", "server revision zero cannot replace unconfirmed local revision one");

    if (lateAFirst) {
      completeLateA!();
      await nextTurn();
      assert.deepEqual(server, { revision: 1, script: "timed-out-A" });
    }
    const revisionB = queue.enqueue({
      projectId,
      save: async ({ revision }) => persist(
        revision,
        (outcome.kind === "local" ? outcome.draft.script : "wrong") as string,
      ),
    });
    assert.equal(revisionB, 2, "recovered local draft uses the next monotonic revision");
    await queue.whenIdle(projectId);
    if (!lateAFirst) {
      completeLateA!();
      await nextTurn();
    }
    assert.deepEqual(
      server,
      { revision: 2, script: "user-new" },
      `recovered local draft wins when late A finishes ${lateAFirst ? "before" : "after"} revision two`,
    );
    assert.equal(queue.revisionWatermark(projectId), 2);
  }

  for (const invalidLocal of [null, {}, [], "corrupt"]) {
    const outcome = await resolveBootstrap({
      projectId: "project-no-recovery",
      localDraft: invalidLocal,
      localDirty: false,
      revisionWatermark: 2,
      loadProject: async () => ({
        status: 200,
        project: { id: "project-no-recovery", draftRevision: 1, draft: { script: "old" } },
      }),
    });
    assert.deepEqual(outcome, { kind: "error", recoveryDraft: null });
  }

  for (const loadProject of [
    async () => { throw new Error("network"); },
    async () => ({ status: 503 }),
  ]) {
    const outcome = await resolveBootstrap({
      projectId: "project-load-error",
      localDraft: { script: "keep-local" },
      localDirty: false,
      revisionWatermark: 0,
      loadProject,
    });
    assert.deepEqual(outcome, { kind: "error", recoveryDraft: { script: "keep-local" } });
  }
  assert.deepEqual(
    await resolveBootstrap({
      projectId: "project-missing",
      localDraft: { script: "local" },
      localDirty: false,
      revisionWatermark: 0,
      loadProject: async () => ({ status: 404 }),
    }),
    { kind: "missing" },
  );
  const dirtyOutcome = await resolveBootstrap({
    projectId: "project-dirty",
    localDraft: { script: "edited-during-error" },
    localDirty: true,
    revisionWatermark: 1,
    loadProject: async () => ({
      status: 200,
      project: { id: "project-dirty", draftRevision: 5, draft: { script: "server" } },
    }),
  });
  assert.equal(dirtyOutcome.kind, "local", "edits made during bootstrap failure win on retry");
  const serverOutcome = await resolveBootstrap({
    projectId: "project-server-current",
    localDraft: { script: "old-local" },
    localDirty: false,
    revisionWatermark: 2,
    loadProject: async () => ({
      status: 200,
      project: { id: "project-server-current", draftRevision: 2, draft: { script: "server-current" } },
    }),
  });
  assert.equal(serverOutcome.kind, "server", "current server state is applied when no local edit is pending");

  const projectSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
    "utf8",
  );
  const serverLoadStart = projectSource.indexOf("if (existingProjectId) {");
  const serverLoadEnd = projectSource.indexOf("const hasLocalDraft =", serverLoadStart);
  assert.ok(serverLoadStart >= 0 && serverLoadEnd > serverLoadStart);
  const serverLoadSource = projectSource.slice(serverLoadStart, serverLoadEnd);
  const idleIndex = serverLoadSource.indexOf("await editorProjectSaveQueue.whenIdle(existingProjectId)");
  const getIndex = serverLoadSource.indexOf("fetch(`/api/editor-projects/");
  const applyIndex = serverLoadSource.indexOf("applyDraft(project.draft as V2Draft)");
  assert.ok(idleIndex >= 0 && getIndex > idleIndex && applyIndex > getIndex, "bootstrap waits before GET and apply");
  assert.match(serverLoadSource, /seedRevision\(project\.id,\s*project\.draftRevision\)/);

  const autosaveStart = projectSource.indexOf("// Persist draft (debounce 1s)");
  const autosaveEnd = projectSource.indexOf("// ข้อมูลอวตาร", autosaveStart);
  const autosaveSource = projectSource.slice(autosaveStart, autosaveEnd);
  assert.match(projectSource, /editorProjectSaveQueue/, "hook uses the shared coordinator");
  assert.match(projectSource, /draftRevision:\s*revision/, "PATCH sends the allocated revision");
  assert.match(projectSource, /signal,/, "PATCH receives the queue AbortSignal");
  assert.match(autosaveSource, /setTimeout\(\(\) => \{[\s\S]*buildDraft\(\)/, "latest draft is captured after 1s");
  assert.match(autosaveSource, /saveRevision\]\);/, "manual retry re-enters the latest-draft debounce");
  assert.doesNotMatch(autosaveSource, /\bfetch\(/, "effect cannot launch unordered PATCH directly");

  console.log("editor-project-save-queue: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

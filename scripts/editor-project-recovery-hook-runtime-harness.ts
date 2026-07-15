import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as bootstrapModule from "../src/lib/editor-project-bootstrap";
import * as journalModule from "../src/lib/editor-project-recovery-journal";
import * as logoOverlayModule from "../src/lib/logo-overlay";
import * as lineageModule from "../src/lib/editor-project-autosave-lineage";
import {
  createEditorProjectSaveQueue,
  type EditorProjectSaveInput,
} from "../src/lib/editor-project-save-queue";

type JsonRecord = Record<string, unknown>;
type FetchInit = { method?: string; body?: string; signal?: AbortSignal; [key: string]: unknown };
type FetchCall = { method: string; url: string; init: FetchInit };
type ResponseLike = { ok: boolean; status: number; json(): Promise<unknown> };

function response(status: number, payload: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class MemoryStorage implements journalModule.RecoveryStorage {
  readonly values = new Map<string, string>();
  readonly operations: Array<{ operation: "set" | "remove"; key: string }> = [];
  failRecoveryWrites = false;

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failRecoveryWrites && key.startsWith("editor-v2-recovery:")) throw new Error("quota");
    this.operations.push({ operation: "set", key });
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.operations.push({ operation: "remove", key });
    this.values.delete(key);
  }
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; task: () => void }>();

  setTimeout = (task: () => void, delay = 0): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delay, task });
    return id;
  };

  clearTimeout = (id: number): void => { this.tasks.delete(id); };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].task();
    }
    this.now = target;
  }
}

class SharedEditorServer {
  private readonly projects = new Map<string, JsonRecord>();

  setProject(projectId: string, draftRevision: number, draft: JsonRecord): void {
    this.projects.set(projectId, {
      id: projectId,
      draftRevision,
      draft: structuredClone(draft),
      status: "draft",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });
  }

  read(projectId: string): JsonRecord | null {
    const value = this.projects.get(projectId);
    return value ? structuredClone(value) : null;
  }

  patch(projectId: string, body: JsonRecord): ResponseLike {
    const current = this.projects.get(projectId);
    if (!current) return response(404, { error: "not_found" });
    const currentRevision = current.draftRevision as number;
    const revision = body.draftRevision;
    const hasExpected = Object.hasOwn(body, "expectedDraftRevision");
    const expected = body.expectedDraftRevision;
    const validRevision = typeof revision === "number"
      && Number.isSafeInteger(revision)
      && revision > currentRevision;
    const validCas = !hasExpected || (
      typeof expected === "number"
      && Number.isSafeInteger(expected)
      && expected === currentRevision
      && typeof revision === "number"
      && revision > expected
    );
    if (!validRevision || !validCas) {
      return response(409, { error: "stale_revision", project: structuredClone(current) });
    }
    this.setProject(projectId, revision, body.draft as JsonRecord);
    const saved = this.projects.get(projectId)!;
    if (typeof body.title === "string") saved.title = body.title;
    return response(200, { project: structuredClone(saved) });
  }
}

class FetchMock {
  readonly calls: FetchCall[] = [];
  private readonly routes = new Map<string, Array<() => Promise<ResponseLike>>>();
  private nextProject = 1;

  constructor(private readonly server?: SharedEditorServer) {}

  enqueue(method: string, url: string, result: ResponseLike | Promise<ResponseLike>): void {
    const key = `${method.toUpperCase()} ${url}`;
    const items = this.routes.get(key) ?? [];
    items.push(() => Promise.resolve(result));
    this.routes.set(key, items);
  }

  enqueueFailure(method: string, url: string, error: Error): void {
    const key = `${method.toUpperCase()} ${url}`;
    const items = this.routes.get(key) ?? [];
    items.push(() => Promise.reject(error));
    this.routes.set(key, items);
  }

  private honorAbort(result: Promise<ResponseLike>, signal?: AbortSignal): Promise<ResponseLike> {
    if (!signal) return result;
    if (signal.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return new Promise<ResponseLike>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void result.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  fetch = async (urlValue: unknown, initValue: unknown = {}): Promise<ResponseLike> => {
    const url = String(urlValue);
    const init = initValue as FetchInit;
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ method, url, init });
    const key = `${method} ${url}`;
    const queued = this.routes.get(key);
    const handler = queued?.shift();
    if (handler) return this.honorAbort(handler(), init.signal);
    if (url === "/api/user/video-settings") return this.honorAbort(Promise.resolve(response(200, {})), init.signal);
    if (url === "/api/videos/usage") return this.honorAbort(Promise.resolve(response(200, null)), init.signal);
    if (url === "/api/user/brand-assets") {
      return this.honorAbort(Promise.resolve(response(200, { defaultLogo: null })), init.signal);
    }
    if (url === "/api/editor-projects" && method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as JsonRecord;
      const id = `new-${this.nextProject++}`;
      this.server?.setProject(id, 0, body.draft as JsonRecord);
      return this.honorAbort(Promise.resolve(response(200, {
        project: { id, draftRevision: 0, draft: body.draft, status: "draft" },
      })), init.signal);
    }
    if (url.startsWith("/api/editor-projects/") && method === "GET" && this.server) {
      const id = decodeURIComponent(url.slice("/api/editor-projects/".length));
      const stored = this.server.read(id);
      return this.honorAbort(Promise.resolve(
        stored ? response(200, { project: stored }) : response(404, { error: "not_found" }),
      ), init.signal);
    }
    if (url.startsWith("/api/editor-projects/") && method === "PATCH") {
      const body = JSON.parse(init.body ?? "{}") as JsonRecord;
      const id = decodeURIComponent(url.slice("/api/editor-projects/".length));
      if (this.server) {
        return this.honorAbort(Promise.resolve(this.server.patch(id, body)), init.signal);
      }
      return this.honorAbort(Promise.resolve(response(200, {
        project: { id, draftRevision: body.draftRevision, draft: body.draft, status: "draft" },
      })), init.signal);
    }
    if (url.startsWith("/api/heygen/avatar-info")) {
      return this.honorAbort(Promise.resolve(response(404, null)), init.signal);
    }
    if (url === "/api/elevenlabs/voices") {
      return this.honorAbort(Promise.resolve(response(200, { voices: [] })), init.signal);
    }
    throw new Error(`unhandled fetch: ${key}`);
  };
}

class QueueMock {
  readonly enqueued: Array<{ projectId: string; revision: number }> = [];
  readonly seeded: Array<{ projectId: string; revision: number }> = [];
  reserveError: Error | null = null;

  private readonly queue: ReturnType<typeof createEditorProjectSaveQueue>;

  constructor(clock: FakeClock) {
    this.queue = createEditorProjectSaveQueue({
      scheduleTimeout: clock.setTimeout,
      cancelTimeout: clock.clearTimeout,
    });
  }

  seedRevision(projectId: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    this.seeded.push({ projectId, revision });
    this.queue.seedRevision(projectId, revision);
  }
  revisionWatermark(projectId: string): number { return this.queue.revisionWatermark(projectId); }
  reserveRevisionAbove(projectId: string, observed: number): number {
    if (this.reserveError) throw this.reserveError;
    this.seeded.push({ projectId, revision: observed });
    return this.queue.reserveRevisionAbove(projectId, observed);
  }
  enqueue(input: EditorProjectSaveInput): number {
    const revision = this.queue.enqueue(input);
    this.enqueued.push({ projectId: input.projectId, revision });
    return revision;
  }
  whenIdle(projectId: string): Promise<void> { return this.queue.whenIdle(projectId); }
}

type StateSlot = { kind: "state"; value: unknown; setter: (next: unknown) => void };
type RefSlot = { kind: "ref"; value: { current: unknown } };
type MemoSlot = { kind: "memo"; value: unknown; deps: readonly unknown[] | undefined };
type EffectSlot = {
  kind: "effect";
  deps: readonly unknown[] | undefined;
  create: () => void | (() => void);
  cleanup?: () => void;
};
type HookSlot = StateSlot | RefSlot | MemoSlot | EffectSlot;

function depsEqual(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  return !!left && !!right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

class HookRunner<T> {
  private readonly slots: HookSlot[] = [];
  private cursor = 0;
  private dirty = false;
  private mounted = false;
  private readonly pendingEffects = new Set<number>();
  current!: T;

  constructor(private readonly hook: () => T) {}

  readonly react = {
    useState: <V,>(initial: V | (() => V)): [V, (next: V | ((value: V) => V)) => void] => {
      const index = this.cursor++;
      let slot = this.slots[index] as StateSlot | undefined;
      if (!slot) {
        slot = {
          kind: "state",
          value: typeof initial === "function" ? (initial as () => V)() : initial,
          setter: (next: unknown) => {
            const previous = slot!.value as V;
            slot!.value = typeof next === "function" ? (next as (value: V) => V)(previous) : next;
            this.dirty = true;
          },
        };
        this.slots[index] = slot;
      }
      return [slot.value as V, slot.setter as (next: V | ((value: V) => V)) => void];
    },
    useRef: <V,>(initial: V): { current: V } => {
      const index = this.cursor++;
      let slot = this.slots[index] as RefSlot | undefined;
      if (!slot) {
        slot = { kind: "ref", value: { current: initial } };
        this.slots[index] = slot;
      }
      return slot.value as { current: V };
    },
    useCallback: <V,>(callback: V, deps: readonly unknown[]): V => {
      const index = this.cursor++;
      let slot = this.slots[index] as MemoSlot | undefined;
      if (!slot || !depsEqual(slot.deps, deps)) {
        slot = { kind: "memo", value: callback, deps: [...deps] };
        this.slots[index] = slot;
      }
      return slot.value as V;
    },
    useEffect: (create: () => void | (() => void), deps?: readonly unknown[]): void => {
      const index = this.cursor++;
      let slot = this.slots[index] as EffectSlot | undefined;
      if (!slot) {
        slot = { kind: "effect", deps: undefined, create };
        this.slots[index] = slot;
      }
      slot.create = create;
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? [...deps] : undefined;
        this.pendingEffects.add(index);
      }
    },
  };

  mount(strict = false): void {
    this.mounted = true;
    this.dirty = true;
    this.flush();
    if (strict) {
      const effects = this.slots.filter((slot): slot is EffectSlot => slot?.kind === "effect");
      for (const effect of effects) effect.cleanup?.();
      for (const effect of effects) effect.cleanup = effect.create() || undefined;
      this.flush();
    }
  }

  flush(): void {
    let guard = 0;
    while ((this.dirty || this.pendingEffects.size > 0) && guard++ < 100) {
      if (this.dirty) {
        this.dirty = false;
        this.cursor = 0;
        this.current = this.hook();
      }
      const effects = [...this.pendingEffects];
      this.pendingEffects.clear();
      for (const index of effects) {
        const effect = this.slots[index] as EffectSlot;
        effect.cleanup?.();
        effect.cleanup = effect.create() || undefined;
      }
    }
    assert.ok(guard < 100, "hook runner reached a stable render");
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const slot of this.slots) if (slot?.kind === "effect") slot.cleanup?.();
  }
}

type ProjectHook = {
  projectId: string | null;
  projectReady: boolean;
  projectStatus: string;
  script: string;
  setScript(next: string | ((value: string) => string)): void;
  clipUrl: string;
  setClipUrl(url: string): void;
  clipDurationSec: number;
  setClipDurationSec(value: number): void;
  brollSource: string;
  autoMixProviders: string[];
  mixPreset: string;
  setMixPreset(value: "free" | "recommended" | "full"): void;
  avatarId: string;
  voiceId: string;
  voiceEngine: string;
  geminiVoiceName: string;
  saveStatus: "idle" | "saving" | "saved" | "error";
  retryProjectSave(): void;
  resetProject(): Promise<void>;
  recovery: {
    status: string;
    local?: { draft: JsonRecord; revision: number | null };
    server?: { draft: JsonRecord; revision: number | null };
    resolving?: false | "local" | "server" | "refresh";
    requiresServerRefresh?: boolean;
    error?: string | null;
  };
  chooseLocalProjectDraft(): Promise<void>;
  chooseServerProjectDraft(): void;
  retryConflictServerRefresh(): Promise<void>;
};

type HarnessOptions = {
  search?: string;
  storage?: MemoryStorage;
  fetchMe?: Promise<JsonRecord | null>;
  server?: SharedEditorServer;
};

const hookSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Project.ts", "utf8");
function compileHook(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "useV2Project.ts",
  }).outputText;
}
let activeCompiledHook = compileHook(hookSource);

function createHarness(options: HarnessOptions = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const clock = new FakeClock();
  const fetchMock = new FetchMock(options.server);
  const queue = new QueueMock(clock);
  const windowMock = { localStorage: storage, location: { search: options.search ?? "" } };
  let runner!: HookRunner<ProjectHook>;
  const module = { exports: {} as Record<string, unknown> };
  const fakeReact: Record<string, unknown> = {};
  const requireMock = (specifier: string): unknown => {
    if (specifier === "react") return fakeReact;
    if (specifier === "@/lib/use-me") return { fetchMe: () => options.fetchMe ?? Promise.resolve({ role: "ADMIN" }) };
    if (specifier === "../_components/types") {
      return { DEFAULT_AUTO_MIX_PROVIDERS: ["video", "pexels-photo", "pixabay-photo"] };
    }
    if (specifier === "./mix-presets") {
      return {
        PRESET_PROVIDERS: {
          free: null,
          recommended: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
          full: ["kie-ai"],
        },
        presetBrollSource: (preset: string) => preset === "free" ? "stock" : "automix",
      };
    }
    if (specifier === "@/lib/editor-project-save-queue") return { editorProjectSaveQueue: queue };
    if (specifier === "@/lib/editor-project-bootstrap") return bootstrapModule;
    if (specifier === "@/lib/editor-project-recovery-journal") return journalModule;
    if (specifier === "@/lib/editor-project-autosave-lineage") return lineageModule;
    if (specifier === "@/lib/logo-overlay") return logoOverlayModule;
    throw new Error(`unhandled hook import: ${specifier}`);
  };
  const factory = new Function(
    "require", "module", "exports", "fetch", "window", "setTimeout", "clearTimeout",
    activeCompiledHook,
  );
  Object.assign(fakeReact, {
    useState: (...args: unknown[]) => runner.react.useState(args[0]),
    useRef: (...args: unknown[]) => runner.react.useRef(args[0]),
    useCallback: (...args: unknown[]) => runner.react.useCallback(args[0], args[1] as readonly unknown[]),
    useEffect: (...args: unknown[]) => runner.react.useEffect(
      args[0] as () => void | (() => void),
      args[1] as readonly unknown[] | undefined,
    ),
  });
  factory(
    requireMock,
    module,
    module.exports,
    fetchMock.fetch,
    windowMock,
    clock.setTimeout,
    clock.clearTimeout,
  );
  const useV2Project = module.exports.useV2Project as () => ProjectHook;
  runner = new HookRunner(useV2Project);
  return { runner, storage, fetchMock, queue, clock };
}

async function settle(runner: HookRunner<ProjectHook>, turns = 16): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
    runner.flush();
  }
}

function editorUrl(projectId: string): string {
  return `/api/editor-projects/${encodeURIComponent(projectId)}`;
}

function project(projectId: string, draftRevision: number, draft: JsonRecord): JsonRecord {
  return { id: projectId, draftRevision, draft, status: "draft", updatedAt: "2026-07-15T10:00:00.000Z" };
}

function patchBodies(fetchMock: FetchMock): JsonRecord[] {
  return fetchMock.calls
    .filter((call) => call.method === "PATCH")
    .map((call) => JSON.parse(call.init.body ?? "{}") as JsonRecord);
}

function autosavePatchCalls(fetchMock: FetchMock, projectId: string): FetchCall[] {
  return fetchMock.calls.filter(
    (call) => call.method === "PATCH" && call.url === editorUrl(projectId),
  );
}

function assertCasAutosaves(fetchMock: FetchMock, projectId: string): void {
  const bodies = autosavePatchCalls(fetchMock, projectId)
    .map((call) => JSON.parse(call.init.body ?? "{}") as JsonRecord);
  assert.ok(bodies.length > 0, `${projectId} sends at least one autosave PATCH`);
  for (const body of bodies) {
    assert.equal(Number.isSafeInteger(body.expectedDraftRevision), true,
      "every Editor v2 autosave carries an integer expectedDraftRevision");
    assert.equal(Number.isSafeInteger(body.draftRevision), true,
      "every Editor v2 autosave carries an integer draftRevision");
    assert.ok((body.draftRevision as number) > (body.expectedDraftRevision as number),
      "every Editor v2 autosave advances above its observed base");
  }
}

async function twoIndependentClientsCannotOverwrite(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("shared-cas", 0, { script: "base" });
  const clientA = createHarness({ search: "?projectId=shared-cas", server });
  const clientB = createHarness({ search: "?projectId=shared-cas", server });
  clientA.runner.mount();
  clientB.runner.mount();
  await settle(clientA.runner);
  await settle(clientB.runner);

  clientA.runner.current.setScript("client A wins");
  clientA.runner.flush();
  clientA.clock.advance(1_000);
  await settle(clientA.runner);
  assert.equal((server.read("shared-cas")?.draft as JsonRecord).script, "client A wins");

  clientB.runner.current.setScript("client B loses");
  clientB.runner.flush();
  clientB.clock.advance(1_000);
  await settle(clientB.runner);
  const localAtConflict = clientB.runner.current.recovery.local;
  assert.deepEqual({
    status: clientB.runner.current.recovery.status,
    projectReady: clientB.runner.current.projectReady,
    local: localAtConflict?.draft.script,
    server: clientB.runner.current.recovery.server?.draft.script,
  }, {
    status: "conflict",
    projectReady: false,
    local: "client B loses",
    server: "client A wins",
  }, "the stale tab blocks with immutable latest-local B and observed server A");
  assert.equal(Object.isFrozen(localAtConflict), true);
  assert.equal(Object.isFrozen(localAtConflict?.draft), true);

  clientB.runner.current.setScript("client B must remain blocked");
  clientB.runner.flush();
  clientB.clock.advance(1_000);
  await settle(clientB.runner);
  assert.equal(autosavePatchCalls(clientB.fetchMock, "shared-cas").length, 1,
    "Retry/next edit cannot send an advancing PATCH while the lineage is blocked");
  assert.equal((server.read("shared-cas")?.draft as JsonRecord).script, "client A wins");
  assertCasAutosaves(clientA.fetchMock, "shared-cas");
  assertCasAutosaves(clientB.fetchMock, "shared-cas");
}

async function timeoutCommittedIsAcknowledgedByFingerprint(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("timeout-committed", 0, { script: "base" });
  const harness = createHarness({ search: "?projectId=timeout-committed", server });
  const lostResponse = deferred<ResponseLike>();
  harness.fetchMock.enqueue("PATCH", editorUrl("timeout-committed"), lostResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("committed despite timeout");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  const attempt = patchBodies(harness.fetchMock)[0];
  server.setProject("timeout-committed", attempt.draftRevision as number, attempt.draft as JsonRecord);
  harness.clock.advance(10_000);
  await settle(harness.runner, 64);
  assert.deepEqual({
    status: harness.runner.current.saveStatus,
    recovery: harness.runner.current.recovery.status,
    patchCount: autosavePatchCalls(harness.fetchMock, "timeout-committed").length,
  }, { status: "saved", recovery: "none", patchCount: 1 },
  "authoritative GET recognizes a committed timeout only by revision and fingerprint");
  assertCasAutosaves(harness.fetchMock, "timeout-committed");
}

async function timeoutNotCommittedRetriesSameImmutableAttempt(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("timeout-retry", 0, { script: "base" });
  const harness = createHarness({ search: "?projectId=timeout-retry", server });
  const lostResponse = deferred<ResponseLike>();
  harness.fetchMock.enqueue("PATCH", editorUrl("timeout-retry"), lostResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("retry immutable");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  harness.clock.advance(10_000);
  await settle(harness.runner, 64);
  const bodies = patchBodies(harness.fetchMock);
  assert.equal(bodies.length, 2, "unchanged confirmed base permits exactly one CAS retry");
  assert.deepEqual(bodies[1], bodies[0], "the retry reuses the exact immutable attempt body");
  assert.equal((server.read("timeout-retry")?.draft as JsonRecord).script, "retry immutable");
  assert.equal(harness.runner.current.saveStatus, "saved");
  assertCasAutosaves(harness.fetchMock, "timeout-retry");
}

async function sameNumericRevisionWithDifferentDraftConflicts(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("numeric-collision", 0, { script: "base" });
  const harness = createHarness({ search: "?projectId=numeric-collision", server });
  const lostResponse = deferred<ResponseLike>();
  harness.fetchMock.enqueue("PATCH", editorUrl("numeric-collision"), lostResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("our revision one");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  server.setProject("numeric-collision", 1, { script: "other tab revision one" });
  harness.clock.advance(10_000);
  await settle(harness.runner);
  assert.deepEqual({
    status: harness.runner.current.recovery.status,
    local: harness.runner.current.recovery.local?.draft.script,
    server: harness.runner.current.recovery.server?.draft.script,
    patches: autosavePatchCalls(harness.fetchMock, "numeric-collision").length,
  }, {
    status: "conflict",
    local: "our revision one",
    server: "other tab revision one",
    patches: 1,
  }, "equal revision without equal fingerprint blocks instead of rebasing");
}

async function suppressedIntermediateAcknowledgementAdvancesBase(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("coalesced-base", 0, { script: "base" });
  const firstResponse = deferred<ResponseLike>();
  const harness = createHarness({ search: "?projectId=coalesced-base", server });
  harness.fetchMock.enqueue("PATCH", editorUrl("coalesced-base"), firstResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("intermediate A");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  harness.runner.current.setScript("coalesced B");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  const firstBody = patchBodies(harness.fetchMock)[0];
  server.setProject("coalesced-base", 1, firstBody.draft as JsonRecord);
  firstResponse.resolve(response(200, {
    project: project("coalesced-base", 1, firstBody.draft as JsonRecord),
  }));
  await settle(harness.runner, 64);
  const bodies = patchBodies(harness.fetchMock);
  assert.equal(bodies.length, 2, "coalesced B starts after A acknowledgement");
  assert.equal(bodies[1].expectedDraftRevision, 1,
    "A acknowledgement updates confirmed base even when A's visible saved status is suppressed");
  assert.equal((bodies[1].draft as JsonRecord).script, "coalesced B");
}

async function pendingDraftWaitsForReconciliationAndBecomesLatestConflict(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("pending-reconcile", 0, { script: "base" });
  const lostResponse = deferred<ResponseLike>();
  const authoritativeGet = deferred<ResponseLike>();
  const harness = createHarness({ search: "?projectId=pending-reconcile", server });
  harness.fetchMock.enqueue("PATCH", editorUrl("pending-reconcile"), lostResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.fetchMock.enqueue("GET", editorUrl("pending-reconcile"), authoritativeGet.promise);
  harness.runner.current.setScript("older in flight A");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  harness.runner.current.setScript("latest pending B");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  harness.clock.advance(10_000);
  await settle(harness.runner);
  assert.equal(autosavePatchCalls(harness.fetchMock, "pending-reconcile").length, 1,
    "pending B sends zero PATCH calls while A reconciliation is unresolved");
  authoritativeGet.resolve(response(200, {
    project: project("pending-reconcile", 1, { script: "another tab" }),
  }));
  await settle(harness.runner);
  assert.deepEqual({
    local: harness.runner.current.recovery.local?.draft.script,
    server: harness.runner.current.recovery.server?.draft.script,
    patches: autosavePatchCalls(harness.fetchMock, "pending-reconcile").length,
  }, { local: "latest pending B", server: "another tab", patches: 1 },
  "an older reconciliation surfaces the newest explicit local snapshot and drops pending B");
}

async function resetAndUnmountIgnoreLateAutosaveObservation(): Promise<void> {
  for (const boundary of ["reset", "unmount"] as const) {
    const projectId = `late-${boundary}`;
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, { script: "base" });
    const lostResponse = deferred<ResponseLike>();
    const authoritativeGet = deferred<ResponseLike>();
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    harness.fetchMock.enqueue("PATCH", editorUrl(projectId), lostResponse.promise);
    harness.runner.mount();
    await settle(harness.runner);
    harness.fetchMock.enqueue("GET", editorUrl(projectId), authoritativeGet.promise);
    harness.runner.current.setScript("old project edit");
    harness.runner.flush();
    harness.clock.advance(1_000);
    await settle(harness.runner);
    harness.clock.advance(10_000);
    await settle(harness.runner);
    assert.equal(
      harness.fetchMock.calls.filter((call) => call.method === "GET" && call.url === editorUrl(projectId)).length,
      2,
      `${boundary} case reaches authoritative reconciliation GET`,
    );
    if (boundary === "reset") {
      await harness.runner.current.resetProject();
      await settle(harness.runner);
    } else {
      harness.runner.unmount();
    }
    const snapshot = {
      projectId: harness.runner.current.projectId,
      recovery: harness.runner.current.recovery.status,
      patchCount: autosavePatchCalls(harness.fetchMock, projectId).length,
    };
    authoritativeGet.resolve(response(200, {
      project: project(projectId, 1, { script: "late server" }),
    }));
    await settle(harness.runner);
    assert.deepEqual({
      projectId: harness.runner.current.projectId,
      recovery: harness.runner.current.recovery.status,
      patchCount: autosavePatchCalls(harness.fetchMock, projectId).length,
    }, snapshot, `${boundary} invalidates late PATCH/GET callbacks and prevents a retry`);
  }
}

async function resetAndUnmountIgnoreLatePatchResponse(): Promise<void> {
  for (const boundary of ["reset", "unmount"] as const) {
    const projectId = `late-patch-${boundary}`;
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, { script: "base" });
    const patchResponse = deferred<ResponseLike>();
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    harness.fetchMock.enqueue("PATCH", editorUrl(projectId), patchResponse.promise);
    harness.runner.mount();
    await settle(harness.runner);
    harness.runner.current.setScript("old project in flight");
    harness.runner.flush();
    harness.clock.advance(1_000);
    await settle(harness.runner);
    const body = patchBodies(harness.fetchMock)[0];
    if (boundary === "reset") {
      await harness.runner.current.resetProject();
      await settle(harness.runner);
    } else {
      harness.runner.unmount();
    }
    const snapshot = {
      projectId: harness.runner.current.projectId,
      projectReady: harness.runner.current.projectReady,
      recovery: harness.runner.current.recovery.status,
      saveStatus: harness.runner.current.saveStatus,
    };
    patchResponse.resolve(response(200, {
      project: project(projectId, body.draftRevision as number, body.draft as JsonRecord),
    }));
    await settle(harness.runner, 64);
    assert.deepEqual({
      projectId: harness.runner.current.projectId,
      projectReady: harness.runner.current.projectReady,
      recovery: harness.runner.current.recovery.status,
      saveStatus: harness.runner.current.saveStatus,
    }, snapshot, `${boundary} ignores an old project's late PATCH acknowledgement`);
  }
}

async function secondAmbiguityLocksUntilGetOnlyRefresh(): Promise<void> {
  const server = new SharedEditorServer();
  server.setProject("second-ambiguity", 0, { script: "base" });
  const firstResponse = deferred<ResponseLike>();
  const harness = createHarness({ search: "?projectId=second-ambiguity", server });
  harness.fetchMock.enqueue("PATCH", editorUrl("second-ambiguity"), firstResponse.promise);
  harness.fetchMock.enqueueFailure("PATCH", editorUrl("second-ambiguity"), new Error("retry response lost"));
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("local uncertain");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  harness.clock.advance(10_000);
  await settle(harness.runner);
  assert.deepEqual({
    status: harness.runner.current.recovery.status,
    resolving: harness.runner.current.recovery.resolving,
    requiresServerRefresh: harness.runner.current.recovery.requiresServerRefresh,
    local: harness.runner.current.recovery.local?.draft.script,
  }, {
    status: "conflict",
    resolving: false,
    requiresServerRefresh: true,
    local: "local uncertain",
  }, "a second ambiguity becomes a retryable GET-only locked conflict");
  const patchCount = patchBodies(harness.fetchMock).length;
  server.setProject("second-ambiguity", 2, { script: "latest server" });
  await harness.runner.current.retryConflictServerRefresh();
  await settle(harness.runner);
  assert.equal(patchBodies(harness.fetchMock).length, patchCount,
    "conflict refresh performs GET only");
  assert.equal(harness.runner.current.recovery.server?.draft.script, "latest server");
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, false);
}

async function settingsAfterServerHydration(): Promise<void> {
  const settings = deferred<ResponseLike>();
  const me = deferred<JsonRecord | null>();
  const harness = createHarness({ search: "?projectId=settings-a", fetchMe: me.promise });
  harness.fetchMock.enqueue("GET", editorUrl("settings-a"), response(200, { project: project("settings-a", 5, {
    script: "server",
    avatarId: "server-avatar",
    voiceId: "server-voice",
    voiceEngine: "gemini",
    geminiVoiceName: "Server Voice",
    mixPreset: "full",
    brollSource: "automix",
    autoMixProviders: ["kie-ai"],
  }) }));
  harness.fetchMock.enqueue("GET", "/api/user/video-settings", settings.promise);
  harness.runner.mount();
  await settle(harness.runner);
  assert.equal(harness.runner.current.script, "server");
  settings.resolve(response(200, {
    heygenAvatarId: "late-avatar",
    elevenlabsVoiceId: "late-voice",
    ttsProvider: "elevenlabs",
    geminiVoiceName: "Late Voice",
  }));
  me.resolve({ role: "USER", plan: "FREE", kiePaidUnlocked: false, managedKieOn: true });
  await settle(harness.runner);
  assert.deepEqual({
    avatarId: harness.runner.current.avatarId,
    voiceId: harness.runner.current.voiceId,
    voiceEngine: harness.runner.current.voiceEngine,
    geminiVoiceName: harness.runner.current.geminiVoiceName,
    mixPreset: harness.runner.current.mixPreset,
    brollSource: harness.runner.current.brollSource,
    providers: harness.runner.current.autoMixProviders,
  }, {
    avatarId: "server-avatar",
    voiceId: "server-voice",
    voiceEngine: "gemini",
    geminiVoiceName: "Server Voice",
    mixPreset: "full",
    brollSource: "automix",
    providers: ["kie-ai"],
  }, "late account initialization cannot overwrite the chosen server draft");
}

async function exactEqualRevisionResume(): Promise<void> {
  const settings = deferred<ResponseLike>();
  const me = deferred<JsonRecord | null>();
  const harness = createHarness({ search: "?projectId=resume-a", fetchMe: me.promise });
  const localDraft = { script: "trusted local", voiceId: "local-voice" };
  journalModule.writeEditorProjectRecoveryJournal(harness.storage, {
    version: 1,
    projectId: "resume-a",
    baseRevision: 4,
    editedAt: "2026-07-15T10:01:00.000Z",
    draft: localDraft,
  });
  harness.fetchMock.enqueue("GET", editorUrl("resume-a"), response(200, {
    project: project("resume-a", 4, { script: "server" }),
  }));
  harness.fetchMock.enqueue("GET", "/api/user/video-settings", settings.promise);
  harness.runner.mount();
  await settle(harness.runner);
  settings.resolve(response(200, { elevenlabsVoiceId: "late-voice", ttsProvider: "elevenlabs" }));
  me.resolve({ role: "USER", plan: "FREE", kiePaidUnlocked: false });
  await settle(harness.runner);
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.deepEqual(patchBodies(harness.fetchMock)[0]?.draft, localDraft,
    "equal-revision resume PATCH sends the exact immutable local candidate");
}

async function resetDuringProjectGet(): Promise<void> {
  const getA = deferred<ResponseLike>();
  const brand = deferred<ResponseLike>();
  const harness = createHarness({ search: "?projectId=project-a" });
  harness.fetchMock.enqueue("GET", editorUrl("project-a"), getA.promise);
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", brand.promise);
  harness.fetchMock.enqueue("POST", "/api/editor-projects", response(200, {
    project: project("project-b", 0, { script: "" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  const reset = harness.runner.current.resetProject();
  getA.resolve(response(200, { project: project("project-a", 8, { script: "OLD-A-APPLIED" }) }));
  await settle(harness.runner);
  assert.notEqual(harness.runner.current.script, "OLD-A-APPLIED",
    "reset invalidates the old GET before its result can mutate state");
  brand.resolve(response(200, { defaultLogo: null }));
  await reset;
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectId, "project-b");
}

async function unmountWhileResetAwaitsBrandAssets(): Promise<void> {
  const brand = deferred<ResponseLike>();
  const harness = createHarness({ search: "?projectId=reset-brand-a" });
  harness.fetchMock.enqueue("GET", editorUrl("reset-brand-a"), response(200, {
    project: project("reset-brand-a", 3, { script: "server A" }),
  }));
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", brand.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.storage.operations.length = 0;
  const reset = harness.runner.current.resetProject();
  harness.runner.unmount();
  brand.resolve(response(200, { defaultLogo: null }));
  await reset;
  await settle(harness.runner);
  assert.equal(
    harness.fetchMock.calls.filter((call) => call.method === "POST").length,
    0,
    "unmount while reset awaits brand assets prevents a late project POST",
  );
  assert.deepEqual(
    harness.storage.operations,
    [],
    "unmount while reset awaits brand assets prevents late storage mutation",
  );
}

async function unmountWhileResetPostIsPending(): Promise<void> {
  const post = deferred<ResponseLike>();
  const harness = createHarness({ search: "?projectId=reset-post-a" });
  harness.fetchMock.enqueue("GET", editorUrl("reset-post-a"), response(200, {
    project: project("reset-post-a", 6, { script: "server A" }),
  }));
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", response(200, { defaultLogo: null }));
  harness.fetchMock.enqueue("POST", "/api/editor-projects", post.promise);
  harness.runner.mount();
  await settle(harness.runner);
  const reset = harness.runner.current.resetProject();
  await settle(harness.runner);
  const postCall = harness.fetchMock.calls.find((call) => call.method === "POST");
  assert.ok(postCall, "reset reaches its project POST before unmount");
  const signal = postCall.init.signal;
  assert.ok(signal, "reset POST carries an AbortSignal");
  const stateAfterUnmount = {
    projectId: harness.runner.current.projectId,
    projectReady: harness.runner.current.projectReady,
    script: harness.runner.current.script,
    projectStatus: harness.runner.current.projectStatus,
  };
  const seededBeforeLateResponse = harness.queue.seeded.length;
  const storageOperationsBeforeLateResponse = harness.storage.operations.length;
  harness.runner.unmount();
  const abortedOnUnmount = signal.aborted;
  let resetSettledBeforeLateResponse = false;
  void reset.then(() => { resetSettledBeforeLateResponse = true; });
  await settle(harness.runner);
  post.resolve(response(200, {
    project: project("reset-post-b", 0, { script: "late POST response" }),
  }));
  await reset;
  await settle(harness.runner);
  assert.deepEqual({
    abortedOnUnmount,
    resetSettledBeforeLateResponse,
    queueSeedDelta: harness.queue.seeded.length - seededBeforeLateResponse,
    storageOperationDelta: harness.storage.operations.length - storageOperationsBeforeLateResponse,
    state: {
      projectId: harness.runner.current.projectId,
      projectReady: harness.runner.current.projectReady,
      script: harness.runner.current.script,
      projectStatus: harness.runner.current.projectStatus,
    },
  }, {
    abortedOnUnmount: true,
    resetSettledBeforeLateResponse: true,
    queueSeedDelta: 0,
    storageOperationDelta: 0,
    state: stateAfterUnmount,
  }, "unmount aborts a pending reset POST and ignores its late response");
}

async function publicSetterRuntimeContract(): Promise<void> {
  const harness = createHarness({ search: "?projectId=setters-a" });
  harness.fetchMock.enqueue("GET", editorUrl("setters-a"), response(200, {
    project: project("setters-a", 2, { script: "base", clipUrl: "clip", clipDurationSec: 12 }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  const scriptSetter = harness.runner.current.setScript;
  scriptSetter((value) => `${value}-functional`);
  harness.runner.flush();
  assert.equal(harness.runner.current.script, "base-functional");
  assert.equal(harness.runner.current.setScript, scriptSetter, "public functional setter identity is stable");
  harness.runner.current.setClipUrl("");
  harness.runner.flush();
  assert.equal(harness.runner.current.clipDurationSec, 0, "clip URL clear couples raw duration reset");
  harness.runner.current.setMixPreset("recommended");
  harness.runner.flush();
  assert.equal(harness.runner.current.mixPreset, "recommended");
  assert.equal(harness.runner.current.brollSource, "automix");
  assert.deepEqual(harness.runner.current.autoMixProviders, ["video", "pexels-photo", "pixabay-photo", "kie-ai"]);
}

async function failedJournalWriteStillAutosaves(): Promise<void> {
  const harness = createHarness({ search: "?projectId=journal-a" });
  harness.fetchMock.enqueue("GET", editorUrl("journal-a"), response(200, {
    project: project("journal-a", 3, { script: "server" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  harness.storage.setItem(journalModule.editorProjectRecoveryKey("journal-a"), JSON.stringify({
    version: 1,
    projectId: "journal-a",
    baseRevision: 2,
    editedAt: "2026-07-15T09:00:00.000Z",
    draft: { script: "cached A" },
  }));
  harness.storage.failRecoveryWrites = true;
  harness.runner.current.setScript("in-memory B");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.equal(harness.storage.getItem(journalModule.editorProjectRecoveryKey("journal-a")), null);
  assert.equal(patchBodies(harness.fetchMock).length, 1, "journal storage failure does not suppress normal autosave");
}

async function projectScopedSwitching(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem(journalModule.editorProjectRecoveryKey("switch-a"), JSON.stringify({
    version: 1,
    projectId: "switch-a",
    baseRevision: 1,
    editedAt: "2026-07-15T09:00:00.000Z",
    draft: { script: "A" },
  }));
  const harness = createHarness({ search: "?projectId=switch-b", storage });
  harness.fetchMock.enqueue("GET", editorUrl("switch-b"), response(200, {
    project: project("switch-b", 7, { script: "B" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  harness.fetchMock.enqueueFailure("PATCH", editorUrl("switch-b"), new Error("keep journal pending"));
  harness.runner.current.setScript("B edited");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.ok(storage.getItem(journalModule.editorProjectRecoveryKey("switch-a")), "switching preserves A journal");
  const journalB = journalModule.readEditorProjectRecoveryJournal(storage, "switch-b");
  assert.equal(journalB?.projectId, "switch-b", "B writes only its project-scoped journal");
  assert.equal(journalB?.baseRevision, 7, "B journal records B's confirmed server revision");
  assert.equal(journalB?.draft.script, "B edited");
}

async function strictModeDoesNotDuplicateWrites(): Promise<void> {
  const harness = createHarness();
  harness.runner.mount(true);
  await settle(harness.runner);
  assert.equal(harness.fetchMock.calls.filter((call) => call.method === "POST").length, 1,
    "StrictMode setup/cleanup creates one project");
  harness.runner.current.setScript("strict edit");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.equal(patchBodies(harness.fetchMock).length, 1, "StrictMode setup/cleanup sends one autosave PATCH");
}

async function ambiguousLocalChoiceRefreshesServer(): Promise<void> {
  const harness = createHarness({ search: "?projectId=conflict-a" });
  journalModule.writeEditorProjectRecoveryJournal(harness.storage, {
    version: 1,
    projectId: "conflict-a",
    baseRevision: 4,
    editedAt: "2026-07-15T09:00:00.000Z",
    draft: { script: "local choice" },
  });
  harness.fetchMock.enqueue("GET", editorUrl("conflict-a"), response(200, {
    project: project("conflict-a", 5, { script: "server five" }),
  }));
  harness.fetchMock.enqueueFailure("PATCH", editorUrl("conflict-a"), new Error("response dropped after commit"));
  harness.fetchMock.enqueue("GET", editorUrl("conflict-a"), response(200, {
    project: project("conflict-a", 6, { script: "local choice" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  const immutableLocal = harness.runner.current.recovery.local;
  await harness.runner.current.chooseLocalProjectDraft();
  await settle(harness.runner);
  assert.equal(harness.fetchMock.calls.filter((call) => call.method === "GET" && call.url === editorUrl("conflict-a")).length, 2,
    "ambiguous PATCH failure performs a fresh GET before enabling choices");
  assert.equal(harness.runner.current.recovery.local, immutableLocal, "refresh preserves immutable local candidate identity");
  assert.equal(harness.runner.current.recovery.server?.revision, 6);
  assert.equal(harness.runner.current.recovery.resolving, false);
  const patchCount = patchBodies(harness.fetchMock).length;
  harness.runner.current.chooseServerProjectDraft();
  harness.runner.flush();
  assert.equal(patchBodies(harness.fetchMock).length, patchCount, "server choice remains PATCH-free after refresh");
}

async function malformedConflictResponsesRefreshAuthoritatively(): Promise<void> {
  const variants: Array<{ name: string; project: JsonRecord }> = [
    {
      name: "missing draftRevision",
      project: { id: "conflict-malformed", draft: { script: "ambiguous missing revision" } },
    },
    {
      name: "wrong project ID",
      project: project("wrong-project", 3, { script: "wrong project" }),
    },
    {
      name: "invalid draftRevision",
      project: { id: "conflict-malformed", draftRevision: "3", draft: { script: "ambiguous invalid revision" } },
    },
    {
      name: "negative draftRevision",
      project: project("conflict-malformed", -1, { script: "ambiguous negative revision" }),
    },
  ];
  const failures: string[] = [];
  for (const variant of variants) {
    const harness = createHarness({ search: "?projectId=conflict-malformed" });
    try {
      journalModule.writeEditorProjectRecoveryJournal(harness.storage, {
        version: 1,
        projectId: "conflict-malformed",
        baseRevision: 1,
        editedAt: "2026-07-15T09:00:00.000Z",
        draft: { script: "local" },
      });
      harness.fetchMock.enqueue("GET", editorUrl("conflict-malformed"), response(200, {
        project: project("conflict-malformed", 2, { script: "server two" }),
      }));
      harness.fetchMock.enqueue("PATCH", editorUrl("conflict-malformed"), response(409, {
        project: variant.project,
      }));
      harness.fetchMock.enqueue("GET", editorUrl("conflict-malformed"), response(200, {
        project: project("conflict-malformed", 3, { script: "authoritative three" }),
      }));
      harness.runner.mount();
      await settle(harness.runner);
      const immutableLocal = harness.runner.current.recovery.local;
      await harness.runner.current.chooseLocalProjectDraft();
      await settle(harness.runner);
      assert.equal(
        harness.fetchMock.calls.filter(
          (call) => call.method === "GET" && call.url === editorUrl("conflict-malformed"),
        ).length,
        2,
        "malformed 409 triggers an authoritative GET",
      );
      assert.equal(harness.runner.current.recovery.local, immutableLocal);
      assert.equal(harness.runner.current.recovery.server?.revision, 3);
      assert.equal(harness.runner.current.recovery.resolving, false);
    } catch (error) {
      failures.push(`${variant.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      harness.runner.unmount();
    }
  }
  assert.deepEqual(failures, [], `malformed 409 validation failures:\n${failures.join("\n")}`);
}

async function failedAmbiguousRefreshStaysLocked(): Promise<void> {
  const harness = createHarness({ search: "?projectId=conflict-locked" });
  journalModule.writeEditorProjectRecoveryJournal(harness.storage, {
    version: 1,
    projectId: "conflict-locked",
    baseRevision: 1,
    editedAt: "2026-07-15T09:00:00.000Z",
    draft: { script: "local" },
  });
  harness.fetchMock.enqueue("GET", editorUrl("conflict-locked"), response(200, {
    project: project("conflict-locked", 2, { script: "server" }),
  }));
  harness.fetchMock.enqueueFailure("PATCH", editorUrl("conflict-locked"), new Error("ambiguous"));
  harness.fetchMock.enqueueFailure("GET", editorUrl("conflict-locked"), new Error("refresh unavailable"));
  harness.runner.mount();
  await settle(harness.runner);
  const immutableLocal = harness.runner.current.recovery.local;
  await harness.runner.current.chooseLocalProjectDraft();
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.local, immutableLocal);
  assert.equal(harness.runner.current.recovery.resolving, false,
    "failed refresh returns control to a retryable locked conflict");
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, true);
  assert.ok(harness.runner.current.recovery.error);
  const patchCount = patchBodies(harness.fetchMock).length;
  harness.runner.current.chooseServerProjectDraft();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.status, "conflict");
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.equal(patchBodies(harness.fetchMock).length, patchCount,
    "locked refresh failure cannot choose or write the stale server candidate");
}

async function revisionExhaustionRestoresConflict(): Promise<void> {
  const harness = createHarness({ search: "?projectId=conflict-revision" });
  journalModule.writeEditorProjectRecoveryJournal(harness.storage, {
    version: 1,
    projectId: "conflict-revision",
    baseRevision: 1,
    editedAt: "2026-07-15T09:00:00.000Z",
    draft: { script: "local" },
  });
  harness.fetchMock.enqueue("GET", editorUrl("conflict-revision"), response(200, {
    project: project("conflict-revision", 2, { script: "server" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  const immutableLocal = harness.runner.current.recovery.local;
  const immutableServer = harness.runner.current.recovery.server;
  harness.queue.reserveError = new Error("draft revision exhausted");
  await harness.runner.current.chooseLocalProjectDraft();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.local, immutableLocal);
  assert.equal(harness.runner.current.recovery.server, immutableServer);
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.ok(harness.runner.current.recovery.error, "revision exhaustion returns a retryable immutable conflict");
}

export async function verifyRuntimeHookContract(): Promise<void> {
  activeCompiledHook = compileHook(hookSource);
  const cases: Array<[string, () => Promise<void>]> = [
    ["two-independent-clients", twoIndependentClientsCannotOverwrite],
    ["timeout-committed", timeoutCommittedIsAcknowledgedByFingerprint],
    ["timeout-not-committed", timeoutNotCommittedRetriesSameImmutableAttempt],
    ["same-revision-different-draft", sameNumericRevisionWithDifferentDraftConflicts],
    ["coalesced-confirmed-base", suppressedIntermediateAcknowledgementAdvancesBase],
    ["pending-waits-for-reconcile", pendingDraftWaitsForReconciliationAndBecomesLatestConflict],
    ["late-lifecycle-callbacks", resetAndUnmountIgnoreLateAutosaveObservation],
    ["late-patch-callbacks", resetAndUnmountIgnoreLatePatchResponse],
    ["second-ambiguity-refresh", secondAmbiguityLocksUntilGetOnlyRefresh],
    ["settings-after-GET", settingsAfterServerHydration],
    ["equal-revision-resume", exactEqualRevisionResume],
    ["reset-during-GET", resetDuringProjectGet],
    ["reset-unmount-during-brand", unmountWhileResetAwaitsBrandAssets],
    ["reset-unmount-during-POST", unmountWhileResetPostIsPending],
    ["functional-public-setters", publicSetterRuntimeContract],
    ["journal-write-failure", failedJournalWriteStillAutosaves],
    ["project-switching", projectScopedSwitching],
    ["StrictMode-setup-cleanup", strictModeDoesNotDuplicateWrites],
    ["ambiguous-local-choice", ambiguousLocalChoiceRefreshesServer],
    ["malformed-409-refresh", malformedConflictResponsesRefreshAuthoritatively],
    ["ambiguous-refresh-failure", failedAmbiguousRefreshStaysLocked],
    ["revision-exhaustion", revisionExhaustionRestoresConflict],
  ];
  const failures: string[] = [];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], `runtime hook contract failures:\n${failures.join("\n")}`);
}

export async function verifyRuntimeHookMutationSensitivity(): Promise<void> {
  const missingExistingGuard = hookSource.replace(
    "if (existingProjectId) {\n        accountDraftDefaultsAllowedRef.current = false;",
    "if (existingProjectId) {",
  );
  assert.notEqual(missingExistingGuard, hookSource, "late-settings runtime mutation applied");
  activeCompiledHook = compileHook(missingExistingGuard);
  await assert.rejects(
    settingsAfterServerHydration,
    /late account initialization cannot overwrite/,
    "runtime harness rejects removal of the existing-project settings guard",
  );

  const rebuiltResume = hookSource.replace(
    "const draft = trustedResumeDraftRef.current\n      ?? canonicalizeDraftLogoOverlay(buildDraft()) as V2Draft;",
    "const draft = canonicalizeDraftLogoOverlay(buildDraft()) as V2Draft;",
  );
  assert.notEqual(rebuiltResume, hookSource, "trusted-resume runtime mutation applied");
  activeCompiledHook = compileHook(rebuiltResume);
  await assert.rejects(
    exactEqualRevisionResume,
    /exact immutable local candidate/,
    "runtime harness rejects rebuilding an equal-revision resume from live state",
  );

  const missingUnmountOwnership = hookSource.replace(
    `mountedRef.current = false;
      autosaveGenerationRef.current += 1;
      autosaveLineageRef.current = null;
      latestDraftRef.current = null;
      bootstrapGenerationRef.current += 1;
      bootstrapAbortControllerRef.current?.abort();
      bootstrapAbortControllerRef.current = null;`,
    "mountedRef.current = false;",
  );
  assert.notEqual(missingUnmountOwnership, hookSource, "unmount ownership runtime mutation applied");
  activeCompiledHook = compileHook(missingUnmountOwnership);
  await assert.rejects(
    unmountWhileResetPostIsPending,
    /unmount aborts a pending reset POST/,
    "runtime harness rejects cleanup that leaves reset ownership alive after unmount",
  );

  const nullableDirectConflictRevision = hookSource.replace(
    "if (server && server.revision !== null) {",
    "if (server) {",
  );
  assert.notEqual(nullableDirectConflictRevision, hookSource, "direct 409 revision runtime mutation applied");
  activeCompiledHook = compileHook(nullableDirectConflictRevision);
  await assert.rejects(
    malformedConflictResponsesRefreshAuthoritatively,
    /missing draftRevision/,
    "runtime harness rejects direct 409 candidates without a concrete revision",
  );

  const missingExpectedRevision = hookSource.replace(
    "        expectedDraftRevision: snapshot.expectedDraftRevision,\n",
    "",
  );
  assert.notEqual(missingExpectedRevision, hookSource, "autosave CAS body mutation applied");
  activeCompiledHook = compileHook(missingExpectedRevision);
  await assert.rejects(
    twoIndependentClientsCannotOverwrite,
    /expectedDraftRevision|stale tab blocks/,
    "runtime harness rejects autosaves that omit expectedDraftRevision",
  );

  const numericOnlyObservation = hookSource.replace(
    "const decision = decideEditorProjectAutosaveObservation({",
    `const decision = observed.revision === currentAttempt.revision
            ? { kind: "saved" as const, confirmed: observed }
            : decideEditorProjectAutosaveObservation({`,
  );
  assert.notEqual(numericOnlyObservation, hookSource, "numeric-only lineage mutation applied");
  activeCompiledHook = compileHook(numericOnlyObservation);
  await assert.rejects(
    sameNumericRevisionWithDifferentDraftConflicts,
    /equal revision without equal fingerprint/,
    "runtime harness rejects numeric-only authoritative matches",
  );

  const confirmationOnlyInStatus = hookSource.replace(
    "            acknowledgeAutosaveCandidate(tracker, result.candidate);\n",
    "",
  );
  assert.notEqual(confirmationOnlyInStatus, hookSource, "deferred confirmation mutation applied");
  activeCompiledHook = compileHook(confirmationOnlyInStatus);
  await assert.rejects(
    suppressedIntermediateAcknowledgementAdvancesBase,
    /updates confirmed base/,
    "runtime harness rejects confirmation that waits for visible onStatus",
  );

  const conflictBlock = `materializeAutosaveConflict({
              tracker,
              generation,
              server: result.server,
              requiresServerRefresh: false,
            });
            return { kind: "blocked" };`;
  const seededConflictContinuation = hookSource.replace(
    conflictBlock,
    `editorProjectSaveQueue.seedRevision(saveProjectId, result.server.revision);
            return { kind: "error" };`,
  );
  assert.notEqual(seededConflictContinuation, hookSource, "409 watermark continuation mutation applied");
  activeCompiledHook = compileHook(seededConflictContinuation);
  await assert.rejects(
    twoIndependentClientsCannotOverwrite,
    /stale tab blocks/,
    "runtime harness rejects seeding the watermark and continuing after 409",
  );

  const reconciliationConflictBlock = `materializeAutosaveConflict({
              tracker,
              generation,
              server: decision.server,
              requiresServerRefresh: false,
            });
            return { kind: "blocked" };`;
  const pendingFetchWhileBlocked = hookSource.replace(
    reconciliationConflictBlock,
    `materializeAutosaveConflict({
              tracker,
              generation,
              server: decision.server,
              requiresServerRefresh: false,
            });
            tracker.blocked = false;
            return { kind: "error" };`,
  );
  assert.notEqual(pendingFetchWhileBlocked, hookSource, "blocked pending-fetch mutation applied");
  activeCompiledHook = compileHook(pendingFetchWhileBlocked);
  await assert.rejects(
    pendingDraftWaitsForReconciliationAndBecomesLatestConflict,
    /pending B|drops pending B/,
    "runtime harness rejects a pending network write after conflict blocking",
  );
  activeCompiledHook = compileHook(hookSource);
}

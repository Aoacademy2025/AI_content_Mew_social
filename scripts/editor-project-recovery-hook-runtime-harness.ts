import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as bootstrapModule from "../src/lib/editor-project-bootstrap";
import * as journalModule from "../src/lib/editor-project-recovery-journal";
import * as logoOverlayModule from "../src/lib/logo-overlay";

type JsonRecord = Record<string, unknown>;
type FetchInit = { method?: string; body?: string; [key: string]: unknown };
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
  failRecoveryWrites = false;

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failRecoveryWrites && key.startsWith("editor-v2-recovery:")) throw new Error("quota");
    this.values.set(key, value);
  }
  removeItem(key: string): void { this.values.delete(key); }
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

class FetchMock {
  readonly calls: FetchCall[] = [];
  private readonly routes = new Map<string, Array<() => Promise<ResponseLike>>>();
  private nextProject = 1;

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

  fetch = async (urlValue: unknown, initValue: unknown = {}): Promise<ResponseLike> => {
    const url = String(urlValue);
    const init = initValue as FetchInit;
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ method, url, init });
    const key = `${method} ${url}`;
    const queued = this.routes.get(key);
    const handler = queued?.shift();
    if (handler) return handler();
    if (url === "/api/user/video-settings") return response(200, {});
    if (url === "/api/videos/usage") return response(200, null);
    if (url === "/api/user/brand-assets") return response(200, { defaultLogo: null });
    if (url === "/api/editor-projects" && method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as JsonRecord;
      const id = `new-${this.nextProject++}`;
      return response(200, {
        project: { id, draftRevision: 0, draft: body.draft, status: "draft" },
      });
    }
    if (url.startsWith("/api/editor-projects/") && method === "PATCH") {
      const body = JSON.parse(init.body ?? "{}") as JsonRecord;
      const id = decodeURIComponent(url.slice("/api/editor-projects/".length));
      return response(200, {
        project: { id, draftRevision: body.draftRevision, draft: body.draft, status: "draft" },
      });
    }
    if (url.startsWith("/api/heygen/avatar-info")) return response(404, null);
    if (url === "/api/elevenlabs/voices") return response(200, { voices: [] });
    throw new Error(`unhandled fetch: ${key}`);
  };
}

type SaveEvent = { projectId: string; revision: number; status: "saving" | "saved" | "error" };
type SaveInput = {
  projectId: string;
  save(context: { revision: number; signal: AbortSignal }): Promise<boolean>;
  isActive?(): boolean;
  onStatus?(event: SaveEvent): void;
};

class QueueMock {
  readonly enqueued: Array<{ projectId: string; revision: number }> = [];
  readonly watermarks = new Map<string, number>();
  reserveError: Error | null = null;

  seedRevision(projectId: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    this.watermarks.set(projectId, Math.max(this.watermarks.get(projectId) ?? 0, revision));
  }
  revisionWatermark(projectId: string): number { return this.watermarks.get(projectId) ?? 0; }
  reserveRevisionAbove(projectId: string, observed: number): number {
    if (this.reserveError) throw this.reserveError;
    this.seedRevision(projectId, observed);
    const next = this.revisionWatermark(projectId) + 1;
    if (next > 2_147_483_647) throw new Error("draft revision exhausted");
    this.watermarks.set(projectId, next);
    return next;
  }
  enqueue(input: SaveInput): number {
    const revision = this.reserveRevisionAbove(input.projectId, this.revisionWatermark(input.projectId));
    this.enqueued.push({ projectId: input.projectId, revision });
    input.onStatus?.({ projectId: input.projectId, revision, status: "saving" });
    void input.save({ revision, signal: new AbortController().signal }).then(
      (ok) => input.onStatus?.({ projectId: input.projectId, revision, status: ok ? "saved" : "error" }),
      () => input.onStatus?.({ projectId: input.projectId, revision, status: "error" }),
    );
    return revision;
  }
  whenIdle(): Promise<void> { return Promise.resolve(); }
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
  resetProject(): Promise<void>;
  recovery: {
    status: string;
    local?: { draft: JsonRecord; revision: number | null };
    server?: { draft: JsonRecord; revision: number | null };
    resolving?: false | "local" | "server";
    error?: string | null;
  };
  chooseLocalProjectDraft(): Promise<void>;
  chooseServerProjectDraft(): void;
};

type HarnessOptions = {
  search?: string;
  storage?: MemoryStorage;
  fetchMe?: Promise<JsonRecord | null>;
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
  const fetchMock = new FetchMock();
  const queue = new QueueMock();
  const clock = new FakeClock();
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
  assert.equal(harness.runner.current.recovery.resolving, "local",
    "failed refresh stays resolving so neither stale candidate can be chosen");
  assert.ok(harness.runner.current.recovery.error);
  const patchCount = patchBodies(harness.fetchMock).length;
  harness.runner.current.chooseServerProjectDraft();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.status, "conflict");
  assert.equal(harness.runner.current.recovery.resolving, "local");
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
    ["settings-after-GET", settingsAfterServerHydration],
    ["equal-revision-resume", exactEqualRevisionResume],
    ["reset-during-GET", resetDuringProjectGet],
    ["functional-public-setters", publicSetterRuntimeContract],
    ["journal-write-failure", failedJournalWriteStillAutosaves],
    ["project-switching", projectScopedSwitching],
    ["StrictMode-setup-cleanup", strictModeDoesNotDuplicateWrites],
    ["ambiguous-local-choice", ambiguousLocalChoiceRefreshesServer],
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
    "const draft = trustedResumeDraftRef.current\n        ?? canonicalizeDraftLogoOverlay(buildDraft()) as V2Draft;",
    "const draft = canonicalizeDraftLogoOverlay(buildDraft()) as V2Draft;",
  );
  assert.notEqual(rebuiltResume, hookSource, "trusted-resume runtime mutation applied");
  activeCompiledHook = compileHook(rebuiltResume);
  await assert.rejects(
    exactEqualRevisionResume,
    /exact immutable local candidate/,
    "runtime harness rejects rebuilding an equal-revision resume from live state",
  );
  activeCompiledHook = compileHook(hookSource);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as bootstrapModule from "../src/lib/editor-project-bootstrap";
import * as journalModule from "../src/lib/editor-project-recovery-journal";
import * as logoOverlayModule from "../src/lib/logo-overlay";
import * as headlineHookModule from "../src/lib/headline-hook";
import * as lineageModule from "../src/lib/editor-project-autosave-lineage";
import * as ttsProvidersModule from "../src/lib/tts-providers";
import * as editorLayerVisibilityModule from "../src/lib/editor-layer-visibility";
import * as editorDefaultDraftModule from "../src/lib/editor-default-draft";
import * as editorStylePresetModule from "../src/lib/editor-style-preset-contract";
import * as musicMoodModule from "../src/lib/music-mood";
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

function deferredJsonResponse(status: number, payload: Promise<unknown>): ResponseLike {
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

  list(): JsonRecord[] {
    return [...this.projects.values()].map((value) => structuredClone(value));
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
    if (url === "/api/editor-projects" && method === "GET" && this.server) {
      return this.honorAbort(Promise.resolve(response(200, {
        projects: this.server.list(),
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
  projectInitialization: "loading-defaults" | "creating-project" | "empty" | "ready" | "error";
  projectStatus: string;
  projectTitle: string;
  setProjectTitle(next: string | ((value: string) => string)): void;
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
  setBgmVolume(value: number): void;
  setLogoOverlay(value: {
    enabled: boolean;
    assetId: string;
    position: "top-left" | "top-center" | "top-right" | "middle-left" | "center" | "middle-right" | "bottom-left" | "bottom-center" | "bottom-right";
    sizePct: number;
    opacity: number;
  } | undefined): void;
  saveStatus: "idle" | "saving" | "saved" | "error";
  retryProjectSave(): void;
  flushPendingProjectDraft(): Promise<boolean>;
  resetProject(): Promise<string | null>;
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
  __debugAutosaveLineage(): {
    blocked: boolean;
    confirmedRevision: number | null;
    issuedSize: number;
    issuedDraftBytes: number;
    latestLocalDraft: JsonRecord | null;
  };
};

type HarnessOptions = {
  search?: string;
  storage?: MemoryStorage;
  fetchMe?: Promise<JsonRecord | null>;
  server?: SharedEditorServer;
};

const hookSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Project.ts", "utf8");
function compileHook(source: string): string {
  const instrumented = source.replace(
    `  return {
    projectTitle, setProjectTitle,`,
    `  return {
    __debugAutosaveLineage: () => ({
      blocked: autosaveLineageRef.current?.blocked ?? false,
      confirmedRevision: autosaveLineageRef.current?.confirmed.revision ?? null,
      issuedSize: autosaveLineageRef.current?.issued.size ?? 0,
      issuedDraftBytes: autosaveLineageRef.current
        ? [...autosaveLineageRef.current.issued.values()].reduce(
            (total, snapshot) => total + JSON.stringify(snapshot.draft).length,
            0,
          )
        : 0,
      latestLocalDraft: autosaveLineageRef.current?.latestLocal?.draft ?? null,
    }),
    projectTitle, setProjectTitle,`,
  );
  assert.notEqual(instrumented, source, "runtime harness instruments the actual autosave tracker");
  return ts.transpileModule(instrumented, {
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
    if (specifier === "@/lib/use-me") {
      return {
        fetchMe: () => options.fetchMe ?? Promise.resolve({ role: "ADMIN" }),
        resolveBrandVisualClientAccess: (account: JsonRecord | null | undefined) => {
          const featureAccess = account?.featureAccess as JsonRecord | undefined;
          const brandVisual = featureAccess?.brandVisual as JsonRecord | undefined;
          return brandVisual?.canUse === true || account?.brandVisualAllowed === true;
        },
      };
    }
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
    if (specifier === "@/lib/editor-default-draft") return editorDefaultDraftModule;
    if (specifier === "@/lib/editor-project-save-queue") return { editorProjectSaveQueue: queue };
    if (specifier === "@/lib/editor-project-bootstrap") return bootstrapModule;
    if (specifier === "@/lib/editor-project-recovery-journal") return journalModule;
    if (specifier === "@/lib/editor-project-autosave-lineage") return lineageModule;
    if (specifier === "@/lib/logo-overlay") return logoOverlayModule;
    if (specifier === "@/lib/headline-hook") return headlineHookModule;
    // Pure module (normalize/derive only, no I/O) — same class as logo-overlay above, so run
    // the real one and let the harness exercise production layer-visibility normalization.
    if (specifier === "@/lib/editor-layer-visibility") return editorLayerVisibilityModule;
    // Pure module — keep project-bootstrap tests on the same subtitle-default coercion as runtime.
    if (specifier === "@/lib/editor-style-preset-contract") return editorStylePresetModule;
    // Pure module — run the real parser so the harness sees production voice-engine coercion.
    if (specifier === "@/lib/tts-providers") return ttsProvidersModule;
    // Pure module (mood label/parse/pick helpers, no server deps) — same class as
    // tts-providers above, so run the real one instead of stubbing it.
    if (specifier === "@/lib/music-mood") return musicMoodModule;
    if (specifier === "@/lib/video-account-defaults") {
      return { saveVideoAccountDefaults: async () => ({ ok: true }) };
    }
    if (specifier === "@/lib/client-request-cache") {
      return {
        fetchClientJson: async () => ({ ok: true, status: 200, data: null }),
      };
    }
    if (specifier === "@/lib/authenticated-fetch") {
      return { authenticatedFetch: fetchMock.fetch };
    }
    // The canary hook is a network gate, not project lifecycle: stub it to the value the real
    // hook returns when NEXT_PUBLIC_OMNIVOICE_ENABLED is unset (the CI/build default).
    if (specifier === "../_hooks/useOmniVoiceAvailability") {
      return { useOmniVoiceAvailability: () => false };
    }
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

function postBodies(fetchMock: FetchMock): JsonRecord[] {
  return fetchMock.calls
    .filter((call) => call.method === "POST" && call.url === "/api/editor-projects")
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

function recoveryJournalDraft(storage: MemoryStorage, projectId: string): JsonRecord | null {
  const raw = storage.getItem(journalModule.editorProjectRecoveryKey(projectId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { draft?: unknown };
  return parsed.draft && typeof parsed.draft === "object" && !Array.isArray(parsed.draft)
    ? parsed.draft as JsonRecord
    : null;
}

async function drainMicrotasksWithoutRender(turns = 24): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
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

async function conflictBlocksSettersBeforeRecoveryRerender(): Promise<void> {
  const projectId = "same-tick-conflict-gate";
  const server = new SharedEditorServer();
  server.setProject(projectId, 0, {
    script: "base",
    clipUrl: "clip-before-conflict",
    clipDurationSec: 12,
    mixPreset: "free",
    brollSource: "stock",
  });
  const patchResponse = deferred<ResponseLike>();
  const harness = createHarness({ search: `?projectId=${projectId}`, server });
  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), patchResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);

  harness.runner.current.setScript("local candidate");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  const journalBeforeConflict = harness.storage.getItem(
    journalModule.editorProjectRecoveryKey(projectId),
  );
  const storageOperationsBeforeConflict = harness.storage.operations.length;

  patchResponse.resolve(response(409, {
    project: project(projectId, 1, { script: "other tab wins" }),
  }));
  await drainMicrotasksWithoutRender();
  assert.equal(harness.runner.current.recovery.status, "none",
    "the test invokes setters through the still-rendered pre-conflict hook value");
  assert.equal(harness.runner.current.projectReady, true,
    "the rendered readiness boolean is intentionally stale in the conflict tick");

  harness.runner.current.setScript("must remain blocked");
  harness.runner.current.setClipUrl("");
  harness.runner.current.setMixPreset("recommended");
  harness.runner.current.setLogoOverlay({
    enabled: true,
    assetId: "must-remain-blocked",
    position: "bottom-right",
    sizePct: 20,
    opacity: 0.8,
  });
  assert.equal(
    harness.storage.operations.length,
    storageOperationsBeforeConflict,
    "same-tick blocked setters cannot touch the recovery journal before rerender",
  );
  assert.equal(
    harness.storage.getItem(journalModule.editorProjectRecoveryKey(projectId)),
    journalBeforeConflict,
    "same-tick blocked setters preserve the exact conflict journal",
  );

  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.deepEqual({
    recovery: harness.runner.current.recovery.status,
    script: harness.runner.current.script,
    clipUrl: harness.runner.current.clipUrl,
    clipDurationSec: harness.runner.current.clipDurationSec,
    mixPreset: harness.runner.current.mixPreset,
    brollSource: harness.runner.current.brollSource,
    patchCount: autosavePatchCalls(harness.fetchMock, projectId).length,
    journal: harness.storage.getItem(journalModule.editorProjectRecoveryKey(projectId)),
  }, {
    recovery: "conflict",
    script: "local candidate",
    clipUrl: "clip-before-conflict",
    clipDurationSec: 12,
    mixPreset: "free",
    brollSource: "stock",
    patchCount: 1,
    journal: journalBeforeConflict,
  }, "recovery ownership blocks public and composite mutations before React rerenders");
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

async function explicitSetterStagesBeforePassiveEffects(): Promise<void> {
  const logo = {
    enabled: true,
    assetId: "asset-async-logo",
    position: "bottom-left" as const,
    sizePct: 24,
    opacity: 0.75,
  };
  const variants: Array<{
    name: string;
    base: JsonRecord;
    stage: (harness: ReturnType<typeof createHarness>) => void | Promise<void>;
    assertDraft: (draft: JsonRecord) => void;
  }> = [
    {
      name: "functional",
      base: { script: "base" },
      stage: (harness) => harness.runner.current.setScript(
        (value) => `${value} / functional B`,
      ),
      assertDraft: (draft) => assert.equal(draft.script, "in-flight A / functional B"),
    },
    {
      name: "async-logo",
      base: { script: "base" },
      stage: async (harness) => {
        await Promise.resolve();
        harness.runner.current.setLogoOverlay(logo);
      },
      assertDraft: (draft) => assert.deepEqual(draft.logoOverlay, logo),
    },
    {
      name: "clip-composite",
      base: { script: "base", clipUrl: "https://cdn.example/clip.mp4", clipDurationSec: 12 },
      stage: (harness) => harness.runner.current.setClipUrl(""),
      assertDraft: (draft) => assert.deepEqual(
        { clipUrl: draft.clipUrl, clipDurationSec: draft.clipDurationSec },
        { clipUrl: "", clipDurationSec: 0 },
      ),
    },
    {
      name: "preset-composite",
      base: {
        script: "base",
        mixPreset: "free",
        brollSource: "stock",
        autoMixProviders: ["video", "pexels-photo", "pixabay-photo"],
      },
      stage: (harness) => harness.runner.current.setMixPreset("recommended"),
      assertDraft: (draft) => assert.deepEqual({
        mixPreset: draft.mixPreset,
        brollSource: draft.brollSource,
        autoMixProviders: draft.autoMixProviders,
      }, {
        mixPreset: "recommended",
        brollSource: "automix",
        autoMixProviders: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
      }),
    },
  ];

  const failures: string[] = [];
  for (const variant of variants) {
    const projectId = `setter-boundary-${variant.name}`;
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, variant.base);
    const patchA = deferred<ResponseLike>();
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    try {
      harness.fetchMock.enqueue("PATCH", editorUrl(projectId), patchA.promise);
      harness.runner.mount();
      await settle(harness.runner);
      harness.runner.current.setScript("in-flight A");
      harness.runner.flush();
      harness.clock.advance(1_000);
      await settle(harness.runner);
      assert.equal(autosavePatchCalls(harness.fetchMock, projectId).length, 1,
        `${variant.name} starts autosave A`);

      await variant.stage(harness);
      variant.assertDraft(harness.runner.current.__debugAutosaveLineage().latestLocalDraft!);
      variant.assertDraft(recoveryJournalDraft(harness.storage, projectId)!);

      patchA.resolve(response(409, {
        project: project(projectId, 1, { script: "other tab" }),
      }));
      await drainMicrotasksWithoutRender();
      const beforeRender = harness.runner.current.__debugAutosaveLineage();
      assert.equal(beforeRender.blocked, true,
        `${variant.name} synchronously blocks before render/passive effects`);
      variant.assertDraft(beforeRender.latestLocalDraft!);
      variant.assertDraft(recoveryJournalDraft(harness.storage, projectId)!);

      harness.runner.flush();
      variant.assertDraft(harness.runner.current.recovery.local!.draft);
      assert.equal(harness.runner.current.recovery.server?.draft.script, "other tab");
      harness.clock.advance(1_000);
      await settle(harness.runner);
      assert.equal(autosavePatchCalls(harness.fetchMock, projectId).length, 1,
        `${variant.name} cannot send an advancing PATCH after the conflict`);
    } catch (error) {
      failures.push(`${variant.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      harness.runner.unmount();
    }
  }
  assert.deepEqual(failures, [], `synchronous setter staging failures:\n${failures.join("\n")}`);
}

async function rawHydrationDoesNotStageExplicitLocal(): Promise<void> {
  const server = new SharedEditorServer();
  const settings = deferred<ResponseLike>();
  const patchA = deferred<ResponseLike>();
  const harness = createHarness({ server });
  harness.fetchMock.enqueue("GET", "/api/user/video-settings", settings.promise);
  harness.runner.mount();
  await settle(harness.runner);
  const projectId = harness.runner.current.projectId!;

  settings.resolve(response(200, { heygenAvatarId: "programmatic-avatar" }));
  await drainMicrotasksWithoutRender();
  assert.deepEqual({
    latestLocal: harness.runner.current.__debugAutosaveLineage().latestLocalDraft,
    journal: recoveryJournalDraft(harness.storage, projectId),
    patches: autosavePatchCalls(harness.fetchMock, projectId).length,
  }, {
    latestLocal: null,
    journal: null,
    patches: 0,
  }, "raw hydration alone cannot manufacture explicit recovery provenance");

  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), patchA.promise);
  harness.runner.current.setScript("explicit A");
  assert.deepEqual({
    script: harness.runner.current.__debugAutosaveLineage().latestLocalDraft?.script,
    avatarId: harness.runner.current.__debugAutosaveLineage().latestLocalDraft?.avatarId,
    journalAvatarId: recoveryJournalDraft(harness.storage, projectId)?.avatarId,
  }, {
    script: "explicit A",
    avatarId: "programmatic-avatar",
    journalAvatarId: "programmatic-avatar",
  }, "the next explicit action stages the exact effective draft including prior raw hydration");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);

  patchA.resolve(response(409, {
    project: project(projectId, 1, { script: "other tab" }),
  }));
  await drainMicrotasksWithoutRender();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.local?.draft.avatarId, "programmatic-avatar",
    "the later explicit edit, not raw hydration alone, owns the effective recovery candidate");
  assert.equal(autosavePatchCalls(harness.fetchMock, projectId).length, 1);
}

async function olderAcknowledgementCannotClearNewerStagedJournal(): Promise<void> {
  const projectId = "setter-boundary-older-ack";
  const server = new SharedEditorServer();
  server.setProject(projectId, 0, { script: "base" });
  const patchA = deferred<ResponseLike>();
  const harness = createHarness({ search: `?projectId=${projectId}`, server });
  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), patchA.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("in-flight A");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  const bodyA = patchBodies(harness.fetchMock)[0];

  harness.runner.current.setScript((value) => `${value} / newer B`);
  assert.equal(recoveryJournalDraft(harness.storage, projectId)?.script,
    "in-flight A / newer B");
  server.setProject(projectId, bodyA.draftRevision as number, bodyA.draft as JsonRecord);
  patchA.resolve(response(200, {
    project: project(projectId, bodyA.draftRevision as number, bodyA.draft as JsonRecord),
  }));
  await drainMicrotasksWithoutRender();
  assert.equal(recoveryJournalDraft(harness.storage, projectId)?.script,
    "in-flight A / newer B",
    "an older exact acknowledgement cannot clear a newer synchronous journal");
  assert.equal(harness.runner.current.__debugAutosaveLineage().latestLocalDraft?.script,
    "in-flight A / newer B");

  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  const bodies = patchBodies(harness.fetchMock);
  assert.equal(bodies.length, 2, "newer B still follows the older acknowledgement normally");
  assert.equal(bodies[1].expectedDraftRevision, 1);
  assert.equal((bodies[1].draft as JsonRecord).script, "in-flight A / newer B");
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
  me.resolve({
    role: "USER",
    plan: "PRO",
    effectivePlan: "PRO",
    kiePaidUnlocked: false,
    heroAiImageEligible: true,
    brandVisualAllowed: true,
    recommendedAutoMixDefault: true,
    managedKieOn: true,
  });
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

async function paidBrandVisualDefaultsNewProjectToRecommendedAutoMix(): Promise<void> {
  const harness = createHarness({
    fetchMe: Promise.resolve({
      role: "USER",
      plan: "PRO",
      effectivePlan: "PRO",
      kiePaidUnlocked: false,
      heroAiImageEligible: true,
      brandVisualAllowed: true,
      recommendedAutoMixDefault: true,
    }),
  });
  harness.runner.mount();
  await settle(harness.runner);

  const created = postBodies(harness.fetchMock)[0];
  assert.ok(created, "a fresh paid Brand Visual account creates one durable project");
  assert.deepEqual({
    persistedPreset: (created.draft as JsonRecord).mixPreset,
    persistedSource: (created.draft as JsonRecord).brollSource,
    persistedProviders: (created.draft as JsonRecord).autoMixProviders,
    visiblePreset: harness.runner.current.mixPreset,
    visibleSource: harness.runner.current.brollSource,
    visibleProviders: harness.runner.current.autoMixProviders,
  }, {
    persistedPreset: "recommended",
    persistedSource: "automix",
    persistedProviders: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
    visiblePreset: "recommended",
    visibleSource: "automix",
    visibleProviders: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
  }, "a paid Brand Visual user's first durable draft defaults to recommended AutoMix without the internal KIE gate");
}

async function paidBrandVisualHydrationPreservesExistingMixChoice(): Promise<void> {
  const harness = createHarness({
    search: "?projectId=paid-existing-choice",
    fetchMe: Promise.resolve({
      role: "USER",
      plan: "PRO",
      effectivePlan: "PRO",
      kiePaidUnlocked: false,
      heroAiImageEligible: true,
      brandVisualAllowed: true,
      recommendedAutoMixDefault: true,
    }),
  });
  harness.fetchMock.enqueue("GET", editorUrl("paid-existing-choice"), response(200, {
    project: project("paid-existing-choice", 4, {
      mixPreset: "free",
      brollSource: "stock",
      autoMixProviders: ["video", "pexels-photo", "pixabay-photo"],
    }),
  }));
  harness.runner.mount();
  await settle(harness.runner);

  assert.deepEqual({
    preset: harness.runner.current.mixPreset,
    source: harness.runner.current.brollSource,
    providers: harness.runner.current.autoMixProviders,
    patches: patchBodies(harness.fetchMock).length,
  }, {
    preset: "free",
    source: "stock",
    providers: ["video", "pexels-photo", "pixabay-photo"],
    patches: 0,
  }, "paid-plan defaults never overwrite an existing project's explicit Stock choice");
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

async function blankBootstrapBlocksUserMutationDuringInitialization(): Promise<void> {
  const defaults = deferred<ResponseLike>();
  const post = deferred<ResponseLike>();
  const harness = createHarness();
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", defaults.promise);
  harness.fetchMock.enqueue("POST", "/api/editor-projects", post.promise);
  harness.runner.mount();
  await settle(harness.runner);

  assert.equal(harness.runner.current.projectInitialization, "loading-defaults");
  assert.equal(harness.runner.current.projectReady, false);
  harness.runner.current.setScript("must-not-survive-bootstrap");
  harness.runner.flush();
  assert.notEqual(harness.runner.current.script, "must-not-survive-bootstrap",
    "blank bootstrap rejects a real user setter while defaults are pending");

  defaults.resolve(response(200, { defaultLogo: null }));
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectInitialization, "creating-project");
  assert.equal(harness.runner.current.projectReady, false);
  const createBody = postBodies(harness.fetchMock)[0];
  assert.equal((createBody.draft as JsonRecord).script, "",
    "the attempted bootstrap value never reaches the project POST");

  post.resolve(response(200, {
    project: project("blank-bootstrap", 0, createBody.draft as JsonRecord),
  }));
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectInitialization, "ready");
  assert.equal(harness.runner.current.projectReady, true);
  assert.notEqual(harness.runner.current.script, "must-not-survive-bootstrap");
}

async function explicitEmptyBootstrapStaysUnpersisted(): Promise<void> {
  const harness = createHarness({ search: "?empty=1" });
  harness.runner.mount();
  await settle(harness.runner);

  assert.deepEqual({
    initialization: harness.runner.current.projectInitialization,
    ready: harness.runner.current.projectReady,
    projectId: harness.runner.current.projectId,
    posts: postBodies(harness.fetchMock).length,
  }, {
    initialization: "empty",
    ready: false,
    projectId: null,
    posts: 0,
  }, "the explicit post-delete empty state creates no replacement project");
}

async function resetBlocksUserMutationWhileDefaultsLoad(): Promise<void> {
  const harness = createHarness();
  harness.runner.mount();
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectInitialization, "ready");

  harness.runner.current.setProjectTitle("Before Reset");
  harness.runner.flush();
  const resetDefaults = deferred<ResponseLike>();
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", resetDefaults.promise);
  const reset = harness.runner.current.resetProject();
  harness.runner.flush();
  assert.equal(harness.runner.current.projectInitialization, "loading-defaults");
  assert.equal(harness.runner.current.projectReady, false,
    "Reset blocks project readiness before awaiting account defaults");

  harness.runner.current.setProjectTitle("must-not-survive-reset");
  harness.runner.flush();
  assert.equal(harness.runner.current.projectTitle, "Before Reset",
    "Reset rejects a real title setter while defaults are pending");
  resetDefaults.resolve(response(200, { defaultLogo: null }));
  await reset;
  await settle(harness.runner);

  assert.equal(harness.runner.current.projectInitialization, "ready");
  assert.equal(harness.runner.current.projectReady, true);
  assert.equal(harness.runner.current.projectTitle, "New Project");
  assert.equal((postBodies(harness.fetchMock).at(-1)?.draft as JsonRecord).projectTitle, "New Project",
    "the attempted Reset value never reaches the replacement project POST");
}

async function resetInheritsSavedVoiceSettings(): Promise<void> {
  const harness = createHarness();
  harness.runner.mount();
  await settle(harness.runner);

  harness.fetchMock.enqueue("GET", "/api/user/video-settings", response(200, {
    ttsProvider: "elevenlabs",
    elevenlabsVoiceId: "duckyhero-saved-voice",
    geminiVoiceName: "Puck",
  }));

  await harness.runner.current.resetProject();
  await settle(harness.runner);

  const createdDraft = postBodies(harness.fetchMock).at(-1)?.draft as JsonRecord;
  assert.deepEqual({
    editor: {
      voiceEngine: harness.runner.current.voiceEngine,
      voiceId: harness.runner.current.voiceId,
      geminiVoiceName: harness.runner.current.geminiVoiceName,
    },
    persisted: {
      voiceEngine: createdDraft.voiceEngine,
      voiceId: createdDraft.voiceId,
      geminiVoiceName: createdDraft.geminiVoiceName,
    },
  }, {
    editor: {
      voiceEngine: "elevenlabs",
      voiceId: "duckyhero-saved-voice",
      geminiVoiceName: "Puck",
    },
    persisted: {
      voiceEngine: "elevenlabs",
      voiceId: "duckyhero-saved-voice",
      geminiVoiceName: "Puck",
    },
  }, "Reset inherits the saved account voice in both the editor and replacement project");
}

async function blankBootstrapInheritsSavedVoiceSettings(): Promise<void> {
  const harness = createHarness();
  const savedSettings = response(200, {
    ttsProvider: "elevenlabs",
    elevenlabsVoiceId: "duckyhero-saved-voice",
    geminiVoiceName: "Puck",
  });
  // Bootstrap and the compatibility hydration effect may share this account boundary.
  // A real GET returns the same account settings on both reads.
  harness.fetchMock.enqueue("GET", "/api/user/video-settings", savedSettings);
  harness.fetchMock.enqueue("GET", "/api/user/video-settings", savedSettings);

  harness.runner.mount();
  await settle(harness.runner);

  const createdDraft = postBodies(harness.fetchMock).at(-1)?.draft as JsonRecord;
  assert.deepEqual({
    voiceEngine: createdDraft.voiceEngine,
    voiceId: createdDraft.voiceId,
    geminiVoiceName: createdDraft.geminiVoiceName,
  }, {
    voiceEngine: "elevenlabs",
    voiceId: "duckyhero-saved-voice",
    geminiVoiceName: "Puck",
  }, "a blank Editor bootstrap persists the saved account voice in its first project");
}

async function supersededResetCannotCompleteInitialization(): Promise<void> {
  const harness = createHarness();
  harness.runner.mount();
  await settle(harness.runner);
  const postsBeforeReset = postBodies(harness.fetchMock).length;
  const firstDefaults = deferred<ResponseLike>();
  const secondDefaults = deferred<ResponseLike>();
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", firstDefaults.promise);
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", secondDefaults.promise);

  const firstReset = harness.runner.current.resetProject();
  harness.runner.flush();
  const secondReset = harness.runner.current.resetProject();
  harness.runner.flush();
  firstDefaults.resolve(response(200, { defaultLogo: null }));
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectInitialization, "loading-defaults",
    "a superseded default completion cannot publish ready");
  assert.equal(harness.runner.current.projectReady, false);
  assert.equal(postBodies(harness.fetchMock).length, postsBeforeReset,
    "a superseded default completion cannot create a project");

  secondDefaults.resolve(response(200, { defaultLogo: null }));
  await Promise.all([firstReset, secondReset]);
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectInitialization, "ready");
  assert.equal(harness.runner.current.projectReady, true);
  assert.equal(postBodies(harness.fetchMock).length, postsBeforeReset + 1,
    "only the latest Reset creates a replacement project");
}

async function unmountWhileBlankBootstrapAwaitsDefaults(): Promise<void> {
  const defaults = deferred<ResponseLike>();
  const harness = createHarness();
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", defaults.promise);
  harness.runner.mount();
  await settle(harness.runner);
  assert.equal(harness.runner.current.projectInitialization, "loading-defaults");
  harness.runner.unmount();
  defaults.resolve(response(200, { defaultLogo: null }));
  await settle(harness.runner);
  assert.equal(postBodies(harness.fetchMock).length, 0,
    "unmount while blank defaults are pending prevents project creation");
  assert.equal(harness.runner.current.projectInitialization, "loading-defaults",
    "unmounted default completion cannot publish initialization state");
}

async function accountDefaultFailureFailsClosed(): Promise<void> {
  const harness = createHarness();
  harness.fetchMock.enqueue("GET", "/api/user/brand-assets", response(500, { error: "unavailable" }));
  harness.runner.mount();
  await settle(harness.runner);
  assert.deepEqual({
    initialization: harness.runner.current.projectInitialization,
    ready: harness.runner.current.projectReady,
    recovery: harness.runner.current.recovery.status,
    posts: postBodies(harness.fetchMock).length,
  }, {
    initialization: "error",
    ready: false,
    recovery: "load-error",
    posts: 0,
  }, "a non-abort account-default failure is visible and fail-closed");
}

async function projectCreationFailureFailsClosed(): Promise<void> {
  const harness = createHarness();
  harness.fetchMock.enqueue("POST", "/api/editor-projects", response(500, { error: "unavailable" }));
  harness.runner.mount();
  await settle(harness.runner);
  assert.deepEqual({
    initialization: harness.runner.current.projectInitialization,
    ready: harness.runner.current.projectReady,
    recovery: harness.runner.current.recovery.status,
  }, {
    initialization: "error",
    ready: false,
    recovery: "load-error",
  }, "a non-abort server-project creation failure is visible and fail-closed");
}

async function staleStoredPointerFallsBackToActiveProject(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem("editor-v2-project-id", "archived-stale");
  storage.setItem("editor-v2-project", JSON.stringify({ script: "stale local" }));
  const server = new SharedEditorServer();
  server.setProject("active-project", 4, { script: "active server draft" });
  const harness = createHarness({
    storage,
    server,
    fetchMe: Promise.resolve({ id: "account-a", role: "ADMIN", plan: "PRO" }),
  });
  harness.runner.mount();
  await settle(harness.runner);
  assert.deepEqual({
    initialization: harness.runner.current.projectInitialization,
    ready: harness.runner.current.projectReady,
    recovery: harness.runner.current.recovery.status,
    projectId: harness.runner.current.projectId,
    script: harness.runner.current.script,
    scopedPointer: storage.getItem("editor-v2-project-id:account-a"),
    legacyPointer: storage.getItem("editor-v2-project-id"),
  }, {
    initialization: "ready",
    ready: true,
    recovery: "none",
    projectId: "active-project",
    script: "active server draft",
    scopedPointer: "active-project",
    legacyPointer: null,
  }, "a stale stored pointer self-heals to the account's active project");
  assert.equal(postBodies(harness.fetchMock).length, 0, "stale recovery never auto-creates a project");
}

async function staleStoredPointerWithoutActiveProjectBecomesEmpty(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem("editor-v2-project-id", "archived-stale");
  const harness = createHarness({
    storage,
    server: new SharedEditorServer(),
    fetchMe: Promise.resolve({ id: "account-a", role: "ADMIN", plan: "PRO" }),
  });
  harness.runner.mount();
  await settle(harness.runner);
  assert.deepEqual({
    initialization: harness.runner.current.projectInitialization,
    ready: harness.runner.current.projectReady,
    recovery: harness.runner.current.recovery.status,
    projectId: harness.runner.current.projectId,
    posts: postBodies(harness.fetchMock).length,
  }, {
    initialization: "empty",
    ready: false,
    recovery: "none",
    projectId: null,
    posts: 0,
  }, "a stale pointer with no active project enters an explicit empty state");
}

async function explicitMissingProjectFailsClosed(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem("editor-v2-project-id", "stored-project");
  const harness = createHarness({
    search: "?projectId=missing-explicit",
    storage,
    server: new SharedEditorServer(),
    fetchMe: Promise.resolve({ id: "account-a", role: "ADMIN", plan: "PRO" }),
  });
  harness.runner.mount();
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.status, "load-error");
  assert.equal(harness.runner.current.projectId, "missing-explicit");
  assert.equal(storage.getItem("editor-v2-project-id"), "stored-project",
    "an explicit URL 404 cannot silently replace or clear the user's stored project");
  assert.equal(harness.fetchMock.calls.some((call) => call.url === "/api/editor-projects"), false,
    "an explicit URL 404 never falls back to an unrelated project");
}

async function storedProjectServerErrorRetainsPointer(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem("editor-v2-project-id", "temporarily-unavailable");
  const harness = createHarness({
    storage,
    fetchMe: Promise.resolve({ id: "account-a", role: "ADMIN", plan: "PRO" }),
  });
  harness.fetchMock.enqueue("GET", editorUrl("temporarily-unavailable"), response(503, { error: "down" }));
  harness.runner.mount();
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.status, "load-error");
  assert.equal(storage.getItem("editor-v2-project-id"), "temporarily-unavailable",
    "5xx keeps the pointer so Retry can reopen the same project");
}

async function stalePointerListFailureRetainsRetryTarget(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem("editor-v2-project-id", "stale-list-retry");
  const harness = createHarness({ storage });
  harness.fetchMock.enqueue("GET", editorUrl("stale-list-retry"), response(404, { error: "not_found" }));
  harness.fetchMock.enqueue("GET", "/api/editor-projects", response(503, { error: "down" }));
  harness.runner.mount();
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.status, "load-error");
  assert.equal(storage.getItem("editor-v2-project-id"), "stale-list-retry",
    "a failed fallback list keeps the stale pointer solely as Retry provenance");
  assert.equal(postBodies(harness.fetchMock).length, 0);
}

async function stalePointerSkipsProjectArchivedDuringFallback(): Promise<void> {
  const storage = new MemoryStorage();
  storage.setItem("editor-v2-project-id", "stale-race");
  const harness = createHarness({ storage });
  harness.fetchMock.enqueue("GET", editorUrl("stale-race"), response(404, { error: "not_found" }));
  harness.fetchMock.enqueue("GET", "/api/editor-projects", response(200, {
    projects: [
      project("archived-during-fallback", 1, { script: "gone" }),
      project("still-active", 2, { script: "survivor" }),
    ],
  }));
  harness.fetchMock.enqueue("GET", editorUrl("archived-during-fallback"), response(404, { error: "not_found" }));
  harness.fetchMock.enqueue("GET", editorUrl("still-active"), response(200, {
    project: project("still-active", 2, { script: "survivor" }),
  }));
  harness.runner.mount();
  await settle(harness.runner, 32);
  assert.deepEqual({
    projectId: harness.runner.current.projectId,
    ready: harness.runner.current.projectReady,
    initialization: harness.runner.current.projectInitialization,
    recovery: harness.runner.current.recovery.status,
    script: harness.runner.current.script,
  }, {
    projectId: "still-active",
    ready: true,
    initialization: "ready",
    recovery: "none",
    script: "survivor",
  });
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
  assert.equal(harness.runner.current.recovery.status, "none",
    "editing script without a configured headline keeps the draft JSON-safe");
  const stagedJournal = journalModule.readEditorProjectRecoveryJournal(
    harness.storage,
    "setters-a",
  );
  assert.ok(stagedJournal, "editing script stages a recovery journal synchronously");
  assert.equal(Object.hasOwn(stagedJournal.draft, "headlineHook"), false,
    "an absent optional headline is omitted from the staged draft");
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

async function pendingUploadFlushesBeforeAuthoritativeBrandPin(): Promise<void> {
  const projectId = "upload-brand-pin";
  const server = new SharedEditorServer();
  server.setProject(projectId, 2, {
    mode: "upload",
    clipUrl: "",
    clipDurationSec: 0,
    mixPreset: "free",
    brollSource: "stock",
  });
  const harness = createHarness({ search: `?projectId=${projectId}`, server });
  harness.runner.mount();
  await settle(harness.runner);

  const uploadedClip = "/api/renders/avatar-upload-ticket.mp4";
  harness.runner.current.setClipUrl(uploadedClip);
  harness.runner.current.setClipDurationSec(90.818);
  harness.runner.flush();

  const flush = harness.runner.current.flushPendingProjectDraft();
  await settle(harness.runner);
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.equal(await flush, true, "the pending upload is durably saved before a Brand mutation");

  const persistedDraft = server.read(projectId)?.draft as JsonRecord;
  assert.deepEqual({
    clipUrl: persistedDraft.clipUrl,
    clipDurationSec: persistedDraft.clipDurationSec,
  }, {
    clipUrl: uploadedClip,
    clipDurationSec: 90.818,
  }, "the flush persists the exact uploaded clip through the editor project interface");

  const brandSnapshot = project(projectId, 4, {
    ...persistedDraft,
    mixPreset: "recommended",
    brollSource: "automix",
  });
  server.setProject(projectId, 4, brandSnapshot.draft as JsonRecord);
  const replacementClip = "/api/renders/avatar-upload-newer-ticket.mp4";
  harness.runner.current.setClipUrl(replacementClip);
  harness.runner.current.setClipDurationSec(91.5);
  harness.runner.flush();
  const accepted = harness.runner.current.acceptAuthoritativeProjectSnapshot(brandSnapshot);
  harness.runner.flush();

  assert.deepEqual({
    accepted,
    clipUrl: harness.runner.current.clipUrl,
    clipDurationSec: harness.runner.current.clipDurationSec,
    mixPreset: harness.runner.current.mixPreset,
    brollSource: harness.runner.current.brollSource,
  }, {
    accepted: true,
    clipUrl: replacementClip,
    clipDurationSec: 91.5,
    mixPreset: "recommended",
    brollSource: "automix",
  }, "Brand Visual defaults apply without discarding a newer edit made while its request was in flight");

  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.deepEqual({
    clipUrl: (server.read(projectId)?.draft as JsonRecord).clipUrl,
    clipDurationSec: (server.read(projectId)?.draft as JsonRecord).clipDurationSec,
    mixPreset: (server.read(projectId)?.draft as JsonRecord).mixPreset,
  }, {
    clipUrl: replacementClip,
    clipDurationSec: 91.5,
    mixPreset: "recommended",
  }, "the rebased newer upload is durably autosaved above the Brand Revision snapshot");
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

async function failedAmbiguousRefreshRetriesGetOnly(): Promise<void> {
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
  const initialServer = harness.runner.current.recovery.server;
  const journalKey = journalModule.editorProjectRecoveryKey("conflict-locked");
  const journalBeforeRetry = harness.storage.getItem(journalKey);
  await harness.runner.current.chooseLocalProjectDraft();
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.local, immutableLocal);
  assert.equal(harness.runner.current.recovery.resolving, false,
    "failed refresh returns control to a retryable locked conflict");
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, true);
  assert.ok(harness.runner.current.recovery.error);
  const patchCount = patchBodies(harness.fetchMock).length;
  const lockedState = harness.runner.current.recovery;
  await harness.runner.current.chooseLocalProjectDraft();
  harness.runner.current.chooseServerProjectDraft();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery, lockedState,
    "both conflict choices remain inert until a server refresh succeeds");
  assert.equal(patchBodies(harness.fetchMock).length, patchCount,
    "locked conflict choices cannot send PATCH");
  const getCountAfterAmbiguousWrite = harness.fetchMock.calls.filter(
    (call) => call.method === "GET" && call.url === editorUrl("conflict-locked"),
  ).length;
  harness.fetchMock.enqueueFailure("GET", editorUrl("conflict-locked"), new Error("retry one unavailable"));
  await harness.runner.current.retryConflictServerRefresh();
  await settle(harness.runner);
  assert.equal(harness.fetchMock.calls.filter(
    (call) => call.method === "GET" && call.url === editorUrl("conflict-locked"),
  ).length, getCountAfterAmbiguousWrite + 1, "first in-dialog retry sends exactly one GET");
  assert.equal(patchBodies(harness.fetchMock).length, patchCount, "first in-dialog retry never sends PATCH");
  assert.equal(harness.runner.current.recovery.local, immutableLocal,
    "failed in-dialog retry preserves the exact immutable local candidate");
  assert.equal(harness.runner.current.recovery.server, initialServer,
    "failed in-dialog retry preserves the last validated server candidate");
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, true);
  assert.equal(harness.storage.getItem(journalKey), journalBeforeRetry,
    "failed in-dialog retry does not clear or rewrite recovery provenance");

  const retryTwo = deferred<ResponseLike>();
  harness.fetchMock.enqueue("GET", editorUrl("conflict-locked"), retryTwo.promise);
  const retryTwoPromise = harness.runner.current.retryConflictServerRefresh();
  const duplicateRetryPromise = harness.runner.current.retryConflictServerRefresh();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.local, immutableLocal);
  assert.equal(harness.runner.current.recovery.resolving, "refresh",
    "only the GET-only action owns the refresh spinner while pending");
  assert.equal(harness.fetchMock.calls.filter(
    (call) => call.method === "GET" && call.url === editorUrl("conflict-locked"),
  ).length, getCountAfterAmbiguousWrite + 2, "rapid double Retry starts one GET");
  assert.equal(patchBodies(harness.fetchMock).length, patchCount, "rapid double Retry remains PATCH-free");
  await duplicateRetryPromise;
  retryTwo.resolve(response(500, { error: "still unavailable" }));
  await retryTwoPromise;
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.local, immutableLocal);
  assert.equal(harness.runner.current.recovery.server, initialServer);
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, true,
    "a repeated failed Retry returns to the same retryable locked state");

  harness.fetchMock.enqueue("GET", editorUrl("conflict-locked"), response(200, {
    project: project("conflict-locked", 3, { script: "latest server" }),
  }));
  await harness.runner.current.retryConflictServerRefresh();
  await settle(harness.runner);
  assert.equal(harness.runner.current.recovery.local, immutableLocal,
    "successful in-dialog retry still preserves the exact immutable local candidate");
  assert.notEqual(harness.runner.current.recovery.server, initialServer,
    "successful in-dialog retry replaces only the server candidate");
  assert.equal(harness.runner.current.recovery.server?.draft.script, "latest server");
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, false,
    "successful in-dialog retry enables the two choices");
  assert.equal(patchBodies(harness.fetchMock).length, patchCount,
    "all in-dialog refresh attempts are GET-only");
  assert.equal(harness.storage.getItem(journalKey), journalBeforeRetry,
    "successful refresh still preserves recovery provenance until an explicit choice");

  harness.runner.current.chooseServerProjectDraft();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.status, "none",
    "a successful refresh re-enables the explicit server choice");
  assert.equal(patchBodies(harness.fetchMock).length, patchCount,
    "the re-enabled server choice remains PATCH-free");
}

async function conflictRefreshLifecycleOwnership(): Promise<void> {
  for (const boundary of ["reset", "project-switch", "unmount"] as const) {
    const projectId = `refresh-${boundary}`;
    const server = new SharedEditorServer();
    server.setProject(projectId, 2, { script: "server" });
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    seedConflictJournal(harness, projectId, { script: "local" }, 1);
    harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
      project: project(projectId, 2, { script: "server" }),
    }));
    harness.fetchMock.enqueueFailure("PATCH", editorUrl(projectId), new Error("ambiguous"));
    harness.fetchMock.enqueueFailure("GET", editorUrl(projectId), new Error("initial refresh unavailable"));
    harness.runner.mount();
    await settle(harness.runner);
    await harness.runner.current.chooseLocalProjectDraft();
    await settle(harness.runner);
    assert.equal(harness.runner.current.recovery.requiresServerRefresh, true);

    const pendingRefresh = deferred<ResponseLike>();
    harness.fetchMock.enqueue("GET", editorUrl(projectId), pendingRefresh.promise);
    const retryPromise = harness.runner.current.retryConflictServerRefresh();
    await settle(harness.runner);
    const retryCalls = harness.fetchMock.calls.filter(
      (call) => call.method === "GET" && call.url === editorUrl(projectId),
    );
    const retrySignal = retryCalls.at(-1)?.init.signal;
    assert.ok(retrySignal, "conflict Retry owns an AbortSignal");
    assert.equal(retrySignal.aborted, false);

    let replacement: ReturnType<typeof createHarness> | null = null;
    if (boundary === "reset") {
      await harness.runner.current.resetProject();
      await settle(harness.runner);
    } else {
      harness.runner.unmount();
      if (boundary === "project-switch") {
        server.setProject("refresh-project-b", 0, { script: "server B" });
        replacement = createHarness({ search: "?projectId=refresh-project-b", server });
        replacement.runner.mount();
        await settle(replacement.runner);
      }
    }
    assert.equal(retrySignal.aborted, true, `${boundary} aborts its stale conflict refresh`);
    const staleSnapshot = {
      projectId: harness.runner.current.projectId,
      projectReady: harness.runner.current.projectReady,
      recovery: harness.runner.current.recovery.status,
      script: harness.runner.current.script,
    };
    pendingRefresh.resolve(response(200, {
      project: project(projectId, 9, { script: "late stale server" }),
    }));
    await retryPromise;
    await settle(harness.runner, 64);
    assert.deepEqual({
      projectId: harness.runner.current.projectId,
      projectReady: harness.runner.current.projectReady,
      recovery: harness.runner.current.recovery.status,
      script: harness.runner.current.script,
    }, staleSnapshot, `${boundary} ignores late conflict refresh callbacks`);
    assert.equal(patchBodies(harness.fetchMock).length, 1,
      `${boundary} stale refresh never starts another PATCH`);
    if (replacement) {
      assert.equal(replacement.runner.current.projectId, "refresh-project-b");
      assert.equal(replacement.runner.current.projectReady, true);
      assert.equal(replacement.runner.current.recovery.status, "none");
      replacement.runner.unmount();
    }
  }
}

function seedConflictJournal(
  harness: { storage: MemoryStorage },
  projectId: string,
  localDraft: JsonRecord,
  baseRevision = 4,
): void {
  journalModule.writeEditorProjectRecoveryJournal(harness.storage, {
    version: 1,
    projectId,
    baseRevision,
    editedAt: "2026-07-15T09:00:00.000Z",
    draft: localDraft,
  });
}

async function localChoiceLifecycleOwnership(): Promise<void> {
  const boundaries = ["reset", "project-switch", "unmount"] as const;
  const outcomes = ["200", "409", "reject"] as const;
  for (const boundary of boundaries) {
    for (const outcome of outcomes) {
      const projectId = `choice-${boundary}-${outcome}`;
      const server = new SharedEditorServer();
      server.setProject(projectId, 5, { script: "server old" });
      const harness = createHarness({ search: `?projectId=${projectId}`, server });
      seedConflictJournal(harness, projectId, { script: "local old" });
      const choiceResponse = deferred<ResponseLike>();
      const choiceJson = deferred<unknown>();
      harness.fetchMock.enqueue(
        "PATCH",
        editorUrl(projectId),
        outcome === "reject"
          ? choiceResponse.promise
          : deferredJsonResponse(outcome === "200" ? 200 : 409, choiceJson.promise),
      );
      harness.runner.mount();
      await settle(harness.runner);
      assert.equal(harness.runner.current.recovery.status, "conflict");
      const choice = harness.runner.current.chooseLocalProjectDraft();
      await settle(harness.runner);
      const choiceBody = patchBodies(harness.fetchMock)[0];
      assert.equal(choiceBody.expectedDraftRevision, 5);
      assert.equal(choiceBody.draftRevision, 6);
      const choiceSignal = autosavePatchCalls(harness.fetchMock, projectId)[0]?.init.signal;
      assert.ok(choiceSignal, "explicit local choice PATCH owns an AbortSignal");

      let replacement: ReturnType<typeof createHarness> | null = null;
      if (boundary === "reset") {
        await harness.runner.current.resetProject();
        await settle(harness.runner);
      } else if (boundary === "project-switch") {
        harness.runner.unmount();
        server.setProject("choice-project-b", 0, { script: "server B" });
        replacement = createHarness({ search: "?projectId=choice-project-b", server });
        replacement.runner.mount();
        await settle(replacement.runner);
      } else {
        harness.runner.unmount();
      }
      assert.equal(choiceSignal.aborted, true, `${boundary} aborts its stale local-choice PATCH`);
      const oldSnapshot = {
        projectId: harness.runner.current.projectId,
        projectReady: harness.runner.current.projectReady,
        script: harness.runner.current.script,
        recovery: harness.runner.current.recovery.status,
        saveStatus: harness.runner.current.saveStatus,
      };
      const oldGetCount = harness.fetchMock.calls.filter(
        (call) => call.method === "GET" && call.url === editorUrl(projectId),
      ).length;
      if (outcome === "200") {
        choiceJson.resolve({
          project: project(projectId, 6, choiceBody.draft as JsonRecord),
        });
      } else if (outcome === "409") {
        choiceJson.resolve({
          project: project(projectId, 7, { script: "late remote old" }),
        });
      } else {
        choiceResponse.reject(new Error("late local-choice rejection"));
      }
      await choice;
      await settle(harness.runner, 64);
      assert.deepEqual({
        projectId: harness.runner.current.projectId,
        projectReady: harness.runner.current.projectReady,
        script: harness.runner.current.script,
        recovery: harness.runner.current.recovery.status,
        saveStatus: harness.runner.current.saveStatus,
      }, oldSnapshot, `${boundary} ignores stale local-choice ${outcome} state callbacks`);
      assert.equal(
        harness.fetchMock.calls.filter(
          (call) => call.method === "GET" && call.url === editorUrl(projectId),
        ).length,
        oldGetCount,
        `${boundary} does not refresh after stale local-choice ${outcome}`,
      );

      const activeHarness = replacement ?? (boundary === "reset" ? harness : null);
      if (activeHarness) {
        const activeProjectId = activeHarness.runner.current.projectId;
        assert.ok(activeProjectId && activeProjectId !== projectId);
        assert.equal(activeHarness.runner.current.projectReady, true);
        activeHarness.runner.current.setScript(`new project survives ${boundary}-${outcome}`);
        activeHarness.runner.flush();
        activeHarness.clock.advance(1_000);
        await settle(activeHarness.runner, 64);
        const activeBodies = autosavePatchCalls(activeHarness.fetchMock, activeProjectId)
          .map((call) => JSON.parse(call.init.body ?? "{}") as JsonRecord);
        assert.equal(activeBodies.length, 1, "the replacement project still autosaves exactly once");
        assert.equal(activeBodies[0].expectedDraftRevision, boundary === "reset" ? 0 : 0);
        assert.equal((activeBodies[0].draft as JsonRecord).script, `new project survives ${boundary}-${outcome}`);
        assert.equal(activeHarness.runner.current.saveStatus, "saved");
      }
    }
  }
}

async function unavailableLogoLocalChoicePreservesConflict(): Promise<void> {
  const projectId = "choice-unavailable-logo";
  const harness = createHarness({ search: `?projectId=${projectId}` });
  seedConflictJournal(harness, projectId, {
    script: "local with retired logo",
    logoOverlay: {
      enabled: true,
      assetId: "private-retired-logo-id",
      position: "top-right",
      sizePct: 18,
      opacity: 0.9,
    },
  });
  harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
    project: project(projectId, 5, { script: "server five" }),
  }));
  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), response(422, {
    error: "brand_asset_unavailable",
    message: "ไม่พบไฟล์โลโก้ กรุณาอัปโหลดใหม่",
  }));
  harness.runner.mount();
  await settle(harness.runner);
  const immutableLocal = harness.runner.current.recovery.local;
  const immutableServer = harness.runner.current.recovery.server;
  const journalKey = journalModule.editorProjectRecoveryKey(projectId);
  const journalBefore = harness.storage.getItem(journalKey);

  await harness.runner.current.chooseLocalProjectDraft();
  await settle(harness.runner);

  assert.equal(harness.runner.current.recovery.status, "conflict");
  assert.equal(harness.runner.current.recovery.local, immutableLocal,
    "422 preserves the exact local conflict candidate");
  assert.equal(harness.runner.current.recovery.server, immutableServer,
    "422 preserves the exact server conflict candidate");
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, false);
  assert.equal(
    harness.runner.current.recovery.error,
    "ไม่พบไฟล์โลโก้เดิม กรุณาอัปโหลดโลโก้ใหม่แล้วเลือกอีกครั้ง",
  );
  assert.equal(harness.storage.getItem(journalKey), journalBefore,
    "422 preserves the exact recovery journal");
  assert.equal(
    harness.fetchMock.calls.filter(
      (call) => call.method === "GET" && call.url === editorUrl(projectId),
    ).length,
    1,
    "a definite unavailable response does not perform ambiguous GET reconciliation",
  );

  const patchCount = patchBodies(harness.fetchMock).length;
  harness.runner.current.chooseServerProjectDraft();
  harness.runner.flush();
  assert.equal(harness.runner.current.recovery.status, "none",
    "the unchanged server choice remains available after a Logo 422");
  assert.equal(harness.runner.current.script, "server five");
  assert.equal(harness.storage.getItem(journalKey), null,
    "only the later explicit server choice clears the journal");
  assert.equal(patchBodies(harness.fetchMock).length, patchCount,
    "server choice remains PATCH-free after a Logo 422");
}

async function lifecycleConflictRefreshesWithoutAcknowledgement(): Promise<void> {
  const projectId = "choice-lifecycle-conflict";
  const harness = createHarness({ search: `?projectId=${projectId}` });
  seedConflictJournal(harness, projectId, { script: "local lifecycle choice" });
  harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
    project: project(projectId, 5, { script: "server five" }),
  }));
  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), response(409, {
    error: "brand_asset_lifecycle_conflict",
  }));
  harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
    project: project(projectId, 6, { script: "authoritative six" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  const immutableLocal = harness.runner.current.recovery.local;
  const journalKey = journalModule.editorProjectRecoveryKey(projectId);
  const journalBefore = harness.storage.getItem(journalKey);

  await harness.runner.current.chooseLocalProjectDraft();
  await settle(harness.runner);

  assert.equal(harness.runner.current.recovery.status, "conflict");
  assert.equal(harness.runner.current.recovery.local, immutableLocal,
    "lifecycle 409 preserves the exact local candidate");
  assert.equal(harness.runner.current.recovery.server?.revision, 6);
  assert.equal(harness.runner.current.recovery.server?.draft.script, "authoritative six");
  assert.equal(harness.runner.current.recovery.resolving, false);
  assert.equal(harness.runner.current.recovery.requiresServerRefresh, false);
  assert.equal(harness.runner.current.projectReady, false,
    "lifecycle 409 cannot acknowledge the local choice");
  assert.equal(harness.storage.getItem(journalKey), journalBefore,
    "lifecycle 409 preserves the recovery journal");
  assert.equal(
    harness.fetchMock.calls.filter(
      (call) => call.method === "GET" && call.url === editorUrl(projectId),
    ).length,
    2,
    "lifecycle 409 performs authoritative GET reconciliation",
  );
}

async function exactLocalChoiceAcknowledgement(): Promise<void> {
  const projectId = "choice-exact-ack";
  const harness = createHarness({ search: `?projectId=${projectId}` });
  seedConflictJournal(harness, projectId, { script: "local exact" });
  harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
    project: project(projectId, 5, { script: "server five" }),
  }));
  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), response(200, {
    project: project(projectId, 6, { script: "local exact" }),
  }));
  harness.runner.mount();
  await settle(harness.runner);
  await harness.runner.current.chooseLocalProjectDraft();
  await settle(harness.runner);
  assert.deepEqual({
    recovery: harness.runner.current.recovery.status,
    projectReady: harness.runner.current.projectReady,
    script: harness.runner.current.script,
    saveStatus: harness.runner.current.saveStatus,
    journal: journalModule.readEditorProjectRecoveryJournal(harness.storage, projectId),
  }, {
    recovery: "none",
    projectReady: true,
    script: "local exact",
    saveStatus: "saved",
    journal: null,
  }, "an exact local-choice revision and fingerprint is acknowledged");
}

async function mismatchedLocalChoiceAcknowledgementsRefresh(): Promise<void> {
  const variants: Array<{
    label: string;
    responseProject: JsonRecord;
  }> = [
    {
      label: "foreign project",
      responseProject: project("choice-foreign", 6, { script: "local mismatch" }),
    },
    {
      label: "wrong revision",
      responseProject: project("choice-mismatch", 7, { script: "local mismatch" }),
    },
    {
      label: "wrong fingerprint",
      responseProject: project("choice-mismatch", 6, { script: "forged response" }),
    },
  ];
  for (const variant of variants) {
    const projectId = "choice-mismatch";
    const harness = createHarness({ search: `?projectId=${projectId}` });
    seedConflictJournal(harness, projectId, { script: "local mismatch" });
    harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
      project: project(projectId, 5, { script: "server five" }),
    }));
    harness.fetchMock.enqueue("PATCH", editorUrl(projectId), response(200, {
      project: variant.responseProject,
    }));
    harness.fetchMock.enqueue("GET", editorUrl(projectId), response(200, {
      project: project(projectId, 5, { script: "server five" }),
    }));
    harness.runner.mount();
    await settle(harness.runner);
    const immutableLocal = harness.runner.current.recovery.local;
    const journalBefore = harness.storage.getItem(journalModule.editorProjectRecoveryKey(projectId));
    await harness.runner.current.chooseLocalProjectDraft();
    await settle(harness.runner);
    assert.deepEqual({
      recovery: harness.runner.current.recovery.status,
      projectReady: harness.runner.current.projectReady,
      localIdentity: harness.runner.current.recovery.local === immutableLocal,
      serverRevision: harness.runner.current.recovery.server?.revision,
      journal: harness.storage.getItem(journalModule.editorProjectRecoveryKey(projectId)),
      getCount: harness.fetchMock.calls.filter(
        (call) => call.method === "GET" && call.url === editorUrl(projectId),
      ).length,
      saveStatus: harness.runner.current.saveStatus,
    }, {
      recovery: "conflict",
      projectReady: false,
      localIdentity: true,
      serverRevision: 5,
      journal: journalBefore,
      getCount: 2,
      saveStatus: "idle",
    }, `${variant.label} 200 is ambiguous and refreshes without acknowledging`);
  }
}

async function invalidLatestLocalShowsRecoveryState(): Promise<void> {
  const projectId = "invalid-latest-local";
  const server = new SharedEditorServer();
  server.setProject(projectId, 0, { script: "base" });
  const harness = createHarness({ search: `?projectId=${projectId}`, server });
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setBgmVolume(Number.NaN);
  assert.equal(harness.runner.current.__debugAutosaveLineage().blocked, true,
    "invalid explicit materialization blocks synchronously at the setter boundary");
  assert.equal(autosavePatchCalls(harness.fetchMock, projectId).length, 0,
    "invalid explicit materialization cannot issue a PATCH before render");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  assert.deepEqual({
    projectReady: harness.runner.current.projectReady,
    recovery: harness.runner.current.recovery.status,
    patches: autosavePatchCalls(harness.fetchMock, projectId).length,
  }, {
    projectReady: false,
    recovery: "load-error",
    patches: 0,
  }, "an unmaterializable explicit local draft locks into a visible recovery state");
}

async function invalidStagingIgnoresLateAutosaveSuccess(): Promise<void> {
  const projectId = "invalid-latest-local-in-flight";
  const server = new SharedEditorServer();
  server.setProject(projectId, 0, { script: "base" });
  const patchA = deferred<ResponseLike>();
  const harness = createHarness({ search: `?projectId=${projectId}`, server });
  harness.fetchMock.enqueue("PATCH", editorUrl(projectId), patchA.promise);
  harness.runner.mount();
  await settle(harness.runner);
  harness.runner.current.setScript("valid A");
  harness.runner.flush();
  harness.clock.advance(1_000);
  await settle(harness.runner);
  const bodyA = patchBodies(harness.fetchMock)[0];

  harness.runner.current.setBgmVolume(Number.NaN);
  assert.equal(harness.runner.current.__debugAutosaveLineage().blocked, true);
  server.setProject(projectId, bodyA.draftRevision as number, bodyA.draft as JsonRecord);
  patchA.resolve(response(200, {
    project: project(projectId, bodyA.draftRevision as number, bodyA.draft as JsonRecord),
  }));
  await drainMicrotasksWithoutRender();
  harness.runner.flush();
  assert.deepEqual({
    projectReady: harness.runner.current.projectReady,
    recovery: harness.runner.current.recovery.status,
    saveStatus: harness.runner.current.saveStatus,
    confirmedRevision: harness.runner.current.__debugAutosaveLineage().confirmedRevision,
    patches: autosavePatchCalls(harness.fetchMock, projectId).length,
  }, {
    projectReady: false,
    recovery: "load-error",
    saveStatus: "error",
    confirmedRevision: 0,
    patches: 1,
  }, "a late success cannot acknowledge or publish saved after explicit staging failed closed");
}

function assertBoundedIssuedTracker(
  harness: ReturnType<typeof createHarness>,
  expectedMaximum: number,
  maximumBytes: number,
  label: string,
): void {
  const debug = harness.runner.current.__debugAutosaveLineage();
  assert.ok(debug.issuedSize <= expectedMaximum,
    `${label}: issued snapshots stay bounded (received ${debug.issuedSize})`);
  assert.ok(debug.issuedDraftBytes <= maximumBytes,
    `${label}: retained full-draft bytes stay bounded (received ${debug.issuedDraftBytes})`);
}

async function issuedSnapshotsStayBounded(): Promise<void> {
  const large = "x".repeat(32_768);

  {
    const projectId = "bounded-success";
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, { script: "base" });
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    harness.runner.mount();
    await settle(harness.runner);
    for (let index = 0; index < 16; index += 1) {
      harness.runner.current.setScript(`${large}-success-${index}`);
      harness.runner.flush();
      harness.clock.advance(1_000);
      await settle(harness.runner);
      assertBoundedIssuedTracker(harness, 0, 0, `successful save ${index}`);
    }
  }

  {
    const projectId = "bounded-error";
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, { script: "base" });
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    harness.runner.mount();
    await settle(harness.runner);
    for (let index = 0; index < 16; index += 1) {
      harness.fetchMock.enqueue("PATCH", editorUrl(projectId), response(500, { error: "definite" }));
      harness.runner.current.setScript(`${large}-error-${index}`);
      harness.runner.flush();
      harness.clock.advance(1_000);
      await settle(harness.runner);
      assertBoundedIssuedTracker(harness, 0, 0, `definite error ${index}`);
    }
  }

  {
    const projectId = "bounded-coalesced";
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, { script: "base" });
    const firstResponse = deferred<ResponseLike>();
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    harness.fetchMock.enqueue("PATCH", editorUrl(projectId), firstResponse.promise);
    harness.runner.mount();
    await settle(harness.runner);
    harness.runner.current.setScript(`${large}-coalesced-0`);
    harness.runner.flush();
    harness.clock.advance(1_000);
    await settle(harness.runner);
    for (let index = 1; index < 8; index += 1) {
      harness.runner.current.setScript(`${large}-coalesced-${index}`);
      harness.runner.flush();
      harness.clock.advance(1_000);
      await settle(harness.runner);
      assertBoundedIssuedTracker(harness, 1, large.length + 4_096, `coalesced pending ${index}`);
    }
    const firstBody = patchBodies(harness.fetchMock)[0];
    server.setProject(projectId, firstBody.draftRevision as number, firstBody.draft as JsonRecord);
    firstResponse.resolve(response(200, {
      project: project(projectId, firstBody.draftRevision as number, firstBody.draft as JsonRecord),
    }));
    await settle(harness.runner, 64);
    assertBoundedIssuedTracker(harness, 0, 0, "coalesced completion");
    const durableCoalescedScript = String((server.read(projectId)?.draft as JsonRecord).script);
    assert.equal(
      durableCoalescedScript.endsWith("-coalesced-7"),
      true,
      "the last large coalesced draft remains the durable save",
    );
  }

  {
    const projectId = "bounded-timeout";
    const server = new SharedEditorServer();
    server.setProject(projectId, 0, { script: "base" });
    const harness = createHarness({ search: `?projectId=${projectId}`, server });
    harness.runner.mount();
    await settle(harness.runner);
    for (let index = 0; index < 10; index += 1) {
      const lostResponse = deferred<ResponseLike>();
      harness.fetchMock.enqueue("PATCH", editorUrl(projectId), lostResponse.promise);
      harness.runner.current.setScript(`${large}-timeout-${index}`);
      harness.runner.flush();
      harness.clock.advance(1_000);
      await settle(harness.runner);
      assertBoundedIssuedTracker(harness, 1, large.length + 4_096, `timeout in flight ${index}`);
      const body = patchBodies(harness.fetchMock).at(-1)!;
      if (index % 2 === 0) {
        server.setProject(projectId, body.draftRevision as number, body.draft as JsonRecord);
      }
      harness.clock.advance(10_000);
      await settle(harness.runner, 64);
      assertBoundedIssuedTracker(harness, 0, 0, `timeout reconciled ${index}`);
      assert.equal(
        String((server.read(projectId)?.draft as JsonRecord).script).endsWith(`-timeout-${index}`),
        true,
        `timeout ${index} preserves the exact large draft`,
      );
    }
  }
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
    ["same-tick-conflict-mutation-gate", conflictBlocksSettersBeforeRecoveryRerender],
    ["timeout-committed", timeoutCommittedIsAcknowledgedByFingerprint],
    ["timeout-not-committed", timeoutNotCommittedRetriesSameImmutableAttempt],
    ["same-revision-different-draft", sameNumericRevisionWithDifferentDraftConflicts],
    ["coalesced-confirmed-base", suppressedIntermediateAcknowledgementAdvancesBase],
    ["pending-waits-for-reconcile", pendingDraftWaitsForReconciliationAndBecomesLatestConflict],
    ["setter-boundary-staging", explicitSetterStagesBeforePassiveEffects],
    ["raw-hydration-provenance", rawHydrationDoesNotStageExplicitLocal],
    ["newer-journal-survives-older-ack", olderAcknowledgementCannotClearNewerStagedJournal],
    ["late-lifecycle-callbacks", resetAndUnmountIgnoreLateAutosaveObservation],
    ["late-patch-callbacks", resetAndUnmountIgnoreLatePatchResponse],
    ["second-ambiguity-refresh", secondAmbiguityLocksUntilGetOnlyRefresh],
    ["settings-after-GET", settingsAfterServerHydration],
    ["paid-brand-visual-default", paidBrandVisualDefaultsNewProjectToRecommendedAutoMix],
    ["paid-brand-visual-existing-choice", paidBrandVisualHydrationPreservesExistingMixChoice],
    ["equal-revision-resume", exactEqualRevisionResume],
    ["blank-bootstrap-initialization", blankBootstrapBlocksUserMutationDuringInitialization],
    ["explicit-empty-bootstrap", explicitEmptyBootstrapStaysUnpersisted],
    ["reset-initialization", resetBlocksUserMutationWhileDefaultsLoad],
    ["reset-saved-voice-defaults", resetInheritsSavedVoiceSettings],
    ["blank-bootstrap-saved-voice-defaults", blankBootstrapInheritsSavedVoiceSettings],
    ["superseded-reset-initialization", supersededResetCannotCompleteInitialization],
    ["blank-bootstrap-unmount", unmountWhileBlankBootstrapAwaitsDefaults],
    ["account-default-failure", accountDefaultFailureFailsClosed],
    ["project-creation-failure", projectCreationFailureFailsClosed],
    ["stale-stored-pointer-fallback", staleStoredPointerFallsBackToActiveProject],
    ["stale-stored-pointer-empty", staleStoredPointerWithoutActiveProjectBecomesEmpty],
    ["explicit-missing-project", explicitMissingProjectFailsClosed],
    ["stored-project-5xx-retains-pointer", storedProjectServerErrorRetainsPointer],
    ["stale-pointer-list-failure-retains-retry", stalePointerListFailureRetainsRetryTarget],
    ["stale-pointer-fallback-race", stalePointerSkipsProjectArchivedDuringFallback],
    ["reset-during-GET", resetDuringProjectGet],
    ["reset-unmount-during-brand", unmountWhileResetAwaitsBrandAssets],
    ["reset-unmount-during-POST", unmountWhileResetPostIsPending],
    ["functional-public-setters", publicSetterRuntimeContract],
    ["pending-upload-before-brand-pin", pendingUploadFlushesBeforeAuthoritativeBrandPin],
    ["journal-write-failure", failedJournalWriteStillAutosaves],
    ["project-switching", projectScopedSwitching],
    ["StrictMode-setup-cleanup", strictModeDoesNotDuplicateWrites],
    ["ambiguous-local-choice", ambiguousLocalChoiceRefreshesServer],
    ["malformed-409-refresh", malformedConflictResponsesRefreshAuthoritatively],
    ["ambiguous-refresh-retry", failedAmbiguousRefreshRetriesGetOnly],
    ["conflict-refresh-lifecycle", conflictRefreshLifecycleOwnership],
    ["local-choice-lifecycle-ownership", localChoiceLifecycleOwnership],
    ["local-choice-unavailable-logo", unavailableLogoLocalChoicePreservesConflict],
    ["local-choice-lifecycle-conflict", lifecycleConflictRefreshesWithoutAcknowledgement],
    ["local-choice-exact-ack", exactLocalChoiceAcknowledgement],
    ["local-choice-mismatch", mismatchedLocalChoiceAcknowledgementsRefresh],
    ["invalid-latest-local", invalidLatestLocalShowsRecoveryState],
    ["invalid-staging-late-success", invalidStagingIgnoresLateAutosaveSuccess],
    ["bounded-issued-snapshots", issuedSnapshotsStayBounded],
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
  const resetReadyAfterDefaults = hookSource
    .replace(
      `    setProjectReady(false);
    setProjectInitialization("loading-defaults");`,
      `    setProjectInitialization("loading-defaults");`,
    )
    .replace(
      `    if (!isCurrentReset()) return null;
    setProjectInitialization("creating-project");
    const nextPreset`,
      `    if (!isCurrentReset()) return null;
    setProjectReady(false);
    setProjectInitialization("creating-project");
    const nextPreset`,
    );
  assert.notEqual(resetReadyAfterDefaults, hookSource, "deferred Reset readiness mutation applied");
  activeCompiledHook = compileHook(resetReadyAfterDefaults);
  await assert.rejects(
    resetBlocksUserMutationWhileDefaultsLoad,
    /Reset blocks project readiness/,
    "runtime harness rejects Reset that remains ready while defaults are pending",
  );

  const missingInitializationGuard = hookSource.replace(
    `    if (!canAcceptUserMutation()) return;
    setSynchronized(next);`,
    `    setSynchronized(next);`,
  );
  assert.notEqual(missingInitializationGuard, hookSource, "initialization setter-guard mutation applied");
  activeCompiledHook = compileHook(missingInitializationGuard);
  await assert.rejects(
    blankBootstrapBlocksUserMutationDuringInitialization,
    /rejects a real user setter|must-not-survive-bootstrap|attempted bootstrap value/,
    "runtime harness rejects a public setter that mutates during blank bootstrap",
  );

  const supersededDefaultPublishesReady = hookSource.replace(
    `    if (!isCurrentReset()) return null;
    setProjectInitialization("creating-project");
    const nextPreset`,
    `    if (!isCurrentReset()) {
      setProjectInitialization("ready");
      return null;
    }
    setProjectInitialization("creating-project");
    const nextPreset`,
  );
  assert.notEqual(supersededDefaultPublishesReady, hookSource,
    "superseded default ownership mutation applied");
  activeCompiledHook = compileHook(supersededDefaultPublishesReady);
  await assert.rejects(
    supersededResetCannotCompleteInitialization,
    /superseded default completion cannot publish ready/,
    "runtime harness rejects a superseded default completion that publishes ready",
  );

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
    "      ?? trustedResumeDraftRef.current\n",
    "",
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
      settleProjectDraftFlushWaiters(null, false);
      autosaveLineageRef.current?.issued.clear();
      autosaveGenerationRef.current += 1;
      autosaveLineageRef.current = null;
      latestDraftRef.current = null;
      stagedUserDraftMutationTokenRef.current = 0;
      localChoiceGenerationRef.current += 1;
      localChoiceAbortControllerRef.current?.abort();
      localChoiceAbortControllerRef.current = null;
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

  const localChoiceWithoutSignal = hookSource.replace(
    `        }),
        signal: controller.signal,
      });
      if (!stillCurrentChoice()) return;`,
    `        }),
      });
      if (!stillCurrentChoice()) return;`,
  );
  assert.notEqual(localChoiceWithoutSignal, hookSource, "local-choice signal mutation applied");
  activeCompiledHook = compileHook(localChoiceWithoutSignal);
  await assert.rejects(
    localChoiceLifecycleOwnership,
    /owns an AbortSignal/,
    "runtime harness rejects a local-choice PATCH without request cancellation",
  );

  const localChoiceWithoutFingerprint = hookSource.replace(
    "        && savedAutosaveCandidate.fingerprint === choiceSnapshot.fingerprint;",
    ";",
  );
  assert.notEqual(localChoiceWithoutFingerprint, hookSource, "local-choice fingerprint mutation applied");
  activeCompiledHook = compileHook(localChoiceWithoutFingerprint);
  await assert.rejects(
    mismatchedLocalChoiceAcknowledgementsRefresh,
    /wrong fingerprint/,
    "runtime harness rejects a 200 accepted by revision without matching fingerprint",
  );

  const unavailableLogoAcknowledged = hookSource.replace(
    `      if (res.status === 422 && payload?.error === "brand_asset_unavailable") {
        setRecoveryState({
          ...conflict,
          resolving: false,
          error: "ไม่พบไฟล์โลโก้เดิม กรุณาอัปโหลดโลโก้ใหม่แล้วเลือกอีกครั้ง",
        });
        return;
      }`,
    `      if (res.status === 422 && payload?.error === "brand_asset_unavailable") {
        clearProjectRecoveryData(projectId);
        setProjectReady(true);
        setRecoveryState({ status: "none" });
        return;
      }`,
  );
  assert.notEqual(unavailableLogoAcknowledged, hookSource,
    "unavailable-Logo acknowledgement mutation applied");
  activeCompiledHook = compileHook(unavailableLogoAcknowledged);
  await assert.rejects(
    unavailableLogoLocalChoicePreservesConflict,
    /422|conflict|candidate|journal/,
    "runtime harness rejects a Logo 422 that acknowledges the choice or clears its journal",
  );

  const resetWithoutChoiceInvalidation = hookSource.replace(
    "const resetProject = useCallback(async (): Promise<string | null> => {\n    invalidateLocalChoiceRequest();",
    "const resetProject = useCallback(async (): Promise<string | null> => {",
  );
  assert.notEqual(resetWithoutChoiceInvalidation, hookSource, "reset choice invalidation mutation applied");
  activeCompiledHook = compileHook(resetWithoutChoiceInvalidation);
  await assert.rejects(
    localChoiceLifecycleOwnership,
    /reset aborts its stale local-choice PATCH/,
    "runtime harness rejects Reset that leaves a local choice request alive",
  );

  const retryCallingLocalChoice = hookSource.replace(
    `    setRecoveryState({ ...conflict, resolving: "refresh", error: null });
    await refreshConflictAfterAmbiguousWrite(projectId, conflict, {
      signal: controller.signal,
      isCurrent: stillCurrentRefresh,
    });`,
    `    setRecoveryState({ ...conflict, resolving: false, requiresServerRefresh: false, error: null });
    await chooseLocalProjectDraft();`,
  );
  assert.notEqual(retryCallingLocalChoice, hookSource, "GET-only Retry choice mutation applied");
  activeCompiledHook = compileHook(retryCallingLocalChoice);
  await assert.rejects(
    failedAmbiguousRefreshRetriesGetOnly,
    /GET|PATCH|refresh|server candidate/,
    "runtime harness rejects a Retry action that invokes the local PATCH choice",
  );

  const failedRefreshRestoringLocalSpinner = hookSource.replace(
    `    } catch {
      if (!stillResolvingThisConflict()) return;
      setRecoveryState({
        status: "conflict",
        local: conflict.local,
        server: conflict.server,
        resolving: false,
        requiresServerRefresh: true,`,
    `    } catch {
      if (!stillResolvingThisConflict()) return;
      setRecoveryState({
        status: "conflict",
        local: conflict.local,
        server: conflict.server,
        resolving: "local",
        requiresServerRefresh: true,`,
  );
  assert.notEqual(failedRefreshRestoringLocalSpinner, hookSource,
    "failed-refresh choice-spinner mutation applied");
  activeCompiledHook = compileHook(failedRefreshRestoringLocalSpinner);
  await assert.rejects(
    failedAmbiguousRefreshRetriesGetOnly,
    /failed refresh|resolving|retryable locked conflict/,
    "runtime harness rejects a failed refresh that restores the local-choice spinner",
  );

  const invalidLocalWithoutRecovery = hookSource.replace(
    `      setRecoveryState({
        status: "load-error",
        message: "ข้อมูลฉบับแก้ไขไม่สมบูรณ์ กรุณาลองโหลดโปรเจกต์อีกครั้ง",
      });`,
    "",
  );
  assert.notEqual(invalidLocalWithoutRecovery, hookSource, "invalid-local recovery mutation applied");
  activeCompiledHook = compileHook(invalidLocalWithoutRecovery);
  await assert.rejects(
    invalidLatestLocalShowsRecoveryState,
    /visible recovery state/,
    "runtime harness rejects an invalid local draft that leaves recovery hidden",
  );

  const passiveOnlyLatestLocal = hookSource.replace(
    "    stageExplicitUserDraftMutationRef.current();\n",
    "",
  );
  assert.notEqual(passiveOnlyLatestLocal, hookSource, "passive-only latest-local mutation applied");
  activeCompiledHook = compileHook(passiveOnlyLatestLocal);
  await assert.rejects(
    explicitSetterStagesBeforePassiveEffects,
    /functional|synchronous|latestLocalDraft|in-flight A/,
    "runtime harness rejects latest-local capture that waits for passive effects",
  );

  const noAcknowledgementPruning = hookSource.replace(
    `  for (const revision of tracker.issued.keys()) {
    if (revision <= confirmedRevision) tracker.issued.delete(revision);
  }`,
    `  void tracker;
  void confirmedRevision;`,
  );
  assert.notEqual(noAcknowledgementPruning, hookSource, "issued pruning mutation applied");
  activeCompiledHook = compileHook(noAcknowledgementPruning);
  await assert.rejects(
    issuedSnapshotsStayBounded,
    /issued snapshots stay bounded/,
    "runtime harness rejects an issued tracker that retains acknowledged full drafts",
  );
  activeCompiledHook = compileHook(hookSource);
}

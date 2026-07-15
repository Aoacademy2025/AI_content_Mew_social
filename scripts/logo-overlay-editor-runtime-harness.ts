import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as logoOverlayModule from "../src/lib/logo-overlay";
import type { BrandAssetView, LogoOverlayConfig } from "../src/lib/logo-overlay";

type ResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type FetchInit = {
  method?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
};

type FetchCall = {
  url: string;
  method: string;
  init: FetchInit;
};

type TelemetryCall = {
  name: string;
  input: unknown;
};

type LogoHook = {
  asset: BrandAssetView | null;
  saving: boolean;
  error: string | null;
  upload(file: File): Promise<boolean>;
};

type LogoHookInput = {
  projectId: string | null;
  eligible: boolean;
  value: LogoOverlayConfig | undefined;
  onChange: (next: LogoOverlayConfig | undefined) => void;
  projectSaveStatus: "idle" | "saving" | "saved" | "error";
  onRetryProjectSave: () => void;
  surface: "desktop" | "mobile";
};

type StateSlot = {
  kind: "state";
  value: unknown;
  setter: (next: unknown) => void;
};
type RefSlot = { kind: "ref"; value: { current: unknown } };
type MemoSlot = {
  kind: "memo";
  value: unknown;
  deps: readonly unknown[] | undefined;
};
type EffectSlot = {
  kind: "effect";
  phase: "layout" | "passive";
  create: () => void | (() => void);
  deps: readonly unknown[] | undefined;
  cleanup?: () => void;
};
type HookSlot = StateSlot | RefSlot | MemoSlot | EffectSlot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function depsEqual(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined,
): boolean {
  return !!left
    && !!right
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

class HookRunner<T> {
  private readonly slots: HookSlot[] = [];
  private readonly pendingLayoutEffects = new Set<number>();
  private readonly pendingEffects = new Set<number>();
  private cursor = 0;
  private dirty = false;
  private mounted = false;
  current!: T;
  postUnmountStateWrites = 0;

  constructor(private readonly hook: () => T) {}

  private registerEffect(
    phase: "layout" | "passive",
    create: () => void | (() => void),
    deps?: readonly unknown[],
  ): void {
    const index = this.cursor++;
    let slot = this.slots[index] as EffectSlot | undefined;
    if (!slot) {
      slot = { kind: "effect", phase, create, deps: undefined };
      this.slots[index] = slot;
    }
    assert.equal(slot.kind, "effect");
    assert.equal(slot.phase, phase, "hook effect phase changed between renders");
    slot.create = create;
    if (!depsEqual(slot.deps, deps)) {
      slot.deps = deps ? [...deps] : undefined;
      (phase === "layout" ? this.pendingLayoutEffects : this.pendingEffects).add(index);
    }
  }

  readonly react = {
    useState: <V,>(initial: V | (() => V)): [V, (next: V | ((value: V) => V)) => void] => {
      const index = this.cursor++;
      let slot = this.slots[index] as StateSlot | undefined;
      if (!slot) {
        slot = {
          kind: "state",
          value: typeof initial === "function" ? (initial as () => V)() : initial,
          setter: (next: unknown) => {
            if (!this.mounted) this.postUnmountStateWrites += 1;
            const previous = slot!.value as V;
            slot!.value = typeof next === "function"
              ? (next as (value: V) => V)(previous)
              : next;
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
    useMemo: <V,>(factory: () => V, deps: readonly unknown[]): V => {
      const index = this.cursor++;
      let slot = this.slots[index] as MemoSlot | undefined;
      if (!slot || !depsEqual(slot.deps, deps)) {
        slot = { kind: "memo", value: factory(), deps: [...deps] };
        this.slots[index] = slot;
      }
      return slot.value as V;
    },
    useLayoutEffect: (
      create: () => void | (() => void),
      deps?: readonly unknown[],
    ): void => this.registerEffect("layout", create, deps),
    useEffect: (
      create: () => void | (() => void),
      deps?: readonly unknown[],
    ): void => this.registerEffect("passive", create, deps),
  };

  mount(): void {
    this.mounted = true;
    this.dirty = true;
    this.flush();
  }

  rerender(): void {
    assert.equal(this.mounted, true, "cannot rerender an unmounted hook");
    this.dirty = true;
    this.flush();
  }

  renderWithoutCommit(): T {
    assert.equal(this.mounted, true, "cannot render an unmounted hook");
    const previousCurrent = this.current;
    const previousDirty = this.dirty;
    const previousCursor = this.cursor;
    const previousLength = this.slots.length;
    const pendingLayouts = [...this.pendingLayoutEffects];
    const pendingPassives = [...this.pendingEffects];
    const snapshots = this.slots.map((slot) => {
      if (slot.kind === "state") return { kind: slot.kind, value: slot.value } as const;
      if (slot.kind === "memo") {
        return {
          kind: slot.kind,
          value: slot.value,
          deps: slot.deps ? [...slot.deps] : undefined,
        } as const;
      }
      if (slot.kind === "effect") {
        return {
          kind: slot.kind,
          phase: slot.phase,
          create: slot.create,
          deps: slot.deps ? [...slot.deps] : undefined,
          cleanup: slot.cleanup,
        } as const;
      }
      return { kind: slot.kind } as const;
    });

    this.dirty = false;
    this.cursor = 0;
    const rendered = this.hook();

    this.slots.splice(previousLength);
    snapshots.forEach((snapshot, index) => {
      const slot = this.slots[index];
      if (snapshot.kind === "ref") return;
      if (snapshot.kind === "state" && slot.kind === "state") {
        slot.value = snapshot.value;
        return;
      }
      if (snapshot.kind === "memo" && slot.kind === "memo") {
        slot.value = snapshot.value;
        slot.deps = snapshot.deps;
        return;
      }
      if (snapshot.kind === "effect" && slot.kind === "effect") {
        slot.phase = snapshot.phase;
        slot.create = snapshot.create;
        slot.deps = snapshot.deps;
        slot.cleanup = snapshot.cleanup;
      }
    });
    this.pendingLayoutEffects.clear();
    pendingLayouts.forEach((index) => this.pendingLayoutEffects.add(index));
    this.pendingEffects.clear();
    pendingPassives.forEach((index) => this.pendingEffects.add(index));
    this.current = previousCurrent;
    this.dirty = previousDirty;
    this.cursor = previousCursor;
    return rendered;
  }

  private commitEffects(pending: Set<number>): void {
    const effects = [...pending];
    pending.clear();
    for (const index of effects) {
      const slot = this.slots[index] as EffectSlot;
      slot.cleanup?.();
      slot.cleanup = slot.create() || undefined;
    }
  }

  flush(): void {
    let guard = 0;
    while (
      (this.dirty || this.pendingLayoutEffects.size > 0 || this.pendingEffects.size > 0)
      && guard++ < 100
    ) {
      if (this.dirty) {
        this.dirty = false;
        this.cursor = 0;
        this.current = this.hook();
      }
      this.commitEffects(this.pendingLayoutEffects);
      if (this.dirty) continue;
      this.commitEffects(this.pendingEffects);
    }
    assert.ok(guard < 100, "logo hook reached a stable render");
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const phase of ["layout", "passive"] as const) {
      for (const slot of this.slots) {
        if (slot?.kind === "effect" && slot.phase === phase) slot.cleanup?.();
      }
    }
  }
}

class TaskScheduler {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void | Promise<void>>();

  setTimeout = (task: () => void | Promise<void>): number => {
    const id = this.nextId++;
    this.tasks.set(id, task);
    return id;
  };

  clearTimeout = (id: number): void => {
    this.tasks.delete(id);
  };

  async runAll(): Promise<void> {
    let guard = 0;
    while (this.tasks.size > 0 && guard++ < 100) {
      const tasks = [...this.tasks.values()];
      this.tasks.clear();
      for (const task of tasks) await task();
    }
    assert.ok(guard < 100, "logo cleanup scheduler reached its retry bound");
  }
}

class FetchMock {
  readonly calls: FetchCall[] = [];
  readonly deletedAssetIds: string[] = [];
  private readonly uploadRoutes: Array<{
    result: Promise<ResponseLike>;
    honorAbort: boolean;
  }> = [];

  enqueueUpload(result: ResponseLike | Promise<ResponseLike>, honorAbort = true): void {
    this.uploadRoutes.push({ result: Promise.resolve(result), honorAbort });
  }

  private withAbort(
    result: Promise<ResponseLike>,
    signal: AbortSignal | undefined,
  ): Promise<ResponseLike> {
    if (!signal) return result;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<ResponseLike>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError());
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

  fetch = (urlValue: unknown, initValue: unknown = {}): Promise<ResponseLike> => {
    const url = String(urlValue);
    const init = initValue as FetchInit;
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ url, method, init });
    if (url === "/api/user/brand-assets" && method === "POST") {
      const route = this.uploadRoutes.shift();
      if (!route) throw new Error("missing queued logo upload response");
      return route.honorAbort
        ? this.withAbort(route.result, init.signal)
        : route.result;
    }
    if (url.startsWith("/api/user/brand-assets/") && method === "DELETE") {
      const encodedId = url.slice("/api/user/brand-assets/".length);
      this.deletedAssetIds.push(decodeURIComponent(encodedId));
      return Promise.resolve(response(200, { ok: true }));
    }
    if (url.startsWith("/api/user/brand-assets/") && method === "GET") {
      const encodedId = url.slice("/api/user/brand-assets/".length);
      const assetId = decodeURIComponent(encodedId);
      return Promise.resolve(response(200, { asset: asset(assetId) }));
    }
    throw new Error(`unhandled logo hook fetch: ${method} ${url}`);
  };
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function response(status: number, payload: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function deferredJsonResponse(status: number, payload: Promise<unknown>): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function asset(id: string): BrandAssetView {
  return {
    id,
    displayName: `${id}.png`,
    mimeType: "image/webp",
    sizeBytes: 24_000,
    width: 800,
    height: 400,
    imageUrl: `/api/user/brand-assets/${encodeURIComponent(id)}/image`,
  };
}

function config(assetId: string): LogoOverlayConfig {
  return {
    enabled: true,
    assetId,
    position: "bottom-right",
    sizePct: 20,
    opacity: 0.8,
  };
}

function uploadFile(name = "logo.png"): File {
  return new File([new Uint8Array(32)], name, { type: "image/png" });
}

function compileHook(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "useLogoOverlayEditor.ts",
  }).outputText;
}

function createHarness(
  source: string,
  initial: { projectId: string; assetId: string },
) {
  const telemetry: TelemetryCall[] = [];
  const onChanges: Array<{
    projectId: string | null;
    value: LogoOverlayConfig | undefined;
  }> = [];
  const idleProjectIds: string[] = [];
  const fetchMock = new FetchMock();
  const scheduler = new TaskScheduler();
  let props!: LogoHookInput;
  const stableOnChange = (value: LogoOverlayConfig | undefined) => {
    onChanges.push({ projectId: props.projectId, value });
  };
  const setProject = (projectId: string, assetId: string): void => {
    props = {
      projectId,
      eligible: true,
      value: config(assetId),
      onChange: stableOnChange,
      projectSaveStatus: "idle",
      onRetryProjectSave() {},
      surface: "desktop",
    };
  };
  setProject(initial.projectId, initial.assetId);

  let runner!: HookRunner<LogoHook>;
  const fakeReact: Record<string, unknown> = {};
  const module = { exports: {} as Record<string, unknown> };
  const requireMock = (specifier: string): unknown => {
    if (specifier === "react") return fakeReact;
    if (specifier === "@/lib/client-telemetry") {
      return {
        trackEvent(name: string, input: unknown) {
          telemetry.push({ name, input });
        },
      };
    }
    if (specifier === "@/lib/editor-project-save-queue") {
      return {
        editorProjectSaveQueue: {
          async whenIdle(projectId: string) {
            idleProjectIds.push(projectId);
          },
        },
      };
    }
    if (specifier === "@/lib/logo-overlay") return logoOverlayModule;
    throw new Error(`unhandled logo hook import: ${specifier}`);
  };
  const factory = new Function(
    "require",
    "module",
    "exports",
    "fetch",
    "setTimeout",
    "clearTimeout",
    compileHook(source),
  );
  Object.assign(fakeReact, {
    useState: (...args: unknown[]) => runner.react.useState(args[0]),
    useRef: (...args: unknown[]) => runner.react.useRef(args[0]),
    useCallback: (...args: unknown[]) => runner.react.useCallback(
      args[0],
      args[1] as readonly unknown[],
    ),
    useMemo: (...args: unknown[]) => runner.react.useMemo(
      args[0] as () => unknown,
      args[1] as readonly unknown[],
    ),
    useLayoutEffect: (...args: unknown[]) => runner.react.useLayoutEffect(
      args[0] as () => void | (() => void),
      args[1] as readonly unknown[] | undefined,
    ),
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
    scheduler.setTimeout,
    scheduler.clearTimeout,
  );
  const useLogoOverlayEditor = module.exports.useLogoOverlayEditor as (
    input: LogoHookInput,
  ) => LogoHook;
  runner = new HookRunner(() => useLogoOverlayEditor(props));
  return {
    runner,
    telemetry,
    onChanges,
    idleProjectIds,
    fetchMock,
    scheduler,
    setProject(projectId: string, assetId: string) {
      setProject(projectId, assetId);
      runner.rerender();
    },
    renderProjectWithoutCommit(projectId: string, assetId: string) {
      const committedProps = props;
      setProject(projectId, assetId);
      try {
        return runner.renderWithoutCommit();
      } finally {
        props = committedProps;
      }
    },
  };
}

async function settle(runner: HookRunner<LogoHook>, turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
    runner.flush();
  }
}

function uploadCalls(fetchMock: FetchMock): FetchCall[] {
  return fetchMock.calls.filter(
    (call) => call.method === "POST" && call.url === "/api/user/brand-assets",
  );
}

function eventCount(telemetry: TelemetryCall[], name: string): number {
  return telemetry.filter((call) => call.name === name).length;
}

async function speculativeProjectRenderLeavesCommittedUploadAlone(source: string): Promise<void> {
  const harness = createHarness(source, { projectId: "project-A", assetId: "old-A" });
  const pendingResponse = deferred<ResponseLike>();
  harness.fetchMock.enqueueUpload(pendingResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  const completion = harness.runner.current.upload(uploadFile("speculative-B.png"));
  harness.runner.flush();
  const request = uploadCalls(harness.fetchMock)[0];

  harness.renderProjectWithoutCommit("project-B", "old-B");
  assert.equal(request.init.signal?.aborted, false,
    "an abandoned project B render cannot abort committed project A");
  assert.equal(harness.runner.current.saving, true,
    "an abandoned render cannot reset committed project A UI state");

  pendingResponse.resolve(response(201, { asset: asset("new-A") }));
  assert.equal(await completion, true, "committed project A upload may still complete normally");
  await settle(harness.runner);
  await harness.scheduler.runAll();
  assert.deepEqual(
    harness.onChanges.map((change) => [change.projectId, change.value?.assetId]),
    [["project-A", "new-A"]],
  );
  assert.equal(harness.runner.current.asset?.id, "new-A");
  assert.equal(harness.runner.current.saving, false);
  assert.deepEqual(harness.fetchMock.deletedAssetIds, ["old-A"]);
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 1);
}

async function projectChangeBeforeResponseIsInert(source: string): Promise<void> {
  const harness = createHarness(source, { projectId: "project-A", assetId: "old-A" });
  const pendingResponse = deferred<ResponseLike>();
  harness.fetchMock.enqueueUpload(pendingResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  const completion = harness.runner.current.upload(uploadFile("late-A.png"));
  harness.runner.flush();
  const request = uploadCalls(harness.fetchMock)[0];
  harness.setProject("project-B", "old-B");
  assert.equal(request.init.signal?.aborted, true,
    "committed project B synchronously aborts A during layout commit");
  assert.equal(harness.runner.current.saving, false,
    "committed project B resets project-scoped saving before paint");
  await settle(harness.runner);
  pendingResponse.resolve(response(201, { asset: asset("new-A") }));
  await completion;
  await settle(harness.runner);
  await harness.scheduler.runAll();

  assert.equal(request.init.signal?.aborted, true, "project change aborts project A upload");
  assert.deepEqual(harness.onChanges, [], "late project A response cannot call shared B onChange");
  assert.equal(harness.runner.current.asset?.id, "old-B", "late A response cannot mutate B asset state");
  assert.deepEqual(harness.fetchMock.deletedAssetIds, [], "unknown late response cannot clean A or B assets");
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 0,
    "late project A response cannot emit success telemetry for B");
}

async function unmountAbortsAndMakesLateResponseInert(source: string): Promise<void> {
  const harness = createHarness(source, { projectId: "project-unmount", assetId: "old-unmount" });
  const pendingResponse = deferred<ResponseLike>();
  harness.fetchMock.enqueueUpload(pendingResponse.promise);
  harness.runner.mount();
  await settle(harness.runner);
  const completion = harness.runner.current.upload(uploadFile("unmount.png"));
  harness.runner.flush();
  const request = uploadCalls(harness.fetchMock)[0];
  harness.runner.unmount();
  pendingResponse.resolve(response(201, { asset: asset("new-unmount") }));
  await completion;
  await Promise.resolve();
  await harness.scheduler.runAll();

  assert.equal(request.init.signal?.aborted, true, "unmount aborts the active upload");
  assert.equal(harness.runner.postUnmountStateWrites, 0, "late response cannot set state after unmount");
  assert.deepEqual(harness.onChanges, [], "late response cannot call onChange after unmount");
  assert.deepEqual(harness.fetchMock.deletedAssetIds, [], "unseen unmounted response cannot clean assets");
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 0);
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_error"), 0,
    "an aborted upload is cancellation rather than an error");
}

async function newerSameProjectUploadOwnsSaving(source: string): Promise<void> {
  const harness = createHarness(source, { projectId: "project-same", assetId: "old-same" });
  const firstJson = deferred<unknown>();
  const secondJson = deferred<unknown>();
  harness.fetchMock.enqueueUpload(deferredJsonResponse(201, firstJson.promise));
  harness.fetchMock.enqueueUpload(deferredJsonResponse(201, secondJson.promise));
  harness.runner.mount();
  await settle(harness.runner);
  const firstCompletion = harness.runner.current.upload(uploadFile("first.png"));
  harness.runner.flush();
  await settle(harness.runner);
  const firstRequest = uploadCalls(harness.fetchMock)[0];
  const secondCompletion = harness.runner.current.upload(uploadFile("second.png"));
  harness.runner.flush();
  await settle(harness.runner);
  firstJson.resolve({ asset: asset("new-first") });
  await firstCompletion;
  await settle(harness.runner);

  assert.equal(firstRequest.init.signal?.aborted, true, "second upload aborts the first upload");
  assert.equal(harness.runner.current.saving, true,
    "stale first finally cannot clear the second upload saving state");
  assert.deepEqual(harness.onChanges, [], "stale first upload cannot apply its asset");
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 0);

  secondJson.resolve({ asset: asset("new-second") });
  assert.equal(await secondCompletion, true);
  await settle(harness.runner);
  assert.equal(harness.runner.current.saving, false);
  assert.equal(harness.runner.current.asset?.id, "new-second");
  assert.deepEqual(
    harness.onChanges.map((change) => [change.projectId, change.value?.assetId]),
    [["project-same", "new-second"]],
  );
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 1);
}

async function normalSuccessAppliesOnceAndCleansReplacement(source: string): Promise<void> {
  const harness = createHarness(source, { projectId: "project-normal", assetId: "old-normal" });
  harness.fetchMock.enqueueUpload(response(201, { asset: asset("new-normal") }));
  harness.runner.mount();
  await settle(harness.runner);
  const result = await harness.runner.current.upload(uploadFile("normal.png"));
  await settle(harness.runner);
  await harness.scheduler.runAll();

  assert.equal(result, true);
  assert.equal(harness.runner.current.asset?.id, "new-normal");
  assert.equal(harness.runner.current.saving, false);
  assert.deepEqual(
    harness.onChanges.map((change) => [change.projectId, change.value?.assetId]),
    [["project-normal", "new-normal"]],
    "normal same-project success applies exactly once",
  );
  assert.deepEqual(harness.fetchMock.deletedAssetIds, ["old-normal"],
    "normal replacement retains prior-asset cleanup");
  assert.deepEqual(harness.idleProjectIds, ["project-normal"]);
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 1);
}

async function staleKnownCreatedAssetCleansOnlyItsOrphan(source: string): Promise<void> {
  const harness = createHarness(source, { projectId: "project-A", assetId: "old-A" });
  const pendingJson = deferred<unknown>();
  harness.fetchMock.enqueueUpload(deferredJsonResponse(201, pendingJson.promise));
  harness.runner.mount();
  await settle(harness.runner);
  const completion = harness.runner.current.upload(uploadFile("known-A.png"));
  harness.runner.flush();
  await settle(harness.runner);
  const request = uploadCalls(harness.fetchMock)[0];
  harness.setProject("project-B", "old-B");
  await settle(harness.runner);
  pendingJson.resolve({ asset: asset("orphan-from-A") });
  assert.equal(await completion, false);
  await settle(harness.runner);
  await harness.scheduler.runAll();

  assert.equal(request.init.signal?.aborted, true);
  assert.deepEqual(harness.onChanges, []);
  assert.equal(harness.runner.current.asset?.id, "old-B");
  assert.deepEqual(harness.fetchMock.deletedAssetIds, ["orphan-from-A"],
    "stale success may clean only the newly revealed unreferenced asset");
  assert.equal(harness.fetchMock.deletedAssetIds.includes("old-A"), false);
  assert.equal(harness.fetchMock.deletedAssetIds.includes("old-B"), false);
  assert.deepEqual(harness.idleProjectIds, ["project-A"],
    "stale orphan cleanup is authorized only through starting project A");
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 0);
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_error"), 0);
}

async function staleParsedResponseHasNoEffects(
  source: string,
  input: {
    name: string;
    status: number;
    settlePayload: (pending: ReturnType<typeof deferred<unknown>>) => void;
  },
): Promise<void> {
  const harness = createHarness(source, { projectId: "project-A", assetId: "old-A" });
  const pendingJson = deferred<unknown>();
  harness.fetchMock.enqueueUpload(deferredJsonResponse(input.status, pendingJson.promise));
  harness.runner.mount();
  await settle(harness.runner);
  const completion = harness.runner.current.upload(uploadFile(`${input.name}.png`));
  harness.runner.flush();
  await settle(harness.runner);
  harness.setProject("project-B", "old-B");
  input.settlePayload(pendingJson);
  assert.equal(await completion, false);
  await settle(harness.runner);
  await harness.scheduler.runAll();

  assert.deepEqual(harness.onChanges, [], `${input.name}: stale response cannot call B onChange`);
  assert.equal(harness.runner.current.asset?.id, "old-B", `${input.name}: B asset remains selected`);
  assert.equal(harness.runner.current.saving, false, `${input.name}: B saving remains clear`);
  assert.equal(harness.runner.current.error, null, `${input.name}: B error remains clear`);
  assert.deepEqual(harness.fetchMock.deletedAssetIds, [],
    `${input.name}: stale response has no authorized cleanup target`);
  assert.deepEqual(harness.idleProjectIds, []);
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_done"), 0);
  assert.equal(eventCount(harness.telemetry, "logo_overlay_upload_error"), 0);
}

async function staleExistingAndUnprovenAssetsNeverCleanup(source: string): Promise<void> {
  await staleParsedResponseHasNoEffects(source, {
    name: "starting-asset-old-A",
    status: 201,
    settlePayload: (pending) => pending.resolve({ asset: asset("old-A") }),
  });
  await staleParsedResponseHasNoEffects(source, {
    name: "current-asset-old-B",
    status: 201,
    settlePayload: (pending) => pending.resolve({ asset: asset("old-B") }),
  });
  await staleParsedResponseHasNoEffects(source, {
    name: "malformed-201",
    status: 201,
    settlePayload: (pending) => pending.resolve({ asset: { id: "incomplete" } }),
  });
  await staleParsedResponseHasNoEffects(source, {
    name: "non-201",
    status: 503,
    settlePayload: (pending) => pending.resolve({ error: "unknown", message: "retry" }),
  });
  await staleParsedResponseHasNoEffects(source, {
    name: "null-201",
    status: 201,
    settlePayload: (pending) => pending.resolve(null),
  });
  await staleParsedResponseHasNoEffects(source, {
    name: "ambiguous-json-read",
    status: 201,
    settlePayload: (pending) => pending.reject(new Error("response body lost")),
  });
}

export async function verifyLogoOverlayEditorRuntime(
  source = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts",
    "utf8",
  ),
): Promise<void> {
  await speculativeProjectRenderLeavesCommittedUploadAlone(source);
  await projectChangeBeforeResponseIsInert(source);
  await unmountAbortsAndMakesLateResponseInert(source);
  await newerSameProjectUploadOwnsSaving(source);
  await normalSuccessAppliesOnceAndCleansReplacement(source);
  await staleKnownCreatedAssetCleansOnlyItsOrphan(source);
  await staleExistingAndUnprovenAssetsNeverCleanup(source);
}

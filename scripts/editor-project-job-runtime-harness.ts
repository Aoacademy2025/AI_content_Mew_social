import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type HookSlot =
  | { kind: "state"; value: unknown; setter: (next: unknown) => void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: readonly unknown[] }
  | {
      kind: "effect";
      create: () => void | (() => void);
      cleanup?: () => void;
      deps: readonly unknown[] | undefined;
    };

function depsEqual(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined,
): boolean {
  return !!left && !!right
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

class HookRunner<T> {
  private readonly slots: HookSlot[] = [];
  private readonly pendingEffects = new Set<number>();
  private cursor = 0;
  private dirty = false;
  current!: T;

  constructor(private readonly hook: () => T) {}

  readonly react = {
    useState: <V,>(initial: V): [V, (next: V | ((current: V) => V)) => void] => {
      const index = this.cursor++;
      let slot = this.slots[index] as Extract<HookSlot, { kind: "state" }> | undefined;
      if (!slot) {
        slot = {
          kind: "state",
          value: initial,
          setter: (next) => {
            const previous = slot!.value as V;
            slot!.value = typeof next === "function"
              ? (next as (current: V) => V)(previous)
              : next;
            this.dirty = true;
          },
        };
        this.slots[index] = slot;
      }
      return [slot.value as V, slot.setter as (next: V | ((current: V) => V)) => void];
    },
    useRef: <V,>(initial: V): { current: V } => {
      const index = this.cursor++;
      let slot = this.slots[index] as Extract<HookSlot, { kind: "ref" }> | undefined;
      if (!slot) {
        slot = { kind: "ref", value: { current: initial } };
        this.slots[index] = slot;
      }
      return slot.value as { current: V };
    },
    useCallback: <V,>(callback: V, deps: readonly unknown[]): V => {
      const index = this.cursor++;
      let slot = this.slots[index] as Extract<HookSlot, { kind: "memo" }> | undefined;
      if (!slot || !depsEqual(slot.deps, deps)) {
        slot = { kind: "memo", value: callback, deps: [...deps] };
        this.slots[index] = slot;
      }
      return slot.value as V;
    },
    useEffect: (
      create: () => void | (() => void),
      deps?: readonly unknown[],
    ): void => {
      const index = this.cursor++;
      let slot = this.slots[index] as Extract<HookSlot, { kind: "effect" }> | undefined;
      if (!slot) {
        slot = { kind: "effect", create, deps: undefined };
        this.slots[index] = slot;
      }
      slot.create = create;
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? [...deps] : undefined;
        this.pendingEffects.add(index);
      }
    },
  };

  mount(): void {
    this.dirty = true;
    this.flush();
  }

  flush(): void {
    let guard = 0;
    while ((this.dirty || this.pendingEffects.size > 0) && guard++ < 50) {
      if (this.dirty) {
        this.dirty = false;
        this.cursor = 0;
        this.current = this.hook();
      }
      const effects = [...this.pendingEffects];
      this.pendingEffects.clear();
      for (const index of effects) {
        const effect = this.slots[index] as Extract<HookSlot, { kind: "effect" }>;
        effect.cleanup?.();
        effect.cleanup = effect.create() || undefined;
      }
    }
    assert.ok(guard < 50, "job hook reaches a stable render");
  }
}

type JobHook = {
  job: { phase: string };
  submit(): Promise<{ ok: boolean; message?: string }>;
  submitExport(input: {
    sourceJobId: string;
    subtitleOverlayConfig: unknown;
  }): Promise<{ ok: boolean; message?: string }>;
};

const jobPath = "src/app/(dashboard)/video-editor/_v2/useV2Job.ts";
const jobSource = readFileSync(jobPath, "utf8");

function compileJobHook(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: jobPath,
  }).outputText;
}

async function sameTickConflictBlocksSubmitAndExport(source: string): Promise<void> {
  const fetchCalls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const storageOperations: string[] = [];
  let operationsAllowed = true;
  const project = {
    projectId: "job-gate-project",
    projectReady: true,
    projectInitialization: "ready",
    recovery: { status: "none" },
    projectStatus: "draft",
    activeJobId: null,
    activeExportJobId: null,
    previewMediaState: null,
    canRunProjectOperation: () => operationsAllowed,
    mode: "script",
    script: "render me",
    clipUrl: "",
    brollSource: "stock",
    targetClipCount: 0,
    brollRegionPreference: "auto",
    brollVisualStyle: "auto",
    kieModel: "",
    autoMixProviders: [],
    isAdmin: false,
    mixPreset: "free",
    voiceEngine: "gemini",
    geminiVoiceName: "Aoede",
    voiceId: "",
    musicTrack: null,
    musicTrackKind: "system",
    bgmVolume: 0.12,
    useAvatar: false,
    avatarId: "",
    avatarMode: "bookend",
    avatarIntroSecs: 5,
    avatarTailSecs: 5,
  };
  const module = { exports: {} as Record<string, unknown> };
  const fakeReact: Record<string, unknown> = {};
  let runner!: HookRunner<JobHook>;
  const factory = new Function(
    "require",
    "module",
    "exports",
    "fetch",
    "window",
    "setInterval",
    "clearInterval",
    compileJobHook(source),
  );
  const requireMock = (specifier: string): unknown => {
    if (specifier === "react") return fakeReact;
    if (specifier === "./mix-presets") return { PRESET_WEIGHTS: { free: {} } };
    if (specifier === "./ExpiredPreviewView") {
      return {
        mediaStateFromJobPoll: (state: unknown, fallback: unknown) => state ?? fallback,
        previewMediaStateAfterVideoError: (state: unknown) => state,
      };
    }
    throw new Error(`unhandled job hook import: ${specifier}`);
  };
  Object.assign(fakeReact, {
    useState: (...args: unknown[]) => runner.react.useState(args[0]),
    useRef: (...args: unknown[]) => runner.react.useRef(args[0]),
    useCallback: (...args: unknown[]) => runner.react.useCallback(
      args[0],
      args[1] as readonly unknown[],
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
    async (url: string, init: Record<string, unknown> = {}) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() { return { jobId: "unexpected-job" }; },
      };
    },
    {
      localStorage: {
        getItem: () => null,
        setItem: (key: string) => storageOperations.push(`set:${key}`),
        removeItem: (key: string) => storageOperations.push(`remove:${key}`),
      },
    },
    () => ({}) as unknown,
    () => undefined,
  );
  const useV2Job = module.exports.useV2Job as (input: typeof project) => JobHook;
  runner = new HookRunner(() => useV2Job(project));
  runner.mount();

  // This is the conflict-before-rerender condition: the object captured by the job
  // hook still says ready/recovery-none, while the lifecycle-owned ref getter has
  // synchronously changed to false.
  operationsAllowed = false;
  const before = {
    fetches: fetchCalls.length,
    storage: storageOperations.length,
    phase: runner.current.job.phase,
  };
  const submit = await runner.current.submit();
  const exportResult = await runner.current.submitExport({
    sourceJobId: "preview-job",
    subtitleOverlayConfig: {},
  });
  runner.flush();
  assert.deepEqual({
    submitOk: submit.ok,
    exportOk: exportResult.ok,
    fetchDelta: fetchCalls.length - before.fetches,
    storageDelta: storageOperations.length - before.storage,
    phase: runner.current.job.phase,
  }, {
    submitOk: false,
    exportOk: false,
    fetchDelta: 0,
    storageDelta: 0,
    phase: before.phase,
  }, "submit and export consult synchronous project lifecycle ownership before side effects");
}

export async function verifyProjectJobRuntimeGate(): Promise<void> {
  await sameTickConflictBlocksSubmitAndExport(jobSource);
}

export async function verifyProjectJobGateMutationSensitivity(): Promise<void> {
  const missingGuards = jobSource.replaceAll(
    "    if (!p.canRunProjectOperation()) return { ok: false, message: PROJECT_OPERATION_BLOCKED_MESSAGE };\n",
    "",
  );
  assert.notEqual(missingGuards, jobSource, "job operation-gate mutant applied");
  await assert.rejects(
    () => sameTickConflictBlocksSubmitAndExport(missingGuards),
    /submit and export consult synchronous project lifecycle ownership/,
    "runtime harness rejects job submission without the synchronous lifecycle getter",
  );
}

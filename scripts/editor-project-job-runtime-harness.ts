import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  canonicalVideoJobRequest,
  fingerprintVideoJobRequest,
} from "../src/lib/video-job-idempotency";

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
  private mounted = false;
  stateUpdatesAfterUnmount = 0;
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
            if (!this.mounted) this.stateUpdatesAfterUnmount += 1;
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
    this.mounted = true;
    this.dirty = true;
    this.flush();
  }

  unmount(): void {
    for (const slot of this.slots) {
      if (slot?.kind === "effect") {
        slot.cleanup?.();
        slot.cleanup = undefined;
      }
    }
    this.pendingEffects.clear();
    this.dirty = false;
    this.mounted = false;
  }

  rerender(): void {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canonicalRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRuntimeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalRuntimeValue(child)]));
  }
  return value;
}

function runtimeRequestFingerprint(
  operation: "preview" | "export" | "broll-rerender",
  rawBody: Record<string, unknown>,
): string {
  const body = { ...rawBody };
  delete body.idempotencyKey;
  const canonical = JSON.stringify(canonicalRuntimeValue({
    version: 1,
    operation,
    body,
  }));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const jobPath = "src/app/(dashboard)/video-editor/_v2/useV2Job.ts";
const jobSource = readFileSync(jobPath, "utf8");
const shellPath = "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx";
const shellSource = readFileSync(shellPath, "utf8");
const jobsRoutePath = "src/app/api/videos/jobs/route.ts";
const jobsRouteSource = readFileSync(jobsRoutePath, "utf8");

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

function compileEditorShell(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: shellPath,
  }).outputText;
}

function compileJobsRoute(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: jobsRoutePath,
  }).outputText;
}

type RuntimeNode = {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
};

function runtimeNodes(root: unknown): RuntimeNode[] {
  const found: RuntimeNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Partial<RuntimeNode>;
    if ("type" in node && node.props && typeof node.props === "object") {
      found.push(node as RuntimeNode);
      visit(node.props.children);
    }
  };
  visit(root);
  return found;
}

async function settleShell(runner: HookRunner<unknown>): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  runner.flush();
}

type ShellProject = Record<string, unknown> & {
  projectId: string;
  projectReady: boolean;
  projectInitialization: string;
  recovery: { status: string };
  canRunProjectOperation(): boolean;
};

function makeShellProject(
  projectId: string,
  canRunProjectOperation: () => boolean,
): ShellProject {
  return {
    projectId,
    projectReady: true,
    projectInitialization: "ready",
    recovery: { status: "none" },
    canRunProjectOperation,
    projectTitle: "Owned project",
    setProjectTitle: () => undefined,
    saveStatus: "idle",
    retryProjectSave: () => undefined,
    mode: "script",
    useAvatar: false,
    avatarId: "",
    activeJobId: null,
    activeExportJobId: null,
    latestVideoId: null,
    previewMediaState: null,
    logoOverlay: undefined,
    setLogoOverlay: () => undefined,
    canUseLogoOverlay: false,
    resetProject: () => Promise.resolve(),
    completeArchivedProject: () => true,
    retryProjectBootstrap: () => undefined,
    retryConflictServerRefresh: () => Promise.resolve(),
    chooseLocalProjectDraft: () => Promise.resolve(),
    chooseServerProjectDraft: () => undefined,
  };
}

function mountEditorShell(input: {
  getProject(): ShellProject;
  submit(): Promise<{ ok: boolean; message?: string }>;
  fetch(url: string, init?: Record<string, unknown>): Promise<unknown>;
  navigations: string[];
}) {
  const markers = new Map<string, { displayName: string }>();
  const marker = (name: string) => {
    let value = markers.get(name);
    if (!value) {
      value = { displayName: name };
      markers.set(name, value);
    }
    return value;
  };
  const fakeReact: Record<string, unknown> = {};
  const module = { exports: {} as Record<string, unknown> };
  let runner!: HookRunner<unknown>;
  const jobApi = {
    job: {
      phase: "idle",
      jobId: null,
      jobType: null,
      projectId: null,
      currentStep: null,
      progress: 0,
      errorMessage: null,
      output: null,
      mediaState: null,
    },
    submit: input.submit,
    submitExport: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    reset: () => undefined,
    adoptJob: () => undefined,
    resumeJob: () => undefined,
    markPreviewMissing: () => undefined,
  };
  const jsx = (type: unknown, props: Record<string, unknown> | null) => ({
    type,
    props: props ?? {},
  });
  const factory = new Function(
    "require",
    "module",
    "exports",
    "fetch",
    "window",
    compileEditorShell(shellSource),
  );
  const requireMock = (specifier: string): unknown => {
    if (specifier === "react") return fakeReact;
    if (specifier === "react/jsx-runtime") {
      return { jsx, jsxs: jsx, Fragment: marker("Fragment") };
    }
    if (specifier === "next/link") {
      return { __esModule: true, default: marker("Link") };
    }
    if (specifier === "next/navigation") {
      return { useRouter: () => ({ push: () => undefined }) };
    }
    if (specifier === "sonner") {
      return { toast: { error: () => undefined, success: () => undefined } };
    }
    if (specifier === "lucide-react") {
      return new Proxy({}, { get: (_target, key) => marker(String(key)) });
    }
    if (specifier === "./tokens") {
      return {
        color: new Proxy({}, { get: () => "#000" }),
        font: new Proxy({}, { get: () => "sans-serif" }),
      };
    }
    if (specifier === "./fonts") return { v2FontClass: "font" };
    if (specifier === "./ui") {
      return {
        StepIndicator: marker("StepIndicator"),
        BtnPrimary: marker("BtnPrimary"),
        BtnSecondary: marker("BtnSecondary"),
        BtnGhost: marker("BtnGhost"),
      };
    }
    if (specifier === "@/components/layout/account-menu") return { AccountMenu: marker("AccountMenu") };
    if (specifier === "@/components/layout/notification-bell") return { NotificationBell: marker("NotificationBell") };
    if (specifier === "@/components/ui/dropdown-menu") {
      return Object.fromEntries([
        "DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuLabel",
        "DropdownMenuSeparator", "DropdownMenuTrigger",
      ].map((name) => [name, marker(name)]));
    }
    if (specifier === "@/components/ui/alert-dialog") {
      return Object.fromEntries([
        "AlertDialog", "AlertDialogAction", "AlertDialogCancel", "AlertDialogContent",
        "AlertDialogDescription", "AlertDialogFooter", "AlertDialogHeader", "AlertDialogTitle",
      ].map((name) => [name, marker(name)]));
    }
    if (specifier === "./useV2Project") return { useV2Project: input.getProject };
    if (specifier === "./useV2Job") return { useV2Job: () => jobApi };
    if (specifier === "./Step1Script") return { Step1Script: marker("Step1Script") };
    if (specifier === "./Step2Elements") return { Step2Elements: marker("Step2Elements") };
    if (specifier === "./RenderingScreen") return { RenderingScreen: marker("RenderingScreen") };
    if (specifier === "./PostPhase") return { PostPhase: marker("PostPhase") };
    if (specifier === "./PostPhaseMobile") return { PostPhaseMobile: marker("PostPhaseMobile") };
    if (specifier === "./ExpiredPreviewView") {
      return {
        ExpiredPreviewView: marker("ExpiredPreviewView"),
        prepareExpiredPreviewRerender: () => undefined,
        shouldShowUnavailablePreview: () => false,
      };
    }
    if (specifier === "./RenderReceiptDialog") return { RenderReceiptDialog: marker("RenderReceiptDialog") };
    if (specifier === "./EditorProjectRecoveryDialog") return { EditorProjectRecoveryDialog: marker("EditorProjectRecoveryDialog") };
    if (specifier === "./useIsMobile") return { useIsMobile: () => false };
    if (specifier === "../_hooks/useCreditsQuota") return { CREDITS_LIVE_CLIENT: true };
    if (specifier === "./project-menu") {
      return {
        PROJECT_STATUS_FILTER_LABEL: { all: "all" },
        filterProjectMenuItems: (items: unknown[]) => items,
        projectDeleteBlocked: () => false,
        projectStatusLabel: (status: string) => status,
      };
    }
    throw new Error(`unhandled editor shell import: ${specifier}`);
  };
  Object.assign(fakeReact, {
    useState: (...args: unknown[]) => runner.react.useState(args[0]),
    useRef: (...args: unknown[]) => runner.react.useRef(args[0]),
    useEffect: (...args: unknown[]) => runner.react.useEffect(
      args[0] as () => void | (() => void),
      args[1] as readonly unknown[] | undefined,
    ),
  });
  factory(
    requireMock,
    module,
    module.exports,
    input.fetch,
    {
      location: {
        href: "https://example.test/video-editor?ui=v2&projectId=archived-project",
        assign: (url: string) => input.navigations.push(url),
      },
    },
  );
  const EditorV2Shell = module.exports.EditorV2Shell as () => unknown;
  runner = new HookRunner(EditorV2Shell);
  runner.mount();
  return { runner, marker };
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
    if (specifier === "@/lib/video-job-idempotency") {
      return {
        fingerprintVideoJobRequest: async (
          operation: "preview" | "export" | "broll-rerender",
          body: Record<string, unknown>,
        ) => runtimeRequestFingerprint(operation, body),
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

async function recoveryCannotDuplicateOwnedBillableSubmit(source: string): Promise<void> {
  const postResponse = deferred<{
    ok: boolean;
    status: number;
    json(): Promise<{ jobId: string }>;
  }>();
  const postBodies: Array<Record<string, unknown>> = [];
  let committedIdempotencyKey: string | null = null;
  let committedJobCount = 0;
  let operationsAllowed = true;
  const project = {
    projectId: "owned-submit-project",
    projectReady: true,
    projectInitialization: "ready",
    recovery: { status: "none" },
    projectStatus: "draft",
    activeJobId: null,
    activeExportJobId: null,
    previewMediaState: null,
    canRunProjectOperation: () => operationsAllowed,
    mode: "script",
    script: "render exactly once",
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
    if (specifier === "@/lib/video-job-idempotency") {
      return {
        fingerprintVideoJobRequest: async (
          operation: "preview" | "export" | "broll-rerender",
          body: Record<string, unknown>,
        ) => runtimeRequestFingerprint(operation, body),
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
      if (url !== "/api/videos/jobs" || init.method !== "POST") {
        throw new Error(`unexpected fetch while submit is pending: ${url}`);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      postBodies.push(body);
      const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
      if (!committedIdempotencyKey) {
        committedIdempotencyKey = key;
        committedJobCount += 1;
        return postResponse.promise;
      }
      assert.equal(key, committedIdempotencyKey, "an ambiguous retry reuses the committed attempt key");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            jobId: "owned-job",
            idempotencyKey: key,
            idempotencyFingerprint: runtimeRequestFingerprint("preview", body),
          };
        },
      };
    },
    {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
    () => ({}) as unknown,
    () => undefined,
  );
  const useV2Job = module.exports.useV2Job as (input: typeof project) => JobHook;
  runner = new HookRunner(() => useV2Job(project));
  runner.mount();

  const first = runner.current.submit();
  for (let index = 0; index < 8 && postBodies.length === 0; index += 1) await Promise.resolve();
  runner.flush();
  assert.equal(runner.current.job.phase, "submitting", "the owned attempt is visibly pending");
  assert.equal(postBodies.length, 1, "the first confirmation creates one billable request");
  assert.equal(
    typeof postBodies[0].idempotencyKey,
    "string",
    "every billable attempt carries an explicit client idempotency key",
  );

  operationsAllowed = false;
  project.projectReady = false;
  project.recovery = { status: "conflict" } as typeof project.recovery;
  runner.rerender();
  operationsAllowed = true;
  project.projectReady = true;
  project.recovery = { status: "none" };
  runner.rerender();
  assert.equal(
    runner.current.job.phase,
    "submitting",
    "project resume effects cannot erase an owned in-flight submission",
  );

  const reconfirm = runner.current.submit();
  runner.flush();
  assert.equal(
    postBodies.length,
    1,
    "reconfirmation while the owned POST is pending creates zero second billable requests",
  );

  postResponse.reject(new Error("server committed but the response was lost"));
  const [firstResult, reconfirmResult] = await Promise.all([first, reconfirm]);
  runner.flush();
  assert.equal(firstResult.ok, false);
  assert.equal(reconfirmResult.ok, false);
  assert.equal(committedJobCount, 1, "the lost response still represents one committed server job");
  const retryResult = await runner.current.submit();
  runner.flush();
  assert.deepEqual(retryResult, { ok: true });
  assert.equal(runner.current.job.phase, "rendering");
  assert.equal(postBodies.length, 2, "only the explicit retry sends another transport request");
  assert.deepEqual(postBodies[1], postBodies[0], "the ambiguous retry preserves the exact logical attempt body");
  assert.equal(committedJobCount, 1, "the idempotent replay resolves the first committed job without creating another");
}

function makeJobRuntimeProject(kind: "create" | "export") {
  return {
    projectId: "attempt-project-a",
    projectReady: true,
    projectInitialization: "ready",
    recovery: { status: "none" },
    projectStatus: kind === "export" ? "exporting" : "draft",
    activeJobId: (kind === "create" ? "baseline-preview-job" : "preview-source-job") as string | null,
    activeExportJobId: kind === "export" ? "baseline-export-job" : null,
    previewMediaState: null,
    canRunProjectOperation: () => true,
    mode: "script",
    script: "render one owned logical request",
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
}

function mountAttemptJobHook(
  source: string,
  project: ReturnType<typeof makeJobRuntimeProject>,
  fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<unknown>,
): HookRunner<JobHook> {
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
    if (specifier === "@/lib/video-job-idempotency") {
      return {
        fingerprintVideoJobRequest: async (
          operation: "preview" | "export" | "broll-rerender",
          body: Record<string, unknown>,
        ) => runtimeRequestFingerprint(operation, body),
      };
    }
    throw new Error(`unhandled attempt job hook import: ${specifier}`);
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
    fetchImpl,
    {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
    () => ({}) as unknown,
    () => undefined,
  );
  const useV2Job = module.exports.useV2Job as (input: typeof project) => JobHook;
  runner = new HookRunner(() => useV2Job(project));
  runner.mount();
  return runner;
}

async function runAttempt(
  runner: HookRunner<JobHook>,
  kind: "create" | "export",
): Promise<{ ok: boolean; message?: string }> {
  return kind === "create"
    ? runner.current.submit()
    : runner.current.submitExport({
        sourceJobId: "preview-source-job",
        subtitleOverlayConfig: { captions: [{ text: "hello", startMs: 0 }] },
      });
}

export async function unrelatedResumeAndProjectReplacementCannotReleaseAttempt(
  source: string,
  kind: "create" | "export",
): Promise<void> {
  const operation = kind === "create" ? "preview" : "export";
  const project = makeJobRuntimeProject(kind);
  const firstResponse = deferred<unknown>();
  const postBodies: Array<Record<string, unknown>> = [];
  let committedJobCount = 0;
  let committedKey: string | null = null;
  let committedFingerprint: string | null = null;
  const runner = mountAttemptJobHook(source, project, async (url, init = {}) => {
    if (url.startsWith("/api/videos/jobs/") && init.method !== "POST") {
      const resumedId = decodeURIComponent(url.slice("/api/videos/jobs/".length));
      const exact = resumedId === "owned-committed-job";
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: resumedId,
            projectId: exact ? "attempt-project-a" : project.projectId,
            type: kind === "export" ? "export" : "create",
            status: exact ? "queued" : "done",
            currentStep: null,
            progress: exact ? 0 : 100,
            errorMessage: null,
            idempotencyKey: exact ? committedKey : "unrelated-old-key",
            idempotencyFingerprint: exact ? committedFingerprint : "unrelated-old-fingerprint",
            output: exact ? null : { videoUrl: "/old.mp4" },
          };
        },
      };
    }
    assert.equal(url, "/api/videos/jobs");
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    postBodies.push(body);
    const key = String(body.idempotencyKey);
    const fingerprint = runtimeRequestFingerprint(operation, body);
    if (!committedKey) {
      committedKey = key;
      committedFingerprint = fingerprint;
      committedJobCount += 1;
      return firstResponse.promise;
    }
    assert.equal(key, committedKey, `${kind} retry reuses the response-lost key`);
    assert.equal(fingerprint, committedFingerprint, `${kind} retry reuses the exact request fingerprint`);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          jobId: "owned-committed-job",
          status: "queued",
          idempotencyKey: key,
          idempotencyFingerprint: fingerprint,
          idempotentReplay: true,
        };
      },
    };
  });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  runner.flush();

  const first = runAttempt(runner, kind);
  for (let index = 0; index < 8 && postBodies.length === 0; index += 1) await Promise.resolve();
  assert.equal(postBodies.length, 1, `${kind} sends the initial owned POST`);
  firstResponse.reject(new Error("server committed but response was lost"));
  assert.equal((await first).ok, false);
  runner.flush();

  project.projectId = "attempt-project-b";
  project.activeJobId = "replacement-preview-job";
  project.activeExportJobId = kind === "export" ? "replacement-export-job" : null;
  runner.rerender();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  runner.flush();
  const replacementAttempt = await runAttempt(runner, kind);
  assert.equal(replacementAttempt.ok, false, `${kind} attempt cannot be rebound to a replacement project`);
  assert.equal(postBodies.length, 1, `${kind} replacement project sends no old logical request`);

  project.projectId = "attempt-project-a";
  project.activeJobId = kind === "create" ? "baseline-preview-job" : "preview-source-job";
  project.activeExportJobId = kind === "export" ? "baseline-export-job" : null;
  runner.rerender();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  runner.flush();
  const retry = await runAttempt(runner, kind);
  runner.flush();
  assert.deepEqual(retry, { ok: true }, `${kind} exact retry resolves the committed job`);
  assert.equal(postBodies.length, 2, `${kind} sends only one explicit retry transport`);
  assert.deepEqual(postBodies[1], postBodies[0], `${kind} retry preserves the full logical body`);
  assert.equal(committedJobCount, 1, `${kind} unrelated resumes and project replacement cannot duplicate creation`);
}

export async function mutableLimitCannotReleaseAttempt(
  source: string,
  kind: "create" | "export",
): Promise<void> {
  const operation = kind === "create" ? "preview" : "export";
  const project = makeJobRuntimeProject(kind);
  project.activeJobId = null;
  project.activeExportJobId = null;
  project.projectStatus = "draft";
  const postBodies: Array<Record<string, unknown>> = [];
  const runner = mountAttemptJobHook(source, project, async (url, init = {}) => {
    if (url.startsWith("/api/videos/jobs/") && init.method !== "POST") {
      const id = decodeURIComponent(url.slice("/api/videos/jobs/".length));
      const body = postBodies[1];
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id,
            projectId: project.projectId,
            type: kind === "export" ? "export" : "create",
            status: "queued",
            currentStep: null,
            progress: 0,
            errorMessage: null,
            idempotencyKey: body?.idempotencyKey,
            idempotencyFingerprint: body ? runtimeRequestFingerprint(operation, body) : null,
          };
        },
      };
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    postBodies.push(body);
    if (postBodies.length === 1) {
      const quota = kind === "export";
      return {
        ok: false,
        status: quota ? 403 : 429,
        async json() {
          return quota
            ? { error: "quota_exceeded", message: "plan quota changed" }
            : { error: "too_many_jobs", message: "render cap is saturated" };
        },
      };
    }
    const fingerprint = runtimeRequestFingerprint(operation, body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          jobId: `limit-retry-${kind}`,
          status: "queued",
          idempotencyKey: body.idempotencyKey,
          idempotencyFingerprint: fingerprint,
        };
      },
    };
  });
  const limited = await runAttempt(runner, kind);
  runner.flush();
  assert.equal(limited.ok, false, `${kind} exposes the mutable limit response`);
  const retry = await runAttempt(runner, kind);
  runner.flush();
  assert.deepEqual(retry, { ok: true }, `${kind} retries after mutable capacity changes`);
  assert.equal(postBodies.length, 2);
  assert.equal(
    postBodies[1].idempotencyKey,
    postBodies[0].idempotencyKey,
    `${kind} mutable limit preserves the owned key`,
  );
  assert.deepEqual(postBodies[1], postBodies[0], `${kind} mutable limit preserves the full body`);
}

export async function matchingPollReleasesAttempt(
  source: string,
  kind: "create" | "export",
): Promise<void> {
  const operation = kind === "create" ? "preview" : "export";
  const project = makeJobRuntimeProject(kind);
  project.activeJobId = null;
  project.activeExportJobId = null;
  project.projectStatus = "draft";
  const lostResponse = deferred<unknown>();
  const postBodies: Array<Record<string, unknown>> = [];
  let committedKey = "";
  let committedFingerprint = "";
  const runner = mountAttemptJobHook(source, project, async (url, init = {}) => {
    if (url.startsWith("/api/videos/jobs/") && init.method !== "POST") {
      const id = decodeURIComponent(url.slice("/api/videos/jobs/".length));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id,
            projectId: "attempt-project-a",
            type: kind === "export" ? "export" : "create",
            status: "queued",
            currentStep: null,
            progress: 0,
            errorMessage: null,
            idempotencyKey: committedKey,
            idempotencyFingerprint: committedFingerprint,
          };
        },
      };
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    postBodies.push(body);
    const fingerprint = runtimeRequestFingerprint(operation, body);
    if (postBodies.length === 1) {
      committedKey = String(body.idempotencyKey);
      committedFingerprint = fingerprint;
      return lostResponse.promise;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          jobId: `new-after-exact-poll-${kind}`,
          status: "queued",
          idempotencyKey: body.idempotencyKey,
          idempotencyFingerprint: fingerprint,
        };
      },
    };
  });
  const first = runAttempt(runner, kind);
  for (let index = 0; index < 8 && postBodies.length === 0; index += 1) await Promise.resolve();
  lostResponse.reject(new Error("committed response lost"));
  assert.equal((await first).ok, false);
  runner.flush();

  if (kind === "export") {
    project.projectStatus = "exporting";
    project.activeExportJobId = "exact-polled-export";
  } else {
    project.activeJobId = "exact-polled-preview";
  }
  runner.rerender();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  runner.flush();

  project.projectId = "attempt-project-b";
  project.projectStatus = "draft";
  project.activeJobId = null;
  project.activeExportJobId = null;
  runner.rerender();
  const nextProjectAttempt = await runAttempt(runner, kind);
  runner.flush();
  assert.deepEqual(nextProjectAttempt, { ok: true }, `${kind} exact polled identity releases the old descriptor`);
  assert.equal(postBodies.length, 2, `${kind} can create a new-project request after exact poll evidence`);
  assert.notEqual(
    postBodies[1].idempotencyKey,
    postBodies[0].idempotencyKey,
    `${kind} new project owns a fresh key only after exact poll evidence`,
  );
}

async function recoveryCannotReleaseShellReceiptAttempt(): Promise<void> {
  const ownedSubmit = deferred<{ ok: boolean }>();
  let submitCalls = 0;
  let lifecycleAllowed = true;
  let currentProject = makeShellProject("receipt-project", () => lifecycleAllowed);
  const navigations: string[] = [];
  const { runner, marker } = mountEditorShell({
    getProject: () => currentProject,
    submit: () => {
      submitCalls += 1;
      return ownedSubmit.promise;
    },
    fetch: async () => ({ ok: true, async json() { return { projects: [] }; } }),
    navigations,
  });
  const find = (type: unknown) => runtimeNodes(runner.current).find((node) => node.type === type);

  const stepOne = find(marker("Step1Script"));
  assert.ok(stepOne, "actual shell renders step one");
  (stepOne.props.onNext as () => void)();
  runner.flush();
  const stepTwo = find(marker("Step2Elements"));
  assert.ok(stepTwo, "actual shell advances to step two");
  await (stepTwo.props.onRender as () => Promise<void>)();
  runner.flush();
  let receipt = find(marker("RenderReceiptDialog"));
  assert.ok(receipt && receipt.props.open === true, "actual receipt opens before confirmation");
  (receipt.props.onConfirm as () => void)();
  runner.flush();
  assert.equal(submitCalls, 1, "the first shell confirmation owns one submission");

  lifecycleAllowed = false;
  currentProject = {
    ...currentProject,
    projectReady: false,
    recovery: { status: "conflict" },
    canRunProjectOperation: () => lifecycleAllowed,
  };
  runner.rerender();
  lifecycleAllowed = true;
  currentProject = {
    ...currentProject,
    projectReady: true,
    recovery: { status: "none" },
    canRunProjectOperation: () => lifecycleAllowed,
  };
  runner.rerender();

  const recoveredStepTwo = find(marker("Step2Elements"));
  assert.ok(recoveredStepTwo, "the recovered shell returns to the editor");
  await (recoveredStepTwo.props.onRender as () => Promise<void>)();
  runner.flush();
  receipt = find(marker("RenderReceiptDialog"));
  assert.ok(receipt && receipt.props.open === true, "the recovered shell can expose the owned receipt");
  assert.equal(
    receipt.props.submitting,
    true,
    "the recovered receipt still reflects the first owned confirmation",
  );
  (receipt.props.onConfirm as () => void)();
  runner.flush();
  assert.equal(
    submitCalls,
    1,
    "reconfirming the actual shell while its first POST is pending creates zero second attempts",
  );

  ownedSubmit.resolve({ ok: true });
  await settleShell(runner);
  assert.equal(submitCalls, 1, "the first shell attempt owns completion after recovery");
  assert.deepEqual(navigations, []);
}

async function runOwnedArchiveCompletionScenario(
  replaceProjectWhilePending: boolean,
  includeNextProject = true,
): Promise<string[]> {
  const deleteResponse = deferred<{
    ok: boolean;
    status: number;
    json(): Promise<{ ok: true }>;
  }>();
  let lifecycleAllowed = true;
  let currentProject = makeShellProject("archived-project", () => lifecycleAllowed);
  const navigations: string[] = [];
  const projects = [
    { id: "archived-project", title: "Archived", status: "draft" },
    ...(includeNextProject ? [{ id: "next-project", title: "Next", status: "draft" }] : []),
  ];
  const { runner, marker } = mountEditorShell({
    getProject: () => currentProject,
    submit: async () => ({ ok: true }),
    fetch: async (url, init = {}) => {
      if (url === "/api/editor-projects") {
        return { ok: true, async json() { return { projects }; } };
      }
      if (url === "/api/editor-projects/archived-project" && init.method === "DELETE") {
        return deleteResponse.promise;
      }
      throw new Error(`unexpected archive shell fetch: ${url}`);
    },
    navigations,
  });
  const find = (type: unknown, predicate: (node: RuntimeNode) => boolean = () => true) => (
    runtimeNodes(runner.current).find((node) => node.type === type && predicate(node))
  );
  const menu = find(marker("DropdownMenu"));
  assert.ok(menu, "actual shell renders the controlled project menu");
  (menu.props.onOpenChange as (open: boolean) => void)(true);
  runner.flush();
  await settleShell(runner);
  const deleteButton = find("button", (node) => node.props["aria-label"] === "ลบโปรเจกต์");
  assert.ok(deleteButton, "actual project row exposes delete");
  (deleteButton.props.onClick as (event: { preventDefault(): void; stopPropagation(): void }) => void)({
    preventDefault() {},
    stopPropagation() {},
  });
  runner.flush();
  const action = find(marker("AlertDialogAction"));
  assert.ok(action, "actual shell opens delete confirmation");
  (action.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
  runner.flush();

  if (replaceProjectWhilePending) {
    currentProject = makeShellProject("replacement-project", () => lifecycleAllowed);
  } else {
    lifecycleAllowed = false;
    currentProject = {
      ...currentProject,
      projectReady: false,
      recovery: { status: "conflict" },
      canRunProjectOperation: () => lifecycleAllowed,
    };
  }
  runner.rerender();
  deleteResponse.resolve({
    ok: true,
    status: 200,
    async json() { return { ok: true }; },
  });
  await settleShell(runner);
  await settleShell(runner);
  return navigations;
}

async function archiveCompletionOwnsDeterministicTransition(): Promise<void> {
  const recoveredNavigations = await runOwnedArchiveCompletionScenario(false);
  assert.equal(
    recoveredNavigations.length,
    1,
    "an owned successful archive transitions away even if recovery opened while DELETE was pending",
  );
  assert.match(
    recoveredNavigations[0],
    /projectId=next-project/,
    "owned archive completion opens the deterministic remaining project",
  );

  const emptyNavigations = await runOwnedArchiveCompletionScenario(false, false);
  assert.equal(emptyNavigations.length, 1, "owned archive completion leaves no archived project stuck when none remain");
  assert.equal(
    new URL(emptyNavigations[0], "https://example.test").searchParams.has("projectId"),
    false,
    "the empty-project transition clears the archived project identity so bootstrap creates a replacement",
  );

  const staleNavigations = await runOwnedArchiveCompletionScenario(true);
  assert.deepEqual(
    staleNavigations,
    [],
    "a stale archive completion cannot transition a replacement project",
  );
}

export async function archiveUnmountInvalidatesLateCompletion(): Promise<void> {
  const deleteResponse = deferred<{
    ok: boolean;
    status: number;
    json(): Promise<{ ok: true }>;
  }>();
  let recentProjectFetches = 0;
  let completeArchivedProjectCalls = 0;
  const currentProject = {
    ...makeShellProject("archive-unmount-project", () => true),
    completeArchivedProject: () => {
      completeArchivedProjectCalls += 1;
      return true;
    },
  };
  const navigations: string[] = [];
  const { runner, marker } = mountEditorShell({
    getProject: () => currentProject,
    submit: async () => ({ ok: true }),
    fetch: async (url, init = {}) => {
      if (url === "/api/editor-projects") {
        recentProjectFetches += 1;
        return {
          ok: true,
          async json() {
            return {
              projects: [
                { id: "archive-unmount-project", title: "Archived", status: "draft" },
                { id: "archive-unmount-next", title: "Next", status: "draft" },
              ],
            };
          },
        };
      }
      if (url === "/api/editor-projects/archive-unmount-project" && init.method === "DELETE") {
        return deleteResponse.promise;
      }
      throw new Error(`unexpected unmount archive fetch: ${url}`);
    },
    navigations,
  });
  const find = (type: unknown, predicate: (node: RuntimeNode) => boolean = () => true) => (
    runtimeNodes(runner.current).find((node) => node.type === type && predicate(node))
  );
  const menu = find(marker("DropdownMenu"));
  assert.ok(menu, "actual shell renders the project menu for the unmount case");
  (menu.props.onOpenChange as (open: boolean) => void)(true);
  runner.flush();
  await settleShell(runner);
  const deleteButton = find("button", (node) => node.props["aria-label"] === "ลบโปรเจกต์");
  assert.ok(deleteButton, "actual shell exposes archive before unmount");
  (deleteButton.props.onClick as (event: { preventDefault(): void; stopPropagation(): void }) => void)({
    preventDefault() {},
    stopPropagation() {},
  });
  runner.flush();
  const action = find(marker("AlertDialogAction"));
  assert.ok(action, "actual shell confirms archive before unmount");
  (action.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
  runner.flush();
  const recentFetchesBeforeUnmount = recentProjectFetches;
  runner.unmount();
  deleteResponse.resolve({
    ok: true,
    status: 200,
    async json() { return { ok: true }; },
  });
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  assert.deepEqual({
    recentFetchDelta: recentProjectFetches - recentFetchesBeforeUnmount,
    completeArchivedProjectCalls,
    navigations,
    stateUpdatesAfterUnmount: runner.stateUpdatesAfterUnmount,
  }, {
    recentFetchDelta: 0,
    completeArchivedProjectCalls: 0,
    navigations: [],
    stateUpdatesAfterUnmount: 0,
  }, "a late DELETE success is inert after the actual editor shell unmounts");
}

async function jobsRouteReplaysSameUserIdempotentJob(source: string): Promise<void> {
  const module = { exports: {} as Record<string, unknown> };
  const replayQueries: Array<Record<string, unknown>> = [];
  let createCalls = 0;
  class KeyRequiredError extends Error {}
  class BrandAssetError extends Error {
    code = "brand_error";
    status = 400;
  }
  const requireMock = (specifier: string): unknown => {
    if (specifier === "next/server") {
      return {
        NextResponse: {
          json: (body: unknown, init: { status?: number } = {}) => new Response(
            JSON.stringify(body),
            { status: init.status ?? 200, headers: { "Content-Type": "application/json" } },
          ),
        },
      };
    }
    if (specifier === "@/lib/clerk-auth") {
      return {
        getCurrentUser: async () => ({
          id: "route-user",
          role: "USER",
          plan: "PRO",
          ttsProvider: "gemini",
          pexelsKey: "pexels",
          pixabayKey: null,
          elevenlabsKey: null,
          elevenlabsVoiceId: null,
        }),
      };
    }
    if (specifier === "@/lib/prisma") {
      return {
        prisma: {
          videoJob: {
            count: async () => 0,
            findFirst: async (query: { where: Record<string, unknown> }) => {
              replayQueries.push(query.where);
              return query.where.userId === "route-user"
                && query.where.idempotencyKey === "committed-route-key"
                ? { id: "committed-route-job", status: "queued" }
                : null;
            },
          },
          editorProject: { updateMany: async () => ({ count: 1 }) },
        },
      };
    }
    if (specifier === "@/lib/mcp/video-job") {
      return {
        createVideoJob: async () => {
          createCalls += 1;
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        },
        parseVideoJobOutput: () => null,
      };
    }
    if (specifier === "@/lib/usage-limits") return { checkClipQuota: async () => ({ allowed: true }) };
    if (specifier === "@/lib/gemini-key") return { resolveGeminiKey: () => "key", KeyRequiredError };
    if (specifier === "@/lib/mcp/avatar-steps") return { resolveAvatarRequest: () => ({ kind: "none" }) };
    if (specifier === "@/lib/avatar-preset") return { getAvatarPreset: async () => null, resolveAvatarLayout: () => null };
    if (specifier === "@/lib/kie-image-guards") return { resolveKieImageAccess: () => ({ kiePaidUnlocked: false }) };
    if (specifier === "@/lib/automix-weights") return { parseAutoMixWeights: () => null };
    if (specifier === "@/lib/broll-preferences") {
      return { normalizeBrollRegionPreference: () => null, normalizeBrollVisualStyle: () => null };
    }
    if (specifier === "@/lib/editor-projects") return { assertEditorProjectOwner: async () => null };
    if (specifier === "@/lib/broll-rerender") return { validateWindowEdits: () => ({ error: "unused" }) };
    if (specifier === "@/lib/brand-assets.server") return { BrandAssetError };
    if (specifier === "@/lib/logo-export.server") {
      return { createDurableExportWithStagedLogo: async () => { throw new Error("unused"); } };
    }
    throw new Error(`unhandled jobs route import: ${specifier}`);
  };
  const factory = new Function("require", "module", "exports", compileJobsRoute(source));
  factory(requireMock, module, module.exports);
  const POST = module.exports.POST as (request: Request) => Promise<Response>;
  const response = await POST(new Request("https://example.test/api/videos/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "committed-route-key",
      script: "same logical attempt",
      voiceProvider: "gemini",
    }),
  }));
  assert.equal(response.status, 200, "same-user P2002 resolves as an idempotent replay");
  assert.deepEqual(await response.json(), {
    jobId: "committed-route-job",
    status: "queued",
    idempotentReplay: true,
  });
  assert.equal(createCalls, 1, "the route attempts no second durable create after P2002");
  assert.deepEqual(replayQueries, [{
    userId: "route-user",
    idempotencyKey: "committed-route-key",
  }], "the replay lookup is scoped to the authenticated user and exact key");
}

type RouteReplayRow = {
  id: string;
  status: string;
  idempotencyKey: string;
  idempotencyFingerprint: string | null;
};

async function runExactReplayRouteScenario(input: {
  body: Record<string, unknown>;
  persistedRow?: RouteReplayRow | null;
  persistedRowUserId?: string;
  persistedAfterCreate?: RouteReplayRow | null;
  createThrowsP2002?: boolean;
  failOnMutableGate?: boolean;
}) {
  const module = { exports: {} as Record<string, unknown> };
  const replayQueries: Array<Record<string, unknown>> = [];
  const createCalls: Array<{
    idempotencyKey: string | undefined;
    options: Record<string, unknown>;
  }> = [];
  const mutableTouches: string[] = [];
  let lookupCount = 0;
  class KeyRequiredError extends Error {}
  class BrandAssetError extends Error {
    code = "brand_error";
    status = 400;
  }
  const touchMutable = (name: string) => {
    mutableTouches.push(name);
    if (input.failOnMutableGate) throw new Error(`mutable gate touched before replay: ${name}`);
  };
  const operation = input.body.mode === "export"
    ? "export"
    : input.body.mode === "broll-rerender"
      ? "broll-rerender"
      : "preview";
  const expectedFingerprint = runtimeRequestFingerprint(operation, input.body);
  const requireMock = (specifier: string): unknown => {
    if (specifier === "next/server") {
      return {
        NextResponse: {
          json: (body: unknown, init: { status?: number } = {}) => new Response(
            JSON.stringify(body),
            { status: init.status ?? 200, headers: { "Content-Type": "application/json" } },
          ),
        },
      };
    }
    if (specifier === "@/lib/clerk-auth") {
      return {
        getCurrentUser: async () => ({
          id: "route-user",
          role: "USER",
          plan: "PRO",
          ttsProvider: "gemini",
          pexelsKey: "pexels",
          pixabayKey: null,
          elevenlabsKey: null,
          elevenlabsVoiceId: null,
        }),
      };
    }
    if (specifier === "@/lib/video-job-idempotency") {
      return {
        fingerprintVideoJobRequest: async (
          kind: "preview" | "export" | "broll-rerender",
          body: Record<string, unknown>,
        ) => runtimeRequestFingerprint(kind, body),
        videoJobOperationKind: (body: Record<string, unknown>) => body.mode === "export"
          ? "export"
          : body.mode === "broll-rerender"
            ? "broll-rerender"
            : "preview",
      };
    }
    if (specifier === "@/lib/prisma") {
      return {
        prisma: {
          videoJob: {
            count: async () => {
              touchMutable("inflight-count");
              return 0;
            },
            findFirst: async (query: { where: Record<string, unknown> }) => {
              replayQueries.push(query.where);
              lookupCount += 1;
              if (
                query.where.userId !== "route-user"
                || query.where.idempotencyKey !== input.body.idempotencyKey
              ) return null;
              if (input.persistedRowUserId && input.persistedRowUserId !== query.where.userId) {
                return null;
              }
              return lookupCount === 1
                ? (input.persistedRow ?? null)
                : (input.persistedAfterCreate ?? input.persistedRow ?? null);
            },
            findUnique: async () => {
              touchMutable("source-job");
              return null;
            },
          },
          editorProject: { updateMany: async () => ({ count: 1 }) },
        },
      };
    }
    if (specifier === "@/lib/mcp/video-job") {
      return {
        createVideoJob: async (
          _userId: string,
          _jobInput: unknown,
          idempotencyKey: string | undefined,
          options: Record<string, unknown> = {},
        ) => {
          createCalls.push({ idempotencyKey, options });
          if (input.createThrowsP2002) {
            throw Object.assign(new Error("duplicate"), { code: "P2002" });
          }
          return { id: "new-route-job", status: "queued" };
        },
        parseVideoJobOutput: () => null,
      };
    }
    if (specifier === "@/lib/usage-limits") {
      return {
        checkClipQuota: async () => {
          touchMutable("quota");
          return { allowed: true };
        },
      };
    }
    if (specifier === "@/lib/gemini-key") return { resolveGeminiKey: () => "key", KeyRequiredError };
    if (specifier === "@/lib/mcp/avatar-steps") return { resolveAvatarRequest: () => ({ kind: "none" }) };
    if (specifier === "@/lib/avatar-preset") {
      return {
        getAvatarPreset: async () => {
          touchMutable("avatar-preset");
          return null;
        },
        resolveAvatarLayout: () => null,
      };
    }
    if (specifier === "@/lib/kie-image-guards") return { resolveKieImageAccess: () => ({ kiePaidUnlocked: false }) };
    if (specifier === "@/lib/automix-weights") return { parseAutoMixWeights: () => null };
    if (specifier === "@/lib/broll-preferences") {
      return { normalizeBrollRegionPreference: () => null, normalizeBrollVisualStyle: () => null };
    }
    if (specifier === "@/lib/editor-projects") {
      return {
        assertEditorProjectOwner: async (_userId: string, projectId: string) => {
          touchMutable("project-owner");
          return projectId;
        },
      };
    }
    if (specifier === "@/lib/broll-rerender") return { validateWindowEdits: () => ({ error: "unused" }) };
    if (specifier === "@/lib/brand-assets.server") return { BrandAssetError };
    if (specifier === "@/lib/logo-export.server") {
      return {
        createDurableExportWithStagedLogo: async () => {
          touchMutable("trusted-logo-staging");
          throw new Error("unused");
        },
      };
    }
    throw new Error(`unhandled exact-replay route import: ${specifier}`);
  };
  const factory = new Function("require", "module", "exports", compileJobsRoute(jobsRouteSource));
  factory(requireMock, module, module.exports);
  const POST = module.exports.POST as (request: Request) => Promise<Response>;
  const response = await POST(new Request("https://example.test/api/videos/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.body),
  }));
  return {
    response,
    responseBody: await response.json() as Record<string, unknown>,
    replayQueries,
    createCalls,
    mutableTouches,
    expectedFingerprint,
  };
}

export async function exactReplayIdentityPrecedesMutableGates(): Promise<void> {
  const canonicalLeft = {
    idempotencyKey: "ignored-left",
    nested: { zebra: 2, alpha: true },
    ordered: [1, "1", false],
  };
  const canonicalRight = {
    ordered: [1, "1", false],
    nested: { alpha: true, zebra: 2 },
    idempotencyKey: "ignored-right",
  };
  assert.equal(
    canonicalVideoJobRequest("preview", canonicalLeft),
    canonicalVideoJobRequest("preview", canonicalRight),
    "canonical identity recursively sorts object keys and excludes the transport key",
  );
  const canonicalFingerprint = await fingerprintVideoJobRequest("preview", canonicalLeft);
  assert.equal(
    canonicalFingerprint,
    runtimeRequestFingerprint("preview", canonicalLeft),
    "the shared helper emits the stable versioned SHA-256 vector",
  );
  assert.notEqual(
    canonicalFingerprint,
    await fingerprintVideoJobRequest("export", canonicalLeft),
    "operation kind is part of the logical identity",
  );
  assert.notEqual(
    canonicalFingerprint,
    await fingerprintVideoJobRequest("preview", { ...canonicalLeft, ordered: ["1", 1, false] }),
    "array order and JSON scalar types remain significant",
  );

  const body = {
    idempotencyKey: "exact-preflight-key",
    projectId: "project-before-quota-change",
    script: "same immutable render request",
    voiceProvider: "gemini",
    stockSource: "stock",
    subtitleMode: "sentence",
    subtitlePosition: "bottom",
    billingContext: { requestedScenes: 4, weights: [1, 2, 3] },
  };
  const fingerprint = runtimeRequestFingerprint("preview", body);
  for (const status of ["queued", "processing", "done", "failed", "canceled"]) {
    const result = await runExactReplayRouteScenario({
      body,
      persistedRow: {
        id: `existing-${status}`,
        status,
        idempotencyKey: body.idempotencyKey,
        idempotencyFingerprint: fingerprint,
      },
      failOnMutableGate: true,
    });
    assert.equal(result.response.status, 200, `exact ${status} replay bypasses mutable gates`);
    assert.deepEqual(result.responseBody, {
      jobId: `existing-${status}`,
      status,
      idempotencyKey: body.idempotencyKey,
      idempotencyFingerprint: fingerprint,
      idempotentReplay: true,
    }, `exact ${status} replay returns authenticated ownership evidence`);
    assert.deepEqual(result.mutableTouches, [], `exact ${status} replay touches no mutable gate`);
    assert.equal(result.createCalls.length, 0, `exact ${status} replay creates no job`);
  }

  for (const operationBody of [
    {
      idempotencyKey: "exact-export-preflight-key",
      mode: "export",
      sourceJobId: "source-export-job",
      subtitleOverlayConfig: { captions: [] },
      exportSceneCount: 3,
    },
    {
      idempotencyKey: "exact-broll-preflight-key",
      mode: "broll-rerender",
      sourceJobId: "source-broll-job",
      windowEdits: [{ index: 0, src: "/api/stocks/replacement.mp4" }],
    },
  ]) {
    const operationKind = operationBody.mode as "export" | "broll-rerender";
    const operationFingerprint = runtimeRequestFingerprint(operationKind, operationBody);
    const result = await runExactReplayRouteScenario({
      body: operationBody,
      persistedRow: {
        id: `existing-${operationKind}`,
        status: "done",
        idempotencyKey: operationBody.idempotencyKey,
        idempotencyFingerprint: operationFingerprint,
      },
      failOnMutableGate: true,
    });
    assert.equal(result.response.status, 200, `exact ${operationKind} replay precedes branch-specific gates`);
    assert.deepEqual(result.mutableTouches, [], `exact ${operationKind} replay touches no source/render gate`);
  }

  for (const mismatch of [
    { label: "body", fingerprint: runtimeRequestFingerprint("preview", { ...body, script: "different" }) },
    { label: "project", fingerprint: runtimeRequestFingerprint("preview", { ...body, projectId: "other-project" }) },
    { label: "kind", fingerprint: runtimeRequestFingerprint("export", { ...body, mode: "export" }) },
    { label: "source", fingerprint: runtimeRequestFingerprint("preview", { ...body, sourceJobId: "other-source" }) },
    { label: "render", fingerprint: runtimeRequestFingerprint("preview", { ...body, subtitlePosition: "top" }) },
    { label: "billing", fingerprint: runtimeRequestFingerprint("preview", { ...body, billingContext: { requestedScenes: 99 } }) },
    { label: "legacy-null", fingerprint: null },
  ]) {
    const result = await runExactReplayRouteScenario({
      body,
      persistedRow: {
        id: `mismatch-${mismatch.label}`,
        status: "queued",
        idempotencyKey: body.idempotencyKey,
        idempotencyFingerprint: mismatch.fingerprint,
      },
      failOnMutableGate: true,
    });
    assert.equal(result.response.status, 409, `${mismatch.label} key reuse fails closed`);
    assert.equal(result.createCalls.length, 0, `${mismatch.label} key reuse creates nothing`);
    assert.deepEqual(result.mutableTouches, [], `${mismatch.label} conflict touches no mutable gate`);
  }

  const exactRaceRow: RouteReplayRow = {
    id: "p2002-exact-job",
    status: "processing",
    idempotencyKey: body.idempotencyKey,
    idempotencyFingerprint: fingerprint,
  };
  const exactRace = await runExactReplayRouteScenario({
    body,
    persistedRow: null,
    persistedAfterCreate: exactRaceRow,
    createThrowsP2002: true,
  });
  assert.equal(exactRace.response.status, 200, "exact P2002 race reuses the winner");
  assert.equal(exactRace.responseBody.jobId, exactRaceRow.id);
  assert.equal(exactRace.replayQueries.length, 2, "P2002 path reuses the same preflight comparator");

  const mismatchRace = await runExactReplayRouteScenario({
    body,
    persistedRow: null,
    persistedAfterCreate: { ...exactRaceRow, id: "p2002-mismatch-job", idempotencyFingerprint: "f".repeat(64) },
    createThrowsP2002: true,
  });
  assert.equal(mismatchRace.response.status, 409, "mismatched P2002 race fails closed");

  const crossUserKey = await runExactReplayRouteScenario({
    body: { ...body, idempotencyKey: "cross-user-isolated-key" },
    persistedRow: {
      id: "other-users-job",
      status: "queued",
      idempotencyKey: "cross-user-isolated-key",
      idempotencyFingerprint: runtimeRequestFingerprint("preview", {
        ...body,
        idempotencyKey: "cross-user-isolated-key",
      }),
    },
    persistedRowUserId: "different-user",
  });
  assert.equal(crossUserKey.response.status, 200, "another user's key cannot block this user's create");
  assert.equal(crossUserKey.responseBody.jobId, "new-route-job");
  assert.equal(crossUserKey.createCalls.length, 1);
  assert.ok(
    crossUserKey.replayQueries.every((where) => (
      where.userId === "route-user"
      && where.idempotencyKey === "cross-user-isolated-key"
    )),
    "every replay comparator query is scoped to the authenticated user and exact key",
  );
  assert.equal(
    crossUserKey.createCalls[0].options.idempotencyFingerprint,
    crossUserKey.expectedFingerprint,
    "a new job atomically persists its exact request fingerprint",
  );
}

export async function verifyProjectJobRuntimeGate(): Promise<void> {
  await sameTickConflictBlocksSubmitAndExport(jobSource);
  await archiveCompletionOwnsDeterministicTransition();
  await archiveUnmountInvalidatesLateCompletion();
  await recoveryCannotReleaseShellReceiptAttempt();
  await recoveryCannotDuplicateOwnedBillableSubmit(jobSource);
  await unrelatedResumeAndProjectReplacementCannotReleaseAttempt(jobSource, "create");
  await unrelatedResumeAndProjectReplacementCannotReleaseAttempt(jobSource, "export");
  await mutableLimitCannotReleaseAttempt(jobSource, "create");
  await mutableLimitCannotReleaseAttempt(jobSource, "export");
  await matchingPollReleasesAttempt(jobSource, "create");
  await matchingPollReleasesAttempt(jobSource, "export");
  await exactReplayIdentityPrecedesMutableGates();
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

  const releasesAmbiguousAttempt = jobSource.replaceAll(
    `          if (retryAmbiguous) attempt.promise = null;
          else submitAttemptRef.current = null;`,
    `          submitAttemptRef.current = null;`,
  );
  assert.notEqual(releasesAmbiguousAttempt, jobSource, "ambiguous-attempt release mutant applied");
  await assert.rejects(
    () => recoveryCannotDuplicateOwnedBillableSubmit(releasesAmbiguousAttempt),
    "runtime harness rejects a new idempotency key after a committed response is lost",
  );

}

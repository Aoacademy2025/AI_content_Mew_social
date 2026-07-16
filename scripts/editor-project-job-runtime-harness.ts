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
        async json() { return { jobId: "owned-job" }; },
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

export async function verifyProjectJobRuntimeGate(): Promise<void> {
  await sameTickConflictBlocksSubmitAndExport(jobSource);
  await archiveCompletionOwnsDeterministicTransition();
  await recoveryCannotReleaseShellReceiptAttempt();
  await recoveryCannotDuplicateOwnedBillableSubmit(jobSource);
  await jobsRouteReplaysSameUserIdempotentJob(jobsRouteSource);
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

  const missingRouteReplay = jobsRouteSource.replaceAll(
    "return replayIdempotentVideoJob(user.id, body.idempotencyKey);",
    `return NextResponse.json(
            { error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" },
            { status: 409 },
          );`,
  );
  assert.notEqual(missingRouteReplay, jobsRouteSource, "route replay mutant applied");
  await assert.rejects(
    () => jobsRouteReplaysSameUserIdempotentJob(missingRouteReplay),
    /same-user P2002 resolves as an idempotent replay/,
    "runtime harness rejects a route that cannot recover the committed job",
  );
}

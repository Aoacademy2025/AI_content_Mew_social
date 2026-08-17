import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type EffectRecord = {
  deps: readonly unknown[] | undefined;
  cleanup?: () => void;
};

type PendingEffect = {
  index: number;
  deps: readonly unknown[] | undefined;
  run: () => void | (() => void);
};

const sameDependencies = (
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean => previous !== undefined
  && next !== undefined
  && previous.length === next.length
  && previous.every((value, index) => Object.is(value, next[index]));

class HookRuntime {
  private readonly states: unknown[] = [];
  private readonly effects: EffectRecord[] = [];
  private stateCursor = 0;
  private effectCursor = 0;
  private pendingEffects: PendingEffect[] = [];
  private dirty = false;

  tree: unknown = null;

  constructor(
    private readonly component: (props: Record<string, unknown>) => unknown,
    private readonly props: Record<string, unknown>,
  ) {}

  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const index = this.stateCursor++;
    if (!(index in this.states)) {
      this.states[index] = typeof initial === "function"
        ? (initial as () => T)()
        : initial;
    }
    const setState = (next: T | ((previous: T) => T)) => {
      const previous = this.states[index] as T;
      const resolved = typeof next === "function"
        ? (next as (previous: T) => T)(previous)
        : next;
      if (!Object.is(previous, resolved)) {
        this.states[index] = resolved;
        this.dirty = true;
      }
    };
    return [this.states[index] as T, setState];
  }

  useMemo<T>(create: () => T): T {
    return create();
  }

  useEffect(run: () => void | (() => void), deps?: readonly unknown[]): void {
    const index = this.effectCursor++;
    if (!sameDependencies(this.effects[index]?.deps, deps)) {
      this.pendingEffects.push({ index, deps, run });
    }
  }

  render(): void {
    this.stateCursor = 0;
    this.effectCursor = 0;
    this.pendingEffects = [];
    activeRuntime = this;
    try {
      this.tree = this.component(this.props);
    } finally {
      activeRuntime = null;
    }
    for (const pending of this.pendingEffects) {
      this.effects[pending.index]?.cleanup?.();
      const cleanup = pending.run();
      this.effects[pending.index] = {
        deps: pending.deps,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    }
  }

  async settle(waitMs = 0): Promise<void> {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.dirty) continue;
      this.dirty = false;
      this.render();
    }
  }
}

let activeRuntime: HookRuntime | null = null;

const reactMock = {
  useState<T>(initial: T | (() => T)) {
    assert.ok(activeRuntime, "useState is called during a component render");
    return activeRuntime.useState(initial);
  },
  useMemo<T>(create: () => T) {
    assert.ok(activeRuntime, "useMemo is called during a component render");
    return activeRuntime.useMemo(create);
  },
  useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
    assert.ok(activeRuntime, "useEffect is called during a component render");
    return activeRuntime.useEffect(run, deps);
  },
};

const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const contentPreflightPosts: number[] = [];
const pendingRefreshes: Array<{ count: number; resolve: (response: Response) => void }> = [];
let holdContentPreflightRefresh = false;

const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === "/api/brand-library") {
    return jsonResponse({
      visualFormats: [{
        id: "clear-infographic",
        label: "อินโฟกราฟิกชัดเจน",
        description: "",
        previewUrl: "/preview.png",
      }],
      treatmentPresets: [{ id: "expert-clarity", label: "ชัดเจนแบบผู้เชี่ยวชาญ" }],
      profiles: [],
    });
  }
  if (url.endsWith("/content-preflight")) {
    const count = Number(JSON.parse(String(init?.body)).narrativeSource.windowCount);
    contentPreflightPosts.push(count);
    if (holdContentPreflightRefresh) {
      return new Promise((resolve) => pendingRefreshes.push({ count, resolve }));
    }
    return jsonResponse({ preflight: buildPreflight(count) });
  }
  if (url.includes("/visual-context")) {
    return jsonResponse({
      context: {
        source: "suggested",
        visualFormatId: "clear-infographic",
        treatment: "ชัดเจน",
      },
      selectedBrandProfile: null,
    });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

function buildPreflight(count: number) {
  return {
    id: `preflight-${count}`,
    sourceHash: `source-${count}`,
    suggestedVisualFormatId: "clear-infographic",
    suggestedTreatment: {
      presetId: "expert-clarity",
      version: "v1.0.0",
      label: "ชัดเจน",
      rationale: "เหมาะกับภาพรวมของเนื้อหา",
    },
    rankedTreatmentPresetIds: ["expert-clarity"],
    formatRecommendation: null,
    visualBeats: Array.from({ length: count }, (_, index) => ({
      id: `beat-${index}`,
      status: "current",
      existingAssetUrl: null,
    })),
  };
}

const sourcePath = "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx";
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;

const exportsObject: Record<string, unknown> = {};
const noopComponent = () => null;
const color = new Proxy({}, { get: () => "#fff" });
const requireMock = (id: string): unknown => {
  if (id === "react") return reactMock;
  if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
  if (id === "next/link") return noopComponent;
  if (id === "lucide-react") {
    return new Proxy({}, { get: () => noopComponent });
  }
  if (id === "sonner") return { toast: { error() {}, success() {} } };
  if (id === "@/lib/client-telemetry") return { trackEvent() {} };
  if (id === "@/lib/logo-overlay") return { normalizeLogoOverlayConfig: (value: unknown) => value };
  if (id === "@/lib/editor-style-preset-contract") return { normalizeSubtitleStylePresetConfig: (value: unknown) => value };
  if (id === "@/lib/automix-plan") return { shouldLoadBrandVisualContext: () => true };
  if (id === "@/lib/brand-visual-system") {
    return { visualFormatThaiLabel: (value: string) => value };
  }
  if (id === "@/lib/brand-treatment-presentation") {
    return {
      buildTreatmentChoiceGroups: () => ({ featured: [], all: [] }),
      buildVisualSummary: (format: string, treatment: string) => `${format} · ${treatment}`,
    };
  }
  if (id === "@/lib/scene-content-policy") return { sceneContentPolicyFromPreference: () => ({}) };
  if (id === "./tokens") return { color, font: { heading: "sans-serif" }, radius: { card: 12 } };
  throw new Error(`Unexpected module import: ${id}`);
};

vm.runInNewContext(compiled, {
  exports: exportsObject,
  module: { exports: exportsObject },
  require: requireMock,
  fetch: fetchMock,
  AbortController,
  console,
  setTimeout,
  clearTimeout,
  window: { setTimeout, clearTimeout },
  URL,
});

const BrandVisualSelector = exportsObject.BrandVisualSelector as (
  props: Record<string, unknown>,
) => unknown;
assert.equal(typeof BrandVisualSelector, "function", "BrandVisualSelector compiles in the behavior harness");

const preflightIdWrites: Array<string | null> = [];
const statuses: string[] = [];
const project = {
  projectId: "project-1",
  script: "Hook\nExplain\nClose",
  mode: "script",
  narrativeSourceKind: "creator-script",
  targetClipCount: 8,
  brollRegionPreference: "auto",
  brollSource: "kie-image",
  mixPreset: "hero",
  brandVisualAllowed: true,
  hasPersistedVisualPin: false,
  heroAiBeta: false,
  isAdmin: false,
  starterAiImageAllowance: undefined,
  setBrandContentPreflightId(value: string | null) { preflightIdWrites.push(value); },
  setHasPersistedVisualPin() {},
  setMixPreset() {},
  flushPendingProjectDraft: async () => true,
  acceptAuthoritativeProjectSnapshot: () => true,
  setVoiceEngine() {},
  setGeminiVoiceName() {},
  setVoiceId() {},
  setOmniVoiceId() {},
  setBrandSubtitleDefault() {},
  setLogoOverlay() {},
};

const runtime = new HookRuntime(BrandVisualSelector, {
  p: project,
  onPreflightStatusChange: (status: string) => statuses.push(status),
  onPolicyWarningsChange: () => {},
  onSelectionBlockedChange: () => {},
});

async function main(): Promise<void> {
  runtime.render();
  await runtime.settle();
  assert.deepEqual(contentPreflightPosts, [8], "the initial visual preflight loads once");
  assert.equal(preflightIdWrites.at(-1), "preflight-8", "the initial preflight becomes render-authoritative");

  contentPreflightPosts.length = 0;
  preflightIdWrites.length = 0;
  statuses.length = 0;
  holdContentPreflightRefresh = true;
  project.targetClipCount = 9;
  runtime.render();
  await runtime.settle(80);
  project.targetClipCount = 10;
  runtime.render();
  await runtime.settle(120);

  assert.deepEqual(
    contentPreflightPosts,
    [],
    "rapid image-count changes are debounced instead of launching a full preflight per click",
  );
  assert.ok(statuses.includes("loading"), "rendering is blocked immediately while the count is unsettled");
  assert.doesNotMatch(
    JSON.stringify(runtime.tree),
    /กำลังอ่านเนื้อหา|กำลังวิเคราะห์แนวภาพและฉากของคลิปครั้งแรก/,
    "the existing visual controls remain mounted while the count refresh is pending",
  );
  assert.equal(
    preflightIdWrites.includes(null),
    false,
    "the last valid preflight is not destructively cleared before its replacement succeeds",
  );

  await runtime.settle(400);
  assert.deepEqual(contentPreflightPosts, [10], "the settled image count launches exactly one replacement preflight");
  assert.equal(pendingRefreshes.length, 1, "the replacement request remains controllable in the harness");
  assert.doesNotMatch(
    JSON.stringify(runtime.tree),
    /กำลังอ่านเนื้อหา|กำลังวิเคราะห์แนวภาพและฉากของคลิปครั้งแรก/,
    "background refresh does not replace the existing panel with a loading screen",
  );
  assert.equal(
    preflightIdWrites.includes(null),
    false,
    "the old render-authoritative preflight remains available during the background request",
  );

  pendingRefreshes[0].resolve(jsonResponse({ preflight: buildPreflight(10) }));
  await runtime.settle();
  assert.equal(preflightIdWrites.at(-1), "preflight-10", "the settled count atomically replaces the preflight");
  assert.equal(statuses.at(-1), "ready", "rendering is unblocked only after the replacement is ready");

  console.log("verify-brand-visual-count-refresh: PASS debounced count refresh preserves the existing UI and swaps preflight atomically");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Regression verification for HERO-118:
// - Every setChanging(true) async path in BrandVisualSelector.tsx cleans up in finally
//   with latest-mutation/mounted guards and recoverable Thai toasts for non-silent throws.
// - Pending 409 confirmation scrolls smoothly into view and surfaces an inline notice +
//   "ไปที่การยืนยัน" jump action next to the Step 2 render CTA (desktop + mobile).
// - EditorV2Shell.tsx never silently drops render/confirm/regenerate clicks or leaves
//   receiptOpen stale when editorBlocked or !canRunProjectOperation().
//
// Run: npm run verify:brand-render-cta-guard

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as stylePackCatalogModule from "../src/lib/style-pack-catalog";

const selectorPath = "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx";
const step2Path = "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx";
const shellPath = "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx";

const selectorSource = readFileSync(selectorPath, "utf8");
const step2Source = readFileSync(step2Path, "utf8");
const shellSource = readFileSync(shellPath, "utf8");

// ── 1. AST guard: EVERY setChanging(true) async path resets in finally ──────

function isSetChangingCall(node: ts.Node, expectedBoolean: boolean): node is ts.CallExpression {
  return (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "setChanging"
    && node.arguments.length === 1
    && node.arguments[0].kind === (expectedBoolean ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword)
  );
}

function containsCall(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function verifyEverySetChangingTrueHasFinallyReset(source: string): number {
  const sf = ts.createSourceFile(selectorPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(sf.parseDiagnostics.length, 0, "BrandVisualSelector.tsx parses cleanly as TSX");

  const trueCalls: ts.CallExpression[] = [];
  const collect = (node: ts.Node): void => {
    if (isSetChangingCall(node, true)) trueCalls.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sf);

  assert.ok(
    trueCalls.length >= 4,
    `expected at least 4 setChanging(true) mutator paths (clearSyncedStylePack, applyLook, applyStylePackChoice, pinProfile), found ${trueCalls.length}`,
  );

  for (const call of trueCalls) {
    // Walk up to the enclosing block containing the setChanging(true) statement.
    let current: ts.Node | undefined = call;
    while (current && !ts.isBlock(current)) current = current.parent;
    assert.ok(current && ts.isBlock(current), "setChanging(true) sits inside a statement block");

    const callLine = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
    const callStatementIndex = current.statements.findIndex(
      (stmt) => call.getStart(sf) >= stmt.getStart(sf) && call.getEnd() <= stmt.getEnd(),
    );
    assert.ok(callStatementIndex >= 0, `located statement for setChanging(true) at line ${callLine}`);

    // Require either a sibling try/catch/finally after setChanging(true) or an enclosing try/finally.
    const followingTry = current.statements
      .slice(callStatementIndex)
      .find((stmt): stmt is ts.TryStatement => ts.isTryStatement(stmt));
    let enclosingTry: ts.TryStatement | undefined;
    let cursor: ts.Node | undefined = current.parent;
    while (cursor && !enclosingTry) {
      if (ts.isTryStatement(cursor)) enclosingTry = cursor;
      cursor = cursor.parent;
    }

    const guardedTry = followingTry ?? enclosingTry;
    assert.ok(
      guardedTry && guardedTry.catchClause && guardedTry.finallyBlock,
      `setChanging(true) at line ${callLine} must be paired with try/catch/finally`,
    );
    assert.ok(
      containsCall(guardedTry.finallyBlock, (node) => isSetChangingCall(node, false)),
      `setChanging(true) at line ${callLine} must reset setChanging(false) inside finally`,
    );
  }

  return trueCalls.length;
}

const verifiedTruePaths = verifyEverySetChangingTrueHasFinallyReset(selectorSource);
console.log(`✓ AST guard: all ${verifiedTruePaths} setChanging(true) mutators reset setChanging(false) in try/catch/finally`);

// Mutation sensitivity: removing one finally cleanup must fail the AST guard.
const mutatedMissingFinally = selectorSource.replace(
  /\} finally \{\s*if \(isCurrentMutation\(mutationId\)\) setChanging\(false\);\s*\}/,
  "}",
);
assert.notEqual(mutatedMissingFinally, selectorSource, "mutation sensitivity patch applied");
assert.throws(
  () => verifyEverySetChangingTrueHasFinallyReset(mutatedMissingFinally),
  /try\/catch\/finally/,
  "AST guard catches a mutator that drops finally cleanup",
);
console.log("✓ AST guard mutation sensitivity: missing finally block fails verification");

// ── 2. Runtime Hook harness for BrandVisualSelector.tsx ─────────────────────

type EffectRecord = { deps: readonly unknown[] | undefined; cleanup?: () => void };
type PendingEffect = { index: number; deps: readonly unknown[] | undefined; run: () => void | (() => void) };

const sameDeps = (
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean => prev !== undefined
  && next !== undefined
  && prev.length === next.length
  && prev.every((value, idx) => Object.is(value, next[idx]));

type VNode = { type: unknown; props: Record<string, unknown>; key?: unknown };

class HookRuntime {
  private readonly states: unknown[] = [];
  private readonly refs: Array<{ current: unknown }> = [];
  private readonly effects: EffectRecord[] = [];
  private stateCursor = 0;
  private refCursor = 0;
  private effectCursor = 0;
  private pendingEffects: PendingEffect[] = [];
  private dirty = false;
  tree: unknown = null;

  constructor(
    private readonly component: (props: Record<string, unknown>) => unknown,
    public props: Record<string, unknown>,
    private readonly onCommit?: (tree: unknown) => void,
  ) {}

  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const index = this.stateCursor++;
    if (!(index in this.states)) {
      this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const setState = (next: T | ((prev: T) => T)) => {
      const prev = this.states[index] as T;
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      if (!Object.is(prev, resolved)) {
        this.states[index] = resolved;
        this.dirty = true;
      }
    };
    return [this.states[index] as T, setState];
  }

  useRef<T>(initial: T): { current: T } {
    const index = this.refCursor++;
    if (!(index in this.refs)) {
      this.refs[index] = { current: initial };
    }
    return this.refs[index] as { current: T };
  }

  useMemo<T>(create: () => T): T {
    return create();
  }

  useEffect(run: () => void | (() => void), deps?: readonly unknown[]): void {
    const index = this.effectCursor++;
    if (!sameDeps(this.effects[index]?.deps, deps)) {
      this.pendingEffects.push({ index, deps, run });
    }
  }

  render(): void {
    this.stateCursor = 0;
    this.refCursor = 0;
    this.effectCursor = 0;
    this.pendingEffects = [];
    setActiveRuntime(this);
    try {
      this.tree = this.component(this.props);
    } finally {
      setActiveRuntime(null);
    }
    this.onCommit?.(this.tree);
    for (const pending of this.pendingEffects) {
      this.effects[pending.index]?.cleanup?.();
      const cleanup = pending.run();
      this.effects[pending.index] = {
        deps: pending.deps,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    }
  }

  unmount(): void {
    for (const effect of this.effects) {
      effect?.cleanup?.();
    }
  }

  async settle(waitMs = 0): Promise<void> {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.dirty) continue;
      this.dirty = false;
      this.render();
    }
  }
}

let activeRuntime: HookRuntime | null = null;
function setActiveRuntime(runtime: HookRuntime | null): void {
  activeRuntime = runtime;
}
const reactMock = {
  useState<T>(initial: T | (() => T)) {
    assert.ok(activeRuntime, "useState called inside render");
    return activeRuntime.useState(initial);
  },
  useRef<T>(initial: T) {
    assert.ok(activeRuntime, "useRef called inside render");
    return activeRuntime.useRef(initial);
  },
  useMemo<T>(create: () => T) {
    assert.ok(activeRuntime, "useMemo called inside render");
    return activeRuntime.useMemo(create);
  },
  useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
    assert.ok(activeRuntime, "useEffect called inside render");
    return activeRuntime.useEffect(run, deps);
  },
};

const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown): VNode => ({
  type,
  props: props ?? {},
  key,
});

function walkTree(value: unknown, visitor: (node: VNode) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkTree(item, visitor);
    return;
  }
  const node = value as Partial<VNode>;
  if (node.type !== undefined && node.props && typeof node.props === "object") {
    visitor(node as VNode);
    if (typeof node.type === "function") {
      // Expand pure helper function components (like PendingChangeConfirmation) that do not use hooks.
      const fnName = (node.type as { name?: string }).name;
      if (fnName === "PendingChangeConfirmation") {
        walkTree((node.type as (props: Record<string, unknown>) => unknown)(node.props), visitor);
      }
    }
  }
  if (node.props && typeof node.props === "object" && "children" in node.props) {
    walkTree(node.props.children, visitor);
  }
}

function findNode(tree: unknown, predicate: (node: VNode) => boolean): VNode | null {
  let found: VNode | null = null;
  walkTree(tree, (node) => {
    if (!found && predicate(node)) found = node;
  });
  return found;
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) {
    const props = (value as { props?: { children?: unknown } }).props;
    return textContent(props?.children);
  }
  return "";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function verifyBrandVisualSelectorRuntime(): Promise<void> {
  const toastErrors: string[] = [];
  const toastSuccesses: string[] = [];
  const StylePackPickerMarker = Symbol("StylePackPicker");

  type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
  let visualContextPutHandler: FetchHandler = async () => jsonResponse({ look: { treatment: "ชัดเจน" } });
  let visualContextDeleteHandler: FetchHandler = async () => jsonResponse({ cleared: true });
  let brandRevisionPutHandler: FetchHandler = async () => jsonResponse({ project: { id: "project-1" } });

  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/brand-library") {
      return jsonResponse({
        visualFormats: [
          { id: "clear-infographic", label: "อินโฟกราฟิกเข้าใจง่าย", description: "", previewUrl: "/a.png" },
          { id: "dramatic-comic", label: "คอมิกเข้มข้น", description: "", previewUrl: "/b.png" },
        ],
        treatmentPresets: [{ id: "expert-clarity", label: "ชัดเจนแบบผู้เชี่ยวชาญ" }],
        profiles: [
          {
            id: "profile-1",
            name: "แบรนด์หลัก",
            frozen: false,
            legacyVisualFormat: false,
            activeRevisionNumber: 1,
            activeRevisionId: "rev-1",
          },
        ],
        stylePacks: [
          {
            id: "shop-review",
            thaiLabel: "รีวิวสินค้า",
            tagline: "สายรีวิว",
            palette: ["#111", "#222", "#333"],
            sampleImage: "/pack.png",
          },
        ],
      });
    }
    if (url.endsWith("/content-preflight")) {
      return jsonResponse({
        preflight: {
          id: "preflight-1",
          sourceHash: "hash-1",
          suggestedVisualFormatId: "clear-infographic",
          suggestedTreatment: {
            presetId: "expert-clarity",
            version: "v1.0.0",
            label: "ชัดเจนแบบผู้เชี่ยวชาญ",
            rationale: "เหมาะกับเนื้อหา",
          },
          rankedTreatmentPresetIds: ["expert-clarity"],
          formatRecommendation: null,
          visualBeats: [{ id: "beat-0", status: "current", existingAssetUrl: null }],
        },
      });
    }
    if (url.includes("/visual-context") && method === "GET") {
      return jsonResponse({
        context: {
          source: "suggested",
          visualFormatId: "clear-infographic",
          treatment: "ชัดเจนแบบผู้เชี่ยวชาญ",
          treatmentPin: { presetId: "expert-clarity", version: "v1.0.0" },
        },
        hasAdmittedVisualPin: true,
        selectedBrandProfile: null,
        stylePack: null,
      });
    }
    if (url.includes("/visual-context") && method === "PUT") {
      return visualContextPutHandler(url, init);
    }
    if (url.includes("/visual-context") && method === "DELETE") {
      return visualContextDeleteHandler(url, init);
    }
    if (url.endsWith("/brand-revision") && method === "PUT") {
      return brandRevisionPutHandler(url, init);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  const compiled = ts.transpileModule(selectorSource, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: selectorPath,
  }).outputText;

  const exportsObj: Record<string, unknown> = {};
  const noop = () => null;
  const requireMock = (id: string): unknown => {
    if (id === "react") return reactMock;
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
    if (id === "next/link") return noop;
    if (id === "lucide-react") return new Proxy({}, { get: () => noop });
    if (id === "sonner") {
      return {
        toast: {
          error(msg: string) { toastErrors.push(msg); },
          success(msg: string) { toastSuccesses.push(msg); },
        },
      };
    }
    if (id === "@/lib/client-telemetry") return { trackEvent() {} };
    if (id === "@/lib/automix-plan") return { shouldLoadBrandVisualContext: () => true };
    if (id === "@/lib/brand-visual-system") return { visualFormatThaiLabel: (v: string) => v };
    if (id === "@/lib/brand-treatment-presentation") {
      return {
        buildTreatmentChoiceGroups: () => ({ featured: [], all: [] }),
        buildVisualSummary: (f: string, t: string) => `${f} · ${t}`,
      };
    }
    if (id === "@/lib/scene-content-policy") {
      return { sceneContentPolicyFromPreference: (pref: string) => ({ pref }) };
    }
    if (id === "@/app/(dashboard)/brands/_components/StylePackPicker") {
      return { StylePackPicker: StylePackPickerMarker };
    }
    if (id === "@/lib/style-pack-catalog") return stylePackCatalogModule;
    if (id === "./tokens") {
      return {
        color: new Proxy({}, { get: () => "#fff" }),
        font: { heading: "sans-serif", body: "sans-serif" },
        radius: { card: 12 },
      };
    }
    throw new Error(`Unexpected BrandVisualSelector import: ${id}`);
  };

  vm.runInNewContext(compiled, {
    exports: exportsObj,
    module: { exports: exportsObj },
    require: requireMock,
    fetch: fetchMock,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    window: {
      setTimeout,
      clearTimeout,
      location: { reload() {} },
    },
    URL,
  });

  const BrandVisualSelector = exportsObj.BrandVisualSelector as (
    props: Record<string, unknown>,
  ) => unknown;

  const blockedTransitions: boolean[] = [];
  let latestBlocked = false;
  const pendingUpdates: Array<{
    kind: string;
    label: string;
    existingImageCount: number;
    quotedCredits: number;
    jumpToConfirmation: () => void;
  } | null> = [];
  const scrollCalls: Array<{ target: string; options: unknown }> = [];

  let flushDeferred: ReturnType<typeof deferred<boolean>> | null = null;
  const project: Record<string, unknown> = {
    projectId: "project-1",
    script: "บททดสอบการสร้างคลิป",
    mode: "script",
    narrativeSourceKind: "creator-script",
    targetClipCount: 6,
    brollRegionPreference: "auto",
    brollSource: "kie-image",
    mixPreset: "recommended",
    brandVisualAllowed: true,
    brandLibraryAllowed: true,
    hasPersistedVisualPin: false,
    hasAdmittedVisualPin: true,
    projectStylePack: null,
    templateId: null,
    heroAiBeta: false,
    isAdmin: false,
    starterAiImageAllowance: undefined,
    setBrandContentPreflightId() {},
    setHasPersistedVisualPin() {},
    setHasAdmittedVisualPin() {},
    setProjectStylePack(next: unknown) { project.projectStylePack = next; },
    setTemplateId(next: unknown) { project.templateId = next ?? null; },
    selectVideoTemplate(next: unknown) { project.templateId = next; },
    setMixPreset() {},
    flushPendingProjectDraft: async () => (flushDeferred ? flushDeferred.promise : true),
    acceptAuthoritativeProjectSnapshot: () => true,
  };

  const attachMockDomRefs = (tree: unknown) => {
    walkTree(tree, (node) => {
      if (node.type === "section" && node.props.ref && typeof node.props.ref === "object") {
        (node.props.ref as { current: unknown }).current = {
          scrollIntoView(options: unknown) {
            scrollCalls.push({ target: "section", options });
          },
        };
      }
      if (
        node.props["data-brand-pending-confirmation"] === "true"
        && node.props.ref
        && typeof node.props.ref === "object"
      ) {
        (node.props.ref as { current: unknown }).current = {
          scrollIntoView(options: unknown) {
            scrollCalls.push({ target: "pending-card", options });
          },
        };
      }
    });
  };

  const runtime = new HookRuntime(
    BrandVisualSelector,
    {
      p: project,
      onPreflightStatusChange: () => {},
      onPolicyWarningsChange: () => {},
      onSelectionBlockedChange: (blocked: boolean) => {
        latestBlocked = blocked;
        blockedTransitions.push(blocked);
      },
      onPendingConfirmationChange: (pendingInfo: typeof pendingUpdates[number]) => pendingUpdates.push(pendingInfo),
    },
    attachMockDomRefs,
  );

  runtime.render();
  await runtime.settle();
  assert.equal(latestBlocked, false, "initial settled BrandVisualSelector is unblocked");

  // Open the options panel so format buttons and StylePackPicker are rendered.
  const toggleBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && node.props["aria-controls"] === "brand-visual-options",
  );
  assert.ok(toggleBtn, "BrandVisualSelector disclosure button is rendered");
  (toggleBtn.props.onClick as () => void)();
  await runtime.settle();

  // 2a. applyLook throws a network error -> transitions true -> false + Thai error toast.
  blockedTransitions.length = 0;
  toastErrors.length = 0;
  const lookFail = deferred<Response>();
  visualContextPutHandler = () => lookFail.promise;
  const comicFormatBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && textContent(node).includes("คอมิกเข้มข้น"),
  );
  assert.ok(comicFormatBtn, "format button exists in expanded BrandVisualSelector");
  (comicFormatBtn.props.onClick as () => void)();
  await runtime.settle();
  assert.equal(latestBlocked, true, "applyLook blocks while request is in flight");
  lookFail.reject(new TypeError("Failed to fetch"));
  await runtime.settle();
  assert.equal(latestBlocked, false, "applyLook network error resets changing to false");
  assert.deepEqual(blockedTransitions, [true, false], "applyLook observed blocked -> unblocked transition");
  assert.equal(toastErrors.length, 1, "applyLook network error surfaces one recoverable Thai toast");
  assert.match(toastErrors[0], /เปลี่ยนแนวภาพไม่สำเร็จ/, "applyLook error toast uses clear Thai copy");

  // 2b. applyLook throws AbortError -> transitions true -> false with NO toast.
  blockedTransitions.length = 0;
  toastErrors.length = 0;
  const lookAbort = deferred<Response>();
  visualContextPutHandler = () => lookAbort.promise;
  (comicFormatBtn.props.onClick as () => void)();
  await runtime.settle();
  assert.equal(latestBlocked, true, "applyLook blocks while request is in flight before abort");
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  lookAbort.reject(abortErr);
  await runtime.settle();
  assert.equal(latestBlocked, false, "applyLook AbortError resets changing to false");
  assert.equal(toastErrors.length, 0, "applyLook AbortError does not show error toast");

  // 2c. applyStylePackChoice explicit click throws -> transitions true -> false + Thai toast.
  const openPackPickerBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && textContent(node).includes("เปลี่ยนเฉพาะคลิปนี้"),
  );
  assert.ok(openPackPickerBtn, "per-clip style pack toggle button exists");
  (openPackPickerBtn.props.onClick as () => void)();
  await runtime.settle();
  const packPicker = findNode(runtime.tree, (node) => node.type === StylePackPickerMarker);
  assert.ok(packPicker, "StylePackPicker mounts when opened");

  blockedTransitions.length = 0;
  toastErrors.length = 0;
  const packFail = deferred<Response>();
  visualContextPutHandler = () => packFail.promise;
  (packPicker.props.onChange as (id: string) => void)("shop-review");
  await runtime.settle();
  assert.equal(latestBlocked, true, "explicit applyStylePackChoice blocks while in flight");
  packFail.reject(new Error("socket hang up"));
  await runtime.settle();
  assert.equal(latestBlocked, false, "explicit applyStylePackChoice throw resets changing to false");
  assert.equal(toastErrors.length, 1, "explicit applyStylePackChoice throw surfaces Thai toast");
  assert.match(toastErrors[0], /เปลี่ยนสไตล์ของคลิปนี้ไม่สำเร็จ/);

  // 2d. applyStylePackChoice silent template auto-sync throws -> transitions true -> false + NO toast.
  blockedTransitions.length = 0;
  toastErrors.length = 0;
  const autoSyncFail = deferred<Response>();
  visualContextPutHandler = () => autoSyncFail.promise;
  project.templateId = "shop-review";
  runtime.render();
  await runtime.settle();
  assert.equal(latestBlocked, true, "silent template auto-sync blocks while in flight");
  autoSyncFail.reject(new Error("network blip"));
  await runtime.settle();
  assert.equal(latestBlocked, false, "silent template auto-sync throw resets changing to false");
  assert.equal(toastErrors.length, 0, "silent template auto-sync throw suppresses toast");

  // 2e. pinProfile throws on PUT /brand-revision AND on flushPendingProjectDraft -> resets + Thai toast.
  const profileSelect = findNode(
    runtime.tree,
    (node) => node.type === "select" && typeof node.props.onChange === "function",
  );
  assert.ok(profileSelect, "Brand profile selector exists");

  blockedTransitions.length = 0;
  toastErrors.length = 0;
  flushDeferred = null;
  const pinPutFail = deferred<Response>();
  brandRevisionPutHandler = () => pinPutFail.promise;
  (profileSelect.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "profile-1" } });
  await runtime.settle();
  assert.equal(latestBlocked, true, "pinProfile blocks while PUT is in flight");
  pinPutFail.reject(new Error("connection reset"));
  await runtime.settle();
  assert.equal(latestBlocked, false, "pinProfile PUT throw resets changing to false");
  assert.equal(toastErrors.length, 1, "pinProfile PUT throw surfaces Thai toast");
  assert.match(toastErrors[0], /เลือกแบรนด์ไม่สำเร็จ/);

  blockedTransitions.length = 0;
  toastErrors.length = 0;
  flushDeferred = deferred<boolean>();
  (profileSelect.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "profile-1" } });
  await runtime.settle();
  assert.equal(latestBlocked, true, "pinProfile blocks while draft flush is in flight");
  flushDeferred.reject(new Error("flush failed"));
  await runtime.settle();
  assert.equal(latestBlocked, false, "pinProfile flushPendingProjectDraft throw resets changing to false");
  assert.equal(toastErrors.length, 1, "pinProfile flush throw surfaces Thai toast");
  flushDeferred = null;

  // 2f. clearSyncedStylePack (DELETE /visual-context) throws -> transitions true -> false cleanly.
  blockedTransitions.length = 0;
  toastErrors.length = 0;
  const deleteFail = deferred<Response>();
  project.projectStylePack = { packId: "shop-review", thaiLabel: "รีวิวสินค้า", source: "project" };
  project.templateId = null;
  visualContextDeleteHandler = () => deleteFail.promise;
  runtime.render();
  await runtime.settle();
  assert.equal(latestBlocked, true, "DELETE auto-sync blocks while in flight");
  deleteFail.reject(new Error("offline"));
  await runtime.settle();
  assert.equal(latestBlocked, false, "DELETE auto-sync throw resets changing to false");

  // 2g. Stale mutation guard: slow first mutation rejecting must NOT unblock active second mutation.
  blockedTransitions.length = 0;
  toastErrors.length = 0;
  const firstMutation = deferred<Response>();
  const secondMutation = deferred<Response>();
  let putCount = 0;
  visualContextPutHandler = () => {
    putCount += 1;
    return putCount === 1 ? firstMutation.promise : secondMutation.promise;
  };
  const liveComicBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && textContent(node).includes("คอมิกเข้มข้น"),
  );
  assert.ok(liveComicBtn);
  (liveComicBtn.props.onClick as () => void)();
  await runtime.settle();
  assert.equal(latestBlocked, true, "first in-flight mutation blocks selection");

  const liveInfographicBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && textContent(node).includes("อินโฟกราฟิกเข้าใจง่าย"),
  );
  assert.ok(liveInfographicBtn);
  (liveInfographicBtn.props.onClick as () => void)();
  await runtime.settle();

  // Reject stale mutation #1 while mutation #2 is still running.
  firstMutation.reject(new Error("stale network failure"));
  await runtime.settle();
  assert.equal(latestBlocked, true, "stale mutation failure does not prematurely unblock active mutation");
  assert.equal(toastErrors.length, 0, "stale mutation failure does not fire stale error toast");

  // Resolve mutation #2 -> cleanly unblocks.
  secondMutation.resolve(jsonResponse({ look: { treatment: "ชัดเจนแบบผู้เชี่ยวชาญ" } }));
  await runtime.settle();
  assert.equal(latestBlocked, false, "latest mutation completion unblocks CTA");

  // 2h. 409 LOOK_CHANGE_CONFIRMATION_REQUIRED on template auto-sync -> scrollIntoView + pending callback + jump!
  // Collapse panel first to simulate creator working below the fold.
  const collapseBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && node.props["aria-controls"] === "brand-visual-options",
  );
  assert.ok(collapseBtn);
  (collapseBtn.props.onClick as () => void)();
  await runtime.settle();

  scrollCalls.length = 0;
  pendingUpdates.length = 0;
  blockedTransitions.length = 0;
  project.projectStylePack = null;
  visualContextPutHandler = async () => jsonResponse(
    { code: "LOOK_CHANGE_CONFIRMATION_REQUIRED", existingImageCount: 4, quotedCredits: 8 },
    409,
  );
  project.templateId = "shop-review";
  runtime.render();
  await runtime.settle();

  assert.equal(latestBlocked, true, "409 confirmation blocks render CTA");
  const activePending = pendingUpdates.at(-1);
  assert.ok(activePending, "onPendingConfirmationChange reports active 409 confirmation");
  assert.equal(activePending.kind, "pack");
  assert.equal(activePending.label, "รีวิวสินค้า");
  assert.equal(activePending.existingImageCount, 4);
  assert.equal(activePending.quotedCredits, 8);
  assert.ok(
    scrollCalls.some((c) => c.target === "pending-card" && JSON.stringify(c.options) === JSON.stringify({ behavior: "smooth", block: "center" })),
    "mounting pending 409 confirmation card smoothly scrolls it into view",
  );

  // Collapse options panel while pending is still active -> must NOT trigger a stray scroll.
  const collapseWhilePendingBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && node.props["aria-controls"] === "brand-visual-options",
  );
  assert.ok(collapseWhilePendingBtn);
  scrollCalls.length = 0;
  (collapseWhilePendingBtn.props.onClick as () => void)();
  await runtime.settle();
  assert.equal(
    findNode(runtime.tree, (node) => node.props["data-brand-pending-confirmation"] === "true"),
    null,
    "collapsing panel hides pending card until jump is clicked",
  );
  assert.equal(scrollCalls.length, 0, "collapsing panel does not jolt scroll position");

  // Click jumpToConfirmation ("ไปที่การยืนยัน") -> re-opens panel & smoothly scrolls pending card into view!
  activePending.jumpToConfirmation();
  await runtime.settle();
  assert.ok(
    findNode(runtime.tree, (node) => node.props["data-brand-pending-confirmation"] === "true"),
    "jumpToConfirmation re-expands BrandVisualSelector so pending confirmation card is visible",
  );
  assert.ok(
    scrollCalls.some((c) => c.target === "pending-card" && JSON.stringify(c.options) === JSON.stringify({ behavior: "smooth", block: "center" })),
    "jumpToConfirmation smoothly scrolls pending confirmation card into view",
  );

  // Cancel pending confirmation -> clears pending notice and unblocks CTA.
  const cancelBtn = findNode(
    runtime.tree,
    (node) => node.type === "button" && textContent(node).trim() === "ยกเลิก",
  );
  assert.ok(cancelBtn, "pending confirmation card renders ยกเลิก button");
  (cancelBtn.props.onClick as () => void)();
  await runtime.settle();
  assert.equal(pendingUpdates.at(-1), null, "cancelling pending confirmation clears pending notice");
  assert.equal(latestBlocked, false, "cancelling pending confirmation unblocks render CTA");

  runtime.unmount();
  console.log("✓ BrandVisualSelector runtime: try/finally cleanup, stale guard, 409 smooth scroll & jump verified");
}

// ── 3. Step2Elements.tsx pending notice + jump wiring ───────────────────────

function verifyStep2PendingJumpWiring(): void {
  const sf = ts.createSourceFile(step2Path, step2Source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(sf.parseDiagnostics.length, 0, "Step2Elements.tsx parses cleanly as TSX");

  assert.match(
    step2Source,
    /const brandRenderBlocked = brandSelectionBlocked;/,
    "Step2Elements keeps brandRenderBlocked tied to brandSelectionBlocked",
  );
  assert.match(
    step2Source,
    /onSelectionBlockedChange=\{setBrandSelectionBlocked\}/,
    "Step2Elements wires onSelectionBlockedChange",
  );
  assert.match(
    step2Source,
    /onPendingConfirmationChange=\{setBrandPendingConfirmation\}/,
    "Step2Elements wires onPendingConfirmationChange to BrandVisualSelector",
  );
  assert.match(
    step2Source,
    /data-brand-pending-cta-notice="true"[\s\S]{0,900}onClick=\{brandPendingConfirmation\.jumpToConfirmation\}[\s\S]{0,600}ไปที่การยืนยัน/u,
    "Step2Elements renders desktop inline pending notice + ไปที่การยืนยัน button next to CTA",
  );
  assert.match(
    step2Source,
    /data-brand-pending-mobile-notice="true"[\s\S]{0,900}onClick=\{brandPendingConfirmation\.jumpToConfirmation\}[\s\S]{0,600}ไปที่การยืนยัน/u,
    "Step2Elements renders mobile inline pending notice + ไปที่การยืนยัน button above sticky CTA",
  );
  assert.match(
    step2Source,
    /ตั้งค่า Brand ให้เสร็จก่อน/,
    "Step2Elements keeps the blocked CTA label intact",
  );
  console.log("✓ Step2Elements wiring: inline pending notice + ไปที่การยืนยัน jump action verified (desktop + mobile)");
}

// ── 4. EditorV2Shell.tsx runtime guard for editorBlocked & receiptOpen ──────

async function verifyEditorV2ShellBlockedRenderGuards(): Promise<void> {
  const toastErrors: string[] = [];
  const toastSuccesses: string[] = [];
  let submitCalls = 0;

  const markers = new Map<string, symbol>();
  const marker = (name: string) => {
    let sym = markers.get(name);
    if (!sym) {
      sym = Symbol(name);
      markers.set(name, sym);
    }
    return sym;
  };

  let lifecycleAllowed = false;
  let currentJob: Record<string, unknown> = { phase: "idle", jobType: "create" };
  let currentProject: Record<string, unknown> = {
    projectId: "proj-guard",
    projectTitle: "Guard Project",
    projectReady: false,
    projectInitialization: "loading-defaults",
    recovery: { status: "none" },
    saveStatus: "idle",
    retryProjectSave: () => {},
    retryProjectBootstrap: () => {},
    retryConflictServerRefresh: () => {},
    chooseLocalProjectDraft: () => {},
    chooseServerProjectDraft: () => {},
    canRunProjectOperation: () => lifecycleAllowed,
    resetProject: async () => "proj-new",
    completeArchivedProject: () => true,
    mode: "script",
    script: "ทดสอบสคริปต์",
    scriptTargetDurationSec: 30,
    voiceEngine: "gemini",
    setVoiceEngine: () => {},
    setUseAvatar: () => {},
    useAvatar: false,
    avatarId: "",
    brollSource: "stock",
    plan: "PRO",
    isActiveTrial: false,
    templateId: null,
    selectVideoTemplate: () => {},
    setTemplateId: () => {},
    setMode: () => {},
    setScript: () => {},
    setProjectTitle: () => {},
    accountId: "acc-1",
    narrativeSourceKind: "creator-script",
    logoOverlay: null,
    setLogoOverlay: () => {},
    brandSubtitleDefault: null,
    brandLibraryAllowed: true,
    layerVisibility: {},
    setLayerVisibility: () => {},
    headlineHook: null,
    setHeadlineHook: () => {},
    backgroundMusic: null,
    setBackgroundMusic: () => {},
    canUseLogoOverlay: true,
    logoEntitlement: "eligible",
    logoEntitlementStalled: false,
    logoEntitlementRetrying: false,
    retryEntitlement: () => {},
    brollRegionPreference: "auto",
    projectStylePack: null,
    activeJobId: null,
    internalAiTester: false,
    starterAiImageAllowance: undefined,
  };

  const compiled = ts.transpileModule(shellSource, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: shellPath,
  }).outputText;

  const exportsObj: Record<string, unknown> = {};
  const requireMock = (specifier: string): unknown => {
    if (specifier === "react") return reactMock;
    if (specifier === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: marker("Fragment") };
    if (specifier === "next/link") return { __esModule: true, default: marker("Link") };
    if (specifier === "next/navigation") return { useRouter: () => ({ push: () => {} }) };
    if (specifier === "sonner") {
      return {
        toast: {
          error(msg: string) { toastErrors.push(msg); },
          success(msg: string) { toastSuccesses.push(msg); },
          warning() {},
        },
      };
    }
    if (specifier === "lucide-react") return new Proxy({}, { get: (_t, key) => marker(String(key)) });
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
    if (specifier === "@/components/quota-status") return { QuotaStatus: marker("QuotaStatus") };
    if (specifier === "@/components/ui/api-key-modal") return { ApiKeyModal: marker("ApiKeyModal") };
    if (specifier === "@/components/ui/upgrade-modal") return { UpgradeModal: marker("UpgradeModal") };
    if (specifier === "@/lib/client-telemetry") return { trackEvent: () => {} };
    if (specifier === "@/lib/quota-error") {
      return { QUOTA_BUY_CREDITS_HREF: "/pricing", QUOTA_PRICING_HREF: "/pricing", quotaExceededText: () => "" };
    }
    if (specifier === "@/components/ui/dropdown-menu") {
      return Object.fromEntries(
        ["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuLabel", "DropdownMenuSeparator", "DropdownMenuTrigger"]
          .map((name) => [name, marker(name)]),
      );
    }
    if (specifier === "@/components/ui/alert-dialog") {
      return Object.fromEntries(
        ["AlertDialog", "AlertDialogAction", "AlertDialogCancel", "AlertDialogContent", "AlertDialogDescription", "AlertDialogFooter", "AlertDialogHeader", "AlertDialogTitle"]
          .map((name) => [name, marker(name)]),
      );
    }
    if (specifier === "./useV2Project") return { useV2Project: () => currentProject };
    if (specifier === "./usePendingEditDraft") {
      return { usePendingEditDraft: () => ({ pendingEdit: null, reloadPendingEdit: async () => null }) };
    }
    if (specifier === "./useV2Job") {
      return {
        useV2Job: () => ({
          job: currentJob,
          submit: async () => {
            submitCalls += 1;
            return { ok: true };
          },
          submitExport: async () => ({ ok: true }),
          cancel: async () => ({ ok: true }),
          reset: () => {},
          adoptJob: () => {},
          resumeJob: () => {},
          resumeFailedExportPreview: () => {},
          resumeExportEditSnapshot: () => {},
          markPreviewMissing: () => {},
        }),
      };
    }
    if (specifier === "./Step1Script") return { Step1Script: marker("Step1Script") };
    if (specifier === "./Step2Elements") return { Step2Elements: marker("Step2Elements") };
    if (specifier === "./RenderingScreen") return { RenderingScreen: marker("RenderingScreen") };
    if (specifier === "./NarrationDurationReview") return { NarrationDurationReview: marker("NarrationDurationReview") };
    if (specifier === "./PostPhase") return { PostPhase: marker("PostPhase") };
    if (specifier === "./PostPhaseMobile") return { PostPhaseMobile: marker("PostPhaseMobile") };
    if (specifier === "./ExpiredPreviewView") {
      return {
        ExpiredPreviewView: marker("ExpiredPreviewView"),
        prepareExpiredPreviewRerender: () => {},
        shouldShowUnavailablePreview: () => false,
      };
    }
    if (specifier === "./RenderReceiptDialog") return { RenderReceiptDialog: marker("RenderReceiptDialog") };
    if (specifier === "./EditorProjectRecoveryDialog") return { EditorProjectRecoveryDialog: marker("EditorProjectRecoveryDialog") };
    if (specifier === "./useEditorDiagnostics") return { useEditorDiagnostics: () => ({}) };
    if (specifier === "./useIsMobile") return { useIsMobile: () => false };
    if (specifier === "../_hooks/useCreditsQuota") return { CREDITS_LIVE_CLIENT: true };
    if (specifier === "./project-menu") {
      return {
        PROJECT_STATUS_FILTER_LABEL: { all: "all" },
        fetchRecentProjectMenu: async () => ({ projects: [], total: 0 }),
        filterProjectMenuItems: (items: unknown[]) => items,
        projectDeleteBlocked: () => false,
        projectMenuDate: () => null,
        projectStatusLabel: () => "",
        projectMenuAgentLabel: () => null,
      };
    }
    if (specifier === "@/lib/video-export-name") return { resolveVideoDownloadFilename: () => "clip.mp4" };
    if (specifier === "@/lib/customer-api-error") return { customerApiErrorMessage: (_d: unknown, f: string) => f };
    if (specifier === "./failure-view") return { classifyFailure: () => "generic", failureViewCopy: () => ({ heading: "", body: "" }) };
    if (specifier === "@/lib/use-me") return { fetchMe: async () => ({ firstClipPath: false }) };
    if (specifier === "@/lib/first-clip-path") return { requiresFirstClipScript: () => false };
    if (specifier === "@/components/convert/first-clip-exported-view-signal") {
      return { FirstClipExportedViewSignal: marker("FirstClipExportedViewSignal") };
    }
    if (specifier === "@/components/billing/grant-expiry-banner") {
      return { GrantExpiryBanner: marker("GrantExpiryBanner") };
    }
    if (specifier === "@/lib/first-clip-convert-events") return { emitFirstClipViewed: () => {} };
    if (specifier === "@/lib/style-pack-catalog") return { isActiveStylePackId: () => false };
    if (specifier === "@/lib/first-clip-starter") {
      return { findFirstClipStarter: () => undefined, shouldApplyFirstClipStarterScript: () => false };
    }
    if (specifier === "@/lib/use-dynamic-thai-loanwords") {
      return { useDynamicThaiLoanwords: () => 0 };
    }
    if (specifier === "@/lib/motion-broll-catalog") {
      return { isMotionThemeId: () => false };
    }
    if (specifier === "@/lib/video-template-apply") {
      return { findFlagshipMotionPreset: () => undefined };
    }
    if (specifier === "@/lib/social-post-handoff") {
      return {
        HERO_AI_SOCIAL_SCHEDULER_URL: "https://app.heroaiengine.com",
        buildSocialPostCaptionPack: () => "",
        buildWeeklySeriesHref: () => "/hero-script",
      };
    }
    throw new Error(`Unexpected EditorV2Shell import: ${specifier}`);
  };

  vm.runInNewContext(compiled, {
    exports: exportsObj,
    module: { exports: exportsObj },
    require: requireMock,
    fetch: async () => jsonResponse({}),
    console,
    setTimeout,
    clearTimeout,
    window: {
      location: { href: "https://example.test/video-editor?ui=v2", search: "", assign() {} },
      history: { replaceState() {} },
    },
    URL,
    URLSearchParams,
  });

  const EditorV2Shell = exportsObj.EditorV2Shell as (props: Record<string, unknown>) => unknown;
  const runtime = new HookRuntime(EditorV2Shell, {});

  // Initial mount: projectInitialization = "loading-defaults" -> editorBlocked = true.
  runtime.render();
  await runtime.settle();

  // Verify visible syncing banner renders when project is still initializing/syncing.
  const syncingBanner = findNode(
    runtime.tree,
    (node) => node.props["data-editor-syncing-banner"] === "true",
  );
  assert.ok(syncingBanner, "visible syncing banner renders while project is loading/syncing");
  assert.equal(syncingBanner.props.role, "status");
  assert.match(textContent(syncingBanner), /กำลังเตรียมโปรเจกต์/, "syncing banner uses clear Thai copy");

  // Advance to Step 2 while ready, then test editorBlocked = true with transient canRunProjectOperation() = true.
  lifecycleAllowed = true;
  currentProject = { ...currentProject, projectReady: true, projectInitialization: "ready" };
  runtime.render();
  await runtime.settle();
  const step1 = findNode(runtime.tree, (node) => node.type === marker("Step1Script"));
  assert.ok(step1, "Step1Script renders");
  (step1.props.onNext as () => void)();
  await runtime.settle();
  assert.ok(findNode(runtime.tree, (node) => node.type === marker("Step2Elements")), "Step2Elements renders");

  // Case A: editorBlocked is true even if ref getter transiently returns true -> must NOT leave receiptOpen stale!
  toastErrors.length = 0;
  submitCalls = 0;
  lifecycleAllowed = true;
  currentProject = { ...currentProject, projectInitialization: "loading-defaults" };
  runtime.render();
  await runtime.settle();
  const blockedStep2 = findNode(runtime.tree, (node) => node.type === marker("Step2Elements"));
  assert.ok(blockedStep2);
  await (blockedStep2.props.onRender as () => Promise<void>)();
  await runtime.settle();
  assert.equal(submitCalls, 0, "handleRender while editorBlocked never submits");
  assert.equal(toastErrors.length, 1, "handleRender while editorBlocked surfaces clear Thai toast");
  assert.match(toastErrors[0], /กำลังโหลดหรือซิงค์ข้อมูล/);
  assert.equal(
    findNode(runtime.tree, (node) => node.type === marker("RenderReceiptDialog"))?.props.open,
    false,
    "receipt stays closed while editorBlocked",
  );

  // Flip editorBlocked back to false -> receipt must STILL be closed (proves receiptOpen was not left stale!).
  currentProject = { ...currentProject, projectInitialization: "ready" };
  runtime.render();
  await runtime.settle();
  assert.equal(
    findNode(runtime.tree, (node) => node.type === marker("RenderReceiptDialog"))?.props.open,
    false,
    "clearing editorBlocked does not pop open a stale receiptOpen dialog",
  );

  // Case B: !canRunProjectOperation() while editorBlocked === false -> clear Thai toast, no submit, receipt closed.
  toastErrors.length = 0;
  lifecycleAllowed = false;
  const unreadyStep2 = findNode(runtime.tree, (node) => node.type === marker("Step2Elements"));
  assert.ok(unreadyStep2);
  await (unreadyStep2.props.onRender as () => Promise<void>)();
  await runtime.settle();
  assert.equal(submitCalls, 0);
  assert.equal(toastErrors.length, 1);
  assert.match(toastErrors[0], /โปรเจกต์กำลังกู้คืน\/โหลด/);
  assert.equal(
    findNode(runtime.tree, (node) => node.type === marker("RenderReceiptDialog"))?.props.open,
    false,
  );

  // Case C: open receipt while ready, then block via !canRunProjectOperation(), then click confirm -> toast + closes receipt!
  toastErrors.length = 0;
  lifecycleAllowed = true;
  await (findNode(runtime.tree, (node) => node.type === marker("Step2Elements"))!.props.onRender as () => Promise<void>)();
  await runtime.settle();
  const openReceipt = findNode(runtime.tree, (node) => node.type === marker("RenderReceiptDialog"));
  assert.equal(openReceipt?.props.open, true, "receipt opens when ready");

  lifecycleAllowed = false;
  await (openReceipt!.props.onConfirm as (m: number) => Promise<void>)(1);
  await runtime.settle();
  assert.equal(submitCalls, 0, "blocked confirm never submits");
  assert.equal(toastErrors.length, 1, "blocked confirm never silently drops click");
  assert.match(toastErrors[0], /กำลังโหลดหรือซิงค์ข้อมูล/);
  assert.equal(
    findNode(runtime.tree, (node) => node.type === marker("RenderReceiptDialog"))?.props.open,
    false,
    "blocked confirm clears receiptOpen so dialog is not left stale",
  );

  // Case D: NarrationDurationReview.onRegenerate while blocked -> toast + no stale receiptOpen!
  toastErrors.length = 0;
  currentJob = {
    phase: "done",
    jobType: "create",
    output: { preview: { audioDurationMs: 32000, voiceUrl: "/voice.wav" } },
  };
  lifecycleAllowed = false;
  runtime.render();
  await runtime.settle();
  const narrationReview = findNode(runtime.tree, (node) => node.type === marker("NarrationDurationReview"));
  assert.ok(narrationReview, "NarrationDurationReview renders in done preview phase");
  (narrationReview.props.onRegenerate as () => void)();
  await runtime.settle();
  assert.equal(toastErrors.length, 1, "blocked onRegenerate never silently drops click");
  assert.match(toastErrors[0], /กำลังโหลดหรือซิงค์ข้อมูล/);
  assert.equal(
    findNode(runtime.tree, (node) => node.type === marker("RenderReceiptDialog"))?.props.open,
    false,
    "blocked onRegenerate leaves receiptOpen closed",
  );

  runtime.unmount();
  console.log("✓ EditorV2Shell runtime: editorBlocked syncing banner, no silent drops, no stale receiptOpen verified");
}

async function main(): Promise<void> {
  await verifyBrandVisualSelectorRuntime();
  verifyStep2PendingJumpWiring();
  await verifyEditorV2ShellBlockedRenderGuards();
  console.log("\nverify-brand-render-cta-guard: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

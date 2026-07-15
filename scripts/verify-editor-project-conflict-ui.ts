// Run with: npx tsx scripts/verify-editor-project-conflict-ui.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import puppeteer, { type Browser } from "puppeteer";
import ts from "typescript";

const shellPath = "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx";
const dialogPath = "src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx";
const historyPath = "src/lib/editor-project-conflict-history.ts";
const focusPath = "src/lib/editor-project-conflict-focus.ts";
const alertDialogWrapperPath = "src/components/ui/alert-dialog.tsx";

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;
type HistoryInput = {
  history: Pick<History, "state" | "pushState" | "back">;
  addPopStateListener: (listener: () => void) => () => void;
  scheduleMacrotask?: (callback: () => void) => () => void;
};
type HistoryFactory = (input: HistoryInput) => { activate(): () => void };
type FocusTarget = {
  isConnected: boolean;
  disabled?: boolean;
  focus(options?: FocusOptions): void;
  closest(selector: string): unknown;
  getAttribute?(name: string): string | null;
};
type FocusFactory = (input: {
  getActiveElement: () => FocusTarget | null;
  getHeading: () => FocusTarget | null;
  getFallback: () => FocusTarget | null;
  scheduleMacrotask?: (callback: () => void) => () => void;
}) => {
  open(): void;
  close(): void;
  dispose(): void;
};

function parse(source: string, fileName: string): ts.SourceFile {
  const root = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(root.parseDiagnostics.length, 0, `${fileName} parses as TypeScript`);
  return root;
}

function collect<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function isJsxNode(node: ts.Node): node is JsxNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function opening(node: JsxNode): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagName(node: JsxNode): string {
  return opening(node).tagName.getText();
}

function attribute(node: JsxNode, name: string): ts.JsxAttribute | undefined {
  return opening(node).attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function attributeText(node: JsxNode, name: string, source: ts.SourceFile): string | undefined {
  return attribute(node, name)?.initializer?.getText(source);
}

function directJsxChildren(node: ts.JsxElement): JsxNode[] {
  return node.children.filter(isJsxNode);
}

function verifyShell(source: string): void {
  const root = parse(source, shellPath);
  const dialogs = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "EditorProjectRecoveryDialog");
  assert.equal(dialogs.length, 1, "EditorV2Shell renders exactly one recovery dialog");
  assert.equal(attributeText(dialogs[0], "recovery", root), "{p.recovery}");
  assert.equal(attributeText(dialogs[0], "onRetryLoad", root), "{p.retryProjectBootstrap}");
  assert.equal(attributeText(dialogs[0], "onChooseLocal", root), "{p.chooseLocalProjectDraft}");
  assert.equal(attributeText(dialogs[0], "onChooseServer", root), "{p.chooseServerProjectDraft}");

  const wrappers = collect(root, (node): node is ts.JsxElement => ts.isJsxElement(node)
    && attributeText(node, "className", root) === '"contents"'
    && attribute(node, "inert") !== undefined);
  assert.equal(wrappers.length, 1, "one contents wrapper owns the blocking inert boundary");
  const wrapper = wrappers[0];
  assert.equal(
    attributeText(wrapper, "inert", root),
    '{p.recovery.status !== "none" ? true : undefined}',
    "loading, load-error, and conflict all make editor content inert",
  );
  assert.equal(
    attributeText(wrapper, "aria-hidden", root),
    '{p.recovery.status !== "none" ? "true" : undefined}',
    "loading, load-error, and conflict all hide editor content from assistive technology",
  );

  const inertAttributes = collect(root, (node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText() === "inert");
  const ariaHiddenAttributes = collect(root, (node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText() === "aria-hidden");
  assert.equal(inertAttributes.length, 1, "the shell has one inert owner");
  assert.equal(ariaHiddenAttributes.length, 1, "the shell has one aria-hidden owner");

  assert.ok(ts.isJsxElement(dialogs[0].parent), "recovery dialog has a shell parent");
  assert.equal(wrapper.parent, dialogs[0].parent, "editor wrapper and recovery dialog are siblings");
  const siblings = directJsxChildren(dialogs[0].parent);
  assert.ok(siblings.indexOf(wrapper) < siblings.indexOf(dialogs[0]), "recovery dialog renders after editor content");
  assert.ok(collect(wrapper, (node): node is ts.JsxElement => ts.isJsxElement(node) && tagName(node) === "header").length > 0,
    "the inert owner contains editor navigation chrome");
  assert.ok(collect(wrapper, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "Step1Script").length > 0,
    "the inert owner contains the editing surface");
  const focusFallbacks = collect(wrapper, (node): node is JsxNode => isJsxNode(node)
    && attributeText(node, "data-editor-recovery-focus-fallback", root) === '"true"');
  assert.equal(focusFallbacks.length, 1, "the editor exposes one stable focus-restoration fallback");
  assert.equal(tagName(focusFallbacks[0]), "button", "the focus fallback is a usable editor control");
}

function assertPreventedHandler(node: JsxNode, name: string, root: ts.SourceFile): void {
  const value = attributeText(node, name, root);
  assert.ok(value, `${name} is present`);
  assert.match(value, /event\.preventDefault\(\)/, `${name} prevents dismissal`);
  assert.doesNotMatch(value, /onChoose|onRetry|setRecovery|onOpenChange/, `${name} cannot resolve or close the dialog`);
}

function verifyDialog(source: string): void {
  const root = parse(source, dialogPath);
  const exactCopy = [
    "พบข้อมูลโปรเจกต์ 2 เวอร์ชัน",
    "โปรเจกต์นี้มีการแก้ไขในเครื่องที่ยังไม่ตรงกับข้อมูลบนระบบ กรุณาเลือกเวอร์ชันที่ต้องการใช้",
    "ฉบับในเครื่อง",
    "ฉบับบนระบบ",
    "ใช้ฉบับในเครื่อง",
    "ใช้ฉบับบนระบบ",
  ];
  for (const copy of exactCopy) assert.ok(source.includes(copy), `exact conflict copy exists: ${copy}`);
  assert.ok(source.includes("โหลดโปรเจกต์ไม่สำเร็จ"), "load-error has the required title");
  assert.ok(source.includes("ลองใหม่"), "load-error provides one Retry action");
  assert.ok(source.includes("ไม่ทราบเวลา"), "unavailable timestamps have an explicit fallback");

  assert.doesNotMatch(source, /recovery\.(?:local|server)\.draft|JSON\.stringify|dangerouslySetInnerHTML/,
    "the dialog never serializes or renders draft content");
  assert.doesNotMatch(source, /assetId|fileName|storagePath|clipUrl|logoId/,
    "the dialog never renders identifiers, filenames, storage paths, or URLs");
  assert.doesNotMatch(source, /AlertDialogCancel|AlertDialogClose|DialogClose|aria-label=["{]ปิด/,
    "the blocking dialog has no close or cancel control");

  const roots = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "AlertDialog");
  assert.equal(roots.length, 1, "the recovery component owns one AlertDialog");
  assert.equal(attributeText(roots[0], "open", root), "{blocking}");
  assert.equal(attribute(roots[0], "onOpenChange"), undefined, "controlled blocking root has no dismiss callback");

  assert.doesNotMatch(source, /BlockingAlertDialogContent|DismissGuardEvent/,
    "the component has no dead type widening around Radix AlertDialog");
  const contents = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "AlertDialogContent");
  assert.equal(contents.length, 1, "one shared content shell serves loading, error, and conflict");
  const content = contents[0];
  assertPreventedHandler(content, "onEscapeKeyDown", root);
  assert.equal(attribute(content, "onPointerDownOutside"), undefined,
    "outside pointer blocking is owned by the AlertDialog primitive, not a dead callback");
  assert.equal(attribute(content, "onInteractOutside"), undefined,
    "outside interaction blocking is owned by the AlertDialog primitive, not a dead callback");
  const autoFocus = attributeText(content, "onOpenAutoFocus", root);
  assert.ok(autoFocus, "the dialog owns initial focus");
  assert.match(autoFocus, /event\.preventDefault\(\)/);
  assert.match(autoFocus, /focusLifecycle\(\)\.open\(\)/,
    "initial focus captures the previous target and focuses the heading");
  const closeFocus = attributeText(content, "onCloseAutoFocus", root);
  assert.ok(closeFocus, "the dialog owns focus restoration");
  assert.match(closeFocus, /event\.preventDefault\(\)/);
  assert.match(closeFocus, /focusLifecycle\(\)\.close\(\)/,
    "close waits for the inert boundary to clear before restoring editor focus");
  assert.match(source, /createEditorRecoveryFocusLifecycle/, "the component uses the tested focus lifecycle");
  assert.match(source, /document\.activeElement\s*!==\s*document\.body/,
    "initial page body focus is treated as absent so the stable editor fallback can win");

  const contentClass = attributeText(content, "className", root) ?? "";
  assert.match(
    contentClass,
    /w-\[calc\(100vw-32px-env\(safe-area-inset-left\)-env\(safe-area-inset-right\)\)\]/,
    "mobile outer gutters are exactly 16px inside both horizontal safe areas",
  );
  assert.match(contentClass, /max-w-\[560px\]/, "desktop content is capped at 560px");
  assert.match(contentClass, /max-h-\[calc\(100dvh-32px-env\(safe-area-inset-top\)-env\(safe-area-inset-bottom\)\)\]/,
    "content fits within viewport safe areas");
  assert.match(contentClass, /overflow-y-auto/, "long dialog content scrolls internally");
  assert.match(contentClass, /overflow-x-hidden/, "landscape safe-area content never scrolls horizontally");
  assert.match(contentClass, /motion-reduce:!animate-none/, "reduced-motion force-disables content entrance animation");
  assert.match(contentClass, /motion-reduce:!transition-none/, "reduced-motion force-disables content transitions");
  assert.equal(
    attributeText(content, "overlayClassName", root),
    '"motion-reduce:!animate-none motion-reduce:!transition-none"',
    "the recovery overlay receives a scoped reduced-motion override",
  );
  const contentStyle = attributeText(content, "style", root) ?? "";
  assert.match(contentStyle, /paddingBottom:\s*["']calc\(20px \+ env\(safe-area-inset-bottom\)\)["']/,
    "home-indicator safe-area padding remains visible");
  assert.match(
    contentStyle,
    /left:\s*["']calc\(env\(safe-area-inset-left\) \+ \(100vw - env\(safe-area-inset-left\) - env\(safe-area-inset-right\)\) \/ 2\)["']/,
    "dialog is centered in the asymmetric horizontal safe rectangle",
  );
  assert.match(
    contentStyle,
    /top:\s*["']calc\(env\(safe-area-inset-top\) \+ \(100dvh - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\)\) \/ 2\)["']/,
    "dialog is centered in the asymmetric vertical safe rectangle",
  );

  const titles = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "AlertDialogTitle");
  assert.equal(titles.length, 1, "all states share one focusable heading");
  assert.equal(attributeText(titles[0], "ref", root), "{headingRef}");
  assert.equal(attributeText(titles[0], "tabIndex", root), "{-1}");

  const actions = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "AlertDialogAction");
  assert.equal(actions.length, 3, "conflict has two choices and load-error has one Retry action");
  const [retry, local, server] = actions;
  assert.match(retry.getText(root), /ลองใหม่/);
  assert.match(local.getText(root), /ใช้ฉบับในเครื่อง/);
  assert.match(server.getText(root), /ใช้ฉบับบนระบบ/);
  assert.ok(local.pos < server.pos, "local choice precedes server choice in DOM order");
  assert.equal(attributeText(local, "disabled", root), "{isResolving}");
  assert.equal(attributeText(server, "disabled", root), "{isResolving}");
  assert.match(local.getText(root), /recovery\.resolving\s*===\s*["']local["']/, "only selected local action spins");
  assert.match(server.getText(root), /recovery\.resolving\s*===\s*["']server["']/, "only selected server action spins");
  for (const action of [retry, local, server]) {
    assert.match(attributeText(action, "className", root) ?? "", /min-h-11/, "all actions meet the 44px touch target");
  }

  assert.match(source, /formatCandidateTimestamp\(recovery\.local\.updatedAt\)/,
    "local candidate renders only its timestamp");
  assert.match(source, /formatCandidateTimestamp\(recovery\.server\.updatedAt\)/,
    "server candidate renders only its timestamp");
  assert.match(source, /role="status"/, "loading is announced as status");
  assert.match(source, /role="alert"/, "load and resolution errors are announced as alerts");
  assert.match(source, /disabled:pointer-events-none/, "disabled choices cannot receive pointer events");
}

function verifyScopedOverlayContract(source: string): void {
  const root = parse(source, alertDialogWrapperPath);
  const overlays = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "AlertDialogOverlay");
  assert.equal(overlays.length, 1, "shared AlertDialog content still renders one overlay");
  assert.equal(attributeText(overlays[0], "className", root), "{overlayClassName}",
    "optional overlay styling is scoped to the requesting dialog");
  assert.match(source, /\{\s*className,\s*overlayClassName,\s*\.\.\.props\s*\}/,
    "overlayClassName is consumed instead of leaking to the Radix content DOM");
  assert.match(source, /overlayClassName\?:\s*string/,
    "the additive wrapper prop leaves existing callers unchanged by default");
}

function verifySafeAreaLayoutFormula(): void {
  const bounds = (viewportWidth: number, safeLeft: number, safeRight: number) => {
    const safeWidth = viewportWidth - safeLeft - safeRight;
    const width = Math.min(560, safeWidth - 32);
    const center = safeLeft + safeWidth / 2;
    return { width, left: center - width / 2, right: center + width / 2 };
  };
  assert.deepEqual(bounds(390, 0, 0), { width: 358, left: 16, right: 374 },
    "portrait keeps exact 16px viewport gutters");
  assert.deepEqual(bounds(568, 44, 0), { width: 492, left: 60, right: 552 },
    "landscape keeps exact 16px gutters inside an asymmetric left safe area");
  assert.deepEqual(bounds(844, 47, 21), { width: 560, left: 155, right: 715 },
    "wide landscape stays capped and centered inside asymmetric safe areas");
}

type MountedDialogResult = {
  afterEscape: string;
  afterPointerOutside: string;
  afterFocusOutside: string;
  openChangeCount: string;
};

async function mountDialogPrimitive(browser: Browser, packageName: string): Promise<MountedDialogResult> {
  const fixture = `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import * as Primitive from ${JSON.stringify(packageName)};

    function Fixture() {
      const [open, setOpen] = useState(true);
      const [changes, setChanges] = useState(0);
      return <>
        <button id="outside" type="button">Outside</button>
        <output id="open-state">{open ? "open" : "closed"}</output>
        <output id="change-count">{changes}</output>
        <Primitive.Root
          open={open}
          onOpenChange={(next) => {
            setChanges((value) => value + 1);
            setOpen(next);
          }}
        >
          <Primitive.Portal>
            <Primitive.Overlay style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)" }} />
            <Primitive.Content
              data-mounted-dialog="true"
              onEscapeKeyDown={(event) => event.preventDefault()}
              style={{ position: "fixed", left: "25%", top: "25%", width: "50%", height: "50%", background: "white" }}
            >
              <Primitive.Title>Blocking decision</Primitive.Title>
              <Primitive.Description>Choose before continuing</Primitive.Description>
              <button id="inside" type="button">Inside</button>
            </Primitive.Content>
          </Primitive.Portal>
        </Primitive.Root>
      </>;
    }

    createRoot(document.getElementById("root")).render(<Fixture />);
  `;
  const bundled = await build({
    stdin: {
      contents: fixture,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "mounted-alert-dialog-fixture.tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.waitForSelector('[data-mounted-dialog="true"]');
    const state = () => page.$eval("#open-state", (node) => node.textContent ?? "");

    await page.keyboard.press("Escape");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    const afterEscape = await state();

    if (afterEscape === "open") {
      await page.mouse.click(12, 12);
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    const afterPointerOutside = await state();

    if (afterPointerOutside === "open") {
      await page.$eval("#outside", (node) => (node as HTMLElement).focus());
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    const afterFocusOutside = await state();
    return {
      afterEscape,
      afterPointerOutside,
      afterFocusOutside,
      openChangeCount: await page.$eval("#change-count", (node) => node.textContent ?? ""),
    };
  } finally {
    await page.close();
  }
}

function assertMountedBlocking(result: MountedDialogResult): void {
  assert.deepEqual(result, {
    afterEscape: "open",
    afterPointerOutside: "open",
    afterFocusOutside: "open",
    openChangeCount: "0",
  }, "mounted AlertDialog ignores Escape, pointer-outside, and focus-outside dismissal");
}

async function verifyMountedAlertDialogContract(): Promise<void> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    assertMountedBlocking(await mountDialogPrimitive(browser, "@radix-ui/react-alert-dialog"));
    await assert.rejects(
      async () => assertMountedBlocking(await mountDialogPrimitive(browser, "@radix-ui/react-dialog")),
      assert.AssertionError,
      "a controlled mutation to the dismissible Dialog primitive is rejected",
    );
  } finally {
    await browser.close();
  }
}

function verifyHistorySource(source: string): void {
  const root = parse(source, historyPath);
  assert.match(source, /__heroEditorConflict/, "history entries use the dedicated module tag");
  assert.match(source, /pushState\([\s\S]*?,\s*["']["']\s*\)/,
    "the blocker pushes a same-URL entry without a URL argument");
  assert.doesNotMatch(source, /location\.(?:assign|replace)\(|window\.location|\.close\(|\.dismiss\(/,
    "history containment never navigates or closes the conflict");
  assert.ok(collect(root, (node): node is ts.CatchClause => ts.isCatchClause(node)).length >= 3,
    "History and listener quirks are swallowed at each boundary");
}

class MacrotaskQueue {
  private tasks: Array<() => void> = [];

  schedule = (callback: () => void): (() => void) => {
    let active = true;
    this.tasks.push(() => { if (active) callback(); });
    return () => { active = false; };
  };

  flush(): void {
    while (this.tasks.length > 0) this.tasks.shift()?.();
  }
}

class FakeFocusTarget implements FocusTarget {
  isConnected = true;
  disabled = false;
  inertAncestor = false;
  hiddenAncestor = false;
  ariaDisabled = false;
  focusCalls = 0;

  constructor(readonly name: string) {}

  focus(): void {
    this.focusCalls += 1;
  }

  closest(selector: string): unknown {
    if (this.inertAncestor && selector.includes("[inert]")) return { inert: true };
    if (this.hiddenAncestor && selector.includes('[aria-hidden="true"]')) return { hidden: true };
    return null;
  }

  getAttribute(name: string): string | null {
    return name === "aria-disabled" && this.ariaDisabled ? "true" : null;
  }
}

function verifyFocusLifecycle(createFocusLifecycle: FocusFactory): void {
  const tasks = new MacrotaskQueue();
  const editorInput = new FakeFocusTarget("editor input");
  const heading = new FakeFocusTarget("dialog heading");
  const fallback = new FakeFocusTarget("dashboard back button");
  editorInput.inertAncestor = true;
  const lifecycle = createFocusLifecycle({
    getActiveElement: () => editorInput,
    getHeading: () => heading,
    getFallback: () => fallback,
    scheduleMacrotask: tasks.schedule,
  });
  lifecycle.open();
  assert.equal(heading.focusCalls, 1, "loading captures editor focus and initially focuses the heading");
  // loading -> load-error -> loading Retry stays in one open dialog lifecycle.
  assert.equal(editorInput.focusCalls, 0, "load-error and Retry do not restore focus behind the dialog");
  lifecycle.close();
  assert.equal(editorInput.focusCalls, 0, "resolution defers restoration until React removes inert");
  editorInput.inertAncestor = false;
  tasks.flush();
  assert.equal(editorInput.focusCalls, 1, "resolution restores the captured editor target after inert clears");
  assert.equal(fallback.focusCalls, 0, "usable captured focus wins over the fallback");

  const disconnectedTasks = new MacrotaskQueue();
  const disconnected = new FakeFocusTarget("removed editor input");
  const disconnectedHeading = new FakeFocusTarget("heading");
  const disconnectedFallback = new FakeFocusTarget("fallback");
  const disconnectedLifecycle = createFocusLifecycle({
    getActiveElement: () => disconnected,
    getHeading: () => disconnectedHeading,
    getFallback: () => disconnectedFallback,
    scheduleMacrotask: disconnectedTasks.schedule,
  });
  disconnectedLifecycle.open();
  disconnected.isConnected = false;
  disconnectedLifecycle.close();
  disconnectedTasks.flush();
  assert.equal(disconnected.focusCalls, 0, "a disconnected target is never focused");
  assert.equal(disconnectedFallback.focusCalls, 1, "a disconnected target falls back to a stable editor control");

  const inertTasks = new MacrotaskQueue();
  const stillInert = new FakeFocusTarget("still inert");
  const inertHeading = new FakeFocusTarget("heading");
  const inertFallback = new FakeFocusTarget("fallback");
  const inertLifecycle = createFocusLifecycle({
    getActiveElement: () => stillInert,
    getHeading: () => inertHeading,
    getFallback: () => inertFallback,
    scheduleMacrotask: inertTasks.schedule,
  });
  inertLifecycle.open();
  stillInert.inertAncestor = true;
  inertLifecycle.close();
  inertTasks.flush();
  assert.equal(stillInert.focusCalls, 0, "an unexpectedly inert target is never focused");
  assert.equal(inertFallback.focusCalls, 1, "an inert target falls back to a usable editor control");

  const disposedTasks = new MacrotaskQueue();
  const disposedTarget = new FakeFocusTarget("disposed target");
  const disposedLifecycle = createFocusLifecycle({
    getActiveElement: () => disposedTarget,
    getHeading: () => new FakeFocusTarget("heading"),
    getFallback: () => new FakeFocusTarget("fallback"),
    scheduleMacrotask: disposedTasks.schedule,
  });
  disposedLifecycle.open();
  disposedLifecycle.close();
  disposedLifecycle.dispose();
  disposedTasks.flush();
  assert.equal(disposedTarget.focusCalls, 0, "unmount cancels pending focus restoration");

  const noActiveTasks = new MacrotaskQueue();
  const noActiveHeading = new FakeFocusTarget("heading");
  const noActiveFallback = new FakeFocusTarget("fallback");
  const noActiveLifecycle = createFocusLifecycle({
    getActiveElement: () => null,
    getHeading: () => noActiveHeading,
    getFallback: () => noActiveFallback,
    scheduleMacrotask: noActiveTasks.schedule,
  });
  noActiveLifecycle.open();
  noActiveLifecycle.close();
  noActiveTasks.flush();
  assert.equal(noActiveFallback.focusCalls, 1, "an absent initial editor target uses the stable fallback");
}

class FakeHistory {
  private entries: unknown[];
  private index = 0;
  private listeners = new Set<() => void>();
  pushCalls: Array<{ state: unknown; title: string; url: string | URL | null | undefined }> = [];
  backCalls = 0;
  listenerAdds = 0;

  constructor(initialState: unknown = { route: "editor", mobileSheetKey: "logo" }, private backQueue?: MacrotaskQueue) {
    this.entries = [initialState];
  }

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState = (state: unknown, title: string, url?: string | URL | null): void => {
    this.entries.splice(this.index + 1);
    this.entries.push(state);
    this.index = this.entries.length - 1;
    this.pushCalls.push({ state, title, url });
  };

  back = (): void => {
    this.backCalls += 1;
    if (this.backQueue) {
      this.backQueue.schedule(() => this.commitBack());
      return;
    }
    this.commitBack();
  };

  private commitBack(): void {
    if (this.index === 0) return;
    this.index -= 1;
    for (const listener of [...this.listeners]) listener();
  }

  addPopStateListener = (listener: () => void): (() => void) => {
    this.listenerAdds += 1;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function verifyHistoryRuntime(createHistory: HistoryFactory): void {
  const repeated = new FakeHistory();
  const repeatedTasks = new MacrotaskQueue();
  const blocker = createHistory({
    history: repeated as unknown as HistoryInput["history"],
    addPopStateListener: repeated.addPopStateListener,
    scheduleMacrotask: repeatedTasks.schedule,
  });
  const cleanupFirst = blocker.activate();
  const cleanupSecond = blocker.activate();
  assert.equal(repeated.pushCalls.length, 1, "repeated active renders add one tagged entry");
  assert.equal(repeated.listenerAdds, 1, "repeated activation installs one pop listener");
  assert.equal(repeated.pushCalls[0].url, undefined, "the tagged entry keeps the same URL");
  assert.equal((repeated.state as Record<string, unknown>).__heroEditorConflict, "hero-editor-conflict-v1");
  assert.equal((repeated.state as Record<string, unknown>).route, "editor", "tagging preserves the current route state");
  assert.equal((repeated.state as Record<string, unknown>).mobileSheetKey, "logo", "tagging preserves sibling UI history state");
  cleanupFirst();
  assert.equal(repeated.backCalls, 0, "one active owner cannot clean up another");
  cleanupSecond();
  assert.equal(repeated.backCalls, 0, "owned-tag cleanup is deferred until a macrotask");
  repeatedTasks.flush();
  assert.equal(repeated.backCalls, 1, "final cleanup consumes its own topmost tag");
  assert.deepEqual(repeated.state, { route: "editor", mobileSheetKey: "logo" });

  const backProtected = new FakeHistory();
  const protectedTasks = new MacrotaskQueue();
  const cleanupProtected = createHistory({
    history: backProtected as unknown as HistoryInput["history"],
    addPopStateListener: backProtected.addPopStateListener,
    scheduleMacrotask: protectedTasks.schedule,
  }).activate();
  backProtected.back();
  assert.equal(backProtected.pushCalls.length, 2, "Back while active re-establishes the tag");
  assert.equal((backProtected.state as Record<string, unknown>).__heroEditorConflict, "hero-editor-conflict-v1");
  cleanupProtected();
  protectedTasks.flush();
  assert.equal(backProtected.backCalls, 2, "resolution resumes normal navigation by consuming the tag");

  const foreignTop = new FakeHistory();
  const foreignTasks = new MacrotaskQueue();
  const cleanupForeign = createHistory({
    history: foreignTop as unknown as HistoryInput["history"],
    addPopStateListener: foreignTop.addPopStateListener,
    scheduleMacrotask: foreignTasks.schedule,
  }).activate();
  foreignTop.pushState({ route: "other", foreign: true }, "", undefined);
  cleanupForeign();
  foreignTasks.flush();
  assert.equal(foreignTop.backCalls, 0, "cleanup never consumes an untagged entry");
  assert.deepEqual(foreignTop.state, { route: "other", foreign: true });
  foreignTop.back();
  foreignTasks.flush();
  assert.equal(foreignTop.backCalls, 2, "a one-shot cleanup skips the stranded owned tag after the foreign entry leaves");
  assert.deepEqual(foreignTop.state, { route: "editor", mobileSheetKey: "logo" });

  const pendingTasks = new MacrotaskQueue();
  const pendingBack = new FakeHistory({ route: "editor" }, pendingTasks);
  const cleanupPending = createHistory({
    history: pendingBack as unknown as HistoryInput["history"],
    addPopStateListener: pendingBack.addPopStateListener,
    scheduleMacrotask: pendingTasks.schedule,
  }).activate();
  pendingBack.back();
  cleanupPending();
  assert.equal(pendingBack.backCalls, 1, "the user has one pending Back traversal");
  pendingTasks.flush();
  assert.equal(pendingBack.backCalls, 1, "deferred cleanup does not double-traverse a pending Back");
  assert.deepEqual(pendingBack.state, { route: "editor" }, "pending Back lands on the real same-URL entry without escaping");

  for (const primitiveState of [null, "editor", 7]) {
    const primitive = new FakeHistory(primitiveState);
    const primitiveTasks = new MacrotaskQueue();
    const cleanupPrimitive = createHistory({
      history: primitive as unknown as HistoryInput["history"],
      addPopStateListener: primitive.addPopStateListener,
      scheduleMacrotask: primitiveTasks.schedule,
    }).activate();
    assert.deepEqual(primitive.state, { __heroEditorConflict: "hero-editor-conflict-v1" },
      "null and primitive history states are safely replaced by a tagged object");
    cleanupPrimitive();
    primitiveTasks.flush();
    assert.equal(primitive.state, primitiveState);
  }

  let listenerRemoved = false;
  const throwingHistory = {
    get state(): unknown { throw new Error("state unavailable"); },
    pushState(): void { throw new Error("push unavailable"); },
    back(): void { throw new Error("back unavailable"); },
  } as unknown as HistoryInput["history"];
  assert.doesNotThrow(() => {
    const cleanup = createHistory({
      history: throwingHistory,
      addPopStateListener: () => () => { listenerRemoved = true; },
      scheduleMacrotask(callback) { callback(); return () => {}; },
    }).activate();
    cleanup();
  }, "History API errors cannot dismiss or crash the conflict surface");
  assert.equal(listenerRemoved, true);
}

function assertFixtureRejected(run: () => void, label: string): void {
  assert.throws(run, assert.AssertionError, label);
}

async function main(): Promise<void> {
  assert.ok(existsSync(dialogPath), `${dialogPath} exists`);
  assert.ok(existsSync(historyPath), `${historyPath} exists`);
  assert.ok(existsSync(focusPath), `${focusPath} exists`);
  const shellSource = readFileSync(shellPath, "utf8");
  const dialogSource = readFileSync(dialogPath, "utf8");
  const historySource = readFileSync(historyPath, "utf8");
  const alertDialogWrapperSource = readFileSync(alertDialogWrapperPath, "utf8");

  verifyShell(shellSource);
  verifyDialog(dialogSource);
  verifyHistorySource(historySource);
  verifyScopedOverlayContract(alertDialogWrapperSource);
  verifySafeAreaLayoutFormula();
  await verifyMountedAlertDialogContract();

  assertFixtureRejected(
    () => verifyShell(shellSource.replace(/\s+inert=\{p\.recovery\.status !== "none" \? true : undefined\}/, "")),
    "controlled fixture proves missing inert is detected",
  );
  assertFixtureRejected(
    () => verifyDialog(dialogSource.replace(
      'onEscapeKeyDown={(event) => event.preventDefault()}',
      'onEscapeKeyDown={() => onChooseServer()}',
    )),
    "controlled fixture proves an Escape close handler is detected",
  );
  assertFixtureRejected(
    () => verifyDialog(dialogSource.replace(
      "w-[calc(100vw-32px-env(safe-area-inset-left)-env(safe-area-inset-right))]",
      "w-[calc(100vw-32px)]",
    )),
    "controlled fixture proves horizontal safe-area subtraction is required",
  );
  assertFixtureRejected(
    () => verifyDialog(dialogSource.replace(
      'overlayClassName="motion-reduce:!animate-none motion-reduce:!transition-none"',
      "",
    )),
    "controlled fixture proves the recovery overlay keeps its reduced-motion override",
  );

  const historyModule = await import(pathToFileURL(resolve(historyPath)).href) as {
    createBlockingDialogHistory: HistoryFactory;
  };
  verifyHistoryRuntime(historyModule.createBlockingDialogHistory);
  const focusModule = await import(pathToFileURL(resolve(focusPath)).href) as {
    createEditorRecoveryFocusLifecycle: FocusFactory;
  };
  verifyFocusLifecycle(focusModule.createEditorRecoveryFocusLifecycle);
  const brokenFocusFactory: FocusFactory = (input) => ({
    open() { input.getHeading()?.focus(); },
    close() { input.getFallback()?.focus(); },
    dispose() {},
  });
  assertFixtureRejected(
    () => verifyFocusLifecycle(brokenFocusFactory),
    "controlled fixture proves immediate fallback focus cannot replace deferred captured-target restoration",
  );
  const duplicatePushFactory: HistoryFactory = ({ history, addPopStateListener }) => ({
    activate() {
      addPopStateListener(() => {});
      history.pushState({ __heroEditorConflict: "hero-editor-conflict-v1" }, "");
      history.pushState({ __heroEditorConflict: "hero-editor-conflict-v1" }, "");
      return () => {};
    },
  });
  assertFixtureRejected(
    () => verifyHistoryRuntime(duplicatePushFactory),
    "controlled fixture proves duplicate history pushes are detected",
  );

  console.log("editor-project-conflict-ui: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

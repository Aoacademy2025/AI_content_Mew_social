// Run with: npx tsx scripts/verify-editor-project-conflict-ui.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";

const shellPath = "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx";
const dialogPath = "src/app/(dashboard)/video-editor/_v2/EditorProjectRecoveryDialog.tsx";
const historyPath = "src/lib/editor-project-conflict-history.ts";

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;
type HistoryInput = {
  history: Pick<History, "state" | "pushState" | "back">;
  addPopStateListener: (listener: () => void) => () => void;
};
type HistoryFactory = (input: HistoryInput) => { activate(): () => void };

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

  assert.match(
    source,
    /const BlockingAlertDialogContent\s*=\s*AlertDialogContent\s+as/,
    "outside guards use a component-local type widening without changing the shared primitive",
  );
  const contents = collect(root, (node): node is JsxNode => isJsxNode(node) && tagName(node) === "BlockingAlertDialogContent");
  assert.equal(contents.length, 1, "one shared content shell serves loading, error, and conflict");
  const content = contents[0];
  assertPreventedHandler(content, "onEscapeKeyDown", root);
  assertPreventedHandler(content, "onPointerDownOutside", root);
  assertPreventedHandler(content, "onInteractOutside", root);
  const autoFocus = attributeText(content, "onOpenAutoFocus", root);
  assert.ok(autoFocus, "the dialog owns initial focus");
  assert.match(autoFocus, /event\.preventDefault\(\)/);
  assert.match(autoFocus, /headingRef\.current\?\.focus\(\)/,
    "initial focus targets the heading rather than a choice");

  const contentClass = attributeText(content, "className", root) ?? "";
  assert.match(contentClass, /w-\[calc\(100vw-32px\)\]/, "mobile outer gutters are exactly 16px");
  assert.match(contentClass, /max-w-\[560px\]/, "desktop content is capped at 560px");
  assert.match(contentClass, /max-h-\[calc\(100dvh-32px-env\(safe-area-inset-top\)-env\(safe-area-inset-bottom\)\)\]/,
    "content fits within viewport safe areas");
  assert.match(contentClass, /overflow-y-auto/, "long dialog content scrolls internally");
  assert.match(attributeText(content, "style", root) ?? "", /paddingBottom:\s*["']calc\(20px \+ env\(safe-area-inset-bottom\)\)["']/,
    "home-indicator safe-area padding remains visible");

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

function verifyHistorySource(source: string): void {
  const root = parse(source, historyPath);
  assert.match(source, /__heroEditorConflict/, "history entries use the dedicated module tag");
  assert.match(source, /pushState\([\s\S]*?,\s*["']["']\s*\)/,
    "the blocker pushes a same-URL entry without a URL argument");
  assert.doesNotMatch(source, /location\.(?:assign|replace)|window\.location|close|dismiss/,
    "history containment never navigates or closes the conflict");
  assert.ok(collect(root, (node): node is ts.CatchClause => ts.isCatchClause(node)).length >= 3,
    "History and listener quirks are swallowed at each boundary");
}

class FakeHistory {
  private entries: unknown[] = [{ route: "editor" }];
  private index = 0;
  private listeners = new Set<() => void>();
  pushCalls: Array<{ state: unknown; title: string; url: string | URL | null | undefined }> = [];
  backCalls = 0;
  listenerAdds = 0;

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
    if (this.index === 0) return;
    this.index -= 1;
    for (const listener of [...this.listeners]) listener();
  };

  addPopStateListener = (listener: () => void): (() => void) => {
    this.listenerAdds += 1;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function verifyHistoryRuntime(createHistory: HistoryFactory): void {
  const repeated = new FakeHistory();
  const blocker = createHistory({
    history: repeated as unknown as HistoryInput["history"],
    addPopStateListener: repeated.addPopStateListener,
  });
  const cleanupFirst = blocker.activate();
  const cleanupSecond = blocker.activate();
  assert.equal(repeated.pushCalls.length, 1, "repeated active renders add one tagged entry");
  assert.equal(repeated.listenerAdds, 1, "repeated activation installs one pop listener");
  assert.equal(repeated.pushCalls[0].url, undefined, "the tagged entry keeps the same URL");
  assert.equal((repeated.state as Record<string, unknown>).__heroEditorConflict, "hero-editor-conflict-v1");
  cleanupFirst();
  assert.equal(repeated.backCalls, 0, "one active owner cannot clean up another");
  cleanupSecond();
  assert.equal(repeated.backCalls, 1, "final cleanup consumes its own topmost tag");
  assert.deepEqual(repeated.state, { route: "editor" });

  const backProtected = new FakeHistory();
  const cleanupProtected = createHistory({
    history: backProtected as unknown as HistoryInput["history"],
    addPopStateListener: backProtected.addPopStateListener,
  }).activate();
  backProtected.back();
  assert.equal(backProtected.pushCalls.length, 2, "Back while active re-establishes the tag");
  assert.equal((backProtected.state as Record<string, unknown>).__heroEditorConflict, "hero-editor-conflict-v1");
  cleanupProtected();
  assert.equal(backProtected.backCalls, 2, "resolution resumes normal navigation by consuming the tag");

  const foreignTop = new FakeHistory();
  const cleanupForeign = createHistory({
    history: foreignTop as unknown as HistoryInput["history"],
    addPopStateListener: foreignTop.addPopStateListener,
  }).activate();
  foreignTop.pushState({ route: "other", foreign: true }, "", undefined);
  cleanupForeign();
  assert.equal(foreignTop.backCalls, 0, "cleanup never consumes an untagged entry");
  assert.deepEqual(foreignTop.state, { route: "other", foreign: true });

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
  const shellSource = readFileSync(shellPath, "utf8");
  const dialogSource = readFileSync(dialogPath, "utf8");
  const historySource = readFileSync(historyPath, "utf8");

  verifyShell(shellSource);
  verifyDialog(dialogSource);
  verifyHistorySource(historySource);

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

  const historyModule = await import(pathToFileURL(resolve(historyPath)).href) as {
    createBlockingDialogHistory: HistoryFactory;
  };
  verifyHistoryRuntime(historyModule.createBlockingDialogHistory);
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

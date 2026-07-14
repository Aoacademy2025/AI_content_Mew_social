// Run with: npx tsx scripts/verify-mobile-sheet.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as mobileSheet from "../src/lib/mobile-sheet";

const failures: string[] = [];

type DragSample = { y: number; atMs: number };
type DragSession = {
  startY: number;
  lastY: number;
  lastAtMs: number;
  velocityY: number;
};
type HistoryAdapter = {
  getState(): unknown;
  getUrl(): string;
  pushState(state: Record<string, unknown>, url: string): void;
  back(): void;
  schedule(task: () => void): void;
};
type SheetCoordinator = {
  register(ownerId: string): void;
  unregister(ownerId: string): void;
  isActive(ownerId: string): boolean;
  requestClose(ownerId: string): "history" | "direct" | "ignored";
  handlePopState(): string | null;
};

function check(name: string, run: () => void) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${detail}`);
    console.error(`not ok - ${name}\n  ${detail}`);
  }
}

function requireFunction<T extends (...args: never[]) => unknown>(name: string): T {
  const candidate = (mobileSheet as Record<string, unknown>)[name];
  assert.equal(typeof candidate, "function", `${name} implementation export is missing`);
  return candidate as T;
}

function parseTsx(source: string) {
  return ts.createSourceFile("MobileSheet.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collectNodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T) {
  const matches: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsxNode(node: ts.Node): node is JsxNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function jsxOpening(node: JsxNode) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function jsxTag(node: JsxNode) {
  return jsxOpening(node).tagName.getText();
}

function jsxAttribute(node: JsxNode, name: string) {
  return jsxOpening(node).attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function jsxStringAttribute(node: JsxNode, name: string) {
  const initializer = jsxAttribute(node, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function jsxExpressionAttribute(node: JsxNode, name: string) {
  const initializer = jsxAttribute(node, name)?.initializer;
  return initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
}

function expressionPath(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) {
    const owner = expressionPath(current.expression);
    return owner ? `${owner}.${current.name.text}` : undefined;
  }
  return undefined;
}

function containsCall(root: ts.Node, path: string) {
  return collectNodes(
    root,
    (node): node is ts.CallExpression => ts.isCallExpression(node)
      && expressionPath(node.expression) === path,
  ).length > 0;
}

function assertSheetJsxContract(source: string) {
  const root = parseTsx(source);
  const dialogs = collectNodes(
    root,
    (node): node is JsxNode => isJsxNode(node) && jsxStringAttribute(node, "role") === "dialog",
  );
  assert.equal(dialogs.length, 1, "exactly one dialog role is required");
  assert.equal(jsxStringAttribute(dialogs[0], "aria-modal"), "true");
  assert.equal(expressionPath(jsxExpressionAttribute(dialogs[0], "aria-labelledby")), "titleId");
  assert.equal(jsxStringAttribute(dialogs[0], "data-mobile-sheet-size"), undefined);
  assert.equal(expressionPath(jsxExpressionAttribute(dialogs[0], "data-mobile-sheet-size")), "size");

  const titles = collectNodes(
    root,
    (node): node is JsxNode => isJsxNode(node)
      && jsxTag(node) === "h2"
      && expressionPath(jsxExpressionAttribute(node, "id")) === "titleId",
  );
  assert.equal(titles.length, 1, "dialog heading must own titleId");

  const handles = collectNodes(
    root,
    (node): node is JsxNode => isJsxNode(node)
      && jsxStringAttribute(node, "data-mobile-sheet-handle") === "true",
  );
  assert.equal(handles.length, 1, "one explicit drag handle is required");
  assert.equal(expressionPath(jsxExpressionAttribute(handles[0], "onPointerDown")), "startDrag");
  assert.equal(expressionPath(jsxExpressionAttribute(handles[0], "onPointerMove")), "moveDrag");
  assert.ok(jsxExpressionAttribute(handles[0], "onPointerUp"), "handle pointer-up is missing");
  assert.ok(jsxExpressionAttribute(handles[0], "onPointerCancel"), "handle pointer-cancel is missing");
  const pointerMoveOwners = collectNodes(
    root,
    (node): node is JsxNode => isJsxNode(node) && !!jsxAttribute(node, "onPointerMove"),
  );
  assert.deepEqual(pointerMoveOwners, handles, "drag movement must exist only on the handle");

  const scrims = collectNodes(
    root,
    (node): node is JsxNode => isJsxNode(node)
      && jsxStringAttribute(node, "data-mobile-sheet-scrim") === "true",
  );
  assert.equal(scrims.length, 1, "blocking scrim is missing");
  assert.ok(jsxExpressionAttribute(scrims[0], "onPointerDown"), "scrim must consume pointer-down");

  const scrollers = collectNodes(
    root,
    (node): node is JsxNode => isJsxNode(node)
      && jsxStringAttribute(node, "data-mobile-sheet-scroll") === "true",
  );
  assert.equal(scrollers.length, 1, "sheet internal scroller is missing");
  assert.match(jsxStringAttribute(scrollers[0], "className") ?? "", /overflow-y-auto/);
}

function assertSheetRuntimeContract(source: string) {
  assert.match(source, /height:\s*medium\s*\?\s*["']min\(60dvh, 620px\)["']/);
  assert.match(source, /maxHeight:\s*medium\s*\?\s*["']min\(60dvh, 620px\)["']\s*:\s*["']94dvh["']/);
  assert.match(source, /paddingBottom:\s*["']calc\(20px \+ env\(safe-area-inset-bottom\)\)["']/);
  assert.match(source, /zIndex:\s*80[\s\S]{0,180}pointerEvents:\s*["']auto["']/);
  assert.match(source, /zIndex:\s*81/);
  assert.match(source, /event\.key\s*===\s*["']Escape["']/);
  assert.match(source, /document\.addEventListener\(["']keydown["'],\s*onKeyDown,\s*true\)/);
  assert.match(source, /document\.addEventListener\(["']focusin["'],\s*onFocusIn,\s*true\)/);
  assert.match(source, /document\.body\.style\.overflow\s*=\s*["']hidden["']/);
  assert.match(source, /unlockBodyScroll\(\)/);
  assert.match(source, /triggerRef\?\.current\s*\?\?\s*previousFocusRef\.current/);
  assert.match(source, /const onKeyDown[\s\S]{0,140}if \(!coordinator\.isActive\(id\)\) return/);
  assert.match(source, /const onFocusIn[\s\S]{0,140}if \(!coordinator\.isActive\(id\)\) return/);
  assert.match(source, /const onPopState[\s\S]{0,140}if \(!coordinator\.isActive\(id\)\) return/);
  assert.match(source, /const restoreFocus\s*=\s*coordinator\.isActive\(id\)[\s\S]{0,300}if \(restoreFocus\)/);
  assert.match(source, /createSheetDragSession/);
  assert.match(source, /moveSheetDragSession/);
  assert.match(source, /releaseSheetDragSession/);
  assert.match(source, /createMobileSheetCoordinator/);
  assert.doesNotMatch(
    source,
    /const openSheetIds\s*=|function ensureSheetHistoryEntry|function consumeSheetHistoryEntry/,
  );
}

function createFakeHistory() {
  const stack: unknown[] = [{ route: "editor" }];
  let index = 0;
  let pushes = 0;
  let backs = 0;
  const urls: string[] = [];
  const tasks: Array<() => void> = [];
  const adapter: HistoryAdapter = {
    getState: () => stack[index],
    getUrl: () => "https://example.test/video-editor?ui=v2",
    pushState(state, url) {
      stack.splice(index + 1);
      stack.push(state);
      index += 1;
      pushes += 1;
      urls.push(url);
    },
    back() {
      backs += 1;
      if (index > 0) index -= 1;
    },
    schedule(task) { tasks.push(task); },
  };
  return {
    adapter,
    get state() { return stack[index]; },
    get pushes() { return pushes; },
    get backs() { return backs; },
    urls,
    externalBack() { if (index > 0) index -= 1; },
    flush() {
      while (tasks.length > 0) tasks.shift()!();
    },
  };
}

check("dismisses at the exact distance or velocity threshold and never upward", () => {
  const shouldDismiss = requireFunction<(motion: mobileSheet.SheetDragMotion) => boolean>(
    "shouldDismissSheetDrag",
  );
  assert.equal(shouldDismiss({ distanceY: 95.99, velocityY: 0.64 }), false);
  assert.equal(shouldDismiss({ distanceY: 96, velocityY: -0.2 }), true);
  assert.equal(shouldDismiss({ distanceY: 0, velocityY: 0.65 }), true);
  assert.equal(shouldDismiss({ distanceY: -1, velocityY: 4 }), false);
});

check("clamps upward visual drag translation at zero", () => {
  const clampTranslation = requireFunction<(distanceY: number) => number>(
    "clampSheetDragTranslation",
  );
  assert.equal(clampTranslation(-48), 0);
  assert.equal(clampTranslation(0), 0);
  assert.equal(clampTranslation(42), 42);
});

check("fast same-position pointer-up retains the recent downward move velocity", () => {
  const create = requireFunction<(sample: DragSample) => DragSession>("createSheetDragSession");
  const move = requireFunction<(session: DragSession, sample: DragSample) => DragSession>("moveSheetDragSession");
  const release = requireFunction<(session: DragSession, sample: DragSample) => mobileSheet.SheetDragMotion>("releaseSheetDragSession");
  const shouldDismiss = requireFunction<(motion: mobileSheet.SheetDragMotion) => boolean>("shouldDismissSheetDrag");
  let session = create({ y: 100, atMs: 0 });
  session = move(session, { y: 140, atMs: 40 });
  const motion = release(session, { y: 140, atMs: 46 });
  assert.equal(motion.distanceY, 40);
  assert.equal(motion.velocityY, 1);
  assert.equal(shouldDismiss(motion), true);
});

check("pointer-up movement is sampled without a preceding move event", () => {
  const create = requireFunction<(sample: DragSample) => DragSession>("createSheetDragSession");
  const release = requireFunction<(session: DragSession, sample: DragSample) => mobileSheet.SheetDragMotion>("releaseSheetDragSession");
  const motion = release(create({ y: 100, atMs: 10 }), { y: 120, atMs: 30 });
  assert.deepEqual(motion, { distanceY: 20, velocityY: 1 });
});

check("upward, slow, and stale releases do not inherit dismiss velocity", () => {
  const create = requireFunction<(sample: DragSample) => DragSession>("createSheetDragSession");
  const move = requireFunction<(session: DragSession, sample: DragSample) => DragSession>("moveSheetDragSession");
  const release = requireFunction<(session: DragSession, sample: DragSample) => mobileSheet.SheetDragMotion>("releaseSheetDragSession");
  const shouldDismiss = requireFunction<(motion: mobileSheet.SheetDragMotion) => boolean>("shouldDismissSheetDrag");

  const upward = release(move(create({ y: 100, atMs: 0 }), { y: 80, atMs: 20 }), { y: 80, atMs: 25 });
  assert.equal(upward.velocityY, -1);
  assert.equal(shouldDismiss(upward), false);

  const slow = release(move(create({ y: 100, atMs: 0 }), { y: 120, atMs: 50 }), { y: 120, atMs: 55 });
  assert.equal(slow.velocityY, 0.4);
  assert.equal(shouldDismiss(slow), false);

  const stale = release(move(create({ y: 100, atMs: 0 }), { y: 130, atMs: 20 }), { y: 130, atMs: 140 });
  assert.equal(stale.velocityY, 0);
  assert.equal(shouldDismiss(stale), false);
});

check("tagged history opens once and UI close consumes only its entry", () => {
  const createCoordinator = requireFunction<(adapter: HistoryAdapter, token: string) => SheetCoordinator>("createMobileSheetCoordinator");
  const fake = createFakeHistory();
  const coordinator = createCoordinator(fake.adapter, "sheet-token");
  coordinator.register("logo");
  assert.equal(fake.pushes, 1);
  assert.deepEqual(fake.urls, ["https://example.test/video-editor?ui=v2"]);
  assert.ok(Object.values(fake.state as Record<string, unknown>).includes("sheet-token"));
  assert.equal(coordinator.requestClose("logo"), "history");
  assert.equal(fake.backs, 1);
  assert.equal(coordinator.handlePopState(), "logo");
  coordinator.unregister("logo");
  fake.flush();
  assert.equal(fake.backs, 1, "cleanup must not back past the consumed tag");
});

check("browser Back identifies the active owner to close", () => {
  const createCoordinator = requireFunction<(adapter: HistoryAdapter, token: string) => SheetCoordinator>("createMobileSheetCoordinator");
  const fake = createFakeHistory();
  const coordinator = createCoordinator(fake.adapter, "sheet-token");
  coordinator.register("edit");
  fake.externalBack();
  assert.equal(coordinator.handlePopState(), "edit");
  coordinator.unregister("edit");
  fake.flush();
  assert.equal(fake.backs, 0);
});

check("same-commit switches and StrictMode cleanup do not duplicate history", () => {
  const createCoordinator = requireFunction<(adapter: HistoryAdapter, token: string) => SheetCoordinator>("createMobileSheetCoordinator");
  const fake = createFakeHistory();
  const coordinator = createCoordinator(fake.adapter, "sheet-token");
  coordinator.register("edit");
  coordinator.unregister("edit");
  coordinator.register("logo");
  fake.flush();
  assert.equal(fake.pushes, 1);
  assert.equal(fake.backs, 0);
  assert.equal(coordinator.isActive("logo"), true);

  coordinator.unregister("logo");
  coordinator.register("logo");
  fake.flush();
  assert.equal(fake.pushes, 1, "StrictMode cleanup/setup must reuse the tag");
  assert.equal(fake.backs, 0);
});

check("concurrent owners arbitrate focus/history to the most recent sheet", () => {
  const createCoordinator = requireFunction<(adapter: HistoryAdapter, token: string) => SheetCoordinator>("createMobileSheetCoordinator");
  const fake = createFakeHistory();
  const coordinator = createCoordinator(fake.adapter, "sheet-token");
  coordinator.register("edit");
  coordinator.register("logo");
  assert.equal(fake.pushes, 1);
  assert.equal(coordinator.isActive("edit"), false);
  assert.equal(coordinator.isActive("logo"), true);
  assert.equal(coordinator.requestClose("edit"), "ignored");
  assert.equal(coordinator.requestClose("logo"), "history");
  assert.equal(coordinator.handlePopState(), "logo");
  coordinator.unregister("logo");
  fake.flush();
  assert.equal(coordinator.isActive("edit"), true);
  assert.equal(fake.pushes, 2, "remaining owner gets one replacement Back entry");
});

const sheetSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/MobileSheet.tsx",
  "utf8",
);

check("MobileSheet JSX enforces dialog, handle-only drag, scrim, and internal scroll", () => {
  assertSheetJsxContract(sheetSource);
  assert.throws(
    () => assertSheetJsxContract(sheetSource.replace('role="dialog"', 'role="region"')),
    /dialog role/,
  );
  assert.throws(
    () => assertSheetJsxContract(sheetSource.replace('data-mobile-sheet-handle="true"', 'data-mobile-sheet-handle="false"')),
    /drag handle/,
  );
});

check("MobileSheet runtime contract covers sizing, safe area, focus, Escape, body lock, and history", () => {
  assertSheetRuntimeContract(sheetSource);
  assert.throws(
    () => assertSheetRuntimeContract(sheetSource.replace("calc(20px + env(safe-area-inset-bottom))", "20px")),
    /paddingBottom/,
  );
  assert.throws(
    () => assertSheetRuntimeContract(sheetSource.replace('event.key === "Escape"', 'event.key === "Enter"')),
    /Escape/,
  );
  assert.throws(
    () => assertSheetRuntimeContract(sheetSource.replace(
      "const onKeyDown = (event: KeyboardEvent) => {\n      if (!coordinator.isActive(id)) return;",
      "const onKeyDown = (event: KeyboardEvent) => {",
    )),
    /onKeyDown/,
  );
});

check("drag release does not re-arm the one-time entrance animation", () => {
  assert.doesNotMatch(sheetSource, /animation:\s*dragging\s*\?/);
  assert.match(sheetSource, /sheetVisible\s*\?\s*["']translate3d\(0, 0, 0\)["']/);
});

if (failures.length > 0) {
  throw new Error(`mobile sheet verifier failed (${failures.length}):\n${failures.join("\n")}`);
}

console.log("mobile-sheet: all checks passed");

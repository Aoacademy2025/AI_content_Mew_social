// verify-hero-114-mobile-editor-banner.ts — HERO-114 verification:
// (1) PostPhaseMobile.tsx: data-mobile-editor-actions is horizontally scrollable (overflow-x-auto)
//     with shrink-0 >=44px touch targets (min-h-[44px], min-w-[68px]) and exposes a quick
//     `สไตล์` action button (data-mobile-editor-action="style") wired to openStyle -> setStyleOpen(true).
// (2) dashboard-layout.tsx + EditorV2Shell.tsx: ProductUpdateBanner renders in normal flex flow
//     above the /video-editor workspace instead of overlaying the topbar with `absolute inset-x-0 top-0`.
//
// Run: npx tsx scripts/verify-hero-114-mobile-editor-banner.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`  PASS  ${name}`);
}

type JsxElementNode = ts.JsxElement | ts.JsxSelfClosingElement;

function parseTsx(source: string, fileName: string) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collectNodes<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function isJsxElementNode(node: ts.Node): node is JsxElementNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function jsxOpening(node: JsxElementNode) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function jsxTagName(node: JsxElementNode) {
  return jsxOpening(node).tagName.getText();
}

function jsxAttribute(node: JsxElementNode, name: string) {
  return jsxOpening(node).attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function jsxStringAttribute(node: JsxElementNode, name: string) {
  const initializer = jsxAttribute(node, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function jsxExpressionAttribute(node: JsxElementNode, name: string) {
  const initializer = jsxAttribute(node, name)?.initializer;
  return initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
}

console.log("1. PostPhaseMobile action bar overflow & quick style trigger");

const mobileSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");
const mobileAst = parseTsx(mobileSrc, "PostPhaseMobile.tsx");

const actionBars = collectNodes(
  mobileAst,
  (node): node is ts.JsxElement =>
    ts.isJsxElement(node) && jsxStringAttribute(node, "data-mobile-editor-actions") === "true",
);
check("PostPhaseMobile renders exactly one data-mobile-editor-actions container", actionBars.length === 1);

const actionBar = actionBars[0];
const actionBarClass = actionBar ? (jsxStringAttribute(actionBar, "className") ?? "") : "";
check(
  "data-mobile-editor-actions is horizontally scrollable (overflow-x-auto)",
  /\boverflow-x-auto\b/.test(actionBarClass),
  actionBarClass,
);

const directButtons = actionBar
  ? actionBar.children.filter((node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "button")
  : [];
const actionNames = directButtons.map((btn) => jsxStringAttribute(btn, "data-mobile-editor-action"));
check(
  "data-mobile-editor-actions contains style, headline, subtitle, logo, music, and layers actions",
  ["style", "headline", "subtitle", "logo", "music", "layers"].every((name) => actionNames.includes(name)),
  JSON.stringify(actionNames),
);

check(
  "every action button uses shrink-0, min-h-[44px], and min-w-[68px] touch-target classes",
  directButtons.length >= 6
    && directButtons.every((btn) => {
      const tokens = (jsxStringAttribute(btn, "className") ?? "").trim().split(/\s+/);
      return tokens.includes("shrink-0") && tokens.includes("min-h-[44px]") && tokens.includes("min-w-[68px]");
    }),
);

check(
  "mobileEditorActionStyle prevents shrinking (flexShrink: 0, minWidth: 68, whiteSpace: nowrap, minHeight: 44)",
  /mobileEditorActionStyle[\s\S]{0,260}minHeight:\s*44[\s\S]{0,260}flexShrink:\s*0[\s\S]{0,260}minWidth:\s*68[\s\S]{0,260}whiteSpace:\s*["']nowrap["']/.test(mobileSrc),
);

const styleBtn = directButtons.find((btn) => jsxStringAttribute(btn, "data-mobile-editor-action") === "style");
const styleOnClick = styleBtn ? jsxExpressionAttribute(styleBtn, "onClick")?.getText() ?? "" : "";
const openStyleFn = mobileSrc.match(/function openStyle\([\s\S]*?\n  \}/)?.[0] ?? "";
check(
  'data-mobile-editor-action="style" button shows สไตล์ label and opens the style sheet (setStyleOpen(true))',
  Boolean(styleBtn)
    && styleBtn!.getText().includes("สไตล์")
    && (styleOnClick === "openStyle" || styleOnClick.includes("setStyleOpen(true)"))
    && openStyleFn.includes("setStyleOpen(true)"),
  `onClick=${styleOnClick}`,
);

console.log("\n2. DashboardLayout /video-editor ProductUpdateBanner non-overlapping flow");

const layoutSrc = readFileSync("src/components/layout/dashboard-layout.tsx", "utf8");
const editorBranchMatch = layoutSrc.match(
  /const shell = pathname === "\/video-editor" \? \(([\s\S]*?)\) : \(/,
);
const editorBranch = editorBranchMatch?.[1] ?? "";

check("dashboard-layout.tsx has a dedicated /video-editor shell branch", editorBranch.length > 0);
check(
  "/video-editor branch no longer overlays ProductUpdateBanner with absolute inset-x-0 top-0",
  !editorBranch.includes("absolute inset-x-0 top-0") && !editorBranch.includes("z-[300]"),
  editorBranch,
);
check(
  "/video-editor branch renders ProductUpdateBanner in normal flow before a min-h-0 flex-1 children container",
  editorBranch.includes("<ProductUpdateBanner />")
    && editorBranch.indexOf("<ProductUpdateBanner />") < editorBranch.indexOf("{children}")
    && /className="[^"]*\bmin-h-0\b[^"]*\bflex-1\b[^"]*"/.test(editorBranch),
  editorBranch,
);

const bannerSrc = readFileSync("src/components/layout/product-update-banner.tsx", "utf8");
check(
  "ProductUpdateBanner root bar is shrink-0 so it takes natural height in flex-col",
  bannerSrc.includes('className="shrink-0 '),
);

const shellSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", "utf8");
check(
  "EditorV2Shell fits inside the flex-1 container (h-full min-h-0 flex-1) instead of forcing h-screen overflow",
  /className=\{`\$\{v2FontClass\} flex h-full min-h-0 flex-1 flex-col`\}/.test(shellSrc)
    && !shellSrc.includes("h-screen"),
);

assert.equal(process.exitCode ?? 0, 0, "One or more HERO-114 checks failed");
console.log(`\nALL ${passed} HERO-114 MOBILE EDITOR & BANNER CHECKS PASSED`);

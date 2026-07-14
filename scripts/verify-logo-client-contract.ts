// Run with: npx tsx scripts/verify-logo-client-contract.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as logoEditorModule from "../src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor";
import {
  LOGO_PICKER_ACCEPT,
  LOGO_PICKER_FORMAT_LABEL,
  buildLogoTelemetryProperties,
  buildLogoUploadFormData,
  logoUploadSizeBucket,
  parseLogoUploadResponse,
} from "../src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor";
import {
  DEFAULT_V2_SUB,
  buildV2BurnConfig,
  type V2Caption,
} from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import type { BrandAssetView, LogoOverlayConfig } from "../src/lib/logo-overlay";

const failures: string[] = [];

type JsxElementNode = ts.JsxElement | ts.JsxSelfClosingElement;

function parseTsx(source: string, fileName = "contract-fixture.tsx") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collectNodes<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
) {
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionPath(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) {
    const owner = expressionPath(current.expression);
    return owner ? `${owner}.${current.name.text}` : undefined;
  }
  return undefined;
}

function containsNode(root: ts.Node, predicate: (node: ts.Node) => boolean) {
  let found = false;
  const visit = (node: ts.Node) => {
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

function branchValueFromEquality(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  if (
    !ts.isBinaryExpression(current)
    || ![
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
    ].includes(current.operatorToken.kind)
  ) {
    return undefined;
  }
  const pairs: Array<[ts.Expression, ts.Expression]> = [
    [current.left, current.right],
    [current.right, current.left],
  ];
  for (const [candidate, value] of pairs) {
    const literal = unwrapExpression(value);
    if (
      expressionPath(candidate) === "rightTab"
      && ts.isStringLiteral(literal)
      && (literal.text === "subtitle" || literal.text === "logo")
    ) {
      return literal.text;
    }
  }
  return undefined;
}

function rightTabBranchValue(node: ts.Node) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && child === parent.right
    ) {
      const value = branchValueFromEquality(parent.left);
      if (value) return value;
    }
  }
  return undefined;
}

function assertSingleSpanTemplate(
  expression: ts.Expression | undefined,
  identifierPath: string,
  tail: string,
  message: string,
) {
  const current = expression && unwrapExpression(expression);
  assert.ok(current && ts.isTemplateExpression(current), message);
  assert.equal(current.head.text, "", message);
  assert.equal(current.templateSpans.length, 1, message);
  assert.equal(expressionPath(current.templateSpans[0].expression), identifierPath, message);
  assert.equal(current.templateSpans[0].literal.text, tail, message);
}

function isExactTabSemanticsGate(expression: ts.Expression) {
  const condition = unwrapExpression(expression);
  if (
    !ts.isBinaryExpression(condition)
    || condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
    || expressionPath(condition.right) !== "id"
  ) {
    return false;
  }
  const semanticsCheck = unwrapExpression(condition.left);
  if (
    !ts.isBinaryExpression(semanticsCheck)
    || semanticsCheck.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    || expressionPath(semanticsCheck.left) !== "semantics"
  ) {
    return false;
  }
  const expectedValue = unwrapExpression(semanticsCheck.right);
  return ts.isStringLiteral(expectedValue) && expectedValue.text === "tabs";
}

function assertDynamicTabLinkExpression(
  expression: ts.Expression | undefined,
  tail: "-tab" | "-panel",
  message: string,
) {
  const current = expression && unwrapExpression(expression);
  assert.ok(current && ts.isConditionalExpression(current), message);
  assert.equal(expressionPath(current.whenFalse), "undefined", message);
  assert.ok(isExactTabSemanticsGate(current.condition), message);
  const template = unwrapExpression(current.whenTrue);
  assert.ok(ts.isTemplateExpression(template) && template.head.text === "", message);
  assert.equal(template.templateSpans.length, 2, message);
  const [idSpan, valueSpan] = template.templateSpans;
  assert.equal(expressionPath(idSpan.expression), "id", message);
  assert.equal(idSpan.literal.text, "-", message);
  assert.equal(expressionPath(valueSpan.expression), "o.value", message);
  assert.equal(valueSpan.literal.text, tail, message);
}

function assertLogoControlsBranchStructure(source: string) {
  const root = parseTsx(source, "logo-branch-contract.tsx");
  const controls = collectNodes(
    root,
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "LogoOverlayControls",
  );
  assert.equal(controls.length, 1, "desktop must have exactly one LogoOverlayControls instance");
  assert.equal(
    rightTabBranchValue(controls[0]),
    "logo",
    'LogoOverlayControls must be inside the rightTab === "logo" branch and nowhere outside it',
  );
}

function assertPreviewSiblingStructure(source: string) {
  const root = parseTsx(source, "preview-sibling-contract.tsx");
  const frames = collectNodes(
    root,
    (node): node is ts.JsxElement =>
      ts.isJsxElement(node) && jsxStringAttribute(node, "data-video-preview-frame") === "true",
  );
  assert.equal(frames.length, 1, "desktop must have exactly one data-video-preview-frame element");

  const directChildren = frames[0].children.filter(isJsxElementNode);
  const videos = directChildren.filter(
    (node) => jsxTagName(node) === "video"
      && expressionPath(jsxExpressionAttribute(node, "ref")) === "ed.videoRef",
  );
  const logos = directChildren.filter((node) => jsxTagName(node) === "LogoOverlayPreview");
  const captions = directChildren.filter((node) => jsxTagName(node) === "V2CaptionOverlay");
  assert.equal(videos.length, 1, "the displayed ed.videoRef video must be a direct preview-frame child");
  assert.equal(logos.length, 1, "LogoOverlayPreview must be a direct sibling of the displayed video");
  assert.equal(captions.length, 1, "V2CaptionOverlay must be a direct sibling of the displayed video");
  assert.ok(
    videos[0].pos < logos[0].pos && logos[0].pos < captions[0].pos,
    "displayed video, LogoOverlayPreview, and V2CaptionOverlay must be direct siblings in that order",
  );
  assert.equal(expressionPath(jsxExpressionAttribute(logos[0], "value")), "logoOverlay");
  assert.equal(expressionPath(jsxExpressionAttribute(logos[0], "asset")), "ed.logo.asset");
  const allLogos = collectNodes(
    root,
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "LogoOverlayPreview",
  );
  assert.equal(allLogos.length, 1, "desktop must have exactly one LogoOverlayPreview instance");
}

function assertMobileActionStructure(source: string) {
  const root = parseTsx(source, "mobile-action-contract.tsx");
  const previewFrames = collectNodes(
    root,
    (node): node is ts.JsxElement => ts.isJsxElement(node)
      && jsxStringAttribute(node, "data-mobile-preview") === "true",
  );
  const actionRows = collectNodes(
    root,
    (node): node is ts.JsxElement => ts.isJsxElement(node)
      && jsxStringAttribute(node, "data-mobile-editor-actions") === "true",
  );
  assert.equal(previewFrames.length, 1, "mobile sticky preview marker is missing");
  assert.equal(actionRows.length, 1, "mobile editor action row is missing");
  assert.equal(
    previewFrames[0].parent,
    actionRows[0].parent,
    "mobile actions must share the preview's direct layout parent",
  );
  const layoutChildren = (previewFrames[0].parent as ts.JsxElement).children.filter(isJsxElementNode);
  assert.equal(
    layoutChildren.indexOf(actionRows[0]),
    layoutChildren.indexOf(previewFrames[0]) + 1,
    "mobile actions must be directly below the sticky preview",
  );

  const directButtons = actionRows[0].children.filter(
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "button",
  );
  const subtitleActions = directButtons.filter(
    (button) => jsxStringAttribute(button, "data-mobile-editor-action") === "subtitle",
  );
  const logoActions = directButtons.filter(
    (button) => jsxStringAttribute(button, "data-mobile-editor-action") === "logo",
  );
  assert.equal(subtitleActions.length, 1, "mobile must expose one แก้ซับ action");
  assert.equal(logoActions.length, 1, "mobile must expose one โลโก้ action");
  assert.match(subtitleActions[0].getText(), /แก้ซับ/);
  assert.match(logoActions[0].getText(), /โลโก้/);
  assert.equal(
    expressionPath(jsxExpressionAttribute(subtitleActions[0], "style")),
    "mobileEditorActionStyle",
    "subtitle action must use the shared equal-size style",
  );
  assert.equal(
    expressionPath(jsxExpressionAttribute(logoActions[0], "style")),
    "mobileEditorActionStyle",
    "logo action must use the shared equal-size style",
  );

  const enabledIndicators = collectNodes(
    logoActions[0],
    (node): node is JsxElementNode => isJsxElementNode(node)
      && jsxStringAttribute(node, "data-logo-enabled-indicator") === "true",
  );
  assert.equal(enabledIndicators.length, 1, "enabled logo needs one explicit indicator");
  assert.match(enabledIndicators[0].getText(), /เปิดอยู่/);
  assert.ok(
    collectNodes(
      enabledIndicators[0],
      (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "Check",
    ).length === 1,
    "enabled logo indicator needs a non-color check icon",
  );
  assert.ok(
    collectNodes(
      logoActions[0],
      (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "ImageIcon",
    ).length === 1,
    "mobile logo action needs an icon alongside its text",
  );
}

function assertMobilePreviewSiblingStructure(source: string) {
  const root = parseTsx(source, "mobile-preview-contract.tsx");
  const frames = collectNodes(
    root,
    (node): node is ts.JsxElement => ts.isJsxElement(node)
      && jsxStringAttribute(node, "data-mobile-video-preview-frame") === "true",
  );
  assert.equal(frames.length, 1, "mobile must have exactly one marked video preview frame");
  const directChildren = frames[0].children.filter(isJsxElementNode);
  const videos = directChildren.filter(
    (node) => jsxTagName(node) === "video"
      && expressionPath(jsxExpressionAttribute(node, "ref")) === "ed.videoRef",
  );
  const logos = directChildren.filter((node) => jsxTagName(node) === "LogoOverlayPreview");
  const captions = directChildren.filter((node) => jsxTagName(node) === "V2CaptionOverlay");
  assert.equal(videos.length, 1, "mobile displayed video must be a direct preview-frame child");
  assert.equal(logos.length, 1, "mobile LogoOverlayPreview must be a direct video sibling");
  assert.equal(captions.length, 1, "mobile V2CaptionOverlay must be a direct video sibling");
  assert.ok(
    videos[0].pos < logos[0].pos && logos[0].pos < captions[0].pos,
    "mobile displayed video, logo, and captions must be direct siblings in that order",
  );
  assert.equal(expressionPath(jsxExpressionAttribute(logos[0], "value")), "logoOverlay");
  assert.equal(expressionPath(jsxExpressionAttribute(logos[0], "asset")), "ed.logo.asset");
}

function assertMobileLogoSheetStructure(source: string) {
  const root = parseTsx(source, "mobile-logo-sheet-contract.tsx");
  const logoSheets = collectNodes(
    root,
    (node): node is ts.JsxElement => ts.isJsxElement(node)
      && jsxTagName(node) === "MobileSheet"
      && jsxStringAttribute(node, "size") === "medium",
  ).filter((sheet) => collectNodes(
    sheet,
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "LogoOverlayControls",
  ).length === 1);
  assert.equal(logoSheets.length, 1, "mobile logo controls need exactly one medium MobileSheet");
  assert.equal(expressionPath(jsxExpressionAttribute(logoSheets[0], "open")), "logoOpen");
  assert.equal(expressionPath(jsxExpressionAttribute(logoSheets[0], "triggerRef")), "logoTriggerRef");
}

function assertMobilePostPhaseEditorForwardingStructure(source: string) {
  const root = parseTsx(source, "mobile-editor-options-contract.tsx");
  const editorCalls = collectNodes(
    root,
    (node): node is ts.CallExpression => ts.isCallExpression(node)
      && expressionPath(node.expression) === "usePostPhaseEditor",
  );
  assert.equal(editorCalls.length, 1, "mobile must call usePostPhaseEditor exactly once");
  const options = editorCalls[0].arguments[2];
  assert.ok(options && ts.isObjectLiteralExpression(options), "mobile editor options object is missing");
  for (const name of [
    "projectId",
    "logoOverlay",
    "onLogoOverlayChange",
    "logoEligible",
    "projectSaveStatus",
    "onRetryProjectSave",
  ]) {
    assert.equal(
      options.properties.filter(
        (property) => ts.isShorthandPropertyAssignment(property) && property.name.text === name,
      ).length,
      1,
      `mobile must forward ${name} unchanged into usePostPhaseEditor`,
    );
  }
  assert.equal(objectLiteralStringProperty(options, "surface"), "mobile");
}

function assertMobileLogoRuntimeStructure(source: string) {
  const root = parseTsx(source, "mobile-logo-runtime-contract.tsx");
  const openLogoFunctions = collectNodes(
    root,
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
      && node.name?.text === "openLogo",
  );
  assert.equal(openLogoFunctions.length, 1, "mobile openLogo handler is missing");
  assert.ok(
    containsNode(openLogoFunctions[0], (node) => ts.isCallExpression(node)
      && expressionPath(node.expression) === "ed.videoRef.current.pause"),
    "opening the mobile logo sheet must pause preview playback",
  );

  const telemetryEffects = collectNodes(
    root,
    (node): node is ts.CallExpression => ts.isCallExpression(node)
      && expressionPath(node.expression) === "useEffect"
      && node.getText().includes("logo_overlay_panel_opened"),
  );
  assert.equal(telemetryEffects.length, 1, "mobile panel telemetry needs one effect");
  const dependencies = telemetryEffects[0].arguments[1];
  assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies), "mobile panel telemetry dependencies are missing");
  assert.deepEqual(
    dependencies.elements.map((element) => expressionPath(element as ts.Expression)),
    ["logoOpen"],
    "mobile panel telemetry must run once per closed-to-open transition",
  );
  assert.match(telemetryEffects[0].getText(), /if\s*\(\s*!logoOpen\s*\)\s*return/);
  assert.match(telemetryEffects[0].getText(), /surface:\s*["']mobile["']/);

  const localSheetFunctions = collectNodes(
    root,
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
      && node.name?.text === "Sheet",
  );
  assert.equal(localSheetFunctions.length, 0, "legacy local Sheet function must stay removed");
  const legacySheetUsages = collectNodes(
    root,
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "Sheet",
  );
  assert.equal(legacySheetUsages.length, 0, "legacy <Sheet> usages must stay removed");
  const mobileSheets = collectNodes(
    root,
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "MobileSheet",
  );
  assert.equal(mobileSheets.length, 3, "edit, style, and logo must share MobileSheet");
  assert.equal(mobileSheets.filter((sheet) => jsxStringAttribute(sheet, "size") === "large").length, 2);
  assert.equal(mobileSheets.filter((sheet) => jsxStringAttribute(sheet, "size") === "medium").length, 1);
}

function assertExactResponsiveBranchStructure(breakpointSource: string, shellSource: string) {
  assert.match(breakpointSource, /matchMedia\(\s*["']\(max-width: 1023px\)["']\s*\)/);
  assert.doesNotMatch(breakpointSource, /max-width:\s*1024px/);
  const root = parseTsx(shellSource, "editor-shell-responsive-contract.tsx");
  const responsiveBranches = collectNodes(
    root,
    (node): node is ts.ConditionalExpression => ts.isConditionalExpression(node)
      && expressionPath(node.condition) === "isMobile"
      && containsNode(node.whenTrue, (child) => isJsxElementNode(child) && jsxTagName(child) === "PostPhaseMobile")
      && containsNode(node.whenFalse, (child) => isJsxElementNode(child) && jsxTagName(child) === "PostPhase"),
  );
  assert.equal(responsiveBranches.length, 1, "shell must select mobile below 1024 and desktop at 1024+");
  assert.equal(
    collectNodes(
      responsiveBranches[0].whenTrue,
      (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "PostPhase",
    ).length,
    0,
    "desktop PostPhase cannot render in the mobile branch",
  );
  assert.equal(
    collectNodes(
      responsiveBranches[0].whenFalse,
      (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "PostPhaseMobile",
    ).length,
    0,
    "PostPhaseMobile cannot render at the 1024 desktop boundary",
  );
}

function objectLiteralStringProperty(object: ts.ObjectLiteralExpression, name: string) {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText() === name,
  );
  return property && ts.isStringLiteral(unwrapExpression(property.initializer))
    ? (unwrapExpression(property.initializer) as ts.StringLiteral).text
    : undefined;
}

function assertDesktopTabLinkageStructure(desktopSource: string, uiSource: string) {
  const desktopRoot = parseTsx(desktopSource, "desktop-tab-contract.tsx");
  const rightTabsIds = collectNodes(
    desktopRoot,
    (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "rightTabsId"
      && !!node.initializer
      && ts.isCallExpression(node.initializer)
      && expressionPath(node.initializer.expression) === "useId"
      && node.initializer.arguments.length === 0,
  );
  assert.equal(rightTabsIds.length, 1, "rightTabsId must be initialized once from useId()");

  const tabControls = collectNodes(
    desktopRoot,
    (node): node is JsxElementNode => isJsxElementNode(node)
      && jsxTagName(node) === "Segmented"
      && jsxStringAttribute(node, "semantics") === "tabs",
  );
  assert.equal(tabControls.length, 1, "desktop must have exactly one tab-semantic Segmented control");
  const tabControl = tabControls[0];
  assert.equal(expressionPath(jsxExpressionAttribute(tabControl, "id")), "rightTabsId");
  assert.equal(jsxStringAttribute(tabControl, "ariaLabel"), "ตั้งค่าองค์ประกอบวิดีโอ");
  const options = jsxExpressionAttribute(tabControl, "options");
  assert.ok(options && ts.isArrayLiteralExpression(unwrapExpression(options)), "tab options must be an array literal");
  const optionValues = (unwrapExpression(options) as ts.ArrayLiteralExpression).elements
    .filter(ts.isObjectLiteralExpression)
    .map((option) => objectLiteralStringProperty(option, "value"));
  assert.deepEqual(optionValues, ["subtitle", "logo"], "desktop tab values must remain stable");

  const tabPanels = collectNodes(
    desktopRoot,
    (node): node is JsxElementNode =>
      isJsxElementNode(node) && jsxStringAttribute(node, "role") === "tabpanel",
  );
  for (const value of ["subtitle", "logo"] as const) {
    const panels = tabPanels.filter((panel) => rightTabBranchValue(panel) === value);
    assert.equal(panels.length, 1, `${value} must have exactly one active tabpanel branch`);
    assertSingleSpanTemplate(
      jsxExpressionAttribute(panels[0], "id"),
      "rightTabsId",
      `-${value}-panel`,
      `${value} tabpanel ID must match the Segmented aria-controls contract`,
    );
    assertSingleSpanTemplate(
      jsxExpressionAttribute(panels[0], "aria-labelledby"),
      "rightTabsId",
      `-${value}-tab`,
      `${value} tabpanel aria-labelledby must match its tab ID`,
    );
  }

  const uiRoot = parseTsx(uiSource, "segmented-tab-contract.tsx");
  const segmentedFunctions = collectNodes(
    uiRoot,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "Segmented",
  );
  assert.equal(segmentedFunctions.length, 1, "Segmented function declaration is missing");
  const tabButtons = collectNodes(
    segmentedFunctions[0],
    (node): node is JsxElementNode => isJsxElementNode(node)
      && jsxTagName(node) === "button"
      && !!jsxExpressionAttribute(node, "role")
      && containsNode(jsxExpressionAttribute(node, "role")!, (child) =>
        ts.isStringLiteral(child) && child.text === "tab"),
  );
  assert.equal(tabButtons.length, 1, "Segmented must render its tab button structurally");
  assertDynamicTabLinkExpression(
    jsxExpressionAttribute(tabButtons[0], "id"),
    "-tab",
    "Segmented tab IDs must be derived from id and o.value",
  );
  assertDynamicTabLinkExpression(
    jsxExpressionAttribute(tabButtons[0], "aria-controls"),
    "-panel",
    "Segmented aria-controls must be derived from id and o.value",
  );
  const ariaSelected = jsxExpressionAttribute(tabButtons[0], "aria-selected");
  assert.ok(
    ariaSelected
    && containsNode(ariaSelected, (node) => ts.isIdentifier(node) && node.text === "active"),
    "Segmented tabs must expose their active state through aria-selected",
  );
  const tabIndex = jsxExpressionAttribute(tabButtons[0], "tabIndex");
  assert.ok(
    tabIndex
    && containsNode(tabIndex, (node) => ts.isIdentifier(node) && node.text === "active")
    && containsNode(tabIndex, (node) => ts.isNumericLiteral(node) && node.text === "0")
    && containsNode(tabIndex, (node) => ts.isPrefixUnaryExpression(node)
      && node.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(node.operand)
      && node.operand.text === "1"),
    "Segmented tabs must retain a 0/-1 roving tabIndex",
  );
  const tabLists = collectNodes(
    segmentedFunctions[0],
    (node): node is JsxElementNode => isJsxElementNode(node)
      && jsxTagName(node) === "div"
      && !!jsxExpressionAttribute(node, "role")
      && containsNode(jsxExpressionAttribute(node, "role")!, (child) =>
        ts.isStringLiteral(child) && child.text === "tablist"),
  );
  assert.equal(tabLists.length, 1, "Segmented tabs must share one tablist");
}

function assertPostPhaseEditorForwardingStructure(source: string) {
  const root = parseTsx(source, "desktop-editor-options-contract.tsx");
  const editorCalls = collectNodes(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && expressionPath(node.expression) === "usePostPhaseEditor",
  );
  assert.equal(editorCalls.length, 1, "desktop must call usePostPhaseEditor exactly once");
  const options = editorCalls[0].arguments[2];
  assert.ok(options && ts.isObjectLiteralExpression(options), "desktop editor options object is missing");
  const requiredShorthand = [
    "projectId",
    "logoOverlay",
    "onLogoOverlayChange",
    "logoEligible",
    "projectSaveStatus",
    "onRetryProjectSave",
  ];
  for (const name of requiredShorthand) {
    const forwarded = options.properties.filter(
      (property) => ts.isShorthandPropertyAssignment(property) && property.name.text === name,
    );
    assert.equal(forwarded.length, 1, `desktop must forward ${name} unchanged into usePostPhaseEditor`);
  }
  assert.equal(objectLiteralStringProperty(options, "surface"), "desktop");
}

function assertDesktopExportFocusStructure(source: string) {
  const root = parseTsx(source, "desktop-focus-contract.tsx");
  const rightPanels = collectNodes(
    root,
    (node): node is ts.JsxElement => ts.isJsxElement(node)
      && jsxTagName(node) === "aside"
      && collectNodes(
        node,
        (child): child is JsxElementNode => isJsxElementNode(child)
          && jsxTagName(child) === "Segmented"
          && jsxStringAttribute(child, "semantics") === "tabs",
      ).length === 1,
  );
  assert.equal(rightPanels.length, 1, "desktop right tab panel is missing");
  const exportBars = collectNodes(
    root,
    (node): node is ts.JsxElement =>
      ts.isJsxElement(node) && jsxStringAttribute(node, "data-desktop-export-bar") === "true",
  );
  assert.equal(exportBars.length, 1, "late-DOM export bar marker is missing");
  const exportBar = exportBars[0];
  assert.ok(exportBar.pos > rightPanels[0].end, "export must follow the editor and right panel in DOM focus order");
  assert.match(jsxStringAttribute(exportBar, "className") ?? "", /(?:^|\s)order-first(?:\s|$)/);
  const exportButtons = collectNodes(
    exportBar,
    (node): node is JsxElementNode => isJsxElementNode(node)
      && jsxTagName(node) === "BtnPrimary"
      && !!jsxExpressionAttribute(node, "onClick")
      && containsNode(jsxExpressionAttribute(node, "onClick")!, (child) =>
        ts.isCallExpression(child) && expressionPath(child.expression) === "ed.exportVideo"),
  );
  assert.equal(exportButtons.length, 1, "late-DOM export bar must contain the export action");
  const timelines = collectNodes(
    root,
    (node): node is JsxElementNode => isJsxElementNode(node) && jsxTagName(node) === "TimelinePanel",
  );
  assert.equal(timelines.length, 1, "desktop TimelinePanel is missing");
  assert.ok(exportBar.end < timelines[0].pos, "export bar must remain before the timeline in DOM order");
}

function assertLogoExportTelemetryControlFlow(source: string) {
  const root = parseTsx(source, "usePostPhaseEditor.ts");
  const exportFunctions = collectNodes(
    root,
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
      && node.name?.text === "exportVideo",
  );
  assert.equal(exportFunctions.length, 1, "exportVideo function is missing or duplicated");
  const exportFunction = exportFunctions[0];
  assert.ok(exportFunction.body, "exportVideo body is missing");

  const acceptanceGuards = collectNodes(
    exportFunction.body,
    (node): node is ts.IfStatement => {
      if (!ts.isIfStatement(node)) return false;
      const condition = unwrapExpression(node.expression);
      return ts.isPrefixUnaryExpression(condition)
        && condition.operator === ts.SyntaxKind.ExclamationToken
        && expressionPath(condition.operand) === "result.ok";
    },
  );
  assert.equal(acceptanceGuards.length, 1, "export must have one !result.ok acceptance guard");
  const guard = acceptanceGuards[0];
  const guardExit = ts.isBlock(guard.thenStatement)
    ? guard.thenStatement.statements.some((statement) => ts.isThrowStatement(statement))
    : ts.isThrowStatement(guard.thenStatement);
  assert.equal(guardExit, true, "a rejected export job must throw/exit before telemetry");

  const telemetryCalls = collectNodes(
    exportFunction.body,
    (node): node is ts.CallExpression => ts.isCallExpression(node)
      && expressionPath(node.expression) === "trackEvent"
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "logo_overlay_export_submitted",
  );
  assert.equal(telemetryCalls.length, 1, "submission telemetry must be emitted exactly once");
  assert.ok(telemetryCalls[0].pos > guard.end, "submission telemetry must follow the acceptance guard");

  assert.ok(ts.isBlock(guard.parent), "acceptance guard must live in a block");
  let telemetryStatement: ts.Node = telemetryCalls[0];
  while (telemetryStatement.parent !== guard.parent) {
    assert.ok(telemetryStatement.parent, "telemetry is outside the acceptance-guard block");
    telemetryStatement = telemetryStatement.parent;
  }
  const guardIndex = guard.parent.statements.findIndex((statement) => statement === guard);
  const telemetryIndex = guard.parent.statements.findIndex((statement) => statement === telemetryStatement);
  assert.ok(
    guardIndex >= 0 && telemetryIndex > guardIndex,
    "submission telemetry must be in a later statement after the exiting guard",
  );
}

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${detail}`);
    console.error(`not ok - ${name}\n  ${detail}`);
  }
}

const asset: BrandAssetView = {
  id: "asset_logo_1",
  displayName: "brand-mark.png",
  mimeType: "image/webp",
  sizeBytes: 42_000,
  width: 800,
  height: 400,
  imageUrl: "/api/user/brand-assets/asset_logo_1/image",
};

const config: LogoOverlayConfig = {
  enabled: true,
  assetId: asset.id,
  position: "bottom-left",
  sizePct: 22,
  opacity: 0.75,
};

const captions: V2Caption[] = [
  { text: "ทดสอบ", startMs: 0, endMs: 1_000, tag: "hook" },
];

type ScheduleLogoAssetCleanup = (
  assetId: string,
  dependencies?: {
    schedule?: (task: () => void | Promise<void>, delayMs: number) => void;
    deleteAsset?: (assetId: string) => Promise<unknown>;
  },
) => boolean;

async function main() {
  await check("picker advertises every accepted MIME type, extension, and the limit", () => {
    for (const token of [
      "image/png",
      "image/jpeg",
      "image/webp",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
    ]) {
      assert.ok(LOGO_PICKER_ACCEPT.split(",").includes(token), `missing picker token: ${token}`);
    }
    assert.match(LOGO_PICKER_FORMAT_LABEL, /PNG/i);
    assert.match(LOGO_PICKER_FORMAT_LABEL, /JPG|JPEG/i);
    assert.match(LOGO_PICKER_FORMAT_LABEL, /WebP/i);
    assert.match(LOGO_PICKER_FORMAT_LABEL, /5\s*MB/i);
  });

  await check("multipart construction sends only file and projectId fields", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "brand.png", {
      type: "image/png",
    });
    const form = buildLogoUploadFormData(file, "project_123");
    assert.equal(form.get("file"), file);
    assert.equal(form.get("projectId"), "project_123");
    assert.deepEqual(Array.from(form.keys()).sort(), ["file", "projectId"]);
  });

  await check("upload response parsing accepts only the public asset shape", () => {
    assert.deepEqual(
      parseLogoUploadResponse(201, {
        asset: { ...asset, storageKey: "private/user/logo.webp", originalName: "secret.png" },
      }),
      { ok: true, asset },
    );
    assert.deepEqual(
      parseLogoUploadResponse(422, {
        error: "corrupt_image",
        message: "ไฟล์รูปภาพเสียหายหรืออ่านไม่ได้",
        path: "/private/logo.webp",
      }),
      {
        ok: false,
        errorCode: "corrupt_image",
        message: "ไฟล์รูปภาพเสียหายหรืออ่านไม่ได้",
      },
    );
    assert.deepEqual(parseLogoUploadResponse(201, { asset: { ...asset, imageUrl: "" } }), {
      ok: false,
      errorCode: "invalid_response",
      message: "อัปโหลดโลโก้ไม่สำเร็จ",
    });
  });

  await check("telemetry properties are normalized and privacy-safe", () => {
    const properties = buildLogoTelemetryProperties({
      planEligible: true,
      errorCode: "CORRUPT_IMAGE /Users/me/brand.png",
      sizeBucket: "1-5mb",
      position: "top-right",
      enabled: false,
      surface: "mobile",
      assetId: asset.id,
      filename: asset.displayName,
      src: "https://attacker.example/private-logo.webp",
      url: asset.imageUrl,
      path: "/private/logo.webp",
      storageKey: "user/private.webp",
      originalName: "private.png",
    });
    assert.deepEqual(properties, {
      planEligible: true,
      errorCode: "unknown",
      sizeBucket: "1-5mb",
      position: "top-right",
      enabled: false,
      surface: "mobile",
    });
    for (const forbidden of [
      "assetId",
      "filename",
      "src",
      "url",
      "path",
      "storageKey",
      "originalName",
    ]) {
      assert.equal(forbidden in properties, false, `telemetry leaked ${forbidden}`);
    }
    assert.equal(logoUploadSizeBucket(0), "under-1mb");
    assert.equal(logoUploadSizeBucket(1024 * 1024), "1-5mb");
    assert.equal(logoUploadSizeBucket(6 * 1024 * 1024), "over-5mb");
  });

  await check("burn config is byte-compatible when logo input is absent", () => {
    const legacy = buildV2BurnConfig("/preview.mp4", captions, 1_000, DEFAULT_V2_SUB);
    const explicitAbsent = buildV2BurnConfig(
      "/preview.mp4",
      captions,
      1_000,
      DEFAULT_V2_SUB,
      30,
      {},
      undefined,
    );
    assert.deepEqual(explicitAbsent, legacy);
    assert.equal("logoOverlay" in legacy, false);
  });

  await check("burn config emits only normalized enabled client logo fields", () => {
    const enabled = buildV2BurnConfig(
      "/preview.mp4",
      captions,
      1_000,
      DEFAULT_V2_SUB,
      30,
      {},
      { ...config, sizePct: 999, opacity: -2 } as LogoOverlayConfig,
    );
    assert.deepEqual(enabled.logoOverlay, {
      enabled: true,
      assetId: asset.id,
      position: "bottom-left",
      sizePct: 35,
      opacity: 0.2,
    });

    const disabled = buildV2BurnConfig(
      "/preview.mp4",
      captions,
      1_000,
      DEFAULT_V2_SUB,
      30,
      {},
      { ...config, enabled: false },
    );
    assert.equal("logoOverlay" in disabled, false);
  });

  const hookSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts",
    "utf8",
  );
  const postPhaseEditorSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
    "utf8",
  );
  await check("cleanup retries a delayed autosave 409 after unmount and then succeeds", async () => {
    const scheduleLogoAssetCleanup = (
      logoEditorModule as typeof logoEditorModule & {
        scheduleLogoAssetCleanup?: ScheduleLogoAssetCleanup;
      }
    ).scheduleLogoAssetCleanup;
    const cleanupDelay = (
      logoEditorModule as typeof logoEditorModule & {
        LOGO_ASSET_CLEANUP_DELAY_MS?: number;
      }
    ).LOGO_ASSET_CLEANUP_DELAY_MS;
    const retryDelay = (
      logoEditorModule as typeof logoEditorModule & {
        LOGO_ASSET_CLEANUP_RETRY_DELAY_MS?: number;
      }
    ).LOGO_ASSET_CLEANUP_RETRY_DELAY_MS;
    assert.equal(
      typeof scheduleLogoAssetCleanup,
      "function",
      "scheduleLogoAssetCleanup is not exported",
    );
    assert.equal(cleanupDelay, 1_100, "cleanup waits beyond the one-second autosave window");
    assert.ok(
      typeof retryDelay === "number" && retryDelay >= 1_000,
      "cleanup retries must be delayed rather than a tight loop",
    );

    const pendingTasks: Array<() => void | Promise<void>> = [];
    const delays: number[] = [];
    let projectPatchFinished = false;
    let deleteAttempts = 0;
    let deleted = false;
    const accepted = scheduleLogoAssetCleanup!("  asset_from_reloaded_project  ", {
      schedule(task, delayMs) {
        pendingTasks.push(task);
        delays.push(delayMs);
      },
      async deleteAsset(assetId) {
        assert.equal(assetId, "asset_from_reloaded_project");
        deleteAttempts += 1;
        if (!projectPatchFinished) return { ok: false, status: 409 };
        deleted = true;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(accepted, true, "a persisted/reloaded asset does not need mount-local provenance");
    assert.deepEqual(delays, [1_100]);

    // The owning hook has unmounted. Its delayed project PATCH is still in flight, so the
    // authoritative DELETE sees the old project reference and refuses with 409.
    await pendingTasks.shift()!();
    assert.equal(deleteAttempts, 1);
    assert.equal(deleted, false);
    assert.deepEqual(delays, [1_100, retryDelay]);
    assert.equal(pendingTasks.length, 1, "409 schedules one delayed condition recheck");

    projectPatchFinished = true;
    await pendingTasks.shift()!();
    assert.equal(deleteAttempts, 2);
    assert.equal(deleted, true, "cleanup succeeds after autosave removes the reference");
    assert.equal(pendingTasks.length, 0);
    assert.equal(scheduleLogoAssetCleanup!("   ", {
      schedule() { throw new Error("blank ids must not schedule"); },
    }), false);
  });

  await check("cleanup retries network races but bounds continuing authoritative 409", async () => {
    const scheduleLogoAssetCleanup = (
      logoEditorModule as typeof logoEditorModule & {
        scheduleLogoAssetCleanup?: ScheduleLogoAssetCleanup;
      }
    ).scheduleLogoAssetCleanup!;
    const maxAttempts = (
      logoEditorModule as typeof logoEditorModule & {
        LOGO_ASSET_CLEANUP_MAX_ATTEMPTS?: number;
      }
    ).LOGO_ASSET_CLEANUP_MAX_ATTEMPTS;
    assert.ok(
      typeof maxAttempts === "number" && maxAttempts >= 2 && maxAttempts <= 10,
      "cleanup retry count must be finite and useful",
    );

    const networkTasks: Array<() => void | Promise<void>> = [];
    let networkAttempts = 0;
    let networkRaceDeleted = false;
    scheduleLogoAssetCleanup("network-race", {
      schedule(task) { networkTasks.push(task); },
      async deleteAsset() {
        networkAttempts += 1;
        if (networkAttempts === 1) throw new Error("temporary disconnect");
        networkRaceDeleted = true;
        return { ok: true, status: 200 };
      },
    });
    while (networkTasks.length > 0) await networkTasks.shift()!();
    assert.equal(networkAttempts, 2);
    assert.equal(networkRaceDeleted, true, "a transient network failure is retried");

    for (const protectedAsset of ["account-default", "other-project-reference"]) {
      const protectedTasks: Array<() => void | Promise<void>> = [];
      let attempts = 0;
      let forcedDeletion = false;
      scheduleLogoAssetCleanup(protectedAsset, {
        schedule(task) { protectedTasks.push(task); },
        async deleteAsset() {
          attempts += 1;
          return { ok: false, status: 409, forcedDeletion };
        },
      });
      while (protectedTasks.length > 0) await protectedTasks.shift()!();
      assert.equal(attempts, maxAttempts, `${protectedAsset} retries stop at the finite cap`);
      assert.equal(forcedDeletion, false, `${protectedAsset} is never force-deleted by the client`);
    }
  });

  await check("replacement/removal cleanup is server-protected rather than mount-gated", () => {
    assert.doesNotMatch(hookSource, /projectOnlyAssetIds|cleanupTimers|clearTimeout/);
    assert.match(
      hookSource,
      /previous\.assetId\s*!==\s*parsed\.asset\.id[\s\S]{0,160}scheduleLogoAssetCleanup\(previous\.assetId\)/,
    );
    assert.match(
      hookSource,
      /removeFromProject[\s\S]{0,420}scheduleLogoAssetCleanup\(normalizedValue\.assetId\)/,
    );
  });

  await check("client mutations never include sensitive asset data in telemetry", () => {
    assert.doesNotMatch(
      hookSource,
      /trackEvent\([^)]*\{[\s\S]{0,240}\b(assetId|filename|imageUrl|storageKey|originalName)\b/,
    );
  });

  await check("logo export submission telemetry follows accepted durable job creation", () => {
    assertLogoExportTelemetryControlFlow(postPhaseEditorSource);
    const nonExitingMutation = postPhaseEditorSource.replace(
      'if (!result.ok) throw new Error(result.message ?? "ส่งออกไม่สำเร็จ");',
      "if (!result.ok) void result;",
    );
    assert.notEqual(nonExitingMutation, postPhaseEditorSource, "acceptance-guard mutation did not apply");
    assert.throws(
      () => assertLogoExportTelemetryControlFlow(nonExitingMutation),
      /must throw\/exit/,
    );
    const exportStart = postPhaseEditorSource.indexOf("async function exportVideo()");
    const exportEnd = postPhaseEditorSource.indexOf("\n  return {", exportStart);
    assert.ok(exportStart >= 0 && exportEnd > exportStart, "exportVideo source is missing");
    const exportSource = postPhaseEditorSource.slice(exportStart, exportEnd);
    const telemetryIndex = exportSource.indexOf('trackEvent("logo_overlay_export_submitted"');
    assert.ok(telemetryIndex >= 0, "submission telemetry is missing");
    assert.match(
      exportSource.slice(telemetryIndex),
      /properties:\s*buildLogoTelemetryProperties\(\{\s*surface,\s*position:\s*submittedLogo\.position,?\s*\}\)/,
      "submission telemetry payload must contain only surface and position",
    );
    assert.doesNotMatch(
      exportSource.slice(telemetryIndex, telemetryIndex + 320),
      /\b(assetId|filename|src|url|storageKey|originalName)\b/,
      "submission telemetry must not include asset identity",
    );
  });

  const previewSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/LogoOverlayPreview.tsx",
    "utf8",
  );
  await check("live preview shares geometry and cannot intercept editor input", () => {
    assert.match(previewSource, /ResizeObserver/);
    assert.match(previewSource, /logoOverlayFrame/);
    assert.match(previewSource, /asset\.imageUrl/);
    assert.match(previewSource, /pointerEvents:\s*["']none["']/);
    assert.match(previewSource, /objectFit:\s*["']contain["']/);
  });

  const desktopSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx",
    "utf8",
  );
  await check("AST logo branch contract rejects proximity-only false positives", () => {
    const brokenFixture = `
      function BrokenLogoBranch() {
        return (
          <aside>
            {rightTab === "logo" && <div role="tabpanel" />}
            <LogoOverlayControls value={logoOverlay} eligible={logoEligible} editor={ed.logo} />
          </aside>
        );
      }
    `;
    assert.match(brokenFixture, /rightTab\s*===\s*["']logo["'][\s\S]{0,240}<LogoOverlayControls/);
    assert.throws(
      () => assertLogoControlsBranchStructure(brokenFixture),
      /inside the rightTab === "logo" branch/,
    );
    assertLogoControlsBranchStructure(desktopSource);
  });

  await check("AST preview contract rejects nested-layer proximity false positives", () => {
    const brokenFixture = `
      function BrokenPreviewFrame() {
        return (
          <div data-video-preview-frame="true">
            <video ref={ed.videoRef} />
            <div><LogoOverlayPreview value={logoOverlay} asset={ed.logo.asset} /></div>
            <V2CaptionOverlay />
          </div>
        );
      }
    `;
    const videoIndex = brokenFixture.indexOf("ref={ed.videoRef}");
    const logoIndex = brokenFixture.indexOf("<LogoOverlayPreview", videoIndex);
    const captionsIndex = brokenFixture.indexOf("<V2CaptionOverlay", videoIndex);
    assert.ok(videoIndex >= 0 && logoIndex > videoIndex && captionsIndex > logoIndex);
    assert.throws(
      () => assertPreviewSiblingStructure(brokenFixture),
      /LogoOverlayPreview must be a direct sibling/,
    );
    assertPreviewSiblingStructure(desktopSource);
  });
  await check("desktop exposes subtitle and logo branches with project wiring", () => {
    assert.match(desktopSource, /useState<\s*["']subtitle["']\s*\|\s*["']logo["']\s*>\(\s*["']subtitle["']\s*\)/);
    assert.match(desktopSource, /value:\s*["']subtitle["']\s*,\s*label:\s*["']ซับ["']/);
    assert.match(desktopSource, /value:\s*["']logo["']\s*,\s*label:\s*["']โลโก้["']/);
    assertPostPhaseEditorForwardingStructure(desktopSource);
  });

  const shellSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx",
    "utf8",
  );
  await check("editor shell supplies the project logo contract to desktop", () => {
    assert.match(shellSource, /projectId:\s*p\.projectId/);
    assert.match(shellSource, /logoOverlay:\s*p\.logoOverlay/);
    assert.match(shellSource, /onLogoOverlayChange:\s*p\.setLogoOverlay/);
    assert.match(shellSource, /logoEligible:\s*p\.canUseLogoOverlay/);
    assert.match(shellSource, /projectSaveStatus:\s*p\.saveStatus/);
    assert.match(shellSource, /onRetryProjectSave:\s*p\.retryProjectSave/);
    assert.match(shellSource, /<PostPhase\s+\{\.\.\.postPhaseProjectProps\}/);
  });

  await check("desktop mounts each control tree inside its matching tab panel", () => {
    assertLogoControlsBranchStructure(desktopSource);
  });

  await check("desktop records the first logo-tab transition once per mount", () => {
    assert.match(desktopSource, /logoPanelOpenedRef\s*=\s*useRef\(false\)/);
    assert.match(
      desktopSource,
      /if\s*\(\s*next\s*===\s*["']logo["']\s*&&\s*!logoPanelOpenedRef\.current\s*\)[\s\S]{0,180}logoPanelOpenedRef\.current\s*=\s*true[\s\S]{0,180}logo_overlay_panel_opened[\s\S]{0,180}surface:\s*["']desktop["']/,
    );
  });

  await check("desktop logo preview shares video bounds below captions and ignores input", () => {
    assertPreviewSiblingStructure(desktopSource);
    assert.match(previewSource, /position:\s*["']absolute["'][\s\S]{0,100}inset:\s*0/);
    assert.match(previewSource, /pointerEvents:\s*["']none["']/);
  });

  const mobileSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx",
    "utf8",
  );
  await check("mobile exposes equal subtitle and logo actions with a non-color enabled indicator", () => {
    assertMobileActionStructure(mobileSource);
    assert.match(
      mobileSource,
      /mobileEditorActionStyle[\s\S]{0,180}minHeight:\s*44[\s\S]{0,180}flex:\s*1/,
    );
  });

  await check("mobile logo controls use the reusable medium sheet", () => {
    assertMobileLogoSheetStructure(mobileSource);
  });

  await check("mobile logo preview is layered before captions", () => {
    assertMobilePreviewSiblingStructure(mobileSource);
  });

  await check("mobile forwards the project logo contract with the mobile surface", () => {
    assertMobilePostPhaseEditorForwardingStructure(mobileSource);
  });

  await check("mobile pauses preview, emits once-per-open telemetry, and reuses MobileSheet", () => {
    assertMobileLogoRuntimeStructure(mobileSource);

    const playbackMutation = mobileSource.replace(
      "ed.videoRef.current?.pause();",
      "ed.videoRef.current?.play();",
    );
    assert.notEqual(playbackMutation, mobileSource, "pause mutation did not apply");
    assert.throws(
      () => assertMobileLogoRuntimeStructure(playbackMutation),
      /pause preview playback/,
    );

    const telemetryMutation = mobileSource.replace("}, [logoOpen]);", "}, []);");
    assert.notEqual(telemetryMutation, mobileSource, "telemetry mutation did not apply");
    assert.throws(
      () => assertMobileLogoRuntimeStructure(telemetryMutation),
      /closed-to-open transition/,
    );
  });

  const breakpointSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useIsMobile.ts",
    "utf8",
  );
  await check("responsive shell switches exactly below the 1024px desktop boundary", () => {
    assertExactResponsiveBranchStructure(breakpointSource, shellSource);

    const breakpointMutation = breakpointSource.replace("1023px", "1024px");
    assert.notEqual(breakpointMutation, breakpointSource, "breakpoint mutation did not apply");
    assert.throws(
      () => assertExactResponsiveBranchStructure(breakpointMutation, shellSource),
      /1023px/,
    );

    const branchMutation = shellSource.replace("isMobile ? (", "!isMobile ? (");
    assert.notEqual(branchMutation, shellSource, "responsive branch mutation did not apply");
    assert.throws(
      () => assertExactResponsiveBranchStructure(breakpointSource, branchMutation),
      /select mobile below 1024/,
    );
  });

  const controlsSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/LogoOverlayControls.tsx",
    "utf8",
  );
  await check("hidden logo picker is not a duplicate invisible tab stop", () => {
    const pickerStart = controlsSource.indexOf('className="logo-controls__file"');
    const pickerEnd = controlsSource.indexOf("/>", pickerStart);
    assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, "hidden logo picker is missing");
    const pickerSource = controlsSource.slice(pickerStart, pickerEnd);
    assert.match(pickerSource, /tabIndex=\{-1\}/);
    assert.match(pickerSource, /aria-label=["']เลือกไฟล์โลโก้["']/);
    assert.match(controlsSource, /fileInputRef\.current\?\.click\(\)/);
    assert.match(controlsSource, /className=["']logo-controls__upload["'][\s\S]{0,140}onClick=\{chooseFile\}/);
    assert.match(controlsSource, /className=["']logo-controls__text-action["'][\s\S]{0,140}onClick=\{chooseFile\}/);
  });

  await check("desktop shared controls preserve accessible anchor order", () => {
    assert.match(controlsSource, /LOGO_POSITIONS\.map/);
    assert.match(controlsSource, /aria-label=\{`วางโลโก้\$\{POSITION_LABELS\[position\]\}`\}/);
    assert.match(controlsSource, /aria-pressed=\{selected\}/);
    const switchIndex = controlsSource.indexOf("<LogoSwitch");
    const replaceIndex = controlsSource.indexOf("logo-controls__text-action", switchIndex);
    const removeIndex = controlsSource.indexOf("logo-controls__remove-action", replaceIndex);
    const positionsIndex = controlsSource.indexOf("LOGO_POSITIONS.map", removeIndex);
    const sizeIndex = controlsSource.indexOf("ขนาดโลโก้", positionsIndex);
    const opacityIndex = controlsSource.indexOf("ความทึบของโลโก้", sizeIndex);
    const defaultIndex = controlsSource.indexOf("logo-controls__default-choice", opacityIndex);
    assert.ok(
      switchIndex < replaceIndex
      && replaceIndex < removeIndex
      && removeIndex < positionsIndex
      && positionsIndex < sizeIndex
      && sizeIndex < opacityIndex
      && opacityIndex < defaultIndex,
      "configured logo controls are not in the required keyboard reading order",
    );
  });

  const uiSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/ui.tsx",
    "utf8",
  );
  await check("AST panel ID contract rejects an independent mismatch", () => {
    const brokenFixture = `
      function BrokenTabs() {
        const rightTabsId = useId();
        return (
          <aside>
            <Segmented
              id={rightTabsId}
              semantics="tabs"
              ariaLabel="ตั้งค่าองค์ประกอบวิดีโอ"
              value={rightTab}
              onChange={setRightTab}
              options={[{ value: "subtitle", label: "ซับ" }, { value: "logo", label: "โลโก้" }]}
            />
            {rightTab === "subtitle" && (
              <div id="wrong-panel" role="tabpanel" aria-labelledby={\`\${rightTabsId}-subtitle-tab\`} />
            )}
            {rightTab === "logo" && (
              <div id={\`\${rightTabsId}-logo-panel\`} role="tabpanel" aria-labelledby={\`\${rightTabsId}-logo-tab\`} />
            )}
          </aside>
        );
      }
    `;
    assert.match(brokenFixture, /semantics=["']tabs["']/);
    assert.match(brokenFixture, /id=\{rightTabsId\}/);
    assert.throws(
      () => assertDesktopTabLinkageStructure(brokenFixture, uiSource),
      /subtitle tabpanel ID must match/,
    );
    assertDesktopTabLinkageStructure(desktopSource, uiSource);
  });

  await check("AST panel label contract rejects an independent aria-labelledby mismatch", () => {
    const brokenFixture = `
      function BrokenTabs() {
        const rightTabsId = useId();
        return (
          <aside>
            <Segmented
              id={rightTabsId}
              semantics="tabs"
              ariaLabel="ตั้งค่าองค์ประกอบวิดีโอ"
              value={rightTab}
              onChange={setRightTab}
              options={[{ value: "subtitle", label: "ซับ" }, { value: "logo", label: "โลโก้" }]}
            />
            {rightTab === "subtitle" && (
              <div id={\`\${rightTabsId}-subtitle-panel\`} role="tabpanel" aria-labelledby="wrong-tab" />
            )}
            {rightTab === "logo" && (
              <div id={\`\${rightTabsId}-logo-panel\`} role="tabpanel" aria-labelledby={\`\${rightTabsId}-logo-tab\`} />
            )}
          </aside>
        );
      }
    `;
    assert.throws(
      () => assertDesktopTabLinkageStructure(brokenFixture, uiSource),
      /subtitle tabpanel aria-labelledby must match/,
    );
  });

  await check("AST Segmented tab ID rejects a non-strict semantics gate", () => {
    const brokenUiSource = uiSource.replace(
      'id={semantics === "tabs" && id ?',
      'id={semantics !== "tabs" && id ?',
    );
    assert.notEqual(brokenUiSource, uiSource, "tab ID mutation did not apply");
    assert.throws(
      () => assertDesktopTabLinkageStructure(desktopSource, brokenUiSource),
      /Segmented tab IDs must be derived/,
    );
  });

  await check("AST Segmented aria-controls rejects a disjunctive gate", () => {
    const brokenUiSource = uiSource.replace(
      'aria-controls={semantics === "tabs" && id ?',
      'aria-controls={semantics === "tabs" || id ?',
    );
    assert.notEqual(brokenUiSource, uiSource, "aria-controls mutation did not apply");
    assert.throws(
      () => assertDesktopTabLinkageStructure(desktopSource, brokenUiSource),
      /Segmented aria-controls must be derived/,
    );
  });

  await check("desktop segmented control opts into complete tab semantics", () => {
    assertDesktopTabLinkageStructure(desktopSource, uiSource);
    assert.match(uiSource, /ArrowLeft/);
    assert.match(uiSource, /ArrowRight/);
  });

  await check("desktop export remains visually first but follows the editor in DOM order", () => {
    assertDesktopExportFocusStructure(desktopSource);
  });

  if (failures.length > 0) {
    throw new Error(`logo client verifier failed (${failures.length}):\n${failures.join("\n")}`);
  }
  console.log("logo-client-contract: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

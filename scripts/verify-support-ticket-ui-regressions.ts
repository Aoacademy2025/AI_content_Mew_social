import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const hookStepPath = "src/app/(dashboard)/hero-script/_components/HookStep.tsx";
const hookStepSource = readFileSync(hookStepPath, "utf8");

const hookCardsStart = hookStepSource.indexOf("{hooks.map((hook, i) => {");
const hookCardsEnd = hookStepSource.indexOf("        </div>\n      )}", hookCardsStart);
assert.ok(hookCardsStart >= 0 && hookCardsEnd > hookCardsStart, "Hook card list exists");
const hookCardsSource = hookStepSource.slice(hookCardsStart, hookCardsEnd);

assert.match(
  hookCardsSource,
  /<button\s+key=\{i\}[\s\S]*?onClick=\{\(\) => selectHook\(i, hook\)\}/,
  "the whole unselected Hook card is the selection button",
);
assert.equal(
  hookCardsSource.match(/onClick=\{\(\) => selectHook\(i, hook\)\}/g)?.length,
  1,
  "Hook selection has one full-card click target rather than a second nested text target",
);

const stepTwoPath = "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx";
const stepTwoSource = readFileSync(stepTwoPath, "utf8");
const stepTwoRoot = ts.createSourceFile(
  stepTwoPath,
  stepTwoSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
assert.equal(stepTwoRoot.parseDiagnostics.length, 0, "Step 2 source parses as TSX");

const invalidSegmentedLabels: string[] = [];
const visit = (node: ts.Node): void => {
  if (
    ts.isJsxElement(node)
    && node.openingElement.tagName.getText(stepTwoRoot) === "label"
  ) {
    let containsSegmented = false;
    const inspect = (child: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child))
        && child.tagName.getText(stepTwoRoot) === "Segmented"
      ) containsSegmented = true;
      ts.forEachChild(child, inspect);
    };
    node.children.forEach(inspect);
    if (containsSegmented) {
      const { line } = stepTwoRoot.getLineAndCharacterOfPosition(node.getStart(stepTwoRoot));
      invalidSegmentedLabels.push(`${stepTwoPath}:${line + 1}`);
    }
  }
  ts.forEachChild(node, visit);
};
visit(stepTwoRoot);

assert.deepEqual(
  invalidSegmentedLabels,
  [],
  `Segmented button groups must not be wrapped by <label>; clicking blank label space activates the first button (${invalidSegmentedLabels.join(", ")})`,
);

const brandVisualPath = "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx";
const brandVisualSource = readFileSync(brandVisualPath, "utf8");
const brandProfileSelectValue = brandVisualSource.indexOf(
  'value={pendingBrandProfileId ?? selectedBrandProfile?.profileId ?? ""}',
);
const brandProfileSelectStart = brandVisualSource.lastIndexOf("<select", brandProfileSelectValue);
const brandProfileSelectEnd = brandVisualSource.indexOf("</select>", brandProfileSelectStart);
assert.ok(
  brandProfileSelectValue >= 0
    && brandProfileSelectStart >= 0
    && brandProfileSelectEnd > brandProfileSelectStart,
  "Brand profile selector exists",
);
const brandProfileSelect = brandVisualSource.slice(brandProfileSelectStart, brandProfileSelectEnd);
assert.match(
  brandProfileSelect,
  /value=\{pendingBrandProfileId \?\? selectedBrandProfile\?\.profileId \?\? ""\}/,
  "a Brand awaiting image-change confirmation remains selected instead of reverting to the project look",
);

const inlineProfileConfirmation = brandVisualSource.indexOf('{pending?.kind === "profile" &&');
const expandedVisualControls = brandVisualSource.indexOf("{visualSelectionEnabled && expanded &&");
assert.ok(
  inlineProfileConfirmation > brandProfileSelectEnd
    && expandedVisualControls > inlineProfileConfirmation,
  "Brand image-change confirmation is shown immediately after the Brand selector",
);

assert.match(
  stepTwoSource,
  /const brandRenderBlocked = brandSelectionBlocked;/,
  "only an in-flight or unconfirmed Brand selection blocks render acceptance",
);
assert.match(
  stepTwoSource,
  /onSelectionBlockedChange=\{setBrandSelectionBlocked\}/,
  "Step 2 receives pending and in-flight Brand selection state",
);
assert.match(
  brandVisualSource,
  /trackEvent\("brand_profile_snapshot_recovery"[\s\S]*?window\.location\.reload\(\);/,
  "a rejected authoritative Brand snapshot reloads the already-flushed server project",
);
assert.doesNotMatch(
  brandVisualSource.slice(
    brandVisualSource.indexOf("async function pinProfile"),
    brandVisualSource.indexOf("if (!canRenderPersistedVisual)"),
  ),
  /const defaults = result\.body\.revisionDefaults/,
  "Brand snapshot recovery cannot replay defaults through public autosave setters",
);

console.log(
  "verify-support-ticket-ui-regressions: PASS full-card Hook selection, inert Step 2 blank space, and Brand confirmation render gate",
);

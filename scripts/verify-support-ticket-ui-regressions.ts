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

console.log("verify-support-ticket-ui-regressions: PASS full-card Hook selection and inert Step 2 blank space");

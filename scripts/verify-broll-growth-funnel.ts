import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  brollExportCompletionProperties,
  summarizeBrollGrowthEdits,
} from "../src/lib/broll-growth-funnel";

const summary = summarizeBrollGrowthEdits([
  { index: 0, start: 0, end: 4.5 },
  { index: 1, src: "/api/stocks/forest.mp4", replacementKind: "stock", enabled: true },
  { index: 2, src: "/api/renders/upload.mp4", replacementKind: "upload" },
  { index: 3, src: "/api/renders/ai.mp4", replacementKind: "ai", imageJobId: "private-ai-job" },
  { index: 4, enabled: false },
]);

assert.deepEqual(summary, {
  editCount: 5,
  replacementCount: 3,
  boundaryChangeCount: 1,
  visibilityChangeCount: 2,
  stockReplacementCount: 1,
  uploadReplacementCount: 1,
  aiReplacementCount: 1,
});
assert.equal("src" in summary, false, "funnel summary never exposes an asset path");
assert.equal("imageJobId" in summary, false, "funnel summary never exposes an image job id");

assert.equal(
  brollExportCompletionProperties({ type: "create", inputJson: null }),
  null,
  "an untouched preview export is outside the B-roll edit funnel",
);

assert.deepEqual(
  brollExportCompletionProperties({
    type: "broll-rerender",
    inputJson: JSON.stringify({
      mode: "broll-rerender",
      sourceJobId: "private-source-job",
      windowEdits: [
        { index: 0, enabled: false },
        { index: 1, src: "/api/renders/private.mp4", replacementKind: "upload", keyword: "private keyword" },
      ],
    }),
  }),
  {
    editCount: 2,
    replacementCount: 1,
    boundaryChangeCount: 0,
    visibilityChangeCount: 1,
    stockReplacementCount: 0,
    uploadReplacementCount: 1,
    aiReplacementCount: 0,
  },
  "a completed export exposes only aggregate B-roll edit facts",
);

assert.deepEqual(
  brollExportCompletionProperties({ type: "broll-rerender", inputJson: "not-json" }),
  {
    editCount: 0,
    replacementCount: 0,
    boundaryChangeCount: 0,
    visibilityChangeCount: 0,
    stockReplacementCount: 0,
    uploadReplacementCount: 0,
    aiReplacementCount: 0,
  },
  "malformed historical input cannot break export completion telemetry",
);

const editorSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
  "utf8",
);
for (const eventName of [
  "editor_broll_edit_viewed",
  "editor_broll_edit_staged",
  "editor_broll_edit_applied",
  "editor_broll_export_submitted",
]) {
  assert.match(editorSource, new RegExp(`trackEvent\\(\\"${eventName}\\"`), `${eventName} is wired to the editor seam`);
}
assert.match(editorSource, /summarizeBrollGrowthEdits/, "client funnel events reuse the aggregate-only builder");
assert.doesNotMatch(
  editorSource,
  /editor_broll_(?:edit_(?:viewed|staged|applied)|export_submitted)[\s\S]{0,320}\b(?:src|keyword|imageJobId|projectId)\s*:/,
  "B-roll growth events never include creator asset or project identity",
);

const workerSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
const transitionIndex = workerSource.indexOf("const completion = await finishJobWithTransition");
const completionEventIndex = workerSource.indexOf('name: "editor_broll_export_completed"');
assert.ok(transitionIndex >= 0 && completionEventIndex > transitionIndex, "worker emits only after durable export finalization");
assert.match(
  workerSource.slice(transitionIndex, completionEventIndex),
  /completion\.transitioned[\s\S]*completion\.job\.status === "done"/,
  "only the processing-to-done winner emits B-roll completion",
);
assert.match(workerSource, /brollExportCompletionProperties\(src\)/, "worker derives aggregate facts from the applied source job");

console.log("verify-broll-growth-funnel: PASS privacy-safe funnel contract");

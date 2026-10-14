import { refreshPendingWindowMedia } from "../src/app/(dashboard)/video-editor/_v2/pending-edit-view";
import assert from "node:assert/strict";
import { buildPlaceholderBgVideos } from "../src/lib/broll-placeholders";
import { planCutaway } from "../src/lib/cutaway-plan";
import { mergeWindowEdits, validateWindowEdits } from "../src/lib/broll-rerender";
import { authorExternalMediaPlan, externalWindowStates, previewWindowOwner } from "../src/lib/external-media";
const windows = Array.from({ length: 4 }, (_, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000 }));
const script = authorExternalMediaPlan({ bgVideos: buildPlaceholderBgVideos(windows, 16) });
assert.equal(script.externalMedia.source, "external");
assert.deepEqual(externalWindowStates(script, script).map(w => w.state), ["unfilled", "unfilled", "unfilled", "unfilled"]);
assert.equal(previewWindowOwner({ config: script, avatarModel: "none" }, 0), "broll", "faceless empty first slot is editable B-roll");
const presenter = authorExternalMediaPlan({ bgVideos: windows.map(w => ({ src: "/api/renders/presenter.mp4", start: w.startMs / 1000, end: w.endMs / 1000 })) }, planCutaway(windows).person);
assert.deepEqual(externalWindowStates(presenter, presenter).map(w => w.state), ["presenter", "unfilled", "presenter", "unfilled"], "temporary presenter backing never fulfills required cutaways");
const filled = mergeWindowEdits(script.bgVideos as unknown[], [{ index: 0, src: "/api/stocks/owned.mp4", enabled: true }]);
assert.ok(!("error" in filled));
assert.equal(externalWindowStates(script, { bgVideos: filled.bgVideos })[0].state, "ready");
assert.equal(externalWindowStates(script, { externalMedia: { slots: [] }, bgVideos: [] })[0].state, "unfilled", "mutable config cannot waive root requirements");
const optional = authorExternalMediaPlan(presenter, planCutaway(windows, { fillYourself: true }).person);
assert.ok(externalWindowStates(optional, optional).every(w => w.state === "presenter"));
assert.deepEqual(externalWindowStates({ bgVideos: buildPlaceholderBgVideos(windows, 16) }, script), [], "historical optional placeholders keep old behavior");
console.log("PASS external required policy: script, presenter, reset/hostile flags, historical optional");

const old = new Map([[1, { src: "old" }]]);
const incoming = new Map([[1, { src: "ready" }], [2, { src: "newly-ready" }]]);
assert.deepEqual([...refreshPendingWindowMedia(new Map([[1, { src: "local" }]]), old, incoming)], [[1, { src: "local" }], [2, { src: "newly-ready" }]], "readiness refresh preserves local edit races");
assert.deepEqual([...refreshPendingWindowMedia(old, old, incoming)], [...incoming], "untouched projection updates without a revision bump");
assert.deepEqual([...refreshPendingWindowMedia(new Map(), old, incoming)], [[2, { src: "newly-ready" }]], "locally cleared server edit stays cleared");
console.log("PASS web media refresh preserves local replacements and clears");

const longExternal = Array.from({ length: 120 }, (_, index) => ({ index, src: "/api/stocks/owned.mp4", enabled: true }));
assert.ok(!("error" in validateWindowEdits(longExternal)), "ten-minute external windows can all be staged before the mandatory final export");
console.log("PASS long external required plan fits shared edit batch");

// Exercise the real shared window planner at the largest public plan duration.
import { buildBrollWindows, capFillYourselfBrollWindows } from "../src/lib/broll-windows";
import { MAX_BROLL_WINDOW_EDITS } from "../src/lib/broll-rerender";
const captions = Array.from({ length: 1200 }, (_, i) => ({ startMs: i * 500, endMs: (i + 1) * 500, text: "word" }));
for (const [cadence, multiplier] of [[4, 1], [4, 0.7], [0.5, undefined]] as const) {
  const planned = capFillYourselfBrollWindows(buildBrollWindows(captions, cadence, 600_000, multiplier ? { cadenceMultiplier: multiplier } : undefined), captions);
  assert.ok(planned.length <= MAX_BROLL_WINDOW_EDITS);
  assert.ok(!("error" in validateWindowEdits(planned.map((_, index) => ({ index, src: "/api/stocks/owned.mp4" })))));
}
const longCaption = [{ startMs: 0, endMs: 600_000, text: "long" }];
assert.equal(capFillYourselfBrollWindows(buildBrollWindows(longCaption, 4, 600_000), longCaption).length, 120);
assert.ok("error" in validateWindowEdits(Array.from({ length: MAX_BROLL_WINDOW_EDITS + 1 }, (_, index) => ({ index, src: "/api/stocks/owned.mp4" }))));
console.log("PASS maximum public duration at normal/fast/minimum cadence and oversized-caption splitting fits bounded edits");

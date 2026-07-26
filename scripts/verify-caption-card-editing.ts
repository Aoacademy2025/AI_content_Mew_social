// Run: npx tsx scripts/verify-caption-card-editing.ts
// Contract for insert/delete + complete caption Undo/Redo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  commitCaptionHistory,
  deleteCaptionCard,
  insertCaptionCardAtPlayhead,
  redoCaptionHistory,
  shiftCaptionOverrides,
  undoCaptionHistory,
} from "../src/lib/caption-card-editing";

const captions = [
  { text: "หนึ่ง", startMs: 0, endMs: 1200, tag: "hook" },
  { text: "สอง", startMs: 1200, endMs: 2400, tag: "body" },
  { text: "สาม", startMs: 3000, endMs: 4000, tag: "cta" },
];

function assertNoOverlap(items: typeof captions) {
  items.forEach((caption, index) => {
    assert.ok(caption.endMs > caption.startMs, `caption ${index} must have positive duration`);
    if (index > 0) {
      assert.ok(items[index - 1].endMs <= caption.startMs, `caption ${index} must not overlap`);
    }
  });
}

const split = insertCaptionCardAtPlayhead(captions, 600, 4000);
assert.equal(split.ok, true, "playhead inside a card inserts by splitting that card");
if (split.ok) {
  assert.equal(split.index, 1);
  assert.deepEqual(split.captions[0], { ...captions[0], endMs: 600 });
  assert.deepEqual(split.captions[1], {
    text: "",
    startMs: 600,
    endMs: 1200,
    tag: "body",
  });
  assert.deepEqual(split.captions.slice(2), captions.slice(1), "later cards keep exact timing");
  assertNoOverlap(split.captions);
}

const gap = insertCaptionCardAtPlayhead(captions, 2600, 4000);
assert.equal(gap.ok, true, "a real gap accepts a new card");
if (gap.ok) {
  assert.deepEqual(gap.captions[gap.index], {
    text: "",
    startMs: 2600,
    endMs: 3000,
    tag: "body",
  });
  assert.deepEqual(gap.captions[3], captions[2], "inserting in a gap never shifts the following card");
  assertNoOverlap(gap.captions);
}

const noRoom = insertCaptionCardAtPlayhead(captions, 100, 4000);
assert.deepEqual(noRoom, { ok: false, reason: "no_room" }, "short split space is rejected safely");

const deleted = deleteCaptionCard(captions, 1);
assert.equal(deleted.ok, true);
if (deleted.ok) {
  assert.deepEqual(deleted.captions, [captions[0], captions[2]], "delete leaves every other timestamp untouched");
  assert.equal(deleted.selected, 1, "selection moves to the next surviving card");
}
assert.deepEqual(
  deleteCaptionCard([captions[0]], 0),
  { ok: false, reason: "last_caption" },
  "the last caption cannot be deleted because export requires a caption",
);

const overrides = { 0: { textColor: "#fff" }, 1: { textColor: "#ff0" }, 2: { accentColor: "#0f0" } };
assert.deepEqual(
  shiftCaptionOverrides(overrides, { from: 1, delta: 1 }),
  { 0: overrides[0], 2: overrides[1], 3: overrides[2] },
  "insert shifts style overrides with their cards",
);
assert.deepEqual(
  shiftCaptionOverrides(overrides, { from: 2, delta: -1, dropIndex: 1 }),
  { 0: overrides[0], 1: overrides[2] },
  "delete drops only its override and shifts later overrides",
);

type Snapshot = { label: string };
let history = { past: [], future: [] } as {
  past: Array<{ id: number; before: Snapshot; after: Snapshot }>;
  future: Array<{ id: number; before: Snapshot; after: Snapshot }>;
};
history = commitCaptionHistory(history, { id: 1, before: { label: "A" }, after: { label: "B" } });
history = commitCaptionHistory(history, { id: 2, before: { label: "B" }, after: { label: "C" } });
const staleUndo = undoCaptionHistory(history, 1);
assert.equal(staleUndo.snapshot, null, "a stale toast cannot undo a newer edit");
assert.equal(staleUndo.history, history);
const undone = undoCaptionHistory(history);
assert.equal(undone.snapshot?.label, "B");
assert.equal(undone.history.past.length, 1);
assert.equal(undone.history.future.length, 1);
const redone = redoCaptionHistory(undone.history);
assert.equal(redone.snapshot?.label, "C");
assert.equal(redone.history.past.length, 2);
assert.equal(redone.history.future.length, 0);
const divergent = commitCaptionHistory(undone.history, {
  id: 3,
  before: { label: "B" },
  after: { label: "D" },
});
assert.equal(divergent.future.length, 0, "a new edit after Undo clears the Redo branch");

const root = process.cwd();
const editorHook = readFileSync(
  path.join(root, "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts"),
  "utf8",
);
const desktop = readFileSync(
  path.join(root, "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx"),
  "utf8",
);
const mobile = readFileSync(
  path.join(root, "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx"),
  "utf8",
);
const timeline = readFileSync(
  path.join(root, "src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx"),
  "utf8",
);

assert.match(editorHook, /insertCaptionAtPlayhead/, "editor hook exposes playhead insertion");
assert.match(editorHook, /deleteSelectedCaption/, "editor hook exposes selected-card deletion");
assert.match(editorHook, /redoCaptions/, "editor hook exposes Redo");
assert.match(editorHook, /e\.shiftKey|key\.toLowerCase\(\) === "y"/, "keyboard supports standard Redo shortcuts");
assert.match(desktop, /data-caption-action="add"/, "desktop exposes Add caption");
assert.match(desktop, /data-caption-action="delete"/, "desktop exposes Delete caption");
assert.match(mobile, /data-caption-action="add"/, "mobile exposes Add caption");
assert.match(mobile, /data-caption-action="delete"/, "mobile exposes Delete caption");
assert.match(timeline, /onRedo/, "Timeline exposes Redo beside Undo");

console.log("caption-card-editing: all checks passed");

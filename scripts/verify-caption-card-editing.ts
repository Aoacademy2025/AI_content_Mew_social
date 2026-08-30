// Run: npx tsx scripts/verify-caption-card-editing.ts
// Contract for insert/delete + complete caption Undo/Redo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  captionExportPreflight,
  commitCaptionHistory,
  deleteCaptionCard,
  insertCaptionCardAtPlayhead,
  redoCaptionHistory,
  shiftCaptionOverrides,
  undoCaptionHistory,
} from "../src/lib/caption-card-editing";
import { compareSubtitleContentToNarration } from "../src/lib/subtitle-content-contract";

const captions = [
  { text: "หนึ่ง", startMs: 0, endMs: 1200, tag: "hook" },
  { text: "สอง", startMs: 1200, endMs: 2400, tag: "body" },
  { text: "สาม", startMs: 3000, endMs: 4000, tag: "cta" },
];

assert.deepEqual(
  compareSubtitleContentToNarration(
    "จริงไหม? ราคา 5,000 บาท!",
    [{ text: "จริงไหม ราคา 5,000 บาท" }],
  ),
  { status: "equivalent", presentationChanged: true },
  "ordinary punctuation edits preserve the spoken Narration Master content",
);
assert.deepEqual(
  compareSubtitleContentToNarration(
    "ยอด 1.05 บาท",
    [{ text: "ยอด 105 บาท" }],
  ),
  { status: "content_mismatch", captionIndex: 0 },
  "numeric punctuation that changes a spoken claim remains blocked",
);
assert.deepEqual(
  compareSubtitleContentToNarration(
    "รายได้ 5,000 บาท",
    [{ text: "รายได้ห้าพันบาท" }],
  ),
  { status: "content_mismatch", captionIndex: 0 },
  "changing authored digits into different letters remains fail-closed even when pronounced alike",
);
assert.deepEqual(
  compareSubtitleContentToNarration(
    "ประโยคแรก ประโยคที่สอง",
    [{ text: "ประโยคแรก " }, { text: "เปลี่ยนคำที่สอง" }],
  ),
  { status: "content_mismatch", captionIndex: 1 },
  "content mismatches identify the first affected caption",
);

assert.deepEqual(
  captionExportPreflight(captions, true),
  { ok: true },
  "non-empty captions are ready to export",
);
assert.deepEqual(
  captionExportPreflight(
    [{ text: "จริงไหม ราคา 5,000 บาท", startMs: 0, endMs: 2_000 }],
    true,
    "จริงไหม? ราคา 5,000 บาท!",
  ),
  { ok: true },
  "presentation-only punctuation edits pass the client export preflight",
);
assert.deepEqual(
  captionExportPreflight(
    [
      { text: "ประโยคแรก\n", startMs: 0, endMs: 1_000 },
      { text: "ประโยคที่สอง", startMs: 1_000, endMs: 2_000 },
    ],
    true,
    "ประโยคแรก ประโยคที่สอง",
  ),
  { ok: true },
  "whitespace, line breaks, and caption boundaries remain presentation-only",
);
assert.deepEqual(
  captionExportPreflight(
    [{ text: "ยอด 105 บาท", startMs: 0, endMs: 2_000 }],
    true,
    "ยอด 1.05 บาท",
  ),
  { ok: false, reason: "spoken_content_changed", index: 0 },
  "a changed spoken claim is stopped before an export job is created",
);
assert.deepEqual(
  captionExportPreflight([
    captions[0],
    { text: "   ", startMs: 1200, endMs: 1800, tag: "body" },
    captions[2],
  ], true),
  { ok: false, reason: "blank_caption", index: 1 },
  "visible subtitles fail preflight at the first whitespace-only card",
);
assert.deepEqual(
  captionExportPreflight([
    { text: "", startMs: 0, endMs: 1200, tag: "body" },
  ], false, "เสียงบรรยายคนละข้อความ"),
  { ok: true },
  "a deliberately hidden subtitle layer bypasses visible-caption content checks",
);

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

// ── H4 regression proof: what a bare `expectedEntryId` misuse looks like ───────────────
// `undoCaptionHistory`'s contract is `expectedEntryId === entry.id` (strict equality). If a
// caller passes something that was never meant to be an id — e.g. the React SyntheticEvent
// React hands `onClick={ed.undoCaptions}` as its first argument — the pure function has no
// way to know that and correctly (from its own contract's point of view) treats it as "stale,
// don't undo". This is exactly the H4 bug: it must never reach this function un-normalized.
// The actual fix lives in usePostPhaseEditor.undoCaptions (normalize non-number -> undefined
// BEFORE calling this lib function), which this script cannot invoke directly (it needs
// React) — verified instead via source-regex below, alongside every call-site wrap.
const eventLikeArg = { type: "click", target: null } as unknown as number;
const blockedByUnnormalizedArg = undoCaptionHistory(history, eventLikeArg);
assert.equal(
  blockedByUnnormalizedArg.snapshot,
  null,
  "documents why the caller MUST normalize a non-number expectedEntryId to undefined before calling undoCaptionHistory",
);

// ── (ข) Undo -> Redo -> Undo roundtrip on REAL caption data (not just string labels) ───
// Regression shape: "รวมการ์ด (หรือแทรก) -> Ctrl+Z -> ต้องได้ข้อความ+เวลาเดิมทุกตัวอักษร",
// not just a snapshot count matching by coincidence.
type CaptionSnapshot = { captions: typeof captions };
let capHistory = { past: [], future: [] } as {
  past: Array<{ id: number; before: CaptionSnapshot; after: CaptionSnapshot }>;
  future: Array<{ id: number; before: CaptionSnapshot; after: CaptionSnapshot }>;
};
const afterInsert = insertCaptionCardAtPlayhead(captions, 2600, 4000);
assert.equal(afterInsert.ok, true, "setup: insert into the real gap from the test fixture above");
if (afterInsert.ok) {
  capHistory = commitCaptionHistory(capHistory, {
    id: 101,
    before: { captions },
    after: { captions: afterInsert.captions as typeof captions },
  });
  const afterDelete = deleteCaptionCard(afterInsert.captions, 0);
  assert.equal(afterDelete.ok, true, "setup: delete the first card of the post-insert list");
  if (afterDelete.ok) {
    capHistory = commitCaptionHistory(capHistory, {
      id: 102,
      before: { captions: afterInsert.captions as typeof captions },
      after: { captions: afterDelete.captions as typeof captions },
    });
  }

  // Undo #2 (the delete) -> back to the exact post-insert list.
  const undo1 = undoCaptionHistory(capHistory);
  assert.deepEqual(undo1.snapshot?.captions, afterInsert.captions, "undo restores exact caption text/timing after a delete, not just the count");
  capHistory = undo1.history;

  // Undo #1 (the insert) -> back to the exact original 3-caption list.
  const undo2 = undoCaptionHistory(capHistory);
  assert.deepEqual(undo2.snapshot?.captions, captions, "second undo restores the exact original caption list");
  capHistory = undo2.history;
  assert.equal(capHistory.past.length, 0, "both edits undone — history.past is empty");
  assert.equal(capHistory.future.length, 2, "both edits are now redoable");

  // Redo #1 (the insert) -> forward again, byte-for-byte.
  const redo1 = redoCaptionHistory(capHistory);
  assert.deepEqual(redo1.snapshot?.captions, afterInsert.captions, "redo replays the insert exactly");
  capHistory = redo1.history;

  // Undo immediately after that redo — the precise "toggle Undo/Redo repeatedly" shape a
  // Timeline button + keyboard shortcut can produce; must still land exactly on the original.
  const undo3 = undoCaptionHistory(capHistory);
  assert.deepEqual(undo3.snapshot?.captions, captions, "undo-after-redo still restores the exact original list");
}

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
const renderSubtitleSrc = readFileSync(
  path.join(root, "src/remotion/renderSubtitle.tsx"),
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
assert.match(
  editorHook,
  /const narrationMasterText = preview\?\.fullText\?\.trim\(\) \|\| script\.trim\(\);[\s\S]+captionExportPreflight\([\s\S]+narrationMasterText,[\s\S]+editCaptionFromTimeline\(captionPreflight\.index\)[\s\S]+spoken_content_changed[\s\S]+สร้างเสียงใหม่[\s\S]+return;/,
  "export preflight compares with the Narration Master, focuses a changed card, and explains how to recover",
);
const exportPreflightAt = editorHook.indexOf("const captionPreflight = captionExportPreflight");
const exportSubmissionAt = editorHook.indexOf("const result = await onExportJob");
assert.ok(exportPreflightAt >= 0, "editor hook contains the export preflight");
assert.ok(exportSubmissionAt >= 0, "editor hook contains the export submission");
assert.ok(exportPreflightAt < exportSubmissionAt, "blank-card preflight runs before onExportJob");

// Clicking a Timeline caption is a text-edit intent: pause playback, select the
// matching left-panel card, reveal its textarea, scroll it into view, and focus.
assert.match(
  desktop,
  /onEditCaption=\{ed\.editCaptionFromTimeline\}/,
  "desktop wires Timeline caption clicks to the editor action",
);
assert.match(
  editorHook,
  /function editCaptionFromTimeline[\s\S]+video\.pause\(\)[\s\S]+setSelected\(index\)[\s\S]+setEditingIdx\(index\)[\s\S]+scrollIntoView[\s\S]+querySelector<HTMLTextAreaElement>\("textarea"\)\?\.focus/,
  "Timeline caption edit pauses, selects, scrolls, opens, and focuses the matching card",
);
assert.match(
  timeline,
  /closest\("\[data-edge\]"\)[\s\S]+onEditCaption\(i\)/,
  "caption timing handles must not trigger text editing after a drag",
);

// Playback follow must be visually obvious on desktop without mutating `selected` (which owns
// edit scope). Mobile already gives the active card a full active surface; desktop previously
// showed only a 2.5px inset bar, which users reasonably read as "highlight does not follow play".
assert.match(
  desktop,
  /selected=\{i === ed\.selected \|\| i === ed\.activeIdx\}/,
  "desktop caption card gives the playing card the full selected surface",
);
assert.match(
  desktop,
  /i === ed\.selected \|\| i === ed\.activeIdx \? color\.primary300 : color\.textFaint/,
  "desktop playing-card timestamp follows the same active visual state",
);

// ── H4: onUndo/onRedo must be wrapped in an arrow at every call site — TimelinePanel's
// <button onClick={onUndo}> forwards the click SyntheticEvent as the first argument, so
// wiring `onUndo={ed.undoCaptions}` directly makes React hand that event to undoCaptions
// as `expectedEntryId`, which almost never matches history.past's real numeric id and so
// silently no-ops. Desktop's left-column Undo/Redo buttons already wrap correctly
// (`onClick={() => ed.undoCaptions()}`); this asserts the Timeline wiring in PostPhase.tsx
// (the one the regression report named) does too, on both onUndo and onRedo.
assert.match(
  desktop,
  /onUndo=\{\(\)\s*=>\s*ed\.undoCaptions\(\)\}/,
  "PostPhase.tsx wires TimelinePanel onUndo through an arrow, not the bare function reference (H4)",
);
assert.match(
  desktop,
  /onRedo=\{\(\)\s*=>\s*ed\.redoCaptions\(\)\}/,
  "PostPhase.tsx wires TimelinePanel onRedo through an arrow (same bug class as onUndo)",
);
// Mobile has no Timeline (cut by design), but its own Undo/Redo buttons must follow the
// same discipline for consistency and to stay defensive against future onClick rewiring.
assert.match(
  mobile,
  /onClick=\{\(\)\s*=>\s*ed\.undoCaptions\(\)\}/,
  "PostPhaseMobile.tsx wires its Undo button through an arrow",
);
assert.match(
  mobile,
  /onClick=\{\(\)\s*=>\s*ed\.redoCaptions\(\)\}/,
  "PostPhaseMobile.tsx wires its Redo button through an arrow",
);
// The runtime guard inside undoCaptions itself — the second, permanent layer of the H4
// fix — must normalize any non-number expectedEntryId to undefined before it ever reaches
// undoCaptionHistory (see the lib-level regression proof above for why that matters).
assert.match(
  editorHook,
  /typeof expectedEntryId === "number" \? expectedEntryId : undefined/,
  "usePostPhaseEditor.undoCaptions guards against a non-number expectedEntryId (H4 permanent fix)",
);

// ── M5: "เพิ่มที่ Playhead" must be pre-flighted and disabled when insertion is impossible,
// not just fail with a toast after the click. Assert the hook exposes the precomputed
// state and both surfaces wire `disabled` off it.
assert.match(editorHook, /canInsertCaption/, "editor hook exposes canInsertCaption");
assert.match(editorHook, /insertCaptionBlockedReason/, "editor hook exposes insertCaptionBlockedReason");
assert.match(
  desktop,
  /data-caption-action="add"[\s\S]{0,400}?disabled=\{!ed\.canInsertCaption\}/,
  "desktop Add-caption button is disabled when insertion is impossible (M5)",
);
assert.match(
  mobile,
  /data-caption-action="add"[\s\S]{0,400}?disabled=\{!ed\.canInsertCaption\}/,
  "mobile Add-caption button is disabled when insertion is impossible (M5)",
);

// ── M6: renderSubtitle must bail on empty/whitespace-only text BEFORE any preset/effect
// branch draws a container (box / box-rounded / karaoke-box / box-white / box-yellow /
// news backgrounds, and the karaoke/typewriter wrapKaraoke() box wrapper) — otherwise an
// empty card renders as a visible empty box in both the live preview and the burned MP4
// (same function backs both, per the file's own header comment).
const earlyReturnMatch = renderSubtitleSrc.match(/if \(!text\.trim\(\)\) return null;/);
assert.ok(earlyReturnMatch, "renderSubtitle has an empty-text early return (M6)");
const guardIndex = renderSubtitleSrc.indexOf(earlyReturnMatch[0]);
const firstContainerIndex = renderSubtitleSrc.indexOf('background: "rgba(0,0,0');
assert.ok(guardIndex > 0 && firstContainerIndex > guardIndex, "the empty-text guard runs BEFORE the first box-preset container is drawn (M6)");

console.log("caption-card-editing: all checks passed");

// HERO-62: fill-yourself B-roll windows can run 12-15s (a caption longer than cadence is
// its own window; the pause-smoothing pass can stretch a window over a long trailing
// silence). This caps every fill-yourself window at 5s, splitting into the fewest equal
// whole-ms pieces, snapping cuts to a caption boundary within +/-750ms when that keeps the
// cap intact.
// Run: npx tsx scripts/verify-broll-fill-yourself-window-cap.ts
import assert from "node:assert/strict";
import {
  buildBrollWindows,
  capFillYourselfBrollWindows,
  type BrollWindow,
  type BrollWindowCaption,
} from "../src/lib/broll-windows";
import { buildPlaceholderBgVideos } from "../src/lib/broll-placeholders";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── Scenario from the AC: one 14s caption, then one 3s caption followed by a 9s pause ──
// buildBrollWindows groups caption 1 (0-14000) as its own window (longer than any sane
// cadence), then caption 2 (14000-17000) as a second window whose smoothing pass stretches
// its end to audioEnd (26000) across the trailing 9s pause — exactly the HERO-62 bug.
const captions: BrollWindowCaption[] = [
  { startMs: 0, endMs: 14_000, text: "a fourteen second caption" },
  { startMs: 14_000, endMs: 17_000, text: "a three second caption" },
];
const audioEndMs = 26_000; // 17000 + 9000s pause
const cadenceSec = 4;

const todaysWindows = buildBrollWindows(captions, cadenceSec, audioEndMs);
check("precondition: today's builder produces the two over-long windows this bug reports",
  todaysWindows.length === 2
  && todaysWindows[0].startMs === 0 && todaysWindows[0].endMs === 14_000
  && todaysWindows[1].startMs === 14_000 && todaysWindows[1].endMs === 26_000,
  JSON.stringify(todaysWindows.map((w) => [w.startMs, w.endMs])));

const capped = capFillYourselfBrollWindows(todaysWindows, captions);

check("every fill-yourself window is <= 5000ms",
  capped.every((w) => w.endMs - w.startMs <= 5_000),
  JSON.stringify(capped.map((w) => w.endMs - w.startMs)));
check("windows tile [0, audioEnd] with no gaps or overlaps",
  capped.length > 0
  && capped[0].startMs === 0
  && capped[capped.length - 1].endMs === audioEndMs
  && capped.every((w, i) => i === 0 || w.startMs === capped[i - 1].endMs));
check("boundaries are whole ms",
  capped.every((w) => Number.isInteger(w.startMs) && Number.isInteger(w.endMs)));
check("more windows than before splitting (the cap actually split something)",
  capped.length > todaysWindows.length, `${capped.length} vs ${todaysWindows.length}`);

// ── Fill-yourself OFF: byte-identical to today's output ──────────────────────────────
// capFillYourselfBrollWindows must never be invoked by a non-fill-yourself caller, so the
// "off" path IS calling buildBrollWindows directly — unchanged by this change existing.
const offPath = buildBrollWindows(captions, cadenceSec, audioEndMs);
check("fill-yourself OFF yields exactly today's windows (byte-identical JSON)",
  JSON.stringify(offPath) === JSON.stringify(todaysWindows));

// capFillYourselfBrollWindows itself is a no-op when every window is already <= cap.
const shortWindows: BrollWindow[] = [
  { startMs: 0, endMs: 3_000, captionStartIdx: 0, captionEndIdx: 0, text: "a" },
  { startMs: 3_000, endMs: 6_000, captionStartIdx: 1, captionEndIdx: 1, text: "b" },
];
check("already-short windows pass through capFillYourselfBrollWindows unchanged",
  JSON.stringify(capFillYourselfBrollWindows(shortWindows, [], 5_000)) === JSON.stringify(shortWindows));

// ── Caption-boundary snapping ──────────────────────────────────────────────────────────
// A single 12s caption with a real sub-caption boundary at 4000ms, 390ms inside the +/-750ms
// tolerance of the even 3-piece split point (4000ms) — it should snap exactly onto it.
const snapCaptions: BrollWindowCaption[] = [
  { startMs: 0, endMs: 4_000, text: "first" },
  { startMs: 4_000, endMs: 12_000, text: "second" },
];
const snapWindow = { startMs: 0, endMs: 12_000, captionStartIdx: 0, captionEndIdx: 1, text: "first second" };
const snapped = capFillYourselfBrollWindows([snapWindow], snapCaptions, 5_000);
check("a caption boundary within tolerance of the even point is snapped onto exactly",
  snapped.some((w) => w.startMs === 4_000 || w.endMs === 4_000),
  JSON.stringify(snapped.map((w) => [w.startMs, w.endMs])));
check("snapped pieces still tile the parent window and stay <= 5000ms",
  snapped[0].startMs === 0
  && snapped[snapped.length - 1].endMs === 12_000
  && snapped.every((w, i) => i === 0 || w.startMs === snapped[i - 1].endMs)
  && snapped.every((w) => w.endMs - w.startMs <= 5_000));

// A boundary further than 750ms from the even point must NOT be used — cut lands mid-caption.
const farCaptions: BrollWindowCaption[] = [
  { startMs: 0, endMs: 5_200, text: "first" }, // boundary at 5200, even point for a 12s/3-piece split is 4000 — 1200ms away
  { startMs: 5_200, endMs: 12_000, text: "second" },
];
const farWindow = { startMs: 0, endMs: 12_000, captionStartIdx: 0, captionEndIdx: 1, text: "first second" };
const farSplit = capFillYourselfBrollWindows([farWindow], farCaptions, 5_000);
check("a caption boundary outside the tolerance is ignored (mid-caption cut kept)",
  !farSplit.some((w) => w.startMs === 5_200 || w.endMs === 5_200)
  && farSplit.every((w) => w.endMs - w.startMs <= 5_000),
  JSON.stringify(farSplit.map((w) => [w.startMs, w.endMs])));

// A snap that would push a neighbouring piece over the 5s cap is rejected even though it is
// within the 750ms tolerance: a 10000ms window splits into exactly 2 x 5000ms pieces (zero
// slack), so ANY shift of the single cut point would push one side over 5000ms.
const zeroSlackCaptions: BrollWindowCaption[] = [
  { startMs: 0, endMs: 4_600, text: "first" }, // 400ms inside tolerance of the 5000ms even point
  { startMs: 4_600, endMs: 10_000, text: "second" },
];
const zeroSlackWindow = { startMs: 0, endMs: 10_000, captionStartIdx: 0, captionEndIdx: 1, text: "first second" };
const zeroSlackSplit = capFillYourselfBrollWindows([zeroSlackWindow], zeroSlackCaptions, 5_000);
check("a snap that would break the 5000ms cap is rejected in favour of the even point",
  zeroSlackSplit.every((w) => w.endMs - w.startMs <= 5_000)
  && zeroSlackSplit.some((w) => w.startMs === 5_000 || w.endMs === 5_000));

// ── Per-piece caption fields (review follow-up) ──────────────────────────────────────
// A parent window spanning 2 captions: cap0 "Hello" (0-3000), cap1 "World" (3000-11000).
// buildBrollWindows groups both into one 11000ms window (captionStartIdx 0, captionEndIdx
// 1, text "Hello World") — splitting it must NOT hand every sibling piece that identical
// parent text; each piece should get only the caption(s) it actually overlaps.
const distinctCaptions: BrollWindowCaption[] = [
  { startMs: 0, endMs: 3_000, text: "Hello" },
  { startMs: 3_000, endMs: 11_000, text: "World" },
];
const distinctParent: BrollWindow = {
  startMs: 0, endMs: 11_000, captionStartIdx: 0, captionEndIdx: 1, text: "Hello World",
};
const distinctPieces = capFillYourselfBrollWindows([distinctParent], distinctCaptions);
check("parent spanning 2+ captions -> pieces get distinct caption ranges",
  distinctPieces.length >= 2
  && distinctPieces[0].captionStartIdx === 0 && distinctPieces[0].captionEndIdx === 0
  && distinctPieces[0].text === "Hello"
  && distinctPieces[distinctPieces.length - 1].captionStartIdx === 1
  && distinctPieces[distinctPieces.length - 1].captionEndIdx === 1
  && distinctPieces[distinctPieces.length - 1].text === "World",
  JSON.stringify(distinctPieces.map((w) => [w.startMs, w.endMs, w.captionStartIdx, w.captionEndIdx, w.text])));
check("distinct-range pieces still tile the parent window and stay <= 5000ms",
  distinctPieces[0].startMs === 0
  && distinctPieces[distinctPieces.length - 1].endMs === 11_000
  && distinctPieces.every((w, i) => i === 0 || w.startMs === distinctPieces[i - 1].endMs)
  && distinctPieces.every((w) => w.endMs - w.startMs <= 5_000));

// A pure-pause piece (no caption overlaps its span) falls back to the parent's own fields.
// Reuse the AC scenario's second window: single 3s caption (14000-17000) stretched over a
// 9s trailing pause to 26000 -> the tail pieces overlap no caption at all.
const pauseOnlyParent = todaysWindows[1]; // {startMs: 14000, endMs: 26000, captionStartIdx: 1, captionEndIdx: 1, text: "a three second caption"}
const pauseOnlyPieces = capFillYourselfBrollWindows([pauseOnlyParent], captions);
const pauseOnlyTailPiece = pauseOnlyPieces[pauseOnlyPieces.length - 1];
check("a pause-only piece (no caption overlap) falls back to the parent's fields",
  pauseOnlyTailPiece.startMs >= 17_000 // past the caption's own end -> pure pause
  && pauseOnlyTailPiece.captionStartIdx === pauseOnlyParent.captionStartIdx
  && pauseOnlyTailPiece.captionEndIdx === pauseOnlyParent.captionEndIdx
  && pauseOnlyTailPiece.text === pauseOnlyParent.text,
  JSON.stringify(pauseOnlyPieces.map((w) => [w.startMs, w.endMs, w.captionStartIdx, w.captionEndIdx, w.text])));

// An invalid caption elsewhere in the list must not shift indices: buildBrollWindows'
// captionStartIdx/captionEndIdx refer to the FILTERED caption list, so the cap function
// must apply the identical filter before indexing — a garbage entry between "Hello" and
// "World" in the RAW list must still land piece 0 on caption index 0 ("Hello") and the
// later pieces on caption index 1 ("World"), exactly as if the garbage entry were absent.
const withInvalidCaption: BrollWindowCaption[] = [
  { startMs: 0, endMs: 3_000, text: "Hello" },
  { startMs: 100, endMs: 50, text: "garbage (endMs <= startMs)" },
  { startMs: 3_000, endMs: 11_000, text: "World" },
];
const invalidFilteredPieces = capFillYourselfBrollWindows([distinctParent], withInvalidCaption);
check("an invalid caption elsewhere in the list does not shift piece caption indices",
  JSON.stringify(invalidFilteredPieces.map((w) => [w.captionStartIdx, w.captionEndIdx, w.text])) ===
  JSON.stringify(distinctPieces.map((w) => [w.captionStartIdx, w.captionEndIdx, w.text])),
  JSON.stringify(invalidFilteredPieces.map((w) => [w.captionStartIdx, w.captionEndIdx, w.text])));

// ── HERO-44 placeholder contract: each piece is its own hidden placeholder ───────────
const placeholders = buildPlaceholderBgVideos(capped, audioEndMs / 1_000);
check("every capped piece becomes its own hidden placeholder",
  placeholders.length === capped.length
  && placeholders.every((p) => p.src === "" && p.brollEnabled === false));
check("each placeholder keeps its own sequential sourceIndex",
  placeholders.every((p, i) => p.sourceIndex === i));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll fill-yourself window cap checks passed.");

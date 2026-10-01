/**
 * T3 — Line-fit QA finding (Card Line Budget, CONTEXT.md).
 *
 * `card_exceeds_line_budget` is the lowest-precedence finding `validateSubtitleQuality`
 * can report: it is checked last, after every other ADR 0056 measurement/content/timing
 * code, so it only ever surfaces when the report would otherwise be `passed`. It is never
 * a Blocking Subtitle Code (ADR 0056: only `empty_script`/`empty_captions` fail a job).
 */
import assert from "node:assert/strict";
import {
  validateSubtitleQuality, subtitleQualityShouldFailJob, BLOCKING_SUBTITLE_CODES,
} from "../src/lib/mcp/subtitle-quality";
import { maxCardCharsFor } from "../src/lib/card-line-budget";
import { resolveExportCardLineBudget } from "../src/lib/mcp/orchestrator-steps";
import { DEFAULT_V2_SUB } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";

assert.ok(
  !(BLOCKING_SUBTITLE_CODES as readonly string[]).includes("card_exceeds_line_budget"),
  "card_exceeds_line_budget must never be a Blocking Subtitle Code",
);

// Size 80, sentence mode: one-line budget is maxCardCharsFor(80) base graphemes, two lines
// for "sentence". A 50-base-grapheme run is over budget at 80 but fits comfortably at 60.
const oneLineBudget80 = maxCardCharsFor(80);
assert.equal(oneLineBudget80, 24, "budget formula changed — recheck fixture lengths below");
const overAt80Text = "ก".repeat(50); // 50 > 2*24=48
const fitsAt60Text = overAt80Text; // 50 <= 2*32=64

// 1. Fires on an over-budget card (sentence mode, size 80).
const overBudget = validateSubtitleQuality({
  script: overAt80Text,
  captions: [{ text: overAt80Text, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: { mode: "sentence", size: 80 },
});
assert.equal(overBudget.status, "warning");
assert.equal(overBudget.status !== "passed" && overBudget.code, "card_exceeds_line_budget");
assert.equal(overBudget.status !== "passed" && overBudget.captionIndex, 0);

// 2. Never fails the job.
assert.equal(subtitleQualityShouldFailJob(overBudget), false);

// 3. Does not mask a higher-precedence code: the same over-budget card, but the timing
// source is `tts_segment_timing` (ADR 0056's `unverified_alignment`, checked well before
// the line-fit pass). The report must still read `unverified_alignment` — line-fit never
// overrides a finding that already exists.
const masked = validateSubtitleQuality({
  script: overAt80Text,
  captions: [{ text: overAt80Text, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "tts_segment_timing",
  cardLineBudget: { mode: "sentence", size: 80 },
});
assert.equal(masked.status, "warning");
assert.equal(masked.status !== "passed" && masked.code, "unverified_alignment");
assert.equal(subtitleQualityShouldFailJob(masked), false);

// 3b. Same with a Blocking Subtitle Code (empty_captions): an empty caption list is still
// `failed`, never downgraded or relabeled by the line-fit pass, and line-fit has nothing
// to check against an empty list regardless.
const blockedByEmptyCaptions = validateSubtitleQuality({
  script: overAt80Text,
  captions: [],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: { mode: "sentence", size: 80 },
});
assert.equal(blockedByEmptyCaptions.status, "failed");
assert.equal(
  blockedByEmptyCaptions.status === "failed" && blockedByEmptyCaptions.code,
  "empty_captions",
);
assert.equal(subtitleQualityShouldFailJob(blockedByEmptyCaptions), true);

// 4. A card within budget at the resolved size reports `passed` — no false positive.
const withinBudget = validateSubtitleQuality({
  script: fitsAt60Text,
  captions: [{ text: fitsAt60Text, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: { mode: "sentence", size: 60 },
});
assert.equal(withinBudget.status, "passed");

// 5. Omitting `cardLineBudget` skips the check entirely (backward compatible: a caller
// that has not resolved mode/size yet never gets a finding it cannot explain).
const unresolvedCaller = validateSubtitleQuality({
  script: overAt80Text,
  captions: [{ text: overAt80Text, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
});
assert.equal(unresolvedCaller.status, "passed");

// 6. Mode matters: the same 30-base-grapheme card is over budget in word-count mode "1"
// (one line, budget 24) but fits in "sentence" mode (two lines, budget 48).
const wordModeText = "ก".repeat(30);
const overInWordMode = validateSubtitleQuality({
  script: wordModeText,
  captions: [{ text: wordModeText, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: { mode: "1", size: 80 },
});
assert.equal(overInWordMode.status, "warning");
assert.equal(overInWordMode.status !== "passed" && overInWordMode.code, "card_exceeds_line_budget");
const fitsInSentenceMode = validateSubtitleQuality({
  script: wordModeText,
  captions: [{ text: wordModeText, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: { mode: "sentence", size: 80 },
});
assert.equal(fitsInSentenceMode.status, "passed");

// 7. A real fixture card already inside budget (T1/T2's documented example, 33 base
// graphemes against the 48-grapheme sentence budget at size 80) never fires.
const docFixture = "กระจุกอยู่ที่เด็กซึ่งทำการบ้านเสร็จเร็วผิดปกติ";
const docFixtureReport = validateSubtitleQuality({
  script: docFixture,
  captions: [{ text: docFixture, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: { mode: "sentence", size: 80 },
});
assert.equal(docFixtureReport.status, "passed");

// ── Fix round 1 (reviewer B1) ────────────────────────────────────────────────────────
// Export call site precedence: `resolveExportCardLineBudget(sourceInput, editSnapshot)`.
// What is actually burned on an Editor V2 export is the creator's post-phase edit
// (`editSnapshot.subtitleConfig.fontSize` / `.cardLen`), not the SOURCE (preview) job's
// resolved design — that design is correct only when the export is unedited.

const sourceAt100: { subtitleDesign: typeof DEFAULT_V2_SUB; subtitleCardLen: "sentence" } = {
  subtitleDesign: { ...DEFAULT_V2_SUB, fontSize: 100 },
  subtitleCardLen: "sentence",
};
const sourceAt60: { subtitleDesign: typeof DEFAULT_V2_SUB; subtitleCardLen: "sentence" } = {
  subtitleDesign: { ...DEFAULT_V2_SUB, fontSize: 60 },
  subtitleCardLen: "sentence",
};

// A. Snapshot size LARGER than source → the check must use the larger (current) size, so
// a card that fit the old, smaller font now correctly reports overflow at the real burned
// size. maxCardCharsFor(100)=19 → sentence budget 38; a 45-grapheme card fits at the old
// size 60 (budget 64) but overflows at the edited size 100.
const largerSnapshot = resolveExportCardLineBudget(sourceAt60, { subtitleConfig: { fontSize: 100 }, cardLen: "sentence" });
assert.deepEqual(largerSnapshot, { mode: "sentence", size: 100 }, "snapshot size must win over the source's");
const cardText45 = "ก".repeat(45);
const overflowAtEditedSize = validateSubtitleQuality({
  script: cardText45,
  captions: [{ text: cardText45, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: largerSnapshot,
});
assert.equal(overflowAtEditedSize.status, "warning");
assert.equal(
  overflowAtEditedSize.status !== "passed" && overflowAtEditedSize.code,
  "card_exceeds_line_budget",
  "a larger edited size must surface the overflow the stale source size would have missed",
);

// B. Snapshot size SMALLER than source → no false-positive warning for a card that is
// actually fine at the real (smaller) burned size. maxCardCharsFor(60)=32 → sentence
// budget 64; the same 45-grapheme card fits comfortably once the edit shrank the font.
const smallerSnapshot = resolveExportCardLineBudget(sourceAt100, { subtitleConfig: { fontSize: 60 }, cardLen: "sentence" });
assert.deepEqual(smallerSnapshot, { mode: "sentence", size: 60 }, "snapshot size must win over the source's");
const noFalsePositive = validateSubtitleQuality({
  script: cardText45,
  captions: [{ text: cardText45, startMs: 0, endMs: 5000 }],
  audioDurationMs: 5000,
  timingSource: "provider_alignment",
  cardLineBudget: smallerSnapshot,
});
assert.equal(
  noFalsePositive.status,
  "passed",
  "a smaller edited size must not carry the stale source size's overflow into a false warning",
);

// C. No snapshot (unedited export) → falls back to the source job's resolved design.
assert.deepEqual(
  resolveExportCardLineBudget(sourceAt100, null),
  { mode: "sentence", size: 100 },
);
assert.deepEqual(
  resolveExportCardLineBudget(sourceAt100, undefined),
  { mode: "sentence", size: 100 },
);

// D. Legacy source with nothing persisted (pre-T4 job) and no snapshot → the same
// DEFAULT_V2_SUB (size 80) / "sentence" fallback `resolvedMcpSubtitleDesignFromInput`
// itself uses for every other call site.
assert.deepEqual(resolveExportCardLineBudget(null, null), { mode: "sentence", size: 80 });
assert.deepEqual(resolveExportCardLineBudget({}, undefined), { mode: "sentence", size: 80 });

// E. A snapshot can edit card length without touching size, and vice versa — each field
// resolves independently (matches T4's own per-field overlay pattern).
assert.deepEqual(
  resolveExportCardLineBudget(sourceAt100, { cardLen: "1" }),
  { mode: "1", size: 100 },
  "cardLen-only edit must keep the source's size",
);
assert.deepEqual(
  resolveExportCardLineBudget(sourceAt100, { subtitleConfig: { fontSize: 60 } }),
  { mode: "sentence", size: 60 },
  "fontSize-only edit must keep the source's cardLen",
);

console.log("verify-subtitle-line-fit-qa: ok");

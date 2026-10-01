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

console.log("verify-subtitle-line-fit-qa: ok");

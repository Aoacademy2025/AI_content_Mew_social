/**
 * ADR 0056 — subtitle QA is a report, not a gate.
 *
 * Only a Blocking Subtitle Code ("nothing to show") may fail a job. Every other
 * finding is a `warning` the Post-phase editor surfaces, and timing is repaired
 * deterministically instead of refusing the render.
 */
import assert from "node:assert/strict";
import {
  validateSubtitleQuality, subtitleQualityShouldFailJob, repairCaptionTiming, BLOCKING_SUBTITLE_CODES,
} from "../src/lib/mcp/subtitle-quality";

const script = "สวัสดีครับ วันนี้เรามาคุยกันเรื่องการออม";
const caps = [
  { text: "สวัสดีครับ", startMs: 0, endMs: 900, tag: "hook" as const },
  { text: "วันนี้เรามาคุยกันเรื่องการออม", startMs: 900, endMs: 3000, tag: "body" as const },
];
// 1. Gemini segment clock is releasable as a warning, never a failure
const gemini = validateSubtitleQuality({ script, captions: caps, audioDurationMs: 3000, timingSource: "tts_segment_timing" });
assert.equal(gemini.status, "warning"); assert.equal(gemini.status !== "passed" && gemini.code, "unverified_alignment");
assert.equal(subtitleQualityShouldFailJob(gemini), false);
// 2. avatar_script_clock likewise
assert.equal(subtitleQualityShouldFailJob(validateSubtitleQuality({ script, captions: caps, audioDurationMs: 3000, timingSource: "avatar_script_clock" })), false);
// 3. text edits are a warning
const edited = validateSubtitleQuality({ script, captions: [caps[0], { ...caps[1], text: "วันนี้มาคุยเรื่องการออมกัน" }], audioDurationMs: 3000, timingSource: "forced_alignment" });
assert.equal(edited.status, "warning"); assert.equal(subtitleQualityShouldFailJob(edited), false);
// 4. speech coverage incomplete is a warning
const tail = validateSubtitleQuality({ script, captions: caps, audioDurationMs: 12000, timingSource: "forced_alignment", speechCoverage: { source: "transcribe", spokenEndMs: 11500 } });
assert.equal(tail.status, "warning"); assert.equal(subtitleQualityShouldFailJob(tail), false);
// 4b. same finding with the persisted production coverage shape
const persistedTail = validateSubtitleQuality({ script, captions: caps, audioDurationMs: 12000, timingSource: "forced_alignment", speechCoverage: { source: "silence_analysis", spokenEndMs: 11500 } });
assert.equal(persistedTail.status, "warning"); assert.equal(persistedTail.status !== "passed" && persistedTail.code, "speech_coverage_incomplete");
// 4c. missing coverage evidence is a warning too — it is not "nothing to show"
const noCoverage = validateSubtitleQuality({ script, captions: caps, audioDurationMs: 3000, timingSource: "forced_alignment" });
assert.equal(noCoverage.status, "warning"); assert.equal(subtitleQualityShouldFailJob(noCoverage), false);
// 5. only empty script / empty captions block
assert.deepEqual([...BLOCKING_SUBTITLE_CODES], ["empty_script", "empty_captions"]);
assert.equal(validateSubtitleQuality({ script, captions: [], audioDurationMs: 3000, timingSource: "forced_alignment" }).status, "failed");
assert.equal(validateSubtitleQuality({ script: "", captions: caps, audioDurationMs: 3000, timingSource: "forced_alignment" }).status, "failed");
// 5b. a blank card inside an otherwise usable set is a warning — the render drops it
const blankCard = validateSubtitleQuality({ script, captions: [caps[0], { ...caps[1], text: "   " }], audioDurationMs: 3000, timingSource: "forced_alignment" });
assert.equal(blankCard.status, "warning"); assert.equal(subtitleQualityShouldFailJob(blankCard), false);
// 6. repair: empty card dropped, overlap/out-of-bounds clamped, monotonic, >= 240 ms
const bad = [
  { text: "ก", startMs: -100, endMs: 500, tag: "hook" as const },
  { text: "   ", startMs: 500, endMs: 900, tag: "body" as const },
  { text: "ข", startMs: 800, endMs: 850, tag: "body" as const },
  { text: "ค", startMs: 2000, endMs: 9000, tag: "cta" as const },
];
const fixed = repairCaptionTiming(bad, 3000);
assert.equal(fixed.dropped, 1); assert.equal(fixed.repaired, true);
assert.equal(fixed.captions[0].startMs, 0);
assert.ok(fixed.captions.every((c, i, a) => c.endMs - c.startMs >= 240 && (i === 0 || c.startMs >= a[i - 1].endMs)));
assert.equal(fixed.captions[fixed.captions.length - 1].endMs, 3000);
// 6b. repair never rewrites the displayed text and keeps the caller's own fields
assert.deepEqual(fixed.captions.map((c) => c.text), ["ก", "ข", "ค"]);
assert.deepEqual(fixed.captions.map((c) => c.tag), ["hook", "body", "cta"]);
// 6c. non-finite timing is replaced instead of poisoning the timeline
const nonFinite = repairCaptionTiming([{ text: "ก", startMs: Number.NaN, endMs: Number.NaN }], 3000);
assert.equal(nonFinite.repaired, true);
assert.deepEqual(nonFinite.captions, [{ text: "ก", startMs: 0, endMs: 240 }]);
/** Every card holds the 240 ms floor and no card starts before the previous one ends. */
function assertRenderSafe(cards: Array<{ startMs: number; endMs: number }>, label: string) {
  assert.ok(
    cards.every((c, i, a) => c.endMs - c.startMs >= 240 && (i === 0 || c.startMs >= a[i - 1].endMs)),
    `${label}: every card keeps the 240 ms floor and stays monotonic — ${JSON.stringify(cards)}`,
  );
}
const timings = (r: { captions: Array<{ startMs: number; endMs: number }> }) =>
  r.captions.map((c) => [c.startMs, c.endMs]);

// 6d. a tail that cannot fit is pulled BACK inside the audio by shortening the cards
// before it. A zero-length or 100 ms card is a Remotion Sequence hazard, and pushing the
// tail past the composition end would simply never show it.
for (const tail of [
  [{ text: "ก", startMs: 0, endMs: 2900, tag: "hook" as const }, { text: "ข", startMs: 2900, endMs: 3000, tag: "body" as const }],
  [{ text: "ก", startMs: 0, endMs: 3000, tag: "hook" as const }, { text: "ข", startMs: 3000, endMs: 3000, tag: "body" as const }],
]) {
  const squeezed = repairCaptionTiming(tail, 3000);
  assert.equal(squeezed.dropped, 0);
  assert.equal(squeezed.repaired, true);
  assertRenderSafe(squeezed.captions, "6d");
  assert.deepEqual(timings(squeezed), [[0, 2760], [2760, 3000]], JSON.stringify(squeezed.captions));
}

// 6d-i. a RUN of short tail cards must not cascade: each squeezed card used to push the
// next one a further 240 ms past the audio (measured: last end 3380 for this input).
const shortTailRun = repairCaptionTiming([
  { text: "ก", startMs: 0, endMs: 2900, tag: "hook" as const },
  { text: "ข", startMs: 2900, endMs: 2950, tag: "body" as const },
  { text: "ค", startMs: 2950, endMs: 3000, tag: "cta" as const },
], 3000);
assertRenderSafe(shortTailRun.captions, "6d-i");
assert.equal(shortTailRun.captions.at(-1)?.endMs, 3000);
assert.equal(shortTailRun.captions[0].endMs, 2520, "the card before the tail gives up its time");
assert.deepEqual(timings(shortTailRun), [[0, 2520], [2520, 2760], [2760, 3000]]);

// 6d-ii. six 20 ms cards after a long one (measured before the backward pass: last end 4320).
const sixShortTail = repairCaptionTiming([
  { text: "ก", startMs: 0, endMs: 2880, tag: "hook" as const },
  { text: "ข", startMs: 2880, endMs: 2900, tag: "body" as const },
  { text: "ค", startMs: 2900, endMs: 2920, tag: "body" as const },
  { text: "ง", startMs: 2920, endMs: 2940, tag: "body" as const },
  { text: "จ", startMs: 2940, endMs: 2960, tag: "body" as const },
  { text: "ฉ", startMs: 2960, endMs: 2980, tag: "body" as const },
  { text: "ช", startMs: 2980, endMs: 3000, tag: "cta" as const },
], 3000);
assertRenderSafe(sixShortTail.captions, "6d-ii");
assert.equal(sixShortTail.captions.length, 7);
assert.equal(sixShortTail.captions.at(-1)?.endMs, 3000);
assert.equal(sixShortTail.captions[0].endMs, 1560, JSON.stringify(sixShortTail.captions));

// 6d-iii. degenerate: 20 cards × 240 ms cannot fit in 3000 ms. Text is never dropped, so
// the forward-pass result stands and the tail is allowed to overshoot.
const cannotFit = repairCaptionTiming(
  Array.from({ length: 20 }, (_, i) => ({ text: `ก${i}`, startMs: i * 20, endMs: i * 20 + 20, tag: "body" as const })),
  3000,
);
assert.equal(cannotFit.dropped, 0);
assert.equal(cannotFit.captions.length, 20);
assertRenderSafe(cannotFit.captions, "6d-iii");
assert.ok(
  cannotFit.captions.at(-1)!.endMs > 3000,
  "a set that cannot fit keeps its text and overshoots rather than collapsing",
);

// 6e. without a usable audio duration there is nothing to clamp against, and `repaired`
// says only whether this function changed anything — it is not an in-bounds guarantee.
assert.deepEqual(
  repairCaptionTiming([{ text: "ก", startMs: 0, endMs: 9000, tag: "hook" as const }], 0),
  { captions: [{ text: "ก", startMs: 0, endMs: 9000, tag: "hook" }], repaired: false, dropped: 0 },
);
// 7. a clean set is untouched
assert.deepEqual(repairCaptionTiming(caps, 3000), { captions: caps, repaired: false, dropped: 0 });
console.log("verify-subtitle-quality-policy: ok");

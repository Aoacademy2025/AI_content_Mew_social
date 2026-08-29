// Run with: node --conditions=react-server --import tsx scripts/verify-story-film-caption-alignment.ts
import assert from "node:assert/strict";
import {
  planStoryFilmAlignmentChunks,
  storyFilmAlignmentHasSpeechTailCoverage,
} from "../src/lib/story-film-caption-alignment";

const durationMs = 145_220;
const chunks = planStoryFilmAlignmentChunks(durationMs, [72_610]);
assert.deepEqual(chunks, [
  { startMs: 0, endMs: 72_610, durationMs: 72_610 },
  { startMs: 72_610, endMs: 145_220, durationMs: 72_610 },
]);

assert.equal(
  storyFilmAlignmentHasSpeechTailCoverage(
    [{ word: "ครับ", startMs: 142_500, endMs: 142_800 }],
    145_160,
  ),
  false,
  "the production 2.36s missing spoken tail must be rejected",
);
assert.equal(
  storyFilmAlignmentHasSpeechTailCoverage(
    [{ word: "ครับ", startMs: 144_500, endMs: 145_020 }],
    145_160,
  ),
  true,
  "a fully covered spoken tail is accepted",
);
assert.deepEqual(
  planStoryFilmAlignmentChunks(75_000, []),
  [{ startMs: 0, endMs: 75_000, durationMs: 75_000 }],
  "short presenter audio remains a single alignment call",
);

console.log("ok: Story Film long-audio alignment is chunked and rejects a missing spoken tail");

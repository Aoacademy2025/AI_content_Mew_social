import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_PARTIAL_ALIGNMENT_MIN_COVERAGE,
  buildPartialAlignmentClock,
  partialAlignmentMinCoverage,
} from "../src/lib/mcp/partial-alignment";
import { tokenizeWords } from "../src/lib/tts-timing";

/** Measured words for the first `count` script words, evenly spaced. */
function measurePrefix(text: string, count: number, msPerWord = 400) {
  return tokenizeWords(text).slice(0, count).map((word, index) => ({
    word: word.word,
    startChar: word.startChar,
    endChar: word.endChar,
    startMs: index * msPerWord,
    endMs: index * msPerWord + msPerWord - 1,
  }));
}

async function main() {
  const text = "one two three four five six seven eight";
  const total = tokenizeWords(text).length;
  assert.equal(total, 8, "the fixture tokenises into eight words");

  // ---- the whole point: a measured prefix survives ----------------------
  {
    const clock = buildPartialAlignmentClock({
      fullText: text,
      measuredWords: measurePrefix(text, 6),
      audioDurationMs: 4000,
      minCoverage: 0.5,
    });
    assert.ok(clock, "six of eight measured words must produce a clock");
    assert.equal(clock.words.length, total, "every script word gets a time, measured or spanned");
    assert.equal(clock.verifiedWordCount, 6, "only the measured words count as verified");
    assert.equal(clock.totalWordCount, total);
    assert.equal(Math.round(clock.coverage * 100), 75, "coverage is measured over the whole script");
    assert.equal(clock.words[0].startMs, 0, "a measured word keeps its own timestamp");
    assert.equal(clock.words[5].endMs, 2399, "the last measured word keeps its own timestamp");
    assert.equal(clock.uncertainRanges.length, 1, "the unmeasured tail is one uncertain range");
    assert.equal(clock.uncertainRanges[0].endMs, 4000, "the tail is spanned to the end of the audio");
    for (let i = 1; i < clock.words.length; i += 1) {
      assert.ok(clock.words[i].startMs >= clock.words[i - 1].endMs - 1,
        "the projected clock is monotonic across the measured/spanned boundary");
    }
  }

  // ---- caption text can never come from the transcript ------------------
  {
    const clock = buildPartialAlignmentClock({
      fullText: text,
      measuredWords: measurePrefix(text, 6).map((w) => ({ ...w, word: "WRONG" })),
      audioDurationMs: 4000,
      minCoverage: 0.5,
    });
    assert.ok(clock, "a differing transcript spelling still yields a clock");
    assert.deepEqual(
      clock.words.map((w) => w.word),
      tokenizeWords(text).map((w) => w.word),
      "every visible word comes from the script, never from the measured input",
    );
  }

  // ---- below the threshold nothing changes -----------------------------
  assert.equal(
    buildPartialAlignmentClock({
      fullText: text, measuredWords: measurePrefix(text, 3), audioDurationMs: 4000, minCoverage: 0.75,
    }),
    null,
    "coverage under the threshold refuses, so the caller falls back exactly as before",
  );
  assert.equal(
    buildPartialAlignmentClock({
      fullText: text, measuredWords: [], audioDurationMs: 4000, minCoverage: 0.1,
    }),
    null,
    "no measured word means no partial clock",
  );

  // ---- refuse anything inconsistent rather than half-believe it ---------
  const base = { fullText: text, audioDurationMs: 4000, minCoverage: 0.1 };
  assert.equal(
    buildPartialAlignmentClock({ ...base, measuredWords: measurePrefix(text, 6).reverse() }),
    null,
    "non-monotonic timing is refused",
  );
  assert.equal(
    buildPartialAlignmentClock({
      ...base,
      measuredWords: measurePrefix(text, 6).map((w, i) => (i === 2 ? { ...w, startChar: w.startChar + 1 } : w)),
    }),
    null,
    "a measured word that does not sit on a script word is refused",
  );
  assert.equal(
    buildPartialAlignmentClock({ ...base, measuredWords: measurePrefix(text, 6), audioDurationMs: 1000 }),
    null,
    "a word ending past the audio is refused",
  );
  assert.equal(
    buildPartialAlignmentClock({ ...base, measuredWords: measurePrefix(text, 6), audioDurationMs: 0 }),
    null,
    "a clip with no duration is refused",
  );
  {
    const duplicated = measurePrefix(text, 2);
    assert.equal(
      buildPartialAlignmentClock({ ...base, measuredWords: [duplicated[0], duplicated[0]] }),
      null,
      "the same script word claimed twice is refused",
    );
  }

  // ---- the threshold is tunable, with a sane default -------------------
  {
    assert.equal(DEFAULT_PARTIAL_ALIGNMENT_MIN_COVERAGE, 0.75);
    const previous = process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE;
    try {
      delete process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE;
      assert.equal(partialAlignmentMinCoverage(), DEFAULT_PARTIAL_ALIGNMENT_MIN_COVERAGE);
      process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE = "0.6";
      assert.equal(partialAlignmentMinCoverage(), 0.6, "a valid override is honoured");
      for (const bad of ["0", "-1", "1.5", "abc", ""]) {
        process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE = bad;
        assert.equal(partialAlignmentMinCoverage(), DEFAULT_PARTIAL_ALIGNMENT_MIN_COVERAGE,
          `an out-of-range override (${bad}) falls back to the default`);
      }
    } finally {
      if (previous === undefined) delete process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE;
      else process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE = previous;
    }
  }

  // ---- one shared span filler, not a second repairer -------------------
  const partial = fs.readFileSync("src/lib/mcp/partial-alignment.ts", "utf8");
  assert.match(partial, /fillUnverifiedSpans/, "gaps must be spanned by the shared acoustic helper");
  const acoustic = fs.readFileSync("src/lib/acoustic-subtitle-clock.ts", "utf8");
  assert.match(acoustic, /export function fillUnverifiedSpans/, "the helper must be the exported shared one");
  assert.equal(
    (acoustic.match(/uncertainRanges\.push\(/g) ?? []).length,
    1,
    "there is exactly one place that decides what an uncertain range is",
  );

  console.log("verify-partial-alignment: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

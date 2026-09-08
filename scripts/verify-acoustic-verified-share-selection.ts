import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  selectAcousticSubtitleClock,
  ACOUSTIC_PARTIAL_APPLY_MIN_VERIFIED_SHARE,
} from "../src/lib/acoustic-subtitle-selection";
import { tokenizeWords, type TimedWord } from "../src/lib/tts-timing";
import type { AcousticWorkerResult } from "../src/lib/acoustic-subtitle-worker";

// 40 Thai characters, 12 words. Dropping one interior word's characters leaves
// 11/12 = .916 verified (a well-verified partial clock); dropping two adjacent
// interior words leaves 10/12 = .833 (the existing "missing Thai word preserves
// the complete alignment" behaviour).
const text = "วันนี้เราจะมาเล่าเรื่องร้านเล็กในซอยเก่า";
const words = tokenizeWords(text);
const ONE_WORD = [9, 10];        // "จะ"
const TWO_WORDS = [9, 10, 11, 12]; // "จะมา"
const characterFor = (index: number) => ({
  startChar: index, endChar: index + 1,
  startMs: 1000 + index * 100, endMs: 1100 + index * 100, confidence: .99,
});
const resultFor = (dropped: number[], mode: "apply" | "shadow" = "apply"): AcousticWorkerResult => ({
  evidence: { status: "partial", mode, applied: false, version: "thai-ctc-v1", modelRevision: "fixture", durationMs: 1 },
  clock: {
    version: "thai-ctc-v1", modelRevision: "fixture", audioHash: "fixture", textHash: "fixture",
    audioDurationMs: 6000,
    characters: [...text].map((_, index) => index).filter(index => !dropped.includes(index)).map(characterFor),
  },
});
const select = (args: {
  dropped?: number[]; existingTimingSource?: string; mode?: "apply" | "shadow"; existingWords?: TimedWord[];
} = {}) => selectAcousticSubtitleClock({
  text,
  maxCardChars: 30,
  existingTimingSource: args.existingTimingSource ?? "forced_alignment",
  result: resultFor(args.dropped ?? ONE_WORD, args.mode ?? "apply"),
  ...(args.existingWords ? { existingWords: args.existingWords } : {}),
});

// (f) runs as a child process so the env override is parsed at module load.
if (process.env.HERO_VERIFY_MIN_SHARE_CHILD === "1") {
  assert.equal(ACOUSTIC_PARTIAL_APPLY_MIN_VERIFIED_SHARE, 0.99, "the env override configures the apply threshold");
  const raised = select();
  assert.equal(raised.replacement, undefined, "a raised threshold keeps the existing alignment clock");
  assert.equal(raised.evidence.applied, false);
  console.log("acoustic verified-share child PASS: env override raises the apply threshold");
  process.exit(0);
}

assert.equal(words.length, 12, "fixture word count anchors the verified-share arithmetic");
assert.equal(ACOUSTIC_PARTIAL_APPLY_MIN_VERIFIED_SHARE, 0.9, "default apply threshold");

// (a) A well-verified partial CTC clock replaces a drifting Gemini-ASR clock.
const applied = select();
assert(applied.replacement, "a >=90%-verified partial clock must replace the remote alignment");
assert.equal(applied.evidence.status, "partial", "interpolated spans keep their approximate provenance");
assert.equal(applied.evidence.applied, true);
assert.equal(applied.evidence.verifiedWordCount, 11);
assert.equal(applied.evidence.totalWordCount, 12);
assert(applied.evidence.uncertainRanges?.length, "the unsupported span stays labelled for card merging");
assert.equal(applied.replacement.words.length, 12);
assert.equal(applied.replacement.words[0].startMs, 1000, "replacement words carry CTC times");
assert.equal(applied.replacement.words[2].endMs, 1900, "the word before the gap keeps its acoustic end");
assert.equal(applied.replacement.fullText, text);
assert.equal(applied.replacement.audioDurationMs, 6000);

// (b) Below the threshold the existing complete alignment is preserved.
const belowShare = select({ dropped: TWO_WORDS });
assert.equal(belowShare.replacement, undefined, "a weakly verified partial clock never replaces a complete alignment");
assert.equal(belowShare.evidence.applied, false);
assert.equal(belowShare.evidence.verifiedWordCount, 10);
assert.equal(belowShare.evidence.totalWordCount, 12);

// (c) Provider-supplied and upload transcription clocks stay protected.
for (const source of ["provider_alignment", "upload_transcription"]) {
  const protectedClock = select({ existingTimingSource: source });
  assert.equal(protectedClock.replacement, undefined, `${source} must never be replaced by a partial clock`);
  assert.equal(protectedClock.evidence.applied, false);
}

// (d) Shadow mode never changes a rendered clock.
const shadow = select({ mode: "shadow" });
assert.equal(shadow.replacement, undefined, "shadow mode reports without replacing");
assert.equal(shadow.evidence.applied, false);
assert.equal(shadow.evidence.verifiedWordCount, 11, "shadow still records the projected coverage");

// (e) Disagreement telemetry, measured over verified words only.
assert.equal(applied.evidence.disagreementMaxMs, undefined, "no existing words means no disagreement measurement");
assert.equal(applied.evidence.disagreementMedianMs, undefined);
const uncertainStartChars = new Set(applied.replacement.words
  .filter(word => applied.evidence.uncertainRanges!.some(range =>
    word.startChar >= range.startChar && word.endChar <= range.endChar))
  .map(word => word.startChar));
assert.equal(uncertainStartChars.size, 1, "one interior word is unsupported");
let shifted = false;
const existingWords: TimedWord[] = applied.replacement.words.map((word) => {
  // An unverified word is excluded from the measurement however far it drifts.
  if (uncertainStartChars.has(word.startChar)) return { ...word, startMs: word.startMs + 50_000 };
  const offset = shifted ? 100 : 2_000;
  shifted = true;
  return { ...word, startMs: word.startMs + offset };
});
const measured = select({ existingWords });
assert.equal(measured.evidence.disagreementMaxMs, 2_000, "the widest verified disagreement is reported");
assert.equal(measured.evidence.disagreementMedianMs, 100, "the median verified disagreement is reported");
assert(measured.replacement, "measuring disagreement does not change the selection");
const partialMatch = select({ existingWords: existingWords.slice(1) }); // the +2000 word has no counterpart
assert.equal(partialMatch.evidence.disagreementMaxMs, 100, "unmatched words are skipped, not thrown on");
assert.equal(select({ existingWords: [] }).evidence.disagreementMaxMs, undefined, "no matched word means no measurement");
const shadowMeasured = select({ mode: "shadow", existingWords });
assert.equal(shadowMeasured.evidence.disagreementMaxMs, 2_000, "shadow mode still measures the disagreement");
assert.equal(shadowMeasured.replacement, undefined);

// (f) Env override, parsed once at module load.
const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
  env: { ...process.env, SUBTITLE_ACOUSTIC_MIN_VERIFIED_SHARE: "0.99", HERO_VERIFY_MIN_SHARE_CHILD: "1" },
  encoding: "utf8",
});
assert.equal(child.status, 0, `env-override child failed:\n${child.stdout}\n${child.stderr}`);
assert.match(child.stdout, /acoustic verified-share child PASS/);

console.log("acoustic verified-share selection PASS: well-verified partial applies, weak share preserved, provider protection, shadow, disagreement telemetry, env override");

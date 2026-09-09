import { fillUnverifiedSpans, type AcousticClock } from "@/lib/acoustic-subtitle-clock";
import { tokenizeWords } from "@/lib/tts-timing";

/**
 * HERO-13: keep the part of a forced alignment that did line up.
 *
 * `alignTranscriptWordsExactly` walks the script and the transcript together and
 * only reports success when both are consumed to the end. One bad chunk of a
 * multi-chunk transcript therefore threw away every word the other chunks had
 * measured, and the clip fell all the way back to the estimated
 * `tts_segment_timing` clock. Measured on production over 8 days: clips with a
 * script of 1800+ characters got no measured timing at all 88% of the time,
 * against 9% under 900 characters, because long audio is chunked (110 s) and
 * every extra chunk is another chance for the all-or-nothing rule to fire.
 *
 * This turns that into the same partial-credit shape the acoustic clock already
 * uses: the words that matched keep their measured timestamps, the rest are
 * spanned between them by `fillUnverifiedSpans` — one shared definition, not a
 * second repairer — and the spanned stretches come back as `uncertainRanges` so
 * the caller can group those cards rather than flash them one by one.
 *
 * Nothing here is a gate. Below `minCoverage`, or on any inconsistency, this
 * returns null and the caller falls back exactly as it does today.
 */

export type PartialAlignmentClock = AcousticClock & {
  /** Share of the script's words that carry a measured timestamp, 0..1. */
  coverage: number;
};

export const DEFAULT_PARTIAL_ALIGNMENT_MIN_COVERAGE = 0.75;

/**
 * Read the apply threshold. Deliberately env-tunable: the default is a first
 * estimate, and `partialCoverage` telemetry is emitted on every partial so it
 * can be moved from measured production data rather than from taste.
 */
export function partialAlignmentMinCoverage(): number {
  const raw = Number(process.env.SUBTITLE_PARTIAL_ALIGNMENT_MIN_COVERAGE);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_PARTIAL_ALIGNMENT_MIN_COVERAGE;
  return raw;
}

/**
 * Project the measured words onto the full script and span the gaps.
 *
 * `measuredWords` must be a subset of `tokenizeWords(fullText)` identified by
 * exact character offsets — the same offsets the caption builder uses — so a
 * word can never receive the timing of a different word. Any measured word that
 * does not sit exactly on a script word, runs backwards, or falls outside the
 * audio is treated as evidence that the projection is untrustworthy, and the
 * whole thing is refused rather than partially believed.
 */
export function buildPartialAlignmentClock(args: {
  fullText: string;
  measuredWords: Array<{ word: string; startChar: number; endChar: number; startMs: number; endMs: number }>;
  audioDurationMs: number;
  minCoverage?: number;
}): PartialAlignmentClock | null {
  const { fullText, measuredWords, audioDurationMs } = args;
  const minCoverage = args.minCoverage ?? partialAlignmentMinCoverage();
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) return null;
  if (!fullText.trim() || measuredWords.length === 0) return null;

  const baseline = tokenizeWords(fullText);
  if (baseline.length === 0) return null;

  const measuredByStartChar = new Map<number, (typeof measuredWords)[number]>();
  let previousEndMs = -1;
  for (const measured of measuredWords) {
    if (!Number.isInteger(measured.startChar) || !Number.isInteger(measured.endChar)) return null;
    if (!Number.isFinite(measured.startMs) || !Number.isFinite(measured.endMs)) return null;
    if (measured.startMs < 0 || measured.endMs <= measured.startMs) return null;
    if (measured.endMs > audioDurationMs) return null;
    // Monotonic in time, and each word may only be claimed once.
    if (measured.startMs < previousEndMs) return null;
    if (measuredByStartChar.has(measured.startChar)) return null;
    previousEndMs = measured.endMs;
    measuredByStartChar.set(measured.startChar, measured);
  }

  let verifiedWordCount = 0;
  const projected = baseline.map((word) => {
    const measured = measuredByStartChar.get(word.startChar);
    const usable = Boolean(measured)
      && measured!.endChar === word.endChar
      && fullText.slice(word.startChar, word.endChar) === word.word;
    if (usable) verifiedWordCount += 1;
    return {
      word: word.word,
      startChar: word.startChar,
      endChar: word.endChar,
      startMs: usable ? measured!.startMs : 0,
      endMs: usable ? measured!.endMs : 0,
      verified: usable,
    };
  });

  // A measured word that matched nothing in the script means the caller handed
  // us words from a different tokenisation; refuse rather than guess.
  if (verifiedWordCount !== measuredByStartChar.size) return null;

  const coverage = verifiedWordCount / baseline.length;
  if (coverage < minCoverage) return null;

  const clock = fillUnverifiedSpans(projected, audioDurationMs);
  if (!clock) return null;
  return { ...clock, coverage };
}

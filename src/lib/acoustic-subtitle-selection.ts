import { tokenizeWords, type TimedWord } from "@/lib/tts-timing";
import { buildCanonicalCaptionsFromAlignedWords } from "@/lib/mcp/subtitle-quality";
import { projectAcousticClock, type AcousticClock, type AcousticEvidence } from "@/lib/acoustic-subtitle-clock";
import type { AcousticWorkerResult } from "@/lib/acoustic-subtitle-worker";

const configuredMinVerifiedShare = Number(process.env.SUBTITLE_ACOUSTIC_MIN_VERIFIED_SHARE);
/** A remote alignment carries no acoustic evidence of its own: production clips it
 * called "aligned" rendered whole passages seconds early. An acoustic clock that
 * verified nearly every word is the better render clock even when a few spans stay
 * interpolated. Parsed once — this is a rollout knob, not a per-job decision. */
export const ACOUSTIC_PARTIAL_APPLY_MIN_VERIFIED_SHARE =
  Number.isFinite(configuredMinVerifiedShare) && configuredMinVerifiedShare > 0
    ? Math.min(1, Math.max(.5, configuredMinVerifiedShare))
    : .9;

/** Measure the two clocks against each other over the words the acoustic pass
 * actually verified; interpolated spans carry no opinion. Unmatched words are
 * skipped so a shorter or differently tokenised existing clock cannot throw. */
function measureDisagreement(projected: AcousticClock, existingWords: TimedWord[]) {
  const existingStartMs = new Map(existingWords.map(word => [word.startChar, word.startMs]));
  const deltas = projected.words
    .filter(word => !projected.uncertainRanges.some(range =>
      word.startChar >= range.startChar && word.endChar <= range.endChar))
    .map(word => Math.abs(word.startMs - (existingStartMs.get(word.startChar) ?? NaN)))
    .filter(delta => Number.isFinite(delta))
    .sort((a, b) => a - b);
  if (!deltas.length) return {};
  const middle = deltas.length >> 1;
  return {
    disagreementMaxMs: Math.round(deltas[deltas.length - 1]),
    disagreementMedianMs: Math.round(deltas.length % 2 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2),
  };
}

/** Partial lexical coverage preserves existing complete alignment, unless the
 * acoustic pass verified nearly every word. A narrowly bounded Thai repetition
 * mark may bridge otherwise verified Thai words, while keeping its partial
 * provenance. Provider-supplied alignment stays protected. */
export function selectAcousticSubtitleClock(args: {
  text: string;
  maxCardChars: number;
  existingTimingSource: string;
  result: AcousticWorkerResult;
  /** The clock that is already rendering, on the same char offsets as
   * `tokenizeWords(text)`. Telemetry only: it never changes the selection. */
  existingWords?: TimedWord[];
}): {
  evidence: AcousticEvidence;
  replacement?: {
    words: TimedWord[];
    captions: NonNullable<ReturnType<typeof buildCanonicalCaptionsFromAlignedWords>>;
    audioDurationMs: number;
    fullText: string;
  };
} {
  const { clock } = args.result;
  const evidence = { ...args.result.evidence };
  if (!clock) return { evidence };
  const projected = projectAcousticClock({
    text: args.text,
    baselineWords: tokenizeWords(args.text).map(word => ({ ...word, startMs: 0, endMs: 0 })),
    characters: clock.characters,
    audioDurationMs: clock.audioDurationMs,
  });
  if (!projected) return { evidence };
  Object.assign(evidence, {
    status: projected.uncertainRanges.length ? "partial" : "aligned",
    verifiedWordCount: projected.verifiedWordCount,
    totalWordCount: projected.totalWordCount,
    uncertainRanges: projected.uncertainRanges,
    ...(args.existingWords?.length ? measureDisagreement(projected, args.existingWords) : {}),
  });
  if (evidence.mode !== "apply") return { evidence };
  const canRepairEstimate = args.existingTimingSource === "tts_segment_timing"
    || args.existingTimingSource === "avatar_script_clock";
  const onlyBoundedRepeats = args.existingTimingSource === "forced_alignment"
    && projected.uncertainRanges.every(range =>
      args.text.slice(range.startChar, range.endChar).trim() === "ๆ"
      && range.startMs > 0 && range.endMs < clock.audioDurationMs
      && range.endMs - range.startMs <= 1500);
  const wellVerifiedPartial = args.existingTimingSource === "forced_alignment"
    && projected.totalWordCount > 0
    && projected.verifiedWordCount / projected.totalWordCount >= ACOUSTIC_PARTIAL_APPLY_MIN_VERIFIED_SHARE;
  if (projected.uncertainRanges.length && !canRepairEstimate && !onlyBoundedRepeats && !wellVerifiedPartial) {
    return { evidence };
  }
  const captions = buildCanonicalCaptionsFromAlignedWords(args.text, projected.words, args.maxCardChars);
  if (!captions) return { evidence };
  evidence.applied = true;
  return { evidence, replacement: { words: projected.words, captions,
    audioDurationMs: clock.audioDurationMs, fullText: args.text } };
}

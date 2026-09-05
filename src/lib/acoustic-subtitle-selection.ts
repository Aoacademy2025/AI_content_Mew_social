import { tokenizeWords, type TimedWord } from "@/lib/tts-timing";
import { buildCanonicalCaptionsFromAlignedWords } from "@/lib/mcp/subtitle-quality";
import { projectAcousticClock, type AcousticEvidence } from "@/lib/acoustic-subtitle-clock";
import type { AcousticWorkerResult } from "@/lib/acoustic-subtitle-worker";

/** Partial lexical coverage preserves existing complete alignment. A narrowly
 * bounded Thai repetition mark may bridge otherwise verified Thai words, while
 * keeping its partial provenance. Provider-supplied alignment stays protected. */
export function selectAcousticSubtitleClock(args: {
  text: string;
  maxCardChars: number;
  existingTimingSource: string;
  result: AcousticWorkerResult;
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
  });
  if (evidence.mode !== "apply") return { evidence };
  const canRepairEstimate = args.existingTimingSource === "tts_segment_timing"
    || args.existingTimingSource === "avatar_script_clock";
  const onlyBoundedRepeats = args.existingTimingSource === "forced_alignment"
    && projected.uncertainRanges.every(range =>
      args.text.slice(range.startChar, range.endChar).trim() === "ๆ"
      && range.startMs > 0 && range.endMs < clock.audioDurationMs
      && range.endMs - range.startMs <= 1500);
  if (projected.uncertainRanges.length && !canRepairEstimate && !onlyBoundedRepeats) return { evidence };
  const captions = buildCanonicalCaptionsFromAlignedWords(args.text, projected.words, args.maxCardChars);
  if (!captions) return { evidence };
  evidence.applied = true;
  return { evidence, replacement: { words: projected.words, captions,
    audioDurationMs: clock.audioDurationMs, fullText: args.text } };
}

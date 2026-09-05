import { tokenizeWords, type TimedWord } from "@/lib/tts-timing";
import { buildCanonicalCaptionsFromAlignedWords } from "@/lib/mcp/subtitle-quality";
import { projectAcousticClock, type AcousticEvidence } from "@/lib/acoustic-subtitle-clock";
import type { AcousticWorkerResult } from "@/lib/acoustic-subtitle-worker";

/** Promotion policy is independent of subprocess/cache availability. A partial
 * acoustic result can repair an estimated clock, but cannot downgrade a clock
 * that already has complete acoustic/provider alignment. */
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
  if (projected.uncertainRanges.length && !canRepairEstimate) return { evidence };
  const captions = buildCanonicalCaptionsFromAlignedWords(args.text, projected.words, args.maxCardChars);
  if (!captions) return { evidence };
  evidence.applied = true;
  return { evidence, replacement: { words: projected.words, captions,
    audioDurationMs: clock.audioDurationMs, fullText: args.text } };
}

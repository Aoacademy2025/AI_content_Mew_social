/**
 * ADR 0056 — partial transcription coverage is a warning, not a refusal.
 *
 * The decision rules `POST /api/videos/transcribe` applies when a slice has spent its whole
 * bounded retry budget, kept pure and exported so the verification fixtures assert the
 * SHIPPED rule instead of a replica of it.
 */

export const TRANSCRIBE_WARNING_CODES = [
  "transcribe_incomplete",
  "transcribe_desynced",
  "word_timing_incomplete",
  "chunk_recovery_exhausted",
] as const;

export type TranscribeWarningCode = (typeof TRANSCRIBE_WARNING_CODES)[number];

export type TranscribeWarning = {
  code: TranscribeWarningCode;
  /** Start of the span the route could not prove complete (source-audio timeline). */
  fromMs?: number;
  /** End of that span. Both bounds are absent for a whole-clip finding. */
  toMs?: number;
};

/**
 * Append a finding, merging it into the previous entry when both describe the same code over
 * touching spans. Slices are reported in timeline order, so a chunk that fails at every
 * recovery level yields ONE range instead of one entry per fine slice. A whole-clip finding
 * (no span) is never duplicated. Mutates and returns `warnings`.
 */
export function mergeTranscribeWarning(
  warnings: TranscribeWarning[],
  code: TranscribeWarningCode,
  fromMs?: number,
  toMs?: number,
): TranscribeWarning[] {
  const from = Number.isFinite(fromMs) ? Math.max(0, Math.round(fromMs as number)) : undefined;
  const to = Number.isFinite(toMs) ? Math.max(0, Math.round(toMs as number)) : undefined;
  const last = warnings[warnings.length - 1];
  if (last && last.code === code) {
    // The same whole-clip finding reported twice by two layers.
    if (from === undefined && to === undefined && last.fromMs === undefined && last.toMs === undefined) {
      return warnings;
    }
    if (
      from !== undefined && to !== undefined
      && last.fromMs !== undefined && last.toMs !== undefined
      && from <= last.toMs && to >= last.fromMs
    ) {
      last.fromMs = Math.min(last.fromMs, from);
      last.toMs = Math.max(last.toMs, to);
      return warnings;
    }
  }
  warnings.push({
    code,
    ...(from !== undefined ? { fromMs: from } : {}),
    ...(to !== undefined ? { toMs: to } : {}),
  });
  return warnings;
}

/**
 * What a slice that exhausted its bounded retry budget is actually reporting.
 *
 * `preSanitizeCoveredEndMs` MUST be the last caption end of the RAW provider result:
 * `sanitizeChunkTimeline()` linearly rescales an overshooting timeline back inside the slice,
 * so measuring after it turns every real desync into a bogus "incomplete".
 *
 * A gap smaller than `gapThresholdMs` in either direction is not a coverage finding at all —
 * the slice was rejected for some other reason (typically an unusable word clock), and
 * emitting a zero-span `transcribe_incomplete` beside it would be noise.
 */
export function classifyExhaustedSlice(input: {
  preSanitizeCoveredEndMs: number;
  referenceMs: number;
  hasUsableWords: boolean;
  gapThresholdMs: number;
}): TranscribeWarning[] {
  const { preSanitizeCoveredEndMs, referenceMs, hasUsableWords, gapThresholdMs } = input;
  const out: TranscribeWarning[] = [];
  if (referenceMs > 0 && Number.isFinite(preSanitizeCoveredEndMs)) {
    const gapMs = preSanitizeCoveredEndMs - referenceMs;
    if (gapMs > gapThresholdMs) {
      mergeTranscribeWarning(out, "transcribe_desynced", referenceMs, preSanitizeCoveredEndMs);
    } else if (-gapMs > gapThresholdMs) {
      mergeTranscribeWarning(out, "transcribe_incomplete", Math.max(0, preSanitizeCoveredEndMs), referenceMs);
    }
  }
  if (!hasUsableWords) mergeTranscribeWarning(out, "word_timing_incomplete");
  return out;
}

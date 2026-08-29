export const SUBTITLE_ALIGNMENT_MAX_ATTEMPTS = 2;

// These outcomes describe an unavailable or incomplete timing measurement, not
// a changed narration. Repeating transcription once reuses the same TTS master
// and does not spend on another voice generation or restart the whole VideoJob.
const TECHNICAL_ALIGNMENT_RETRY_CODES = new Set([
  "word_timing_incomplete",
  "empty_captions",
  "empty_transcript",
  "no_usable_words",
  "transcribe_request_failed",
  "transcribe_incomplete",
  "transcribe_desynced",
  "incomplete_alignment",
]);

export type SubtitleAlignmentRetryDirective = {
  nextAttempt: number;
  delayMs: number;
};

export function subtitleAlignmentTechnicalRetryDirective(
  code: string | null | undefined,
  completedRetries: number,
): SubtitleAlignmentRetryDirective | null {
  if (!code || !TECHNICAL_ALIGNMENT_RETRY_CODES.has(code) || completedRetries >= 1) return null;
  return { nextAttempt: completedRetries + 2, delayMs: 500 };
}

export const SUBTITLE_SPEECH_TAIL_TOLERANCE_MS = 5_000;

export type SubtitleSpeechCoverage = {
  source: "silence_analysis" | "upload_transcription";
  /** Last millisecond that the acoustic analysis still requires subtitles to cover. */
  spokenEndMs: number;
};

export type SubtitleSpeechCoverageAssessment =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "passed"; gapMs: number }
  | { status: "incomplete"; gapMs: number };

export function parseSubtitleSpeechCoverage(value: unknown): SubtitleSpeechCoverage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return (candidate.source === "silence_analysis" || candidate.source === "upload_transcription")
    && typeof candidate.spokenEndMs === "number"
    && Number.isFinite(candidate.spokenEndMs)
    && candidate.spokenEndMs >= 0
    ? {
        source: candidate.source,
        spokenEndMs: candidate.spokenEndMs,
      }
    : null;
}

export function subtitleTimingRequiresSpeechCoverage(timingSource: string): boolean {
  return timingSource === "forced_alignment" || timingSource === "partial_forced_alignment" || timingSource === "upload_transcription";
}

/** Shared runtime/audit invariant for the spoken tail of an acoustic timeline. */
export function assessSubtitleSpeechCoverage(input: {
  captions: Array<{ endMs: number }>;
  audioDurationMs: number;
  speechCoverage: SubtitleSpeechCoverage | null | undefined;
}): SubtitleSpeechCoverageAssessment {
  if (!input.speechCoverage) return { status: "missing" };
  const spokenEndMs = input.speechCoverage.spokenEndMs;
  const lastCaption = input.captions.at(-1);
  if (
    !lastCaption
    || !Number.isFinite(lastCaption.endMs)
    || !Number.isFinite(input.audioDurationMs)
    || input.audioDurationMs <= 0
    || spokenEndMs < 0
    || spokenEndMs > input.audioDurationMs + 250
  ) {
    return { status: "invalid" };
  }
  const gapMs = spokenEndMs - lastCaption.endMs;
  return gapMs > SUBTITLE_SPEECH_TAIL_TOLERANCE_MS
    ? { status: "incomplete", gapMs }
    : { status: "passed", gapMs };
}

import { sanitizeChunkTimeline } from "@/lib/transcribe-timeline";
import type { DesktopSttResult } from "./types";

export function sanitizeDesktopTranscript(
  raw: DesktopSttResult,
  durationSec: number,
): DesktopSttResult {
  const durationMs = Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : 0;
  const words = raw.words.map((word) => ({ word: word.w, start: word.start, end: word.end }));
  const segments = raw.segments;
  const geminiDirectCaptions = segments.map((segment) => ({
    text: segment.text,
    startMs: segment.start * 1000,
    endMs: segment.end * 1000,
    timestampMs: segment.start * 1000,
    confidence: 1,
  }));
  const fullText = segments.map((segment) => segment.text).join(" ")
    || words.map((word) => word.word).join("");
  const sanitized = sanitizeChunkTimeline(
    { words, segments, geminiDirectCaptions, fullText },
    durationMs,
  );
  return {
    words: sanitized.words.map((word) => ({ w: word.word, start: word.start, end: word.end })),
    segments: sanitized.segments,
    language: raw.language,
    provider: raw.provider,
  };
}

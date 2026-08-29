import {
  TRANSCRIBE_CHUNK_MAX_MS,
  planTranscriptionChunkBoundaries,
} from "@/lib/transcribe-timeline";

export type StoryFilmAlignmentWord = {
  word: string;
  startMs: number;
  endMs: number;
};

export type StoryFilmAlignmentChunk = {
  startMs: number;
  endMs: number;
  durationMs: number;
};

// Forced alignment drives per-word editorial timing, so its spoken-tail gate
// is deliberately stricter than the generic transcript fallback. The old Mew
// track ended 2.36s before speech and accumulated visibly early captions.
export const STORY_FILM_ALIGNMENT_SPEECH_TAIL_TOLERANCE_MS = 1_200;

export function planStoryFilmAlignmentChunks(
  durationMs: number,
  silenceCutPointsMs: number[],
): StoryFilmAlignmentChunk[] {
  if (!(durationMs > 0)) return [];
  const cuts = durationMs > TRANSCRIBE_CHUNK_MAX_MS
    ? planTranscriptionChunkBoundaries(durationMs, silenceCutPointsMs)
    : [];
  const bounds = [0, ...cuts, durationMs];
  return bounds.slice(0, -1).map((startMs, index) => {
    const endMs = bounds[index + 1];
    return { startMs, endMs, durationMs: endMs - startMs };
  });
}

export function storyFilmAlignmentHasSpeechTailCoverage(
  words: StoryFilmAlignmentWord[],
  spokenEndMs: number,
): boolean {
  if (!(spokenEndMs > 0) || words.length === 0) return false;
  const lastEndMs = words.reduce((latest, word) => Math.max(latest, word.endMs), 0);
  return spokenEndMs - lastEndMs <= STORY_FILM_ALIGNMENT_SPEECH_TAIL_TOLERANCE_MS;
}

export function storyFilmAlignmentScriptSlice(input: {
  script: string;
  startMs: number;
  durationMs: number;
  totalDurationMs: number;
}) {
  if (!input.script || !(input.totalDurationMs > 0)) return "";
  const lo = Math.max(0, input.startMs / input.totalDurationMs - 0.12);
  const hi = Math.min(1, (input.startMs + input.durationMs) / input.totalDurationMs + 0.12);
  return input.script.slice(
    Math.floor(input.script.length * lo),
    Math.ceil(input.script.length * hi),
  );
}

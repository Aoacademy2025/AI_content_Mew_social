// Guards for Gemini word/caption timestamps on chunked long-audio transcribes.
//
// Prod 2026-06-12 (285s clip, 2 chunks): chunk 2 returned 108 words for 105
// captions — a truncated/degenerate words array whose timestamps ran past the
// chunk length. The server only clamps CAPTIONS, so the raw words reached the
// editor, and the "แบ่งซับ N คำ" button (which rebuilds captions purely from
// words) produced a 411s subtitle timeline on a 285s clip: the player showed
// 6:51 and the caption↔video mapper (k = captionEnd/duration = 1.44) ran every
// subtitle 1.44× ahead of the audio from the first second.
//
// Unit conventions follow transcribe/route.ts internals:
//   words/segments are in SECONDS, captions in MILLISECONDS.
// boundWordsForSplit() uses the client shape (startMs/endMs).

export type ChunkWord = { word: string; start: number; end: number };
export type ChunkSegment = { text: string; start: number; end: number };
export type ChunkCaption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number;
  confidence: number;
  tag?: "hook" | "body" | "cta";
};

export type ChunkResult = {
  words: ChunkWord[];
  segments: ChunkSegment[];
  geminiDirectCaptions: ChunkCaption[];
  fullText: string;
};

export type SanitizedChunk = ChunkResult & {
  stats: {
    wordsDropped: number;
    wordsDegenerate: boolean;
    rescaleK: number;
  };
};

// Timestamps may legitimately run slightly past the slice end (codec frame
// padding, breath tails) — anything beyond this margin is hallucinated.
const BOGUS_MARGIN_MS = 2000;

// Real speech carries several words per subtitle card (Thai viral cards are
// 3-8 words; prod healthy chunk: 549 words / 98 captions ≈ 5.6). A words array
// that is not even 2× the caption count is a truncated/degenerate response —
// rebuilding captions from it desyncs, so it is safer to drop it entirely and
// let the segment-based interpolation produce full-coverage word timing.
const MIN_WORDS_PER_CAPTION = 2;

export function sanitizeChunkTimeline(r: ChunkResult, chunkDurationMs: number): SanitizedChunk {
  if (!(chunkDurationMs > 0)) {
    return { ...r, stats: { wordsDropped: 0, wordsDegenerate: false, rescaleK: 1 } };
  }
  const limitSec = (chunkDurationMs + BOGUS_MARGIN_MS) / 1000;

  // 1) Progressive tail drift: the LAST caption overshooting the chunk length
  //    is the signature of Gemini losing sync over the chunk. Linear-rescale
  //    the whole chunk timeline onto the real duration instead of letting the
  //    downstream clamp squeeze everything into the tail.
  //    (When the drift is big — > CHUNK_DESYNC_RETRY_RATIO — the caller should
  //    have retried the chunk first; this rescale is the best-effort fallback.)
  const captions = r.geminiDirectCaptions;
  const lastEndMs = captions.length > 0 ? captions[captions.length - 1].endMs : 0;
  const rescaleK = lastEndMs > chunkDurationMs + BOGUS_MARGIN_MS ? chunkDurationMs / lastEndMs : 1;

  // 2) Drop hallucinated words — AFTER applying the rescale, because with
  //    uniform drift the tail words map back INSIDE the chunk. Filtering first
  //    (prod 06-12: 327/502 kept) deleted the words for the last ~30s of real
  //    audio → word-split subtitles vanished in stretches.
  const keptWords = r.words
    .map((w) => ({ ...w, start: w.start * rescaleK, end: w.end * rescaleK }))
    .filter(
      (w) =>
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        w.start >= 0 &&
        w.end > w.start &&
        w.end <= limitSec,
    );
  const wordsDropped = r.words.length - keptWords.length;

  const limitMs = chunkDurationMs + BOGUS_MARGIN_MS;
  const clampMs = (v: number) => Math.min(Math.max(0, Math.round(v * rescaleK)), limitMs);
  const scaledCaptions = captions.map((c) => {
    const startMs = Math.min(clampMs(c.startMs), limitMs - 1);
    const endMs = Math.min(Math.max(startMs + 1, clampMs(c.endMs)), limitMs);
    return { ...c, startMs, endMs, timestampMs: startMs };
  });
  const clampSec = (v: number) => Math.min(Math.max(0, v * rescaleK), limitSec);
  const scaledSegments = r.segments.map((s) => {
    const start = clampSec(s.start);
    return { ...s, start, end: Math.max(start + 0.001, clampSec(s.end)) };
  });
  // keptWords are already rescaled+bounded above — no further transform.
  const scaledWords = keptWords;

  // 3) Degenerate words → zero them out so the caller falls back to
  //    segment-based interpolation (full coverage, bounded timing).
  const wordsDegenerate =
    scaledCaptions.length > 0 && scaledWords.length < scaledCaptions.length * MIN_WORDS_PER_CAPTION;

  return {
    words: wordsDegenerate ? [] : scaledWords,
    segments: scaledSegments,
    geminiDirectCaptions: scaledCaptions,
    fullText: r.fullText,
    stats: { wordsDropped, wordsDegenerate, rescaleK },
  };
}

// How far past its real slice length a chunk's transcript may run before the
// chunk is considered desynced and worth RE-TRANSCRIBING (Gemini flash is
// non-deterministic — a re-roll usually re-syncs; same spirit as the old
// single-call desync guard). Prod 06-12 #2: chunk 1 overshot ×1.264 and the
// blanket rescale dragged its correct early captions out of sync instead.
export const CHUNK_DESYNC_RETRY_RATIO = 1.10;

// Ratio of the chunk transcript's reported end vs the real slice length.
// 1 = in sync (or nothing to measure). Caller retries when > CHUNK_DESYNC_RETRY_RATIO.
export function chunkOvershootRatio(captions: ChunkCaption[], chunkDurationMs: number): number {
  if (!(chunkDurationMs > 0) || captions.length === 0) return 1;
  const lastEndMs = captions[captions.length - 1].endMs;
  return lastEndMs > 0 ? lastEndMs / chunkDurationMs : 1;
}

// ── Client-side guard for the "แบ่งซับ N คำ" rebuild ──
// Drops words outside the real audio duration and reports whether what is left
// still covers the timeline well enough to rebuild captions from. When it does
// not (e.g. only the first chunk survived), the caller must fall back to
// proportional splitting inside the original captions instead of producing a
// stretched/holey subtitle timeline.
export type ClientWord = { word: string; startMs: number; endMs: number };

const MIN_COVERAGE = 0.85;

export function boundWordsForSplit(
  words: ClientWord[],
  audioDurationMs: number,
): { words: ClientWord[]; coverageOk: boolean } {
  if (!(audioDurationMs > 0)) {
    return { words, coverageOk: words.length > 0 };
  }
  const kept = words.filter(
    (w) =>
      Number.isFinite(w.startMs) &&
      Number.isFinite(w.endMs) &&
      w.startMs >= 0 &&
      w.endMs > w.startMs &&
      w.endMs <= audioDurationMs + BOGUS_MARGIN_MS,
  );
  const maxEndMs = kept.reduce((max, w) => Math.max(max, w.endMs), 0);
  const coverageOk = kept.length > 0 && maxEndMs >= audioDurationMs * MIN_COVERAGE;
  return { words: kept, coverageOk };
}

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

// Keep the long-audio planning policy in a Prisma-free module so the production
// route and its regression harness exercise the same seam.
export const TRANSCRIBE_CHUNK_MAX_MS = 110_000;
export const TRANSCRIBE_CHUNK_MIN_MS = 30_000;
export const TRANSCRIBE_CHUNK_TARGET_MS = 75_000;
export const TRANSCRIBE_RECOVERY_MAX_MS = 45_000;
export const TRANSCRIBE_TRAILING_SILENCE_MIN_MS = 3_000;

export type TranscriptionSilenceAnalysis = {
  cutPointsMs: number[];
  trailingSilenceStartMs: number | null;
};

/** Parse ffmpeg silencedetect output once for both chunk boundaries and
 * trailing silence at EOF. ffmpeg may report that tail as open-ended or emit a
 * `silence_end` a codec frame before total duration; both prove that media
 * duration extends beyond the last spoken word. */
export function parseTranscriptionSilenceAnalysis(
  stderr: string,
  totalDurationMs: number,
): TranscriptionSilenceAnalysis {
  const cutPointsMs: number[] = [];
  let openSilenceStartMs: number | null = null;
  let lastSilence: { startMs: number; endMs: number } | null = null;
  const event = /silence_(start|end):\s*([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = event.exec(stderr || "")) !== null) {
    const ms = Math.round(Number.parseFloat(match[2]) * 1000);
    if (!Number.isFinite(ms) || ms < 0) continue;
    if (match[1] === "start") {
      openSilenceStartMs = ms;
    } else {
      cutPointsMs.push(ms);
      if (openSilenceStartMs !== null) {
        lastSilence = { startMs: openSilenceStartMs, endMs: ms };
      }
      openSilenceStartMs = null;
    }
  }
  const closedAtEofStartMs = lastSilence
    && Math.abs(totalDurationMs - lastSilence.endMs) <= 1_000
    && lastSilence.endMs - lastSilence.startMs >= TRANSCRIBE_TRAILING_SILENCE_MIN_MS
    ? lastSilence.startMs
    : null;
  const trailingSilenceStartMs = openSilenceStartMs !== null
      && totalDurationMs - openSilenceStartMs >= TRANSCRIBE_TRAILING_SILENCE_MIN_MS
    ? openSilenceStartMs
    : closedAtEofStartMs;
  return {
    cutPointsMs: [...new Set(cutPointsMs)].sort((a, b) => a - b),
    trailingSilenceStartMs,
  };
}

/** Duration the final chunk's transcript is expected to cover. Only a proven
 * trailing silence at EOF can shorten it; internal chunks and ordinary
 * tails still use their full slice duration so real missing speech stays red. */
export function chunkTranscriptionReferenceDurationMs(input: {
  chunkStartMs: number;
  chunkDurationMs: number;
  totalDurationMs: number;
  trailingSilenceStartMs: number | null;
}): number {
  const chunkEndMs = input.chunkStartMs + input.chunkDurationMs;
  const isFinalChunk = Math.abs(chunkEndMs - input.totalDurationMs) <= 1_000;
  const silenceStart = input.trailingSilenceStartMs;
  if (
    !isFinalChunk
    || silenceStart === null
    || silenceStart <= input.chunkStartMs
    || silenceStart >= chunkEndMs
  ) return input.chunkDurationMs;
  return Math.max(1_000, silenceStart - input.chunkStartMs);
}

/**
 * Return balanced internal cut points (milliseconds), preferring detected
 * silence without ever creating a >110s chunk or a tiny tail. The old route
 * gated this planner at 240s, leaving the 110-240s reliability gap that caused
 * the production 180.11s/200.12s failures.
 */
export function planTranscriptionChunkBoundaries(totalMs: number, silences: number[]): number[] {
  if (!(totalMs > TRANSCRIBE_CHUNK_MAX_MS)) return [];
  // Keep exact audio anchors around the original proven 75s target. The prior
  // balanced-by-110s planner turned a 180.11s production upload into two 90s
  // calls; Gemini repeatedly truncated the second call. Three balanced ~60s
  // windows stay well inside the timestamp-reliable zone without a tiny tail.
  const chunkCount = Math.max(2, Math.ceil(totalMs / TRANSCRIBE_CHUNK_TARGET_MS));
  const cuts: number[] = [];
  let lastCut = 0;
  for (let index = 1; index < chunkCount; index++) {
    const remainingChunks = chunkCount - index;
    const target = Math.round((totalMs * index) / chunkCount);
    const lo = Math.max(
      lastCut + TRANSCRIBE_CHUNK_MIN_MS,
      totalMs - remainingChunks * TRANSCRIBE_CHUNK_MAX_MS,
    );
    const hi = Math.min(
      lastCut + TRANSCRIBE_CHUNK_MAX_MS,
      totalMs - remainingChunks * TRANSCRIBE_CHUNK_MIN_MS,
    );
    const boundedTarget = Math.max(lo, Math.min(hi, target));
    let best = -1;
    let bestDist = Infinity;
    for (const silence of silences) {
      if (silence < lo || silence > hi) continue;
      const dist = Math.abs(silence - boundedTarget);
      if (dist < bestDist) {
        bestDist = dist;
        best = silence;
      }
    }
    const cut = best >= 0 ? best : boundedTarget;
    cuts.push(cut);
    lastCut = cut;
  }
  return cuts;
}

/**
 * After three model attempts fail on one otherwise valid primary chunk, split
 * only that failed region into balanced 30–45s recovery calls. Healthy chunks
 * are left untouched, so reliability improves without doubling normal cost.
 */
export function planTranscriptionRecoveryBoundaries(totalMs: number): number[] {
  if (!(totalMs > TRANSCRIBE_RECOVERY_MAX_MS)) return [];
  const chunkCount = Math.ceil(totalMs / TRANSCRIBE_RECOVERY_MAX_MS);
  return Array.from({ length: chunkCount - 1 }, (_, index) =>
    Math.round((totalMs * (index + 1)) / chunkCount));
}

export type RawGeminiWord = {
  word?: unknown;
  start?: unknown;
  end?: unknown;
  startMs?: unknown;
  endMs?: unknown;
};

export type NormalizedGeminiWords = {
  words: ChunkWord[];
  detectedUnit: "seconds" | "milliseconds" | "mixed" | "invalid";
};

/**
 * Normalize Gemini word timestamps to the route's internal seconds unit.
 * New prompts request explicit startMs/endMs. Legacy start/end responses are
 * duration-classified because Gemini sometimes returned milliseconds there,
 * which the old parser multiplied by another 1000 (135s → 135,000,000ms).
 */
export function normalizeGeminiWords(
  rawWords: RawGeminiWord[],
  audioDurationMs: number,
): NormalizedGeminiWords {
  const explicitMs = rawWords.filter(
    (word) =>
      typeof word.word === "string"
      && typeof word.startMs === "number"
      && Number.isFinite(word.startMs)
      && typeof word.endMs === "number"
      && Number.isFinite(word.endMs),
  );
  const legacy = rawWords.filter(
    (word) =>
      typeof word.word === "string"
      && typeof word.start === "number"
      && Number.isFinite(word.start)
      && typeof word.end === "number"
      && Number.isFinite(word.end),
  );

  let legacyUnit: "seconds" | "milliseconds" | "invalid" = "seconds";
  if (legacy.length > 0 && audioDurationMs > 0) {
    const maxEnd = Math.max(...legacy.map((word) => word.end as number));
    const secondsLimit = audioDurationMs / 1000 * 1.2 + 2;
    const millisecondsLimit = audioDurationMs * 1.2 + 2000;
    legacyUnit = maxEnd <= secondsLimit
      ? "seconds"
      : maxEnd <= millisecondsLimit
        ? "milliseconds"
        : "invalid";
  }

  const durationLimitSec = audioDurationMs > 0
    ? (audioDurationMs + 2000) / 1000
    : Number.POSITIVE_INFINITY;
  const words: ChunkWord[] = [];
  for (const word of explicitMs) {
    const start = (word.startMs as number) / 1000;
    const end = (word.endMs as number) / 1000;
    if (start >= 0 && end > start && end <= durationLimitSec) {
      words.push({ word: (word.word as string).trim(), start, end });
    }
  }
  if (legacyUnit !== "invalid") {
    const scale = legacyUnit === "milliseconds" ? 1 / 1000 : 1;
    for (const word of legacy) {
      const start = (word.start as number) * scale;
      const end = (word.end as number) * scale;
      if (start >= 0 && end > start && end <= durationLimitSec) {
        words.push({ word: (word.word as string).trim(), start, end });
      }
    }
  }

  const cleaned = words.filter((word) => word.word.length > 0).sort((a, b) => a.start - b.start);
  const detectedUnit = explicitMs.length > 0 && legacy.length > 0
    ? "mixed"
    : explicitMs.length > 0
      ? "milliseconds"
      : legacyUnit;
  return { words: cleaned, detectedUnit };
}

const TRANSCRIPTION_INCOMPLETE_GAP_MS = 5000;
const TRANSCRIPTION_OVERSHOOT_RATIO = 1.10;
const TRANSCRIPTION_OVERSHOOT_TAIL_MS = 2000;

function transcriptionQualityDistance(captions: ChunkCaption[], durationMs: number): number {
  if (!(durationMs > 0) || captions.length === 0) return Number.POSITIVE_INFINITY;
  let previousEnd = -1;
  for (const caption of captions) {
    if (
      !Number.isFinite(caption.startMs)
      || !Number.isFinite(caption.endMs)
      || caption.startMs < 0
      || caption.endMs <= caption.startMs
      || caption.startMs < previousEnd
    ) return Number.POSITIVE_INFINITY;
    previousEnd = caption.endMs;
  }
  return Math.abs(captions[captions.length - 1].endMs - durationMs);
}

/** Match the route's terminal incomplete/desync guards before returning 422. */
export function transcriptionNeedsRetry(captions: ChunkCaption[], durationMs: number): boolean {
  if (!Number.isFinite(transcriptionQualityDistance(captions, durationMs))) return true;
  const gap = chunkTailGapMs(captions, durationMs);
  if (gap < -TRANSCRIPTION_INCOMPLETE_GAP_MS) return true;
  return gap > TRANSCRIPTION_OVERSHOOT_TAIL_MS
    && captions[captions.length - 1].endMs > durationMs * TRANSCRIPTION_OVERSHOOT_RATIO;
}

/** Retry semantic timeline failures and retain the closest valid attempt. */
export async function runTranscriptionQualityRetries<T extends ChunkResult>(
  attempt: (attemptNumber: number) => Promise<T>,
  durationMs: number,
  maxAttempts = 3,
  onRetry?: (input: { nextAttempt: number; tailGapMs: number }) => void,
  options: { requireUsableWords?: boolean } = {},
): Promise<{ result: T; attempts: number; accepted: boolean }> {
  const boundedAttempts = Math.max(1, Math.floor(maxAttempts));
  let attempts = 1;
  let best = await attempt(1);
  let bestDistance = transcriptionQualityDistance(best.geminiDirectCaptions, durationMs);
  const needsRetry = (result: T) =>
    transcriptionNeedsRetry(result.geminiDirectCaptions, durationMs)
    || (options.requireUsableWords === true && sanitizeChunkTimeline(result, durationMs).stats.wordsDegenerate);
  let bestNeedsRetry = needsRetry(best);

  while (attempts < boundedAttempts && bestNeedsRetry) {
    const nextAttempt = attempts + 1;
    onRetry?.({
      nextAttempt,
      tailGapMs: chunkTailGapMs(best.geminiDirectCaptions, durationMs),
    });
    const candidate = await attempt(nextAttempt);
    attempts = nextAttempt;
    const candidateDistance = transcriptionQualityDistance(candidate.geminiDirectCaptions, durationMs);
    const candidateNeedsRetry = needsRetry(candidate);
    if ((!candidateNeedsRetry && bestNeedsRetry) || (candidateNeedsRetry === bestNeedsRetry && candidateDistance < bestDistance)) {
      best = candidate;
      bestDistance = candidateDistance;
      bestNeedsRetry = candidateNeedsRetry;
    }
  }

  return {
    result: best,
    attempts,
    accepted: !bestNeedsRetry,
  };
}

// Timestamps may legitimately run slightly past the slice end (codec frame
// padding, breath tails) — anything beyond this margin is hallucinated.
const BOGUS_MARGIN_MS = 2000;

// Real speech carries several words per subtitle card (Thai viral cards are
// 3-8 words; prod healthy chunk: 549 words / 98 captions ≈ 5.6). A words array
// that is not even 2× the caption count is a truncated/degenerate response —
// rebuilding captions from it desyncs, so sanitization drops it and the route
// retries/re-slices that chunk instead of shipping synthetic word timing.
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

  // 3) Degenerate words → zero them out and surface wordsDegenerate so the
  //    route can retry/re-slice this chunk before any merge.
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

// A transcript may also UNDERSHOOT its slice (end well before the real audio
// does) — those captions are compressed and run ahead of the voice. Chunk cuts
// land where speech resumes after a silence, so a chunk can legitimately end
// with a few seconds of pause; only a shortfall a TTS voice would never produce
// counts as desync. (Prod 06-12 #3: the kept retry undershot → subs ran early
// after 2:20 — the one-sided overshoot check let it through.)
export const CHUNK_UNDERSHOOT_RETRY_MS = 12_000;

// Signed gap between the transcript's last caption end and the real slice
// length: positive = overshoot, negative = undershoot, 0 = nothing to measure.
export function chunkTailGapMs(captions: ChunkCaption[], chunkDurationMs: number): number {
  if (!(chunkDurationMs > 0) || captions.length === 0) return 0;
  return captions[captions.length - 1].endMs - chunkDurationMs;
}

// Should the caller re-transcribe this chunk? Judged on BOTH directions, and
// attempts must be compared by |chunkTailGapMs| — a 0.7× undershoot is not
// "better" than a 1.4× overshoot.
export function chunkNeedsRetry(captions: ChunkCaption[], chunkDurationMs: number): boolean {
  if (!(chunkDurationMs > 0)) return false;
  if (captions.length === 0) return true; // empty transcript is always a bad roll
  const gap = chunkTailGapMs(captions, chunkDurationMs);
  if (gap > Math.max(chunkDurationMs * (CHUNK_DESYNC_RETRY_RATIO - 1), BOGUS_MARGIN_MS)) return true;
  return gap < -CHUNK_UNDERSHOOT_RETRY_MS;
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

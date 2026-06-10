import type { Caption } from "../_components/types";

/**
 * Binary search for the caption active at `captionMs` (caption-time ms).
 *
 * Replaces the old per-frame O(n) scan in the rAF loop:
 *   captions.findIndex(c => captionMs >= c.startMs && captionMs < c.endMs)
 * which ran 60×/sec × N captions during playback.
 *
 * Requires captions sorted by startMs and non-overlapping — guaranteed by
 * normalizeCaptionsForTimeline (sorts + clamps each end to the next start)
 * and by the timeline drag handlers (clamp between neighbours).
 * Returns the index with startMs <= captionMs < endMs, or -1 (gaps, before
 * first, after last) — identical results to the old findIndex.
 */
export function findActiveCaptionIdx(captions: readonly Caption[], captionMs: number): number {
  let lo = 0;
  let hi = captions.length - 1;
  let best = -1; // last caption whose startMs <= captionMs
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (captions[mid].startMs <= captionMs) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (best === -1) return -1;
  return captionMs < captions[best].endMs ? best : -1;
}

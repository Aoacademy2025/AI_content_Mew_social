// Auto Mix source planning — pure, no I/O.
//
// The old Automix was video-FIRST-fallback: images/AI were fetched only for keywords
// that found ZERO video, so with the default providers it always collapsed to 100%
// video. These helpers instead pre-assign each b-roll PIECE a source by weight, so the
// pipeline fetches a real, interleaved mix (default video:photo:ai = 3:2:1) across a
// cadence-capped number of pieces — video/photo are free, AI (paid) gets the smallest
// share by default.

export type AutoMixSource = "video" | "photo" | "ai";
export type AutoMixWeights = { video: number; photo: number; ai: number };

/**
 * Assign a source to each of `n` pieces by weight, smoothly interleaved (not blocked).
 * Sources with weight 0 never appear. If every weight is 0, returns all "video"
 * (a usable default — never empty/undefined entries). Uses a deficit-based weighted
 * round-robin so e.g. 6 pieces @ 3:2:1 → [video, photo, video, ai, photo, video].
 */
export function planAutoMixSources(n: number, weights: AutoMixWeights): AutoMixSource[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  const entries = ([
    ["video", Math.max(0, weights.video)],
    ["photo", Math.max(0, weights.photo)],
    ["ai", Math.max(0, weights.ai)],
  ] as [AutoMixSource, number][]).filter(([, w]) => w > 0);
  if (entries.length === 0) return Array.from({ length: count }, () => "video" as AutoMixSource);

  const total = entries.reduce((a, [, w]) => a + w, 0);
  const served: Record<AutoMixSource, number> = { video: 0, photo: 0, ai: 0 };
  const out: AutoMixSource[] = [];
  for (let i = 0; i < count; i++) {
    let best: AutoMixSource = entries[0][0];
    let bestDeficit = -Infinity;
    for (const [src, w] of entries) {
      // ideal cumulative count after i+1 picks = (i+1)*w/total; pick the most-behind source
      const deficit = ((i + 1) * w) / total - served[src];
      if (deficit > bestDeficit) { bestDeficit = deficit; best = src; }
    }
    out.push(best);
    served[best]++;
  }
  return out;
}

/**
 * Pick `n` evenly-spaced indices from [0, total) (ascending, unique). Used to choose
 * which captions become active b-roll pieces when the cadence cap wants fewer pieces
 * than there are captions — spreads the chosen captions across the whole script.
 * When n >= total, returns every index.
 */
export function pickEvenIndices(total: number, n: number): number[] {
  const t = Math.max(0, Math.floor(total));
  const k = Math.max(0, Math.min(Math.floor(n), t));
  if (k === 0) return [];
  if (k === t) return Array.from({ length: t }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(Math.floor(((i + 0.5) * t) / k));
  return out;
}

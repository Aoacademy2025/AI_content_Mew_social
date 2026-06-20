/**
 * Pure helpers for the subtitle-waveform feature: derive "snap points" (speech
 * onset/offset boundaries) and downsample raw PCM to drawable peaks. No DOM.
 */

export interface SilenceInterval { startMs: number; endMs: number; }

/** Snap points from server silence intervals: each interval's edges (speech↔silence
 * transitions), clamped to [0,totalMs], sorted ascending, deduped. */
export function snapPointsFromSilence(intervals: SilenceInterval[], totalMs: number): number[] {
  if (!intervals?.length) return [];
  const set = new Set<number>();
  for (const s of intervals) {
    for (const edge of [s.startMs, s.endMs]) {
      if (Number.isFinite(edge)) set.add(Math.round(Math.max(0, Math.min(totalMs, edge))));
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Max absolute amplitude per bucket, normalized to 0..1 by the global peak. */
export function downsamplePeaks(samples: ArrayLike<number>, buckets: number): number[] {
  const n = samples.length;
  if (n === 0 || buckets <= 0) return [];
  const size = n / buckets;
  const out = new Array<number>(buckets).fill(0);
  let globalMax = 0;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(n, Math.floor((b + 1) * size));
    let max = 0;
    for (let i = start; i < end; i++) { const a = Math.abs(samples[i]); if (a > max) max = a; }
    out[b] = max;
    if (max > globalMax) globalMax = max;
  }
  if (globalMax > 0) for (let b = 0; b < buckets; b++) out[b] = out[b] / globalMax;
  return out;
}

/** Client-side silence detection from peaks: ms positions where amplitude crosses
 * `threshold` (onset = silent→loud, offset = loud→silent). `minRunMs` requires the
 * new state to persist that long before a transition counts (noise guard). */
export function snapPointsFromPeaks(peaks: number[], msPerPeak: number, threshold = 0.08, minRunMs = 60): number[] {
  if (!peaks?.length) return [];
  const minRun = Math.max(1, Math.round(minRunMs / Math.max(1, msPerPeak)));
  const points: number[] = [];
  let state = peaks[0] >= threshold; // true = loud
  let runStart = 0;
  for (let i = 1; i < peaks.length; i++) {
    const loud = peaks[i] >= threshold;
    if (loud !== state) {
      if (i - runStart >= minRun) { points.push(Math.round(i * msPerPeak)); state = loud; runStart = i; }
    } else {
      runStart = Math.max(runStart, i - minRun + 1);
    }
  }
  return points;
}

/** Nearest snap point within thresholdMs; otherwise return ms unchanged. */
export function snapToNearest(ms: number, points: number[], thresholdMs: number): number {
  let best = ms, bestD = thresholdMs;
  for (const p of points) { const d = Math.abs(p - ms); if (d <= bestD) { bestD = d; best = p; } }
  return best;
}

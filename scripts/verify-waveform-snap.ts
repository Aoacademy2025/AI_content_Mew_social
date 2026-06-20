// Unit tests for the pure waveform/snap helpers. Run: npx tsx scripts/verify-waveform-snap.ts
import { snapPointsFromSilence, downsamplePeaks, snapPointsFromPeaks, snapToNearest } from "../src/app/(dashboard)/video-editor/_components/waveform-snap";

let passed = 0;
function check(name: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  passed++;
}
function arrEq(a: number[], b: number[]) { return a.length === b.length && a.every((v, i) => v === b[i]); }

// snapPointsFromSilence: interval edges, clamped, sorted, deduped
check("silence: edges sorted+deduped+clamped", arrEq(
  snapPointsFromSilence([{ startMs: 1000, endMs: 1500 }, { startMs: 1500, endMs: 2000 }, { startMs: -50, endMs: 99999 }], 5000),
  [0, 1000, 1500, 2000, 5000]
));
check("silence: empty → []", arrEq(snapPointsFromSilence([], 5000), []));

// downsamplePeaks: max-abs per bucket, normalized 0..1
const peaks = downsamplePeaks([0, 0.5, -1, 0.25, 0, 0, 0.1, -0.2], 4);
check("downsample: length = buckets", peaks.length === 4);
check("downsample: bucket1 = 1 (|-1| max, normalized)", Math.abs(peaks[1] - 1) < 1e-9);
check("downsample: all within 0..1", peaks.every(p => p >= 0 && p <= 1));

// snapPointsFromPeaks: boundary ms where amplitude crosses threshold (with min run)
check("peaks: onset+offset detected", arrEq(
  snapPointsFromPeaks([0, 0, 0.9, 0.9, 0, 0], 100, 0.3, 0),
  [200, 400]
));
check("peaks: all silent → []", arrEq(snapPointsFromPeaks([0, 0, 0, 0], 100, 0.3, 0), []));

// snapToNearest: nearest within threshold else unchanged
check("snap: within threshold → snapped", snapToNearest(1040, [0, 1000, 2000], 120) === 1000);
check("snap: outside threshold → unchanged", snapToNearest(1500, [0, 1000, 2000], 120) === 1500);
check("snap: empty points → unchanged", snapToNearest(1500, [], 120) === 1500);
check("snap: picks nearest of two", snapToNearest(1490, [1000, 1500], 120) === 1500);

console.log(`\n${passed}/11 passed`);

// Unit tests for the pure waveform/snap helpers. Run: npx tsx scripts/verify-waveform-snap.ts
import { readFileSync } from "node:fs";
import { snapPointsFromSilence, downsamplePeaks, snapPointsFromPeaks, snapToNearest } from "../src/app/(dashboard)/video-editor/_components/waveform-snap";

let passed = 0;
function check(name: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  passed++;
}
function arrEq<T>(a: T[], b: T[]) { return a.length === b.length && a.every((v, i) => v === b[i]); }

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

// Timeline UX contract: the waveform is a visual reference for subtitle timing, so the
// two tracks stay adjacent on the same time scale instead of being split by visual tracks.
const timelineSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx",
  "utf8",
);
const trackOrder = Array.from(
  timelineSource.matchAll(/trackLabel\("([^"]+)"/g),
  (match) => match[1],
);
// The invariant this branch actually owns: nothing may be inserted BETWEEN the waveform and the
// subtitle track. Asserted directly (not implied by a frozen full list) so a future track added
// elsewhere in the timeline can't be mistaken for an adjacency regression — and, conversely, so
// inserting anything between these two still fails even if the full list is updated.
const voiceIdx = trackOrder.indexOf("เสียงพูด");
const subIdx = trackOrder.indexOf("ซับไทย");
check(
  "timeline: voice waveform sits immediately above subtitles",
  voiceIdx >= 0 && subIdx === voiceIdx + 1,
);
// Full order, kept as a change detector. "โลโก้" was added by editor-layer-visibility-toggles
// and sits BELOW subtitles, matching the real z-order (logo renders above the video and under
// the captions) — it does not break the adjacency invariant above.
check(
  "timeline: track order stays avatar → b-roll → voice → subtitles → logo → music",
  arrEq(trackOrder, ["อวตาร", "บีโรล", "เสียงพูด", "ซับไทย", "โลโก้", "เพลง"]),
);
check(
  "timeline: Snap tooltip explains the voice-timing behavior",
  timelineSource.includes('title="Snap กับจังหวะเสียง"'),
);

console.log(`\n${passed}/14 passed`);

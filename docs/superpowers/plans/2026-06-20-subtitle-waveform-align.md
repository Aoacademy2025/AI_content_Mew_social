# Subtitle Waveform Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the voice waveform under the SUBTITLES timeline track in `/video-editor` and snap caption-edge drags to speech onset/offset, so users can manually fix subtitle timing that auto-timing got wrong.

**Architecture:** Frontend-only. A pure, unit-tested module (`waveform-snap.ts`) derives snap points and downsamples audio peaks. A browser hook (`useAudioPeaks`) decodes the existing `voiceUrl` via Web Audio API and caches peak arrays. A `WaveformCanvas` draws peaks. The existing caption-edge drag (`clipResizeRef`, `page.tsx:4272`) gets a snap step + a guide line, and the canvas is placed inside the existing SUBTITLES track at the existing zoom-scaled width. Captions stay the source of truth → edits already flow to Burn. Nothing touches the TTS / `tts-timing.ts` / render-timing logic.

**Tech Stack:** Next.js 15 / React 19 / TypeScript, Web Audio API (`AudioContext.decodeAudioData`), HTML canvas. Tests via the team pattern: a `scripts/verify-*.ts` run with `tsx`.

## Global Constraints

- Frontend-only: no API route, no Prisma schema, no backend change.
- MUST NOT modify `src/lib/tts-timing.ts`, the TTS routes, `captionsFromTtsTiming`, or render-time timing logic — read `silenceIntervals` / `voiceUrl` only.
- Fail-safe: with no voiceUrl, no decoded peaks, or no snap points, the timeline behaves exactly as today (plain drag, no waveform).
- Snap source priority ("C"): use `ttsTimingRef.current.silenceIntervals` when present and non-empty; otherwise derive snap points client-side from the decoded peaks.
- `SilenceInterval = { startMs: number; endMs: number }` (already defined in `src/lib/tts-timing.ts:47`).
- Verify scripts use `function check(name, ok){ if(!ok) throw new Error("FAIL: "+name); console.log("PASS: "+name); }` and run via `npx tsx scripts/verify-*.ts`.
- Follow existing code style; gate every UI task on `npx tsc --noEmit --pretty false` (0 errors) and `BUILD_NO_LINT=1 npm run build` (exit 0).

---

## File Structure

- **Create** `src/app/(dashboard)/video-editor/_components/waveform-snap.ts` — pure helpers: `snapPointsFromSilence`, `downsamplePeaks`, `snapPointsFromPeaks`, `snapToNearest`. No DOM/browser deps.
- **Create** `scripts/verify-waveform-snap.ts` — unit tests for the pure helpers.
- **Create** `src/app/(dashboard)/video-editor/_components/useAudioPeaks.ts` — React hook: decode `voiceUrl` → cached `{ peaks, durationMs }`.
- **Create** `src/app/(dashboard)/video-editor/_components/WaveformCanvas.tsx` — canvas that draws a peak array at a given width/height.
- **Modify** `src/app/(dashboard)/video-editor/page.tsx` — reactive voice-url + snap-points state, render `WaveformCanvas` inside the SUBTITLES track, apply `snapToNearest` in the `clipResizeRef` drag handler, add a snap toggle + guide line.

---

## Task 1: Pure waveform/snap helpers (TDD)

**Files:**
- Create: `src/app/(dashboard)/video-editor/_components/waveform-snap.ts`
- Test: `scripts/verify-waveform-snap.ts`

**Interfaces:**
- Produces:
  - `snapPointsFromSilence(intervals: {startMs:number;endMs:number}[], totalMs: number): number[]`
  - `downsamplePeaks(samples: ArrayLike<number>, buckets: number): number[]`
  - `snapPointsFromPeaks(peaks: number[], msPerPeak: number, threshold?: number, minRunMs?: number): number[]`
  - `snapToNearest(ms: number, points: number[], thresholdMs: number): number`

- [ ] **Step 1: Write the failing test** — `scripts/verify-waveform-snap.ts`

```ts
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
// peaks: silent(0,0) loud(1,1) silent(0,0) — msPerPeak=100, threshold 0.3, minRunMs 0
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

console.log(`\n${passed}/12 passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-waveform-snap.ts`
Expected: FAIL — `Cannot find module '../src/app/(dashboard)/video-editor/_components/waveform-snap'`

- [ ] **Step 3: Write minimal implementation** — `src/app/(dashboard)/video-editor/_components/waveform-snap.ts`

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-waveform-snap.ts`
Expected: PASS — `12/12 passed`. If `snapPointsFromPeaks` differs, adjust the run-tracking so the simple case `[0,0,0.9,0.9,0,0]` yields `[200,400]`.

- [ ] **Step 5: Add npm script + commit**

Add to `package.json` scripts (after `verify:llm-rank`): `"verify:waveform-snap": "tsx scripts/verify-waveform-snap.ts"`

```bash
git add "src/app/(dashboard)/video-editor/_components/waveform-snap.ts" scripts/verify-waveform-snap.ts package.json
git commit -m "feat(editor): pure waveform snap-point + peak-downsample helpers"
```

---

## Task 2: useAudioPeaks hook (decode + cache)

**Files:**
- Create: `src/app/(dashboard)/video-editor/_components/useAudioPeaks.ts`

**Interfaces:**
- Consumes: `downsamplePeaks` from `./waveform-snap`.
- Produces: `useAudioPeaks(voiceUrl: string | null | undefined, buckets?: number): { peaks: number[] | null; durationMs: number; loading: boolean }`

- [ ] **Step 1: Write the hook**

```ts
import { useEffect, useState } from "react";
import { downsamplePeaks } from "./waveform-snap";

// Module-level cache keyed by voiceUrl so re-renders / re-opening a draft don't re-decode.
const peakCache = new Map<string, { peaks: number[]; durationMs: number }>();

export function useAudioPeaks(voiceUrl: string | null | undefined, buckets = 1400) {
  const [data, setData] = useState<{ peaks: number[]; durationMs: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!voiceUrl) { setData(null); return; }
    const cached = peakCache.get(voiceUrl);
    if (cached) { setData(cached); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(voiceUrl);
        const buf = await res.arrayBuffer();
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        const audio = await ctx.decodeAudioData(buf);
        const peaks = downsamplePeaks(audio.getChannelData(0), buckets);
        const out = { peaks, durationMs: Math.round(audio.duration * 1000) };
        void ctx.close();
        peakCache.set(voiceUrl, out);
        if (!cancelled) setData(out);
      } catch {
        if (!cancelled) setData(null); // fail-safe: no waveform, plain drag still works
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [voiceUrl, buckets]);

  return { peaks: data?.peaks ?? null, durationMs: data?.durationMs ?? 0, loading };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --pretty false`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_components/useAudioPeaks.ts"
git commit -m "feat(editor): useAudioPeaks — decode voiceUrl to cached waveform peaks"
```

---

## Task 3: WaveformCanvas component

**Files:**
- Create: `src/app/(dashboard)/video-editor/_components/WaveformCanvas.tsx`

**Interfaces:**
- Produces: `WaveformCanvas(props: { peaks: number[] | null; width: number; height: number; color?: string }): JSX.Element | null`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useRef } from "react";

/** Draws a peak array (0..1) as a centered vertical-bar waveform. Renders nothing
 * when there are no peaks — the timeline simply shows no waveform (fail-safe). */
export function WaveformCanvas({ peaks, width, height, color = "rgba(139,124,246,0.40)" }: {
  peaks: number[] | null;
  width: number;
  height: number;
  color?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !peaks?.length || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.floor(width * dpr));
    cv.height = Math.max(1, Math.floor(height * dpr));
    const c = cv.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, cv.width, cv.height);
    c.fillStyle = color;
    const mid = cv.height / 2;
    const bw = cv.width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(1, peaks[i] * cv.height);
      c.fillRect(i * bw, mid - h / 2, Math.max(1, bw * 0.8), h);
    }
  }, [peaks, width, height, color]);

  if (!peaks?.length) return null;
  return <canvas ref={ref} style={{ width, height, display: "block" }} aria-hidden />;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --pretty false`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_components/WaveformCanvas.tsx"
git commit -m "feat(editor): WaveformCanvas — draw peak array as a timeline waveform"
```

---

## Task 4: Integrate waveform + snap into the SUBTITLES track

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`

**Interfaces:**
- Consumes: `useAudioPeaks` (Task 2), `WaveformCanvas` (Task 3), `snapPointsFromSilence`, `snapPointsFromPeaks`, `snapToNearest` (Task 1).
- Existing anchors: `ttsTimingRef` (`page.tsx:295`), TTS capture (`captureTtsTiming`, `page.tsx:1407`), `pipe.current.voiceUrl` (`page.tsx:828, 964`), the SUBTITLES drag handler (`page.tsx:4272-4307`), the track-content canvas-width container (`page.tsx:4317`, `timelineCanvasWidthPct`/`totalMs`).

- [ ] **Step 1: Add imports** (top of `page.tsx`, with the other `_components` imports near line 44)

```ts
import { useAudioPeaks } from "./_components/useAudioPeaks";
import { WaveformCanvas } from "./_components/WaveformCanvas";
import { snapPointsFromSilence, snapPointsFromPeaks, snapToNearest } from "./_components/waveform-snap";
```

- [ ] **Step 2: Add reactive voice-url state** — so the hook re-runs when TTS produces audio. Add near the other editor state (after `ttsTimingRef`, ~`page.tsx:296`):

```ts
const [waveformVoiceUrl, setWaveformVoiceUrl] = useState<string | null>(null);
const [snapEnabled, setSnapEnabled] = useState(true);
const snapGuideRef = useRef<number | null>(null); // active snap target ms, for the guide line
const [snapGuideTick, setSnapGuideTick] = useState(0); // forces guide re-render
const waveLaneRef = useRef<HTMLDivElement>(null);   // the background lane we draw the canvas into
const [waveLaneSize, setWaveLaneSize] = useState({ w: 0, h: 0 }); // measured px size of that lane
```

- [ ] **Step 3: Set the reactive url** wherever `pipe.current.voiceUrl` is assigned. In `captureTtsTiming` (`page.tsx:1407`) add, and in the draft-restore block (`page.tsx:828`) add after `pipe.current.voiceUrl = d.voiceUrl ?? ""`:

```ts
setWaveformVoiceUrl(pipe.current.voiceUrl || null);
```

- [ ] **Step 4: Decode peaks + build snap points** — add after the state declarations:

```ts
const { peaks: wavePeaks, durationMs: waveDurationMs } = useAudioPeaks(waveformVoiceUrl);

const snapPoints = useMemo(() => {
  const totalForSnap = totalMs || waveDurationMs || 0;
  const intervals = ttsTimingRef.current?.silenceIntervals;
  if (Array.isArray(intervals) && intervals.length > 0) {
    return snapPointsFromSilence(intervals.filter(s => Number.isFinite(s?.startMs) && Number.isFinite(s?.endMs)), totalForSnap);
  }
  if (wavePeaks?.length && waveDurationMs > 0) {
    return snapPointsFromPeaks(wavePeaks, waveDurationMs / wavePeaks.length);
  }
  return [];
}, [wavePeaks, waveDurationMs, totalMs, waveformVoiceUrl, captions.length]);
```

(Note: `captions.length` in deps is a cheap re-trigger after TTS recompute; `ttsTimingRef` is a ref so it can't be a dep — `waveformVoiceUrl` changing covers the new-TTS case.)

- [ ] **Step 5: Apply snap in the drag handler** — in the `onPointerMove` (`page.tsx:4282-4303`), wrap the raw candidate before clamping. Replace the three edge branches' first line so the candidate `r.startMs + dxMs` passes through snap. Define a local at the top of the `setCaptionsRaw` map callback:

```ts
const rawTarget = r.startMs + dxMs;
const snapped = snapEnabled && snapPoints.length ? snapToNearest(rawTarget, snapPoints, SNAP_MS) : rawTarget;
```

Then use `snapped` in place of `r.startMs + dxMs` in all three branches (left `newStart`, right `newEnd`, move `newStart`). After computing the clamped value, record the guide:

```ts
snapGuideRef.current = (snapEnabled && snapPoints.length && Math.abs(snapped - rawTarget) > 0.5) ? snapped : null;
```

And add a module-level const near the other timeline consts: `const SNAP_MS = 120;`. After the `setCaptionsRaw` call in `onPointerMove`, add `setSnapGuideTick(t => t + 1);` so the guide redraws. In `onPointerUp` (`page.tsx:4308`) add `snapGuideRef.current = null; setSnapGuideTick(t => t + 1);`.

- [ ] **Step 6a: Measure the lane** — add this effect after the `snapPoints` memo so the canvas gets exact px dimensions (the lane is sized by the existing zoom-scaled container, so this stays correct at every zoom):

```ts
useEffect(() => {
  const el = waveLaneRef.current;
  if (!el) return;
  const measure = () => setWaveLaneSize({ w: el.clientWidth, h: el.clientHeight });
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  return () => ro.disconnect();
}, [wavePeaks]);
```

- [ ] **Step 6b: Render the waveform + guide** inside the canvas-width container (`page.tsx:4317`, the `<div className="relative" style={{ width: timelineCanvasWidthPct% }}>`), as the FIRST child so it sits behind the caption blocks. The lane is `absolute inset-0`, so `clientWidth`/`clientHeight` equal the zoom-scaled content width and the subtitle row height — the peaks line up with caption blocks at every zoom:

```tsx
<div ref={waveLaneRef} className="absolute inset-x-0 top-0 bottom-0 pointer-events-none opacity-70" aria-hidden>
  {wavePeaks?.length && waveLaneSize.w > 0 ? (
    <WaveformCanvas peaks={wavePeaks} width={waveLaneSize.w} height={waveLaneSize.h} />
  ) : null}
</div>
{snapGuideRef.current != null && totalMs > 0 ? (
  <div className="absolute top-0 bottom-0 w-px bg-amber-400/80 pointer-events-none" aria-hidden
    style={{ left: `${(snapGuideRef.current / totalMs) * 100}%` }} />
) : null}
```

(`snapGuideTick` is referenced by reading `snapGuideRef.current` during a render triggered by `setSnapGuideTick` — keep the `void snapGuideTick;` discard near the render if the linter flags it as unused, or read it into the `style` calc.)

- [ ] **Step 7: Add the snap toggle** — near the timeline zoom slider control (search `Timeline zoom` in page.tsx), add a small button:

```tsx
<button onClick={() => setSnapEnabled(v => !v)}
  className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors",
    snapEnabled ? "bg-violet-600/80 text-white" : "bg-[#2a2a36] text-slate-400")}
  title="ดูดซับเข้าจังหวะเสียง (snap)">⌁ Snap</button>
```

- [ ] **Step 8: Typecheck + build**

Run: `npx tsc --noEmit --pretty false` → 0 errors.
Run: `BUILD_NO_LINT=1 npm run build` → exit 0, `/video-editor` compiles.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(editor): waveform under subtitle track + snap caption drag to speech"
```

---

## Task 5: Live browser QA + verify

**Files:** none (verification only).

- [ ] **Step 1: Run the unit verify**

Run: `npx tsx scripts/verify-waveform-snap.ts` → `12/12 passed`.

- [ ] **Step 2: Live QA on deploy** (after merge/deploy, logged in via duckyhero, as done for #97/#99)
  - Generate a Gemini clip → confirm the waveform appears under the SUBTITLES track and lines up with the caption blocks.
  - Drag a caption left/right edge near a pause → confirm it snaps and an amber guide line shows; toggle Snap off → confirm free drag.
  - Generate an ElevenLabs or uploaded-audio clip → confirm the client-computed snap still works (waveform present, snapping near pauses).
  - Burn → confirm the burned MP4's subtitle timing reflects the dragged/snapped positions.

- [ ] **Step 3: Reply + close ticket cmqjciav** (prisma script on prod, same pattern as cmqakk0n: `supportTicket.update` CLOSED + `notification.create` type `VIDEO_COMPLETED`).

---

## Notes for the implementer

- `totalMs` and `timelineCanvasWidthPct` already exist in `page.tsx` and drive the timeline's px↔ms mapping; the waveform and guide MUST use the same mapping so they line up with caption blocks at every zoom level.
- The biggest integration risk is measuring the canvas's px width (zoom-scaled). Reuse the timeline's existing width measurement; if none exists, add one `ResizeObserver` on the canvas-width container.
- Keep `buckets` (≈1400) independent of zoom — the canvas is drawn at the container's CSS width and stretched; peaks need not be re-decoded on zoom, only redrawn.

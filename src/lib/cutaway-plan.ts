// Phase 1 planner for "upload clip + auto B-roll cutaway".
// Decides which b-roll windows show the uploaded clip (person) vs the b-roll base.
// Windows tile [0, clipEnd] with no gaps (see buildBrollWindows), so person ∪ broll
// covers the whole clip.

import {
  buildBrollWindows,
  buildFixedCountBrollWindows,
  type BrollWindowCaption,
} from "./broll-windows";

export type CutawayRange = { startMs: number; endMs: number };
export type CutawayPlan = { person: CutawayRange[]; broll: CutawayRange[] };
export type CutawayRangeSec = { start: number; end: number };
export type CutawayBrollSegment = {
  src?: unknown;
  start?: unknown;
  end?: unknown;
  sourceIndex?: unknown;
  brollEnabled?: unknown;
};
export type CutawayBackgroundAsset = {
  sourceIndex?: number;
  clipOffset?: number;
  [key: string]: unknown;
};

const rangeKey = (range: CutawayRange) => `${range.startMs}:${range.endMs}`;

const MIN_VISIBLE_CUTAWAY_MS = 3_000;
const MIN_CUTAWAY_CLIP_MS = 10_000;

function normalizeVisibleCutawayCount(targetClipCount: unknown): number {
  const raw = Number(targetClipCount);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(60, Math.floor(raw))
    : 0;
}

/**
 * Maximum visible B-roll pieces that can fit while preserving the advertised
 * 3-second minimum hold. Cutaway alternates presenter and B-roll, so each
 * visible piece consumes two equal timeline windows. Clips below 10 seconds
 * intentionally remain presenter-only (the original product design's short-
 * clip fail-open rule).
 */
export function cutawayPieceLimit(durationMs: unknown): number {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < MIN_CUTAWAY_CLIP_MS) return 0;
  return Math.min(60, Math.floor(duration / (MIN_VISIBLE_CUTAWAY_MS * 2)));
}

/** Customer-facing visible count after applying the duration safety limit. */
export function effectiveManualCutawayPieceCount(
  targetClipCount: unknown,
  durationMs?: unknown,
): number {
  const requested = normalizeVisibleCutawayCount(targetClipCount);
  if (durationMs === undefined) return requested;
  return Math.min(requested, cutawayPieceLimit(durationMs));
}

/**
 * Quote the number of B-roll pieces that can actually be visible in upload
 * cutaway mode. Manual requests are duration-clamped; Auto estimates the same
 * alternating 4-second timeline used by the worker, then counts only odd
 * (visible B-roll) windows. This keeps setup, receipt, and provider ceilings
 * aligned before transcription supplies exact semantic window boundaries.
 */
export function estimatedCutawayPieceCount(
  targetClipCount: unknown,
  durationMs: unknown,
  windowMs: unknown = 4_000,
): number {
  const limit = cutawayPieceLimit(durationMs);
  if (limit === 0) return 0;
  const manual = normalizeVisibleCutawayCount(targetClipCount);
  if (manual > 0) return Math.min(manual, limit);

  const duration = Number(durationMs);
  const requestedWindowMs = Number(windowMs);
  const cadenceMs = Number.isFinite(requestedWindowMs) && requestedWindowMs > 0
    ? requestedWindowMs
    : 4_000;
  const internalWindows = Math.max(1, Math.ceil(duration / cadenceMs));
  return Math.min(limit, Math.floor(internalWindows / 2));
}

/**
 * `targetClipCount` in upload mode is a count of visible B-roll pieces, not a
 * count of the alternating presenter+B-roll timeline windows. The cutaway plan
 * starts on the presenter and uses every odd window for B-roll, so each visible
 * piece needs two internal windows. Public input remains capped at 60 pieces.
 */
export function manualCutawayWindowCount(targetClipCount: unknown, durationMs?: unknown): number {
  const visibleCount = effectiveManualCutawayPieceCount(targetClipCount, durationMs);
  return visibleCount * 2;
}

export type CutawayTimelineScene =
  | { kind: "presenter" }
  | { kind: "broll"; visualBeatSequence: number };

/**
 * Cutaway timelines alternate presenter (even) and visible B-roll (odd).
 * Visual Beats are numbered only for those visible B-roll pieces, so
 * window `i` maps to beat `floor(i / 2)` when `i` is odd.
 */
export function cutawayTimelineScene(windowIndex: number): CutawayTimelineScene {
  if (windowIndex % 2 === 0) return { kind: "presenter" };
  return { kind: "broll", visualBeatSequence: Math.floor(windowIndex / 2) };
}

/** Upload jobs, and any job that persisted person ranges, use the cutaway timeline. */
export function sourceJobUsesCutawayTimeline(source: {
  mode?: unknown;
  cutawayPersonRanges?: unknown;
}): boolean {
  if (source?.mode === "upload") return true;
  return Array.isArray(source?.cutawayPersonRanges) && source.cutawayPersonRanges.length > 0;
}

export const CUTAWAY_PRESENTER_SCENE_REROLL_MESSAGE =
  "ช่วงนี้เป็นคลิปที่ถ่ายเอง ไม่สามารถลองภาพใหม่ได้";

/**
 * Scene Reroll's editor index is a timeline window. Faceless jobs keep that
 * index as the Visual Beat sequence; cutaway jobs remap odd windows and refuse
 * presenter windows.
 */
export function sceneRerollBeatTarget(
  timelineIndex: number,
  source: { mode?: unknown; cutawayPersonRanges?: unknown },
): CutawayTimelineScene {
  if (!sourceJobUsesCutawayTimeline(source)) {
    return { kind: "broll", visualBeatSequence: timelineIndex };
  }
  return cutawayTimelineScene(timelineIndex);
}

export function cutawayTimelineSourceFromJob(job: {
  inputJson?: string | null;
  outputJson?: string | null;
}): { mode?: unknown; cutawayPersonRanges?: unknown } {
  let mode: unknown;
  try {
    const parsed = JSON.parse(String(job?.inputJson ?? "")) as { mode?: unknown };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) mode = parsed.mode;
  } catch {
    mode = undefined;
  }
  let cutawayPersonRanges: unknown;
  try {
    const parsed = JSON.parse(String(job?.outputJson ?? "")) as {
      preview?: { cutawayPersonRanges?: unknown };
    };
    cutawayPersonRanges = parsed?.preview?.cutawayPersonRanges;
  } catch {
    cutawayPersonRanges = undefined;
  }
  return { mode, cutawayPersonRanges };
}

/**
 * window 0 (hook) = person; then every odd-index window is b-roll. Guarantees:
 * hook is always the person, no two consecutive b-roll windows. B-roll ratio is
 * ~40–50% for clips with >= 4 windows; short clips intentionally get fewer cutaways
 * (n=3 => 33%, n=2 => 50%). Fewer than 2 valid windows => all person (skip cutaway).
 */
export function planCutaway(windows: { startMs: number; endMs: number }[]): CutawayPlan {
  const person: CutawayRange[] = [];
  const broll: CutawayRange[] = [];
  const ws = (windows ?? []).filter(
    (w) => w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs,
  );
  if (ws.length < 2) {
    for (const w of ws) person.push({ startMs: w.startMs, endMs: w.endMs });
    return { person, broll };
  }
  ws.forEach((w, i) => {
    (i % 2 === 1 ? broll : person).push({ startMs: w.startMs, endMs: w.endMs });
  });
  return { person, broll };
}

/**
 * Re-expands the intentionally sparse, billable B-roll result into the complete
 * upload timeline expected by generate-config.
 *
 * AI/stock media is requested only for visible cutaway ranges. Person ranges get
 * the uploaded clip as a hidden background filler, with its media offset aligned
 * to the timeline. This prevents assignBrollWindows from consuming the next AI
 * asset under a presenter range and then flashing/reusing another asset when the
 * cutaway becomes visible.
 */
export function buildCutawayBackgroundTimeline({
  windows,
  brollRanges,
  brollAssets,
  presenterAsset,
}: {
  windows: CutawayRange[];
  brollRanges: CutawayRange[];
  brollAssets: CutawayBackgroundAsset[];
  presenterAsset: CutawayBackgroundAsset;
}): { windows: CutawayRange[]; assets: CutawayBackgroundAsset[] } {
  const validWindows = (windows ?? []).filter(
    (window) => window
      && Number.isFinite(window.startMs)
      && Number.isFinite(window.endMs)
      && window.endMs > window.startMs,
  );
  const visibleRanges = new Set(
    (brollRanges ?? [])
      .filter((range) => range && Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
      .map(rangeKey),
  );
  const visibleAssets = Array.isArray(brollAssets) ? brollAssets.filter(Boolean) : [];
  const indexedVisibleAssets = new Map<number, CutawayBackgroundAsset>();
  visibleAssets.forEach((asset, index) => {
    const sourceIndex = Number.isFinite(asset.sourceIndex) ? Number(asset.sourceIndex) : index;
    if (!indexedVisibleAssets.has(sourceIndex)) indexedVisibleAssets.set(sourceIndex, asset);
  });

  let visibleIndex = 0;
  const assets = validWindows.map((window, windowIndex) => {
    if (!visibleRanges.has(rangeKey(window))) {
      return {
        ...presenterAsset,
        sourceIndex: windowIndex,
        clipOffset: window.startMs / 1_000,
      };
    }

    const selected = indexedVisibleAssets.get(visibleIndex)
      ?? visibleAssets[visibleIndex]
      ?? visibleAssets[visibleIndex % Math.max(1, visibleAssets.length)]
      ?? presenterAsset;
    visibleIndex += 1;
    return { ...selected, sourceIndex: windowIndex };
  });

  return { windows: validWindows, assets };
}

function normalizeRanges(ranges: CutawayRangeSec[]): CutawayRangeSec[] {
  const sorted = ranges
    .filter((range) =>
      range
      && Number.isFinite(range.start)
      && Number.isFinite(range.end)
      && range.start >= 0
      && range.end > range.start)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CutawayRangeSec[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 0.001) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function subtractRange(ranges: CutawayRangeSec[], cut: CutawayRangeSec): CutawayRangeSec[] {
  const next: CutawayRangeSec[] = [];
  for (const range of ranges) {
    if (cut.end <= range.start || cut.start >= range.end) {
      next.push(range);
      continue;
    }
    if (cut.start > range.start) next.push({ start: range.start, end: Math.min(cut.start, range.end) });
    if (cut.end < range.end) next.push({ start: Math.max(cut.end, range.start), end: range.end });
  }
  return normalizeRanges(next);
}

/** Inputs needed to replay the ORIGINAL cutaway plan of a preview that predates
 *  `preview.cutawayPersonRanges`. Every field mirrors the creation call verbatim. */
export type CutawayReconstructInput = {
  /** `preview.captions` — the exact caption list the windows were built from. */
  captions?: { startMs?: unknown; endMs?: unknown; text?: unknown }[] | null;
  /** `preview.audioDurationMs` — the clip length windows were tiled over. */
  audioDurationMs?: unknown;
  /** `NEXT_PUBLIC_BROLL_WINDOW_SEC` (auto cadence). Non-positive/absent => 4. */
  windowSec?: unknown;
  /** The ORIGINAL upload job's `targetClipCount` (absent/<=0 => auto cadence). */
  targetClipCount?: unknown;
};

/**
 * Rebuild the person ↔ B-roll baseline for previews created before
 * `preview.cutawayPersonRanges` was persisted.
 *
 * This runs the EXACT formula the upload path used (orchestrator `mode:"upload"`):
 *   buildFixedCountBrollWindows | buildBrollWindows → planCutaway → clamp person[0].start = 0
 * so a legacy project re-renders with the same layout it was created with. Guessing the
 * alternation from `sourceIndex` is NOT viable: coverage repair reuses one asset for several
 * windows (nearest fallback), so the same `sourceIndex` can appear more than once and the
 * parity flips for the whole clip.
 *
 * Returns `[]` only when the captions cannot produce any window — callers must fail closed
 * rather than fall back to a guess.
 */
export function reconstructCutawayPersonRanges(input: CutawayReconstructInput): CutawayRangeSec[] {
  const captions: BrollWindowCaption[] = (Array.isArray(input?.captions) ? input.captions : [])
    .map((caption) => ({
      startMs: Number(caption?.startMs),
      endMs: Number(caption?.endMs),
      text: typeof caption?.text === "string" ? caption.text : "",
    }));

  const rawDurationMs = Number(input?.audioDurationMs);
  const audioEndMs = Number.isFinite(rawDurationMs) && rawDurationMs > 0
    ? Math.round(rawDurationMs)
    : undefined;

  // Legacy previews reached this fallback before the visible-count fix and used
  // targetClipCount directly as the TOTAL window count. Preserve that old formula
  // here so re-rendering an existing project does not change its layout. New jobs
  // persist `cutawayPersonRanges` and never need this reconstruction path.
  const rawCount = Number(input?.targetClipCount);
  const manualCount = Number.isFinite(rawCount) && rawCount > 0
    ? Math.min(60, Math.floor(rawCount))
    : 0;

  const rawWindowSec = Number(input?.windowSec);
  const windowSec = Number.isFinite(rawWindowSec) && rawWindowSec > 0 ? rawWindowSec : 4;

  const windows = manualCount > 0
    ? buildFixedCountBrollWindows(captions, manualCount, audioEndMs)
    : buildBrollWindows(captions, windowSec, audioEndMs);

  const person = planCutaway(windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })))
    .person
    .map((range) => ({ start: range.startMs / 1000, end: range.endMs / 1000 }));
  // Same hook fix as creation (PR #157): transcribe leaves [0, first word) unlabelled, so the
  // uploaded clip must still own frame 0 instead of letting B-roll open the video.
  if (person.length > 0) person[0] = { ...person[0], start: 0 };
  return normalizeRanges(person);
}

/**
 * Resolve the uploaded-speaker overlay ranges after per-window B-roll visibility edits.
 *
 * `basePersonRanges` is the ORIGINAL plan — either the persisted `preview.cutawayPersonRanges`
 * (new jobs) or `reconstructCutawayPersonRanges(...)` (legacy jobs). It is never inferred from
 * the segments themselves.
 * - `brollEnabled:false` adds the uploaded speaker over that exact fixed span.
 * - `brollEnabled:true` removes the speaker overlay and reveals B-roll over that span.
 */
export function resolveCutawayPersonRanges(
  rawSegments: CutawayBrollSegment[],
  basePersonRanges: CutawayRangeSec[],
): CutawayRangeSec[] {
  const segments = (Array.isArray(rawSegments) ? rawSegments : [])
    .map((raw, originalIndex) => ({
      raw,
      originalIndex,
      start: Number(raw?.start),
      end: Number(raw?.end),
    }))
    .filter((segment) =>
      Number.isFinite(segment.start)
      && Number.isFinite(segment.end)
      && segment.start >= 0
      && segment.end > segment.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  let personRanges = normalizeRanges(Array.isArray(basePersonRanges) ? basePersonRanges : []);

  for (const segment of segments) {
    if (typeof segment.raw.brollEnabled !== "boolean") continue;
    const span = { start: segment.start, end: segment.end };
    personRanges = segment.raw.brollEnabled
      ? subtractRange(personRanges, span)
      : normalizeRanges([...personRanges, span]);
  }
  return normalizeRanges(personRanges);
}

export type CutawayRecompositeDecision = {
  /** Ranges to hand to `/api/heygen/composite` (mode:"cutaway"). */
  personRanges: CutawayRangeSec[];
  /**
   * `true` => do NOT composite. Every window shows B-roll, so there is no speaker overlay
   * left. Compositing anyway is actively wrong: an empty `enable=` expression makes ffmpeg
   * draw the uploaded clip over the WHOLE video (the exact opposite of the user's edit).
   * The base render already carries the clip's own audio, so it IS the finished video.
   */
  skipComposite: boolean;
};

/**
 * Move the original person/B-roll decision onto edited window timings.
 *
 * A timing edit changes the span owned by a logical window, not whether that window shows the
 * uploaded speaker. Pairing source and edited segments by their stable array position keeps the
 * overlay and the rendered `bgVideos` boundary in lockstep. Invalid legacy data fails closed to
 * the persisted ranges instead of inventing a new layout.
 */
export function retimeCutawayPersonRanges(
  rawSourceSegments: CutawayBrollSegment[],
  rawEditedSegments: CutawayBrollSegment[],
  basePersonRanges: CutawayRangeSec[],
): CutawayRangeSec[] {
  const fallback = normalizeRanges(Array.isArray(basePersonRanges) ? basePersonRanges : []);
  if (
    !Array.isArray(rawSourceSegments)
    || !Array.isArray(rawEditedSegments)
    || rawSourceSegments.length === 0
    || rawSourceSegments.length !== rawEditedSegments.length
  ) return fallback;

  const retimed: CutawayRangeSec[] = [];
  for (let index = 0; index < rawSourceSegments.length; index++) {
    const sourceStart = Number(rawSourceSegments[index]?.start);
    const sourceEnd = Number(rawSourceSegments[index]?.end);
    const editedStart = Number(rawEditedSegments[index]?.start);
    const editedEnd = Number(rawEditedSegments[index]?.end);
    if (
      !Number.isFinite(sourceStart)
      || !Number.isFinite(sourceEnd)
      || sourceStart < 0
      || sourceEnd <= sourceStart
      || !Number.isFinite(editedStart)
      || !Number.isFinite(editedEnd)
      || editedStart < 0
      || editedEnd <= editedStart
    ) return fallback;

    const midpoint = sourceStart + (sourceEnd - sourceStart) / 2;
    if (fallback.some((range) => midpoint >= range.start && midpoint < range.end)) {
      retimed.push({ start: editedStart, end: editedEnd });
    }
  }
  return normalizeRanges(retimed);
}

/**
 * Decide what the free per-window re-render must do for an upload-cutaway preview.
 * Pure: no I/O, so the empty-ranges → skip-composite rule is unit-testable.
 */
export function planCutawayRecomposite(
  rawSegments: CutawayBrollSegment[],
  basePersonRanges: CutawayRangeSec[],
  sourceSegments?: CutawayBrollSegment[],
): CutawayRecompositeDecision {
  const timingAlignedBase = sourceSegments
    ? retimeCutawayPersonRanges(sourceSegments, rawSegments, basePersonRanges)
    : basePersonRanges;
  const personRanges = resolveCutawayPersonRanges(rawSegments, timingAlignedBase);
  const firstSegment = (Array.isArray(rawSegments) ? rawSegments : [])
    .filter((entry) => Number.isFinite(Number(entry?.start)) && Number.isFinite(Number(entry?.end)))
    .sort((left, right) => Number(left.start) - Number(right.start))[0];
  if (
    personRanges.length > 0
    && firstSegment
    && firstSegment.brollEnabled !== true
    && personRanges[0].start <= Number(firstSegment.end)
  ) {
    // Preserve the original hook fix for leading silence before the first transcript word.
    personRanges[0] = { ...personRanges[0], start: 0 };
  }
  return { personRanges, skipComposite: personRanges.length === 0 };
}

/**
 * ffmpeg overlay `enable=` expression, true during the given ranges (seconds).
 * '+' is logical OR in ffmpeg expressions. Empty => "" (caller draws always).
 * Defense-in-depth: this output is interpolated into an ffmpeg filter string, so accept
 * ONLY finite, non-negative numbers with end > start. `Number.isFinite` does not coerce
 * (drops strings/NaN/Infinity), and `toFixed(3)` emits only [-0-9.], so the result can
 * never contain filter-graph metacharacters. Non-array input => no ranges (never throws).
 */
export function buildEnableExpr(rangesSec: CutawayRangeSec[]): string {
  return (Array.isArray(rangesSec) ? rangesSec : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start)
    .map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`)
    .join("+");
}

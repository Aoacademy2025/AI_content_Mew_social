// Phase 1 planner for "upload clip + auto B-roll cutaway".
// Decides which b-roll windows show the uploaded clip (person) vs the b-roll base.
// Windows tile [0, clipEnd] with no gaps (see buildBrollWindows), so person ∪ broll
// covers the whole clip.

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

/**
 * Resolve the uploaded-speaker overlay ranges after per-window B-roll visibility edits.
 *
 * - New previews pass their persisted `basePersonRanges`, so repeated re-renders are stable.
 * - Legacy previews omit it; we reconstruct the original hook/person ↔ B-roll alternation from
 *   semantic `sourceIndex` (not raw segment index, because coverage repair may split a window).
 * - `brollEnabled:false` adds the uploaded speaker over that exact fixed span.
 * - `brollEnabled:true` removes the speaker overlay and reveals B-roll over that span.
 */
export function resolveCutawayPersonRanges(
  rawSegments: CutawayBrollSegment[],
  basePersonRanges?: CutawayRangeSec[] | null,
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

  let personRanges: CutawayRangeSec[];
  if (Array.isArray(basePersonRanges)) {
    personRanges = normalizeRanges(basePersonRanges);
  } else {
    const semanticOrdinal = new Map<string, number>();
    let nextOrdinal = 0;
    personRanges = [];
    for (const segment of segments) {
      const sourceIndex = segment.raw.sourceIndex;
      const key = typeof sourceIndex === "number" && Number.isFinite(sourceIndex) && sourceIndex >= 0
        ? `source:${Math.floor(sourceIndex)}`
        : `segment:${segment.originalIndex}`;
      if (!semanticOrdinal.has(key)) semanticOrdinal.set(key, nextOrdinal++);
      const ordinal = semanticOrdinal.get(key) ?? 0;
      if (ordinal % 2 === 0) personRanges.push({ start: segment.start, end: segment.end });
    }
    personRanges = normalizeRanges(personRanges);
  }

  for (const segment of segments) {
    if (typeof segment.raw.brollEnabled !== "boolean") continue;
    const span = { start: segment.start, end: segment.end };
    personRanges = segment.raw.brollEnabled
      ? subtractRange(personRanges, span)
      : normalizeRanges([...personRanges, span]);
  }
  return normalizeRanges(personRanges);
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

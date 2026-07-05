// Phase 1 planner for "upload clip + auto B-roll cutaway".
// Decides which b-roll windows show the uploaded clip (person) vs the b-roll base.
// Windows tile [0, clipEnd] with no gaps (see buildBrollWindows), so person ∪ broll
// covers the whole clip.

export type CutawayRange = { startMs: number; endMs: number };
export type CutawayPlan = { person: CutawayRange[]; broll: CutawayRange[] };

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
 * ffmpeg overlay `enable=` expression, true during the given ranges (seconds).
 * '+' is logical OR in ffmpeg expressions. Empty => "" (caller draws always).
 * Defense-in-depth: this output is interpolated into an ffmpeg filter string, so accept
 * ONLY finite, non-negative numbers with end > start. `Number.isFinite` does not coerce
 * (drops strings/NaN/Infinity), and `toFixed(3)` emits only [-0-9.], so the result can
 * never contain filter-graph metacharacters. Non-array input => no ranges (never throws).
 */
export function buildEnableExpr(rangesSec: { start: number; end: number }[]): string {
  return (Array.isArray(rangesSec) ? rangesSec : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start)
    .map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`)
    .join("+");
}

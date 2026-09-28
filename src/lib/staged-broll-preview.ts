/** Which staged B-roll asset covers the playhead. Pure: no render job and no file. */

export type StagedBrollSpan = {
  index: number;
  startMs: number;
  endMs: number;
};

export type StagedBrollEdit = {
  src?: string;
  enabled?: boolean;
};

export type StagedBrollOverlay = {
  src: string;
  offsetSec: number;
};

export function stagedBrollOverlayAt(
  timeMs: number,
  spans: readonly StagedBrollSpan[],
  edits: ReadonlyMap<number, StagedBrollEdit>,
): StagedBrollOverlay | null {
  if (!Number.isFinite(timeMs)) return null;
  const span = spans.find((item) => timeMs >= item.startMs && timeMs < item.endMs);
  if (!span) return null;
  const edit = edits.get(span.index);
  const src = edit?.src?.trim();
  if (!src || edit?.enabled === false) return null;
  return {
    src,
    offsetSec: Math.max(0, (timeMs - span.startMs) / 1000),
  };
}

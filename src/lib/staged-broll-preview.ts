/** Which staged B-roll asset covers the playhead. Pure: no render job and no file. */
import type { MotionTemplateConfig } from "./motion-broll-catalog";

export type StagedBrollSpan = {
  index: number;
  startMs: number;
  endMs: number;
};

export type StagedBrollEdit = {
  src?: string;
  enabled?: boolean;
  motionTemplate?: MotionTemplateConfig;
};

export type StagedBrollOverlay = {
  src: string;
  offsetSec: number;
  durationSec: number;
  motionTemplate?: MotionTemplateConfig;
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
  const durationSec = Math.max(0.2, (span.endMs - span.startMs) / 1000);
  return {
    src,
    offsetSec: Math.max(0, (timeMs - span.startMs) / 1000),
    durationSec,
    ...(edit?.motionTemplate ? { motionTemplate: edit.motionTemplate } : {}),
  };
}

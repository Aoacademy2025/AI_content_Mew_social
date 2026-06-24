export type BrollWindowCaption = { startMs: number; endMs: number; text: string };
export type BrollWindow = {
  startMs: number;
  endMs: number;
  captionStartIdx: number;
  captionEndIdx: number;
  text: string;
};

/**
 * Group consecutive captions into ~cadenceSec windows — the single unit b-roll uses.
 * Each window grows by including captions until its span reaches the cadence (cut on a
 * caption boundary); a caption longer than the cadence is its own window. Windows tile
 * [0, audioEnd] with no gaps/overlaps. Count ≈ ceil(audioDuration / cadenceSec).
 */
export function buildBrollWindows(captions: BrollWindowCaption[], cadenceSec: number): BrollWindow[] {
  const caps = (captions ?? []).filter(
    (c) => c && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs,
  );
  if (caps.length === 0) return [];
  const cadenceMs = Math.max(500, (cadenceSec > 0 ? cadenceSec : 4) * 1000);

  const windows: BrollWindow[] = [];
  let i = 0;
  while (i < caps.length) {
    const start = caps[i].startMs;
    let j = i;
    // grow until this window's span reaches the cadence, or we run out of captions
    while (j < caps.length - 1 && caps[j].endMs - start < cadenceMs) j++;
    windows.push({
      startMs: start,
      endMs: caps[j].endMs,
      captionStartIdx: i,
      captionEndIdx: j,
      text: caps.slice(i, j + 1).map((c) => c.text.trim()).filter(Boolean).join(" "),
    });
    i = j + 1;
  }
  return windows;
}

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
export function buildBrollWindows(
  captions: BrollWindowCaption[],
  cadenceSec: number,
  audioEndMs?: number,
): BrollWindow[] {
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

  // Captions from real TTS contain short natural pauses. Keep the previous visual on
  // screen through those pauses so coverage never interprets them as standalone cuts.
  let cursor = 0;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    window.startMs = cursor;
    if (index < windows.length - 1) {
      window.endMs = Math.max(window.endMs, windows[index + 1].startMs);
    } else if (Number.isFinite(audioEndMs) && (audioEndMs ?? 0) > 0) {
      window.endMs = Math.max(window.endMs, audioEndMs as number);
    }
    cursor = window.endMs;
  }
  return windows;
}

/**
 * Build the exact number of contiguous B-roll chapters requested by the user.
 *
 * When enough subtitle cards exist, chapter boundaries stay on caption boundaries
 * nearest to evenly-spaced time targets. This preserves authored sentence timing
 * while preventing a long clip from becoming five arbitrary equal-time slices.
 * When the requested count exceeds the caption count, time is split evenly and the
 * nearest/overlapping caption text is reused only as prompt context; the visual slots
 * themselves remain distinct and still tile the full audio timeline.
 */
export function buildFixedCountBrollWindows(
  captions: BrollWindowCaption[],
  requestedCount: number,
  audioEndMs?: number,
  maxCount = 60,
): BrollWindow[] {
  const caps = (captions ?? [])
    .filter((caption) => (
      caption
      && Number.isFinite(caption.startMs)
      && Number.isFinite(caption.endMs)
      && caption.endMs > caption.startMs
    ))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const countCap = Number.isFinite(maxCount) ? Math.max(0, Math.floor(maxCount)) : 60;
  const count = Number.isFinite(requestedCount)
    ? Math.max(0, Math.min(countCap, Math.floor(requestedCount)))
    : 0;
  if (caps.length === 0 || count === 0) return [];

  const lastCaptionEndMs = caps.reduce((latest, caption) => Math.max(latest, caption.endMs), 0);
  const timelineEndMs = Math.max(
    1,
    lastCaptionEndMs,
    Number.isFinite(audioEndMs) && (audioEndMs ?? 0) > 0 ? Math.round(audioEndMs as number) : 0,
  );

  if (count <= caps.length) {
    const groups: Array<{ startIdx: number; endIdx: number }> = [];
    let startIdx = 0;
    for (let groupIndex = 0; groupIndex < count - 1; groupIndex += 1) {
      const remainingGroups = count - groupIndex - 1;
      const maxEndIdx = caps.length - remainingGroups - 1;
      const targetEndMs = (timelineEndMs * (groupIndex + 1)) / count;
      let bestEndIdx = startIdx;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let candidate = startIdx; candidate <= maxEndIdx; candidate += 1) {
        const distance = Math.abs(caps[candidate].endMs - targetEndMs);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEndIdx = candidate;
        }
      }
      groups.push({ startIdx, endIdx: bestEndIdx });
      startIdx = bestEndIdx + 1;
    }
    groups.push({ startIdx, endIdx: caps.length - 1 });

    let cursorMs = 0;
    return groups.map((group, index) => {
      const nextGroup = groups[index + 1];
      const endMs = nextGroup
        ? Math.max(cursorMs + 1, Math.min(timelineEndMs, caps[nextGroup.startIdx].startMs))
        : timelineEndMs;
      const window: BrollWindow = {
        startMs: cursorMs,
        endMs,
        captionStartIdx: group.startIdx,
        captionEndIdx: group.endIdx,
        text: caps.slice(group.startIdx, group.endIdx + 1)
          .map((caption) => caption.text.trim())
          .filter(Boolean)
          .join(" "),
      };
      cursorMs = endMs;
      return window;
    });
  }

  // More requested visuals than caption cards: preserve the exact user count by
  // splitting time. Prompt context follows whichever card overlaps that slot.
  return Array.from({ length: count }, (_, index) => {
    const startMs = Math.round((timelineEndMs * index) / count);
    const endMs = index === count - 1
      ? timelineEndMs
      : Math.round((timelineEndMs * (index + 1)) / count);
    const overlapping = caps
      .map((caption, captionIndex) => ({ caption, captionIndex }))
      .filter(({ caption }) => caption.endMs > startMs && caption.startMs < endMs);
    const midpoint = (startMs + endMs) / 2;
    const nearest = overlapping.length > 0
      ? overlapping
      : [caps
          .map((caption, captionIndex) => ({ caption, captionIndex }))
          .reduce((best, candidate) => {
            const bestMidpoint = (best.caption.startMs + best.caption.endMs) / 2;
            const candidateMidpoint = (candidate.caption.startMs + candidate.caption.endMs) / 2;
            return Math.abs(candidateMidpoint - midpoint) < Math.abs(bestMidpoint - midpoint)
              ? candidate
              : best;
          })];
    return {
      startMs,
      endMs,
      captionStartIdx: nearest[0].captionIndex,
      captionEndIdx: nearest[nearest.length - 1].captionIndex,
      text: nearest.map(({ caption }) => caption.text.trim()).filter(Boolean).join(" "),
    };
  });
}

import type { TimedWord } from "@/lib/tts-timing";

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

type NarrativeAlignedBrollInput = {
  captions: BrollWindowCaption[];
  words: TimedWord[];
  spokenText: string;
  narrativeWindows: string[];
  audioEndMs?: number;
};

function narrativePresentationCharacters(value: string): string[] {
  switch (value) {
    case "…":
      return [".", ".", "."];
    case "“":
    case "”":
      return ["\""];
    case "‘":
    case "’":
      return ["'"];
    default:
      return [value];
  }
}

function visibleCharacters(text: string): Array<{ value: string; startChar: number; endChar: number }> {
  const characters: Array<{ value: string; startChar: number; endChar: number }> = [];
  let offset = 0;
  for (const value of text) {
    const startChar = offset;
    offset += value.length;
    if (/\s/u.test(value)) continue;
    narrativePresentationCharacters(value).forEach((presentationValue) => {
      characters.push({ value: presentationValue, startChar, endChar: offset });
    });
  }
  return characters;
}

function boundaryTimeFromWords(words: TimedWord[], boundaryChar: number): number | null {
  const ordered = words
    .filter((word) => (
      Number.isFinite(word.startMs)
      && Number.isFinite(word.endMs)
      && word.endMs > word.startMs
      && Number.isSafeInteger(word.startChar)
      && Number.isSafeInteger(word.endChar)
      && word.endChar > word.startChar
    ))
    .sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar);
  if (ordered.length === 0) return null;
  for (const word of ordered) {
    if (boundaryChar <= word.startChar) return Math.round(word.startMs);
    if (boundaryChar < word.endChar) {
      const ratio = (boundaryChar - word.startChar) / (word.endChar - word.startChar);
      return Math.round(word.startMs + ratio * (word.endMs - word.startMs));
    }
  }
  return Math.round(ordered[ordered.length - 1].endMs);
}

/**
 * Put the exact Narrative windows accepted by Content Preflight onto the TTS
 * timeline. Scene N therefore speaks the same source excerpt Visual Beat N was
 * analyzed from; an unrelated fixed-count timing planner can never silently
 * pair a Beat with different words.
 *
 * Whitespace and equivalent typographic punctuation are presentation-only for
 * this alignment. Every narrative character must otherwise match exactly and
 * in order. A mismatch returns null so Brand Visual callers can fail closed
 * before image/provider spend.
 */
export function buildNarrativeAlignedBrollWindows(
  input: NarrativeAlignedBrollInput,
): BrollWindow[] | null {
  const narrativeWindows = input.narrativeWindows.map((window) => window.trim());
  if (narrativeWindows.length === 0 || narrativeWindows.some((window) => !window)) return null;
  const spokenVisible = visibleCharacters(input.spokenText);
  const windowVisible = narrativeWindows.map(visibleCharacters);
  const narrativeVisibleText = windowVisible.flat().map((character) => character.value).join("");
  if (
    spokenVisible.length === 0
    || narrativeVisibleText !== spokenVisible.map((character) => character.value).join("")
  ) return null;

  const captions = input.captions
    .filter((caption) => (
      Number.isFinite(caption.startMs)
      && Number.isFinite(caption.endMs)
      && caption.endMs > caption.startMs
    ))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const lastTimedEnd = Math.max(
    0,
    ...captions.map((caption) => caption.endMs),
    ...input.words.map((word) => Number.isFinite(word.endMs) ? word.endMs : 0),
  );
  const audioEndMs = Math.max(
    1,
    lastTimedEnd,
    Number.isFinite(input.audioEndMs) && (input.audioEndMs ?? 0) > 0
      ? Math.round(input.audioEndMs as number)
      : 0,
  );
  if (audioEndMs < narrativeWindows.length) return null;

  const boundaryTimes = [0];
  let visibleOffset = 0;
  for (let index = 0; index < windowVisible.length - 1; index += 1) {
    visibleOffset += windowVisible[index].length;
    const boundaryChar = spokenVisible[visibleOffset]?.startChar;
    if (boundaryChar === undefined) return null;
    const boundaryTime = boundaryTimeFromWords(input.words, boundaryChar);
    if (boundaryTime === null) return null;
    const minimum = boundaryTimes[boundaryTimes.length - 1] + 1;
    const remainingWindows = narrativeWindows.length - index - 1;
    const maximum = audioEndMs - remainingWindows;
    if (minimum > maximum) return null;
    boundaryTimes.push(Math.max(minimum, Math.min(maximum, boundaryTime)));
  }
  boundaryTimes.push(audioEndMs);

  return narrativeWindows.map((text, index) => {
    const startMs = boundaryTimes[index];
    const endMs = boundaryTimes[index + 1];
    const overlapping = captions
      .map((caption, captionIndex) => ({ caption, captionIndex }))
      .filter(({ caption }) => caption.endMs > startMs && caption.startMs < endMs);
    const midpoint = (startMs + endMs) / 2;
    const nearest = overlapping.length > 0
      ? overlapping
      : captions.length > 0
        ? [captions
            .map((caption, captionIndex) => ({ caption, captionIndex }))
            .reduce((best, candidate) => {
              const bestMidpoint = (best.caption.startMs + best.caption.endMs) / 2;
              const candidateMidpoint = (candidate.caption.startMs + candidate.caption.endMs) / 2;
              return Math.abs(candidateMidpoint - midpoint) < Math.abs(bestMidpoint - midpoint)
                ? candidate
                : best;
            })]
        : [];
    return {
      startMs,
      endMs,
      captionStartIdx: nearest[0]?.captionIndex ?? 0,
      captionEndIdx: nearest[nearest.length - 1]?.captionIndex ?? 0,
      text,
    };
  });
}

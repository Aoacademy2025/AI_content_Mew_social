export const TIGHTEN_DEFAULT_MAX_GAP_MS = 400;
export const TIGHTEN_MIN_MAX_GAP_MS = 250;
export const TIGHTEN_MAX_MAX_GAP_MS = 2000;
export const TIGHTEN_RESIDUAL_SILENCE_MS = 100;
export const TIGHTEN_CROSSFADE_MS = 12;
export const TIGHTEN_DEFAULT_SPEED = 1.1;
export const TIGHTEN_MIN_SPEED = 1.0;
export const TIGHTEN_MAX_SPEED = 1.25;

export type TightenInput = {
  tighten?: boolean | null;
  tightenMaxGapMs?: number | null;
  tightenSpeed?: number | null;
};

export type ResolvedTightenOptions = {
  enabled: boolean;
  maxGapMs: number;
  residualGapMs: number;
  crossfadeMs: number;
  speed: number;
};

export type SilenceIntervalSec = {
  start: number;
  end: number;
};

export type TightenSegmentSec = {
  startSec: number;
  endSec: number;
};

export type TightenPlan = {
  segments: TightenSegmentSec[];
  jumpCutTimesSec: number[];
  estimatedOutputDurationSec: number;
  trimmedSilenceMs: number;
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function isValidTightenMaxGapMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= TIGHTEN_MIN_MAX_GAP_MS &&
    value <= TIGHTEN_MAX_MAX_GAP_MS
  );
}

export function isValidTightenSpeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= TIGHTEN_MIN_SPEED &&
    value <= TIGHTEN_MAX_SPEED
  );
}

export function resolveTightenOptions(input: TightenInput): ResolvedTightenOptions {
  const hasExplicitOverrides =
    typeof input.tightenMaxGapMs === "number" || typeof input.tightenSpeed === "number";
  const enabled = input.tighten === true || (input.tighten !== false && hasExplicitOverrides);

  const rawGap =
    typeof input.tightenMaxGapMs === "number" && Number.isFinite(input.tightenMaxGapMs)
      ? Math.round(input.tightenMaxGapMs)
      : TIGHTEN_DEFAULT_MAX_GAP_MS;
  const maxGapMs = Math.min(
    TIGHTEN_MAX_MAX_GAP_MS,
    Math.max(TIGHTEN_MIN_MAX_GAP_MS, rawGap),
  );

  const rawSpeed =
    typeof input.tightenSpeed === "number" && Number.isFinite(input.tightenSpeed)
      ? input.tightenSpeed
      : TIGHTEN_DEFAULT_SPEED;
  const speed = round3(Math.min(TIGHTEN_MAX_SPEED, Math.max(TIGHTEN_MIN_SPEED, rawSpeed)));

  return {
    enabled,
    maxGapMs,
    residualGapMs: TIGHTEN_RESIDUAL_SILENCE_MS,
    crossfadeMs: TIGHTEN_CROSSFADE_MS,
    speed,
  };
}

export function parseFfmpegSilenceDetectIntervals(
  stderr: string,
  durationSec: number,
): SilenceIntervalSec[] {
  const intervals: SilenceIntervalSec[] = [];
  let openStart: number | null = null;
  const lines = stderr.split(/\r?\n/);

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      const start = Number(startMatch[1]);
      if (Number.isFinite(start) && start >= 0) {
        openStart = start;
      }
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch && openStart !== null) {
      const end = Number(endMatch[1]);
      if (Number.isFinite(end) && end > openStart) {
        intervals.push({ start: openStart, end: Math.min(durationSec, end) });
      }
      openStart = null;
    }
  }

  if (openStart !== null && durationSec > openStart) {
    intervals.push({ start: openStart, end: durationSec });
  }

  return intervals;
}

/**
 * Compute synchronized video/audio keep-segments and output jump-cut timestamps from
 * detected silence intervals.
 */
export function planTightenKeepSegments(input: {
  durationSec: number;
  silences: readonly SilenceIntervalSec[];
  maxGapMs: number;
  residualGapMs?: number;
  crossfadeMs?: number;
  speed: number;
}): TightenPlan {
  const durationSec = Math.max(0, input.durationSec);
  if (durationSec <= 0) {
    return {
      segments: [],
      jumpCutTimesSec: [],
      estimatedOutputDurationSec: 0,
      trimmedSilenceMs: 0,
    };
  }

  const maxGapSec = Math.max(0.1, input.maxGapMs / 1000);
  const residualSec = Math.min(
    maxGapSec * 0.8,
    Math.max(0, (input.residualGapMs ?? TIGHTEN_RESIDUAL_SILENCE_MS) / 1000),
  );
  const halfResidualSec = residualSec / 2;
  const minKeepSegmentSec = 0.18;

  const sortedSilences = [...input.silences]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({
      start: Math.max(0, s.start),
      end: Math.min(durationSec, s.end),
    }))
    .filter((s) => s.end - s.start >= maxGapSec)
    .sort((a, b) => a.start - b.start);

  const segments: TightenSegmentSec[] = [];
  let cursor = 0;
  let trimmedSilenceSec = 0;

  for (const silence of sortedSilences) {
    const cutStart = round3(Math.max(cursor, silence.start + halfResidualSec));
    const cutEnd = round3(Math.min(durationSec, silence.end - halfResidualSec));
    if (cutEnd <= cutStart + 0.04) continue;

    if (cutStart - cursor >= minKeepSegmentSec) {
      segments.push({ startSec: round3(cursor), endSec: cutStart });
      trimmedSilenceSec += cutEnd - cutStart;
      cursor = cutEnd;
    } else if (cursor === 0 && silence.start <= 0.08) {
      // Trim dead leading silence at the very beginning of the clip.
      trimmedSilenceSec += cutEnd - cursor;
      cursor = cutEnd;
    }
  }

  if (durationSec - cursor >= minKeepSegmentSec) {
    segments.push({ startSec: round3(cursor), endSec: round3(durationSec) });
  } else if (segments.length === 0) {
    segments.push({ startSec: 0, endSec: round3(durationSec) });
    trimmedSilenceSec = 0;
  }

  const speed = Math.max(0.5, input.speed || 1);
  const jumpCutTimesSec: number[] = [];
  let accSourceSec = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    accSourceSec += seg.endSec - seg.startSec;
    if (i < segments.length - 1) {
      const outCueSec = round3(Math.max(0, accSourceSec / speed));
      jumpCutTimesSec.push(outCueSec);
    }
  }

  const totalKeptSec = Math.max(0.1, accSourceSec);
  const estimatedOutputDurationSec = round3(totalKeptSec / speed);

  return {
    segments,
    jumpCutTimesSec,
    estimatedOutputDurationSec,
    trimmedSilenceMs: Math.round(trimmedSilenceSec * 1000),
  };
}

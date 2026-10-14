export const TTS_SPEED_MIN = 0.85;
export const TTS_SPEED_MAX = 1.25;
export const TARGET_DURATION_AUTO_SPEED_MIN = 0.85;
export const TARGET_DURATION_AUTO_SPEED_MAX = 1.20;
export const TARGET_DURATION_SEC_MIN = 5;
export const TARGET_DURATION_SEC_MAX = 600;

export type TtsPaceInput = {
  ttsSpeed?: number | null;
  targetDurationSec?: number | null;
};

export type TtsPaceResolution = {
  effectiveSpeed: number;
  clamped: boolean;
  requestedSpeed?: number;
  warning?: string;
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function isValidTtsSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= TTS_SPEED_MIN && value <= TTS_SPEED_MAX;
}

export function isValidTargetDurationSec(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= TARGET_DURATION_SEC_MIN &&
    value <= TARGET_DURATION_SEC_MAX
  );
}

/**
 * Resolve the effective playback speed for generated TTS audio.
 *
 * - When `targetDurationSec` is provided, computes `naturalDurationSec / targetDurationSec`
 *   and clamps to the natural `[0.85x, 1.20x]` band with a Thai `warning` when clamped.
 * - Otherwise, when `ttsSpeed` is provided, clamps to `[0.85x, 1.25x]`.
 * - Defaults to `1.0x`.
 */
export function resolveEffectiveTtsSpeed(input: {
  ttsSpeed?: number | null;
  targetDurationSec?: number | null;
  naturalDurationSec: number;
}): TtsPaceResolution {
  const { ttsSpeed, targetDurationSec, naturalDurationSec } = input;

  if (
    typeof targetDurationSec === "number" &&
    Number.isFinite(targetDurationSec) &&
    targetDurationSec > 0 &&
    Number.isFinite(naturalDurationSec) &&
    naturalDurationSec > 0
  ) {
    const rawSpeed = naturalDurationSec / targetDurationSec;
    const clampedSpeed = Math.min(
      TARGET_DURATION_AUTO_SPEED_MAX,
      Math.max(TARGET_DURATION_AUTO_SPEED_MIN, rawSpeed),
    );
    const effectiveSpeed = round3(clampedSpeed);
    const clamped = Math.abs(clampedSpeed - rawSpeed) > 0.015;
    if (clamped) {
      const projectedSec = Math.max(1, Math.round((naturalDurationSec / effectiveSpeed) * 10) / 10);
      const boundLabel =
        rawSpeed > TARGET_DURATION_AUTO_SPEED_MAX
          ? `สูงสุด ${TARGET_DURATION_AUTO_SPEED_MAX.toFixed(2)}x`
          : `ต่ำสุด ${TARGET_DURATION_AUTO_SPEED_MIN.toFixed(2)}x`;
      return {
        effectiveSpeed,
        clamped: true,
        requestedSpeed: round3(rawSpeed),
        warning: `ปรับความเร็วเสียงพากย์ได้${boundLabel} เพื่อความเป็นธรรมชาติ (ความยาวจริงประมาณ ${projectedSec} วินาที จากเป้าหมาย ${Math.round(targetDurationSec)} วินาที)`,
      };
    }
    return {
      effectiveSpeed,
      clamped: false,
      requestedSpeed: round3(rawSpeed),
    };
  }

  if (typeof ttsSpeed === "number" && Number.isFinite(ttsSpeed) && ttsSpeed > 0) {
    const clampedSpeed = Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, ttsSpeed));
    const effectiveSpeed = round3(clampedSpeed);
    const clamped = Math.abs(clampedSpeed - ttsSpeed) > 1e-4;
    return {
      effectiveSpeed,
      clamped,
      requestedSpeed: round3(ttsSpeed),
    };
  }

  return { effectiveSpeed: 1, clamped: false };
}

export function estimatePacedDurationSeconds(
  baseDurationSec: number,
  input: TtsPaceInput,
): {
  durationSeconds: number;
  effectiveSpeed: number;
  clamped: boolean;
  warning?: string;
} {
  if (!(baseDurationSec > 0) || !Number.isFinite(baseDurationSec)) {
    return { durationSeconds: 0, effectiveSpeed: 1, clamped: false };
  }
  const res = resolveEffectiveTtsSpeed({
    ttsSpeed: input.ttsSpeed,
    targetDurationSec: input.targetDurationSec,
    naturalDurationSec: baseDurationSec,
  });
  const durationSeconds = Math.max(1, Math.round((baseDurationSec / res.effectiveSpeed) * 100) / 100);
  return {
    durationSeconds,
    effectiveSpeed: res.effectiveSpeed,
    clamped: res.clamped,
    ...(res.warning ? { warning: res.warning } : {}),
  };
}

import type { TtsTiming } from "./tts-timing";

export function scaleTtsTiming<
  T extends { startMs: number; endMs: number; durationMs?: number },
>(timing: readonly T[], speed: number): T[];
export function scaleTtsTiming(
  timing: TtsTiming | undefined,
  speed: number,
): TtsTiming | undefined;
export function scaleTtsTiming<
  T extends { startMs: number; endMs: number; durationMs?: number },
>(
  timing: readonly T[] | TtsTiming | undefined,
  speed: number,
): T[] | TtsTiming | undefined {
  if (!timing) return undefined;
  const noOp = !Number.isFinite(speed) || speed <= 0 || Math.abs(speed - 1) < 0.005;
  if (Array.isArray(timing)) {
    if (noOp) {
      return timing.map((item) => ({ ...item }));
    }
    return timing.map((item) => {
      const startMs = Math.max(0, Math.round(item.startMs / speed));
      const endMs = Math.max(startMs, Math.round(item.endMs / speed));
      return {
        ...item,
        startMs,
        endMs,
        ...(typeof item.durationMs === "number"
          ? { durationMs: Math.max(0, endMs - startMs) }
          : {}),
      };
    });
  }
  const obj = timing as TtsTiming;
  if (noOp) {
    return {
      ...obj,
      segments: obj.segments.map((seg) => ({ ...seg })),
      chars: obj.chars
        ? {
            characters: [...obj.chars.characters],
            startSec: [...obj.chars.startSec],
            endSec: [...obj.chars.endSec],
          }
        : null,
      ...(obj.silences ? { silences: [...obj.silences] } : {}),
      ...(obj.silenceIntervals
        ? { silenceIntervals: obj.silenceIntervals.map((iv) => ({ ...iv })) }
        : {}),
    };
  }
  return {
    ...obj,
    segments: obj.segments.map((seg) => ({
      ...seg,
      startMs: Math.max(0, Math.round(seg.startMs / speed)),
      durationMs: Math.max(1, Math.round(seg.durationMs / speed)),
    })),
    chars: obj.chars
      ? {
          characters: [...obj.chars.characters],
          startSec: obj.chars.startSec.map((s) => round3(Math.max(0, s / speed))),
          endSec: obj.chars.endSec.map((e) => round3(Math.max(0, e / speed))),
        }
      : null,
    ...(obj.silences
      ? { silences: obj.silences.map((ms) => Math.max(0, Math.round(ms / speed))) }
      : {}),
    ...(obj.silenceIntervals
      ? {
          silenceIntervals: obj.silenceIntervals.map((iv) => {
            const startMs = Math.max(0, Math.round(iv.startMs / speed));
            const endMs = Math.max(startMs, Math.round(iv.endMs / speed));
            return { startMs, endMs };
          }),
        }
      : {}),
  };
}

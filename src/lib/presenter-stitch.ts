export const MIN_STITCH_CLIPS = 1;
export const MAX_STITCH_CLIPS = 10;
export const STITCH_CROSSFADE_MS = 12;
export const STITCH_TARGET_WIDTH = 1080;
export const STITCH_TARGET_HEIGHT = 1920;
export const STITCH_TARGET_FPS = 30;
export const STITCH_TARGET_SAMPLE_RATE = 48000;

export type StitchedDurationPlan = {
  totalDurationMs: number;
  totalDurationSec: number;
  stitchCutTimesSec: number[];
};

/**
 * Compute the stitched timeline duration and boundary cut timestamps (in seconds)
 * across an ordered list of presenter clip durations.
 *
 * Edge micro-fades (12ms) are applied inside the head/tail of each clip before
 * `concat=n=N:v=1:a=1`, keeping video and audio stream lengths 100% locked.
 */
export function computeStitchedDurationMs(
  durationsMs: readonly number[],
): StitchedDurationPlan {
  const valid = durationsMs
    .map((d) => (Number.isFinite(d) && d > 0 ? Math.round(d) : 0))
    .filter((d) => d > 0);

  if (valid.length === 0) {
    return {
      totalDurationMs: 0,
      totalDurationSec: 0,
      stitchCutTimesSec: [],
    };
  }

  let runningMs = 0;
  const stitchCutTimesSec: number[] = [];
  for (let i = 0; i < valid.length; i += 1) {
    runningMs += valid[i]!;
    if (i < valid.length - 1) {
      stitchCutTimesSec.push(Number((runningMs / 1000).toFixed(3)));
    }
  }

  return {
    totalDurationMs: runningMs,
    totalDurationSec: Number((runningMs / 1000).toFixed(3)),
    stitchCutTimesSec,
  };
}

export type PresenterStitchFilterClipSpec = {
  durationSec: number;
  hasAudio?: boolean;
};

/**
 * Build a deterministic FFmpeg `filter_complex` graph that normalizes N presenter clips
 * to 1080x1920 @ 30fps (`yuv420p`, `setsar=1`) and 48kHz stereo audio with 12ms
 * boundary micro-fades (`afade`), then concatenates them into `[vout]` and `[aout]`.
 */
export function buildPresenterStitchFfmpegFilter(
  clips: readonly (number | PresenterStitchFilterClipSpec)[],
  options?: {
    width?: number;
    height?: number;
    fps?: number;
    sampleRate?: number;
    fadeMs?: number;
  },
): string {
  if (clips.length === 0) {
    throw new Error("buildPresenterStitchFfmpegFilter requires at least 1 clip");
  }

  const width = options?.width ?? STITCH_TARGET_WIDTH;
  const height = options?.height ?? STITCH_TARGET_HEIGHT;
  const fps = options?.fps ?? STITCH_TARGET_FPS;
  const sampleRate = options?.sampleRate ?? STITCH_TARGET_SAMPLE_RATE;
  const fadeMs = options?.fadeMs ?? STITCH_CROSSFADE_MS;
  const fadeSec = Number(Math.max(0.004, fadeMs / 1000).toFixed(4));

  const parts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < clips.length; i += 1) {
    const raw = clips[i]!;
    const spec: PresenterStitchFilterClipSpec =
      typeof raw === "number" ? { durationSec: raw, hasAudio: true } : raw;
    const dur = Math.max(0.05, Number(spec.durationSec) || 0.05);
    const hasAudio = spec.hasAudio !== false;

    parts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    );

    const afades: string[] = [];
    if (clips.length > 1 && dur > fadeSec * 2.5) {
      if (i > 0) {
        afades.push(`afade=t=in:st=0:d=${fadeSec}`);
      }
      if (i < clips.length - 1) {
        const fadeOutStart = Number(Math.max(0, dur - fadeSec).toFixed(4));
        afades.push(`afade=t=out:st=${fadeOutStart}:d=${fadeSec}`);
      }
    }
    const fadeChain = afades.length > 0 ? `,${afades.join(",")}` : "";

    if (hasAudio) {
      parts.push(
        `[${i}:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS${fadeChain}[a${i}]`,
      );
    } else {
      const durFixed = Number(dur.toFixed(4));
      parts.push(
        `anullsrc=r=${sampleRate}:cl=stereo,atrim=0:${durFixed},asetpts=PTS-STARTPTS${fadeChain}[a${i}]`,
      );
    }

    concatInputs.push(`[v${i}][a${i}]`);
  }

  if (clips.length === 1) {
    parts.push(`[v0]null[vout]`);
    parts.push(`[a0]anull[aout]`);
  } else {
    parts.push(
      `${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[vout][aout]`,
    );
  }

  return parts.join(";");
}

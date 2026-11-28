/**
 * Beat-Synced Multi-Cut & Speed Ramp Planner (`src/lib/beat-sync-plan.ts`).
 *
 * Pure, client- & server-safe deterministic rhythm engine for AI Story Director:
 *   1. `detectBpmAndBeatsFromEnvelope` — Percussion onset flux + autocorrelation BPM
 *      estimator (`92..152 BPM`) over low-rate energy envelopes, snapping cuts to
 *      30fps frame boundaries (`round(sec * 30) / 30`).
 *   2. `buildMusicalBeatGrid` — Clean beat grid for any BPM (`default 124 BPM` upbeat
 *      pop/rock/marching cadence) with downbeat markers (`isBarDownbeat`).
 *   3. `planBeatSyncedStoryCuts` — Subdivides raw uploaded clips + photos into a
 *      high-retention vertical story EDL:
 *        • Cold Open with real clip speech/reaction audio (`keepClipAudio: true`)
 *        • Hero Freeze Intro (`freezeAtEndFrames` + `hero-freeze-card` shutter flash)
 *        • Beat-locked snappy `0.95–1.55s` cuts (`transition: "cut"`)
 *        • Smooth `slow-mo` (`playbackRate: 0.58`) on peak action moments
 *        • Optional `blooper-end` tail with live reaction audio
 */

import type { FaceBox } from "@/lib/face-safe-placement";
import type { BrollVideo } from "@/remotion/types";

export const DEFAULT_STORY_BPM = 124;
export const MIN_BEAT_BPM = 88;
export const MAX_BEAT_BPM = 158;
const RENDER_FPS = 30;

export function snapToFrameSec(sec: number, fps = RENDER_FPS): number {
  return Math.round(Math.max(0, sec) * fps) / fps;
}

export interface BeatPoint {
  timeSec: number;
  beatIndex: number;
  isDownbeat: boolean;
}

export function buildMusicalBeatGrid(input: {
  durationSec: number;
  bpm?: number;
  firstBeatOffsetSec?: number;
  fps?: number;
}): BeatPoint[] {
  const durationSec = Math.max(0.5, Number(input.durationSec) || 15);
  const rawBpm = Number(input.bpm);
  const bpm = Number.isFinite(rawBpm)
    ? Math.max(MIN_BEAT_BPM, Math.min(MAX_BEAT_BPM, rawBpm))
    : DEFAULT_STORY_BPM;
  const fps = input.fps && input.fps > 0 ? input.fps : RENDER_FPS;
  const beatDur = 60 / bpm;
  const startOffset = Math.max(0, Number(input.firstBeatOffsetSec) || 0);

  const beats: BeatPoint[] = [];
  for (let i = 0; ; i += 1) {
    const rawTime = startOffset + i * beatDur;
    if (rawTime > durationSec + 0.02) break;
    beats.push({
      timeSec: snapToFrameSec(rawTime, fps),
      beatIndex: i,
      isDownbeat: i % 4 === 0,
    });
  }
  return beats;
}

/**
 * Estimates BPM (`92..152 BPM`) and first-beat phase offset from a 1D RMS/energy envelope
 * sampled at `envelopeHz` (e.g., 100 Hz or 200 Hz).
 */
export function detectBpmAndBeatsFromEnvelope(
  envelope: ArrayLike<number>,
  envelopeHz: number,
  durationSec: number,
): { bpm: number; firstBeatOffsetSec: number; beats: BeatPoint[] } {
  const n = envelope.length;
  if (n < envelopeHz * 2 || envelopeHz <= 10) {
    return {
      bpm: DEFAULT_STORY_BPM,
      firstBeatOffsetSec: 0,
      beats: buildMusicalBeatGrid({ durationSec, bpm: DEFAULT_STORY_BPM }),
    };
  }

  // Positive first-order spectral/energy flux (percussive attacks)
  const onset = new Float64Array(n);
  let maxOnset = 0;
  for (let i = 1; i < n; i += 1) {
    const diff = (envelope[i] ?? 0) - (envelope[i - 1] ?? 0);
    if (diff > 0) {
      onset[i] = diff;
      if (diff > maxOnset) maxOnset = diff;
    }
  }

  if (maxOnset <= 1e-6) {
    return {
      bpm: DEFAULT_STORY_BPM,
      firstBeatOffsetSec: 0,
      beats: buildMusicalBeatGrid({ durationSec, bpm: DEFAULT_STORY_BPM }),
    };
  }

  for (let i = 0; i < n; i += 1) onset[i] /= maxOnset;

  // Autocorrelation over candidate BPMs [92..152]
  let bestBpm = DEFAULT_STORY_BPM;
  let bestScore = -1;
  for (let bpm = 92; bpm <= 152; bpm += 2) {
    const lag = Math.round((60 / bpm) * envelopeHz);
    if (lag < 2 || lag >= n / 2) continue;
    let sum = 0;
    let count = 0;
    for (let i = 0; i + lag < n; i += 1) {
      sum += onset[i]! * onset[i + lag]!;
      if (i + lag * 2 < n) {
        sum += 0.5 * onset[i]! * onset[i + lag * 2]!;
      }
      count += 1;
    }
    // Mild perceptual prior around energetic short-video tempos (116..132 BPM)
    const tempoPrior = 1 - Math.abs(bpm - 124) * 0.0018;
    const score = count > 0 ? (sum / count) * tempoPrior : 0;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  // Phase alignment: find offset in [0, beatPeriod) that maximizes onset hits
  const beatFrames = Math.max(2, Math.round((60 / bestBpm) * envelopeHz));
  let bestPhase = 0;
  let bestPhaseEnergy = -1;
  for (let phase = 0; phase < beatFrames; phase += 1) {
    let energy = 0;
    for (let pos = phase; pos < n; pos += beatFrames) {
      energy += onset[pos]! + (pos > 0 ? onset[pos - 1]! * 0.45 : 0) + (pos + 1 < n ? onset[pos + 1]! * 0.45 : 0);
    }
    if (energy > bestPhaseEnergy) {
      bestPhaseEnergy = energy;
      bestPhase = phase;
    }
  }

  const firstBeatOffsetSec = snapToFrameSec(bestPhase / envelopeHz);
  return {
    bpm: bestBpm,
    firstBeatOffsetSec,
    beats: buildMusicalBeatGrid({
      durationSec,
      bpm: bestBpm,
      firstBeatOffsetSec,
    }),
  };
}

export interface StoryCandidateClip {
  src: string;
  durationSec: number;
  stillImage?: boolean;
  hasAudio?: boolean;
  /** True when speech/cheer energy was detected in this clip (ideal for Cold Open or Blooper). */
  hasSpeechOrCheer?: boolean;
  /** Optional peak action start offset inside the clip (seconds). */
  bestOffsetSec?: number;
  /** Optional detected face bounding boxes in normalized 0..1 coordinates. */
  faceBoxes?: FaceBox[];
  label?: string;
}

export interface BeatSyncStoryEdlOptions {
  clips: readonly StoryCandidateClip[];
  targetDurationSec: number;
  bpm?: number;
  firstBeatOffsetSec?: number;
  /** Play real clip audio on the opening shot (`Cold Open` Q&A / cheer). */
  keepColdOpenAudio?: boolean;
  /** Add camera-shutter freeze hold (`freezeAtEndFrames`) on the hero reveal shot. */
  heroFreezeIntro?: boolean;
  /** Apply `0.58x` smooth slow-mo on the longest high-action middle clip. */
  slowMoPeakShot?: boolean;
  /** Reserve the final ~2.4s for a playful behind-the-scenes/blooper clip with native audio. */
  blooperTail?: boolean;
}

export interface BeatSyncStoryEdlResult {
  bpm: number;
  beats: BeatPoint[];
  bgVideos: BrollVideo[];
  coldOpenEndSec: number;
  heroFreezeRangeSec: { startSec: number; endSec: number } | null;
  peakSlowMoIndex: number | null;
  blooperRangeSec: { startSec: number; endSec: number } | null;
}

/**
 * Builds a complete, frame-accurate 30fps `bgVideos` timeline locked to the beat grid.
 */
export function planBeatSyncedStoryCuts(options: BeatSyncStoryEdlOptions): BeatSyncStoryEdlResult {
  const validClips = options.clips.filter((c) => Boolean(c.src) && c.durationSec > 0);
  const targetDurationSec = Math.max(4, snapToFrameSec(options.targetDurationSec));
  const bpm = options.bpm && Number.isFinite(options.bpm)
    ? Math.max(MIN_BEAT_BPM, Math.min(MAX_BEAT_BPM, options.bpm))
    : DEFAULT_STORY_BPM;
  const beats = buildMusicalBeatGrid({
    durationSec: targetDurationSec,
    bpm,
    firstBeatOffsetSec: options.firstBeatOffsetSec ?? 0,
  });

  if (validClips.length === 0) {
    return {
      bpm,
      beats,
      bgVideos: [],
      coldOpenEndSec: 0,
      heroFreezeRangeSec: null,
      peakSlowMoIndex: null,
      blooperRangeSec: null,
    };
  }

  const beatDur = 60 / bpm; // e.g., 124 BPM => 0.4838s/beat, 2 beats = 0.97s, 3 beats = 1.45s, 4 beats = 1.94s
  const bgVideos: BrollVideo[] = [];
  let cursorSec = 0;

  // Choose Cold Open clip (prefer video with speech/cheer or audio)
  const videoClips = validClips.filter((c) => !c.stillImage);
  const coldOpenCandidate = options.keepColdOpenAudio
    ? (videoClips.find((c) => c.hasSpeechOrCheer && c.hasAudio) ?? videoClips.find((c) => c.hasAudio) ?? validClips[0]!)
    : validClips[0]!;

  let coldOpenEndSec = 0;
  let heroFreezeRangeSec: { startSec: number; endSec: number } | null = null;
  let blooperRangeSec: { startSec: number; endSec: number } | null = null;
  let clipCursor = 0;

  // Reserve blooper window at end if requested and clip pool >= 3 and targetDuration >= 12s
  const useBlooper = Boolean(options.blooperTail && validClips.length >= 3 && targetDurationSec >= 12);
  const blooperDurSec = useBlooper ? snapToFrameSec(Math.min(2.8, Math.max(2.0, beatDur * 5))) : 0;
  const mainEndSec = snapToFrameSec(targetDurationSec - blooperDurSec);

  // 1. Cold Open shot (4–5 beats ~ 2.0–2.5s)
  if (options.keepColdOpenAudio && coldOpenCandidate.hasAudio && mainEndSec >= 6) {
    const coldDur = snapToFrameSec(Math.min(coldOpenCandidate.durationSec, Math.max(1.9, beatDur * 4)));
    coldOpenEndSec = coldDur;
    bgVideos.push({
      src: coldOpenCandidate.src,
      start: 0,
      end: coldDur,
      sourceIndex: bgVideos.length,
      clipOffset: coldOpenCandidate.bestOffsetSec ?? 0,
      clipDuration: coldOpenCandidate.durationSec,
      stillImage: coldOpenCandidate.stillImage,
      keepClipAudio: true,
      clipAudioVolume: 1.0,
      transition: "cut",
      ...(coldOpenCandidate.faceBoxes?.length ? { faceBoxes: coldOpenCandidate.faceBoxes } : {}),
      title: coldOpenCandidate.label ?? "Cold Open",
    });
    cursorSec = coldDur;
    clipCursor = 1;
  }

  // 2. Hero Freeze Intro shot (3–4 beats ~ 1.5–1.9s with camera shutter freeze on the final 14 frames)
  if (options.heroFreezeIntro && mainEndSec - cursorSec >= 4.2) {
    const heroClip = validClips[clipCursor % validClips.length]!;
    clipCursor += 1;
    const heroDur = snapToFrameSec(Math.min(2.1, Math.max(1.5, beatDur * 3.5)));
    const heroEnd = snapToFrameSec(Math.min(mainEndSec, cursorSec + heroDur));
    heroFreezeRangeSec = { startSec: cursorSec, endSec: heroEnd };
    bgVideos.push({
      src: heroClip.src,
      start: cursorSec,
      end: heroEnd,
      sourceIndex: bgVideos.length,
      clipOffset: heroClip.bestOffsetSec ?? 0,
      clipDuration: heroClip.durationSec,
      stillImage: heroClip.stillImage,
      freezeAtEndFrames: heroClip.stillImage ? 0 : 14,
      transition: "cut",
      ...(heroClip.faceBoxes?.length ? { faceBoxes: heroClip.faceBoxes } : {}),
      title: heroClip.label ?? "Hero Freeze",
    });
    cursorSec = heroEnd;
  }

  // 3. Beat-synced multi-cut body (alternate snappy 2-beat ~1.0s and 3-beat ~1.45s cuts!)
  const bodyStartIdx = bgVideos.length;
  let cutStep = 0;
  const usedOffsetsBySrc = new Map<string, number>();
  for (const existing of bgVideos) {
    usedOffsetsBySrc.set(existing.src, (existing.clipOffset ?? 0) + (existing.end - existing.start));
  }

  while (cursorSec < mainEndSec - 0.35) {
    const clip = validClips[clipCursor % validClips.length]!;
    clipCursor += 1;
    const beatsForCut = clip.stillImage ? 4 : (cutStep % 3 === 1 ? 3 : 2);
    cutStep += 1;
    let segDur = snapToFrameSec(beatDur * beatsForCut);
    const remaining = snapToFrameSec(mainEndSec - cursorSec);
    if (remaining <= segDur + 0.65) {
      segDur = remaining;
    }
    const endSec = snapToFrameSec(cursorSec + segDur);

    const priorOffset = usedOffsetsBySrc.get(clip.src) ?? (clip.bestOffsetSec ?? 0);
    const maxSafeOffset = Math.max(0, clip.durationSec - segDur - 0.15);
    const offsetSec = clip.stillImage
      ? 0
      : Number(Math.min(maxSafeOffset, priorOffset <= maxSafeOffset ? priorOffset : 0).toFixed(2));
    usedOffsetsBySrc.set(clip.src, offsetSec + segDur);

    bgVideos.push({
      src: clip.src,
      start: cursorSec,
      end: endSec,
      sourceIndex: bgVideos.length,
      clipOffset: offsetSec,
      clipDuration: clip.durationSec,
      stillImage: clip.stillImage,
      transition: clip.stillImage ? "dissolve" : "cut",
      ...(clip.faceBoxes?.length ? { faceBoxes: clip.faceBoxes } : {}),
      title: clip.label,
    });
    cursorSec = endSec;
  }

  // Pick 1 peak action video clip in the body for smooth 0.58x Slow-Mo highlight
  let peakSlowMoIndex: number | null = null;
  if (options.slowMoPeakShot) {
    for (let idx = Math.max(bodyStartIdx, Math.floor(bgVideos.length * 0.45)); idx < bgVideos.length; idx += 1) {
      const candidate = bgVideos[idx]!;
      const dur = candidate.end - candidate.start;
      if (!candidate.stillImage && (candidate.clipDuration ?? 0) >= dur * 0.75 + 0.5) {
        candidate.playbackRate = 0.58;
        peakSlowMoIndex = idx;
        break;
      }
    }
  }

  // 4. Optional Blooper / Behind-the-Scenes tail
  if (useBlooper && blooperDurSec > 0 && cursorSec < targetDurationSec - 0.2) {
    const blooperClip =
      [...validClips].reverse().find((c) => !c.stillImage && c.hasAudio)
      ?? validClips[validClips.length - 1]!;
    blooperRangeSec = { startSec: cursorSec, endSec: targetDurationSec };
    bgVideos.push({
      src: blooperClip.src,
      start: cursorSec,
      end: targetDurationSec,
      sourceIndex: bgVideos.length,
      clipOffset: blooperClip.bestOffsetSec ?? 0,
      clipDuration: blooperClip.durationSec,
      stillImage: blooperClip.stillImage,
      keepClipAudio: Boolean(blooperClip.hasAudio),
      clipAudioVolume: 0.95,
      transition: "cut",
      ...(blooperClip.faceBoxes?.length ? { faceBoxes: blooperClip.faceBoxes } : {}),
      title: blooperClip.label ?? "Blooper",
    });
  }

  return {
    bpm,
    beats,
    bgVideos,
    coldOpenEndSec,
    heroFreezeRangeSec,
    peakSlowMoIndex,
    blooperRangeSec,
  };
}

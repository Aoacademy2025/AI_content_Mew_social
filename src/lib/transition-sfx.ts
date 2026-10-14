/**
 * EP5/S2 Backlog #3 — Subtle Transition Sound Effects (`sfxMode: "none" | "subtle"`).
 *
 * Pure, deterministic planner and 16-bit PCM WAV synthesizer for subtle transition SFX:
 * - Mixes subtle `whoosh` (on B-roll cuts) and `pop` (on hook entry / presenter punch-zoom cues)
 *   at `-18 dB` (`SFX_SUBTLE_LINEAR_VOLUME ≈ 0.1259`) so the voiceover is never masked.
 * - Enforces a minimum spacing of `SFX_MIN_GAP_SEC` (1.8s) and a maximum of `SFX_MAX_CUES` (12)
 *   so rapid cuts never sound noisy or repetitive.
 */

export const SFX_MODES = ["none", "subtle"] as const;
export type SfxMode = (typeof SFX_MODES)[number];
export type TransitionSfxKind = "whoosh" | "pop";

export const DEFAULT_SFX_MODE: SfxMode = "none";
export const SFX_SUBTLE_DB = -18;
export const SFX_SUBTLE_LINEAR_VOLUME = Number(Math.pow(10, SFX_SUBTLE_DB / 20).toFixed(4)); // 0.1259
export const SFX_MIN_GAP_SEC = 1.8;
export const SFX_MAX_CUES = 12;

export type TransitionSfxCue = {
  timeSec: number;
  kind: TransitionSfxKind;
  durationSec: number;
  volumeLinear: number;
  volumeDb: number;
};

export function isSfxMode(value: unknown): value is SfxMode {
  return value === "none" || value === "subtle";
}

export function effectiveSfxMode(value: unknown): SfxMode {
  return value === "subtle" ? "subtle" : "none";
}

export type PlanTransitionSfxOptions = {
  sfxMode?: unknown;
  /** B-roll window start times in seconds (e.g. from `bgVideos[].start`). */
  brollStartTimesSec?: readonly number[];
  /** Presenter punch-in zoom or emphasis cue times in seconds. */
  punchCueTimesSec?: readonly number[];
  /** Whether an opening visual hook (`headlineHook`) is enabled at t=0. */
  hasOpeningHook?: boolean;
  /** Total video duration in seconds. */
  totalDurationSec?: number;
  /** Minimum spacing between two SFX cues in seconds (default 1.8s). */
  minGapSec?: number;
  /** Maximum cues across the clip (default 12). */
  maxCues?: number;
};

/**
 * Deterministically plans subtle transition SFX cues for a short video.
 * Returns an empty array when `sfxMode !== "subtle"`.
 */
export function planTransitionSfxCues(opts: PlanTransitionSfxOptions): TransitionSfxCue[] {
  if (effectiveSfxMode(opts.sfxMode) !== "subtle") return [];

  const minGapSec = typeof opts.minGapSec === "number" && opts.minGapSec > 0
    ? opts.minGapSec
    : SFX_MIN_GAP_SEC;
  const maxCues = typeof opts.maxCues === "number" && opts.maxCues > 0
    ? Math.floor(opts.maxCues)
    : SFX_MAX_CUES;
  const totalDurationSec = typeof opts.totalDurationSec === "number" && opts.totalDurationSec > 0
    ? opts.totalDurationSec
    : Infinity;

  const candidates: Array<{ timeSec: number; kind: TransitionSfxKind }> = [];

  if (opts.hasOpeningHook) {
    candidates.push({ timeSec: 0.08, kind: "pop" });
  }

  for (const rawTime of opts.brollStartTimesSec ?? []) {
    if (typeof rawTime !== "number" || !Number.isFinite(rawTime)) continue;
    // Skip t=0 opening frame (handled by opening hook if any) and cues too close to the end.
    if (rawTime < 0.25 || rawTime > totalDurationSec - 0.35) continue;
    candidates.push({ timeSec: Number(rawTime.toFixed(3)), kind: "whoosh" });
  }

  for (const rawTime of opts.punchCueTimesSec ?? []) {
    if (typeof rawTime !== "number" || !Number.isFinite(rawTime)) continue;
    if (rawTime < 0.25 || rawTime > totalDurationSec - 0.35) continue;
    candidates.push({ timeSec: Number(rawTime.toFixed(3)), kind: "pop" });
  }

  candidates.sort((a, b) => a.timeSec - b.timeSec || (a.kind === "whoosh" ? -1 : 1));

  const selected: TransitionSfxCue[] = [];
  let lastTimeSec = -Infinity;

  for (const candidate of candidates) {
    if (selected.length >= maxCues) break;
    if (candidate.timeSec - lastTimeSec < minGapSec) continue;
    const durationSec = candidate.kind === "whoosh" ? 0.22 : 0.12;
    selected.push({
      timeSec: candidate.timeSec,
      kind: candidate.kind,
      durationSec,
      volumeLinear: SFX_SUBTLE_LINEAR_VOLUME,
      volumeDb: SFX_SUBTLE_DB,
    });
    lastTimeSec = candidate.timeSec;
  }

  return selected;
}

/**
 * Synthesizes a clean, self-contained 16-bit mono 22050 Hz PCM WAV buffer for `"whoosh"` or `"pop"`.
 * Deterministic (seeded PRNG for airy whoosh noise) so tests and builds are byte-reproducible.
 */
export function synthesizeTransitionSfxWavBytes(kind: TransitionSfxKind): Uint8Array {
  const sampleRate = 22050;
  const durationSec = kind === "whoosh" ? 0.22 : 0.12;
  const numSamples = Math.max(1, Math.round(sampleRate * durationSec));
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF WAVE header
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let seed = kind === "whoosh" ? 0x13579bdf : 0x2468ace0;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  let prevFiltered = 0;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const progress = i / numSamples;
    let sample = 0;

    if (kind === "whoosh") {
      // Hann window envelope + swept low-passed noise + soft sine sweep (180Hz -> 520Hz -> 220Hz)
      const env = Math.sin(Math.PI * progress);
      const rawNoise = nextRand();
      const alpha = 0.18 + 0.35 * Math.sin(Math.PI * progress);
      prevFiltered = prevFiltered + alpha * (rawNoise - prevFiltered);
      const sweepFreq = 180 + 320 * Math.sin(Math.PI * progress);
      const tone = Math.sin(2 * Math.PI * sweepFreq * t) * 0.35;
      sample = (prevFiltered * 0.65 + tone) * env * 0.85;
    } else {
      // Subtle "pop": fast attack, exponential decay pitch drop (540Hz -> 190Hz)
      const attack = Math.min(1, progress / 0.08);
      const decay = Math.exp(-progress * 6.5);
      const freq = 190 + 350 * Math.exp(-progress * 8);
      sample = Math.sin(2 * Math.PI * freq * t) * attack * decay * 0.9;
    }

    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  return new Uint8Array(buffer);
}

const cachedDataUrls = new Map<TransitionSfxKind, string>();

/**
 * Base64 `data:audio/wav;base64,...` URI for Remotion / browser `<Audio>` preview playback.
 */
export function getTransitionSfxDataUrl(kind: TransitionSfxKind): string {
  const existing = cachedDataUrls.get(kind);
  if (existing) return existing;
  const bytes = synthesizeTransitionSfxWavBytes(kind);
  let base64 = "";
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    base64 = btoa(binary);
  }
  const url = `data:audio/wav;base64,${base64}`;
  cachedDataUrls.set(kind, url);
  return url;
}

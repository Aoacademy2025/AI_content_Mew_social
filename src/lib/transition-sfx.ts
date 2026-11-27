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
 * Synthesizes a clean, broadcast-grade 16-bit stereo 48000 Hz PCM WAV buffer for `"whoosh"` or `"pop"`.
 * - `"whoosh"`: Swept dual-stage resonant bandpass air movement with subtle stereo width and zero
 *   metallic FM sine whistle.
 * - `"pop"`: Warm tactile transient with integrated-phase pitch drop (360 Hz -> 130 Hz) and smooth
 *   click-free raised-cosine attack.
 * Deterministic (seeded PRNG) so tests and builds remain byte-reproducible.
 */
export function synthesizeTransitionSfxWavBytes(kind: TransitionSfxKind): Uint8Array {
  const sampleRate = 48000;
  const numChannels = 2;
  const durationSec = kind === "whoosh" ? 0.22 : 0.12;
  const numSamples = Math.max(1, Math.round(sampleRate * durationSec));
  const blockAlign = numChannels * 2;
  const dataBytes = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF WAVE header (48kHz stereo 16-bit PCM)
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // Byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // Bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let seedL = kind === "whoosh" ? 0x13579bdf : 0x2468ace0;
  let seedR = kind === "whoosh" ? 0x6c8e9cf5 : 0x9e3779b9;
  const nextRandL = () => {
    seedL = (seedL * 1664525 + 1013904223) >>> 0;
    return (seedL / 0xffffffff) * 2 - 1;
  };
  const nextRandR = () => {
    seedR = (seedR * 22695477 + 1) >>> 0;
    return (seedR / 0xffffffff) * 2 - 1;
  };

  // Chamberlin state-variable bandpass states for L/R air-whoosh
  let bpL = 0;
  let lpL = 0;
  let bpR = 0;
  let lpR = 0;
  let phase = 0;

  for (let i = 0; i < numSamples; i++) {
    const progress = i / numSamples;
    let outL = 0;
    let outR = 0;

    if (kind === "whoosh") {
      // Smooth raised-cosine bell envelope (zero click at head/tail)
      const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * progress);
      const sweepBell = Math.sin(Math.PI * Math.pow(progress, 0.88));
      const cutoffHz = 240 + 1350 * sweepBell;
      const f = Math.min(0.45, 2 * Math.sin((Math.PI * cutoffHz) / sampleRate));
      const q = 0.68; // warm, wide air band (damping = 1/Q)

      const nL = nextRandL();
      const nR = nextRandR();
      const mid = (nL + nR) * 0.5;
      const inL = mid * 0.78 + nL * 0.22;
      const inR = mid * 0.78 + nR * 0.22;

      const hpL = inL - lpL - q * bpL;
      bpL += f * hpL;
      lpL += f * bpL;

      const hpR = inR - lpR - q * bpR;
      bpR += f * hpR;
      lpR += f * bpR;

      // Subtle low-end air body with properly integrated instantaneous phase
      const subFreq = 85 + 90 * sweepBell;
      phase += (2 * Math.PI * subFreq) / sampleRate;
      const subBody = Math.sin(phase) * 0.14;

      // Slight stereo pan motion left -> right across the transition
      const panL = 0.92 + 0.08 * (1 - progress);
      const panR = 0.92 + 0.08 * progress;
      outL = (bpL * 0.72 + lpL * 0.18 + subBody) * env * panL * 0.9;
      outR = (bpR * 0.72 + lpR * 0.18 + subBody) * env * panR * 0.9;
    } else {
      // Warm organic pop: 2.5ms raised-cosine attack + integrated pitch drop (360Hz -> 130Hz)
      const attackSamples = Math.max(1, Math.round(sampleRate * 0.0025));
      const attack = i < attackSamples
        ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attackSamples)
        : 1;
      const decay = Math.exp(-progress * 9.2);
      const freq = 130 + 230 * Math.exp(-progress * 14);
      phase += (2 * Math.PI * freq) / sampleRate;
      const body = Math.sin(phase) + 0.18 * Math.sin(phase * 2) * Math.exp(-progress * 22);
      const mono = body * attack * decay * 0.78;
      outL = mono;
      outR = mono;
    }

    const clampedL = Math.max(-1, Math.min(1, outL));
    const clampedR = Math.max(-1, Math.min(1, outR));
    const byteOffset = 44 + i * blockAlign;
    view.setInt16(byteOffset, Math.round(clampedL * 32767), true);
    view.setInt16(byteOffset + 2, Math.round(clampedR * 32767), true);
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

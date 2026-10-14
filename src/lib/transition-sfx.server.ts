import fs from "node:fs";
import path from "node:path";
import {
  SFX_SUBTLE_DB,
  synthesizeTransitionSfxWavBytes,
  type TransitionSfxCue,
  type TransitionSfxKind,
} from "./transition-sfx";

/**
 * Server-side helpers for EP5/S2 Backlog #3 — Subtle Transition Sound Effects:
 * - Materializes deterministic `whoosh.wav` and `pop.wav` assets on disk when needed.
 * - Builds FFmpeg `adelay` + `volume=-18dB` + `amix` filter graphs for mixing transition SFX
 *   cues into a rendered audio/video stream without clipping or ducking the presenter voice.
 */

export function ensureTransitionSfxWavFiles(targetDir: string): Record<TransitionSfxKind, string> {
  fs.mkdirSync(targetDir, { recursive: true });
  const paths: Record<TransitionSfxKind, string> = {
    whoosh: path.join(targetDir, "sfx-subtle-whoosh.wav"),
    pop: path.join(targetDir, "sfx-subtle-pop.wav"),
  };
  for (const kind of ["whoosh", "pop"] as const) {
    const filePath = paths[kind];
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 100) {
      fs.writeFileSync(filePath, Buffer.from(synthesizeTransitionSfxWavBytes(kind)));
    }
  }
  return paths;
}

/**
 * Builds a deterministic FFmpeg filter_complex string that mixes `cues` (starting at input index
 * `firstSfxInputIndex`) onto a base audio stream (`baseAudioLabel`, default `"0:a"`) at `-18dB`.
 */
export function buildTransitionSfxFfmpegFilter(
  cues: readonly TransitionSfxCue[],
  opts?: { baseAudioLabel?: string; firstSfxInputIndex?: number; outputLabel?: string },
): string | null {
  if (!cues.length) return null;
  const baseAudioLabel = opts?.baseAudioLabel ?? "0:a";
  const firstSfxInputIndex = opts?.firstSfxInputIndex ?? 1;
  const outputLabel = opts?.outputLabel ?? "aout";

  const parts: string[] = [];
  const mixLabels: string[] = [`[${baseAudioLabel}]`];

  cues.forEach((cue, idx) => {
    const inputIdx = firstSfxInputIndex + idx;
    const delayMs = Math.max(0, Math.round(cue.timeSec * 1000));
    const volumeDb = Number.isFinite(cue.volumeDb) ? cue.volumeDb : SFX_SUBTLE_DB;
    const label = `sfx${idx}`;
    parts.push(
      `[${inputIdx}:a]volume=${volumeDb}dB,adelay=${delayMs}|${delayMs}[${label}]`,
    );
    mixLabels.push(`[${label}]`);
  });

  parts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[${outputLabel}]`,
  );

  return parts.join(";");
}

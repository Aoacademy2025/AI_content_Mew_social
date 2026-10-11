import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { getFfmpegPath } from "@/lib/ffmpeg-path";

const execFileAsync = promisify(execFile);

/**
 * EP5 backlog #8: final export audio loudness, always on, no knob (ADR 0066 §3 — a quality
 * default applied for everyone needs no control on either front-end). Integrated target
 * −14 LUFS, true peak ≤ −1.5 dBTP.
 *
 * Runs AFTER the burn/export render already produced `filePath` (the muxed MP4 both web
 * "Burn & Download" and MCP `export_video` deliver — they share run-render.ts's one burn
 * path). Two-pass ffmpeg `loudnorm`:
 *   1. measure (no output) → `measured_*` stats
 *   2. apply with `linear=true` — a pure per-sample gain, so it never shifts audio timing or
 *      changes the sample count (unlike the limiter/dynamic mode), which is what keeps the
 *      85 ms sync fix (aac-priming.ts) intact.
 *
 * Video is stream-copied (`-c:v copy`, never re-encoded). Audio is re-encoded with ffmpeg's
 * OWN native `aac` encoder (never `libfdk_aac`) — exactly the encoder whose priming ffmpeg's
 * muxer already signals correctly via its own edit list (see aac-priming.ts's comment: "the
 * same thing ffmpeg writes for its own AAC encoder … which our composite and low-res preview
 * MP4s already carry"), so this pass never reintroduces the ADTS/no-edit-list lag that
 * aac-priming.ts fixes.
 *
 * Fails open: any ffmpeg error, a silent/missing audio stream, or an unparseable measurement
 * leaves `filePath` exactly as the render produced it. Export must never fail because of
 * loudness normalization.
 */
export const LOUDNESS_TARGET_I = -14;
export const LOUDNESS_TARGET_TP = -1.5;
const LOUDNESS_TARGET_LRA = 11; // ffmpeg loudnorm's own default target LRA
const MEASURE_TIMEOUT_MS = 2 * 60 * 1000;
const APPLY_TIMEOUT_MS = 5 * 60 * 1000;
/** ffmpeg's own floor for "no audible signal" is -70 LUFS; treat that (or no stream at all,
 *  which ffmpeg also reports as -inf → NaN here) as silent. */
const SILENT_INPUT_I_LUFS = -70;

export type LoudnessNormalizeResult =
  | { applied: true; beforeLufs: number; targetLufs: number }
  | { applied: false; reason: string };

type LoudnormMeasured = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

function parseLoudnormJson(stderr: string): LoudnormMeasured | null {
  // ffmpeg's loudnorm (print_format=json) writes ONE json object; it is the last `{...}` block
  // in stderr (everything before it is ordinary ffmpeg banner/progress text).
  const matches = stderr.match(/\{[^{}]*\}/g);
  if (!matches || matches.length === 0) return null;
  try {
    const parsed = JSON.parse(matches[matches.length - 1]) as Partial<LoudnormMeasured>;
    if (
      typeof parsed.input_i !== "string"
      || typeof parsed.input_tp !== "string"
      || typeof parsed.input_lra !== "string"
      || typeof parsed.input_thresh !== "string"
      || typeof parsed.target_offset !== "string"
    ) return null;
    return parsed as LoudnormMeasured;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export async function normalizeFinalAudioLoudness(filePath: string): Promise<LoudnessNormalizeResult> {
  const ffmpeg = getFfmpegPath();
  const measureFilter = `loudnorm=I=${LOUDNESS_TARGET_I}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}:print_format=json`;
  let measured: LoudnormMeasured | null;
  try {
    const { stderr } = await execFileAsync(ffmpeg, [
      "-hide_banner", "-nostats", "-y",
      "-i", filePath,
      "-map", "0:a:0",
      "-af", measureFilter,
      "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ], { maxBuffer: 16 * 1024 * 1024, timeout: MEASURE_TIMEOUT_MS });
    measured = parseLoudnormJson(stderr);
  } catch (error) {
    // Includes "Stream map '0:a:0' matches no streams" — a render with no audio at all.
    return { applied: false, reason: `measure_failed: ${errorMessage(error)}` };
  }
  if (!measured) return { applied: false, reason: "measure_unparseable" };
  const inputI = Number(measured.input_i);
  if (!Number.isFinite(inputI) || inputI <= SILENT_INPUT_I_LUFS) {
    return { applied: false, reason: "silent_or_no_audio" };
  }

  const applyFilter = [
    `loudnorm=I=${LOUDNESS_TARGET_I}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    "linear=true",
  ].join(":");
  const tmpOut = `${filePath}.loudnorm-${process.pid}-${Date.now()}.mp4`;
  try {
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-nostats", "-y",
      "-i", filePath,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-af", applyFilter,
      "-movflags", "+faststart",
      tmpOut,
    ], { maxBuffer: 16 * 1024 * 1024, timeout: APPLY_TIMEOUT_MS });
  } catch (error) {
    try { fs.rmSync(tmpOut, { force: true }); } catch {}
    return { applied: false, reason: `apply_failed: ${errorMessage(error)}` };
  }
  if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1024) {
    try { fs.rmSync(tmpOut, { force: true }); } catch {}
    return { applied: false, reason: "apply_produced_no_output" };
  }
  try {
    fs.renameSync(tmpOut, filePath);
  } catch (error) {
    try { fs.rmSync(tmpOut, { force: true }); } catch {}
    return { applied: false, reason: `replace_failed: ${errorMessage(error)}` };
  }
  return { applied: true, beforeLufs: inputI, targetLufs: LOUDNESS_TARGET_I };
}

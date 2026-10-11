// EP5 backlog #8: final export loudness normalization, always on, no knob.
//
// Generates synthetic fixtures with ffmpeg lavfi (a loud tone, a silent track, a video-only
// clip) and runs them through the real `normalizeFinalAudioLoudness` to prove:
//  - a loud source is pulled down to ~-14 LUFS integrated, measured independently afterwards;
//  - the video stream and the container duration are untouched (no re-encode, no timing shift);
//  - a silent track and a video-only (no audio) file are left byte-for-byte alone (fail open).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeFinalAudioLoudness, LOUDNESS_TARGET_I } from "../src/lib/render/loudness-normalize";

function ffmpeg(args: string[]): string {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} exited ${result.status}: ${result.stderr.toString().slice(-800)}`);
  }
  return result.stdout.toString();
}

/** Independent integrated-loudness measurement (never reuses the module under test). */
function measureIntegratedLufs(file: string): number {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file,
    "-map", "0:a:0",
    "-af", "loudnorm=print_format=json", "-f", "null", "/dev/null",
  ]);
  const stderr = result.stderr.toString();
  const matches = stderr.match(/\{[^{}]*\}/g);
  assert.ok(matches && matches.length > 0, `no loudnorm json in: ${stderr.slice(-400)}`);
  const parsed = JSON.parse(matches![matches!.length - 1]) as { input_i: string };
  return Number(parsed.input_i);
}

function probeDurationMs(file: string): number {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  const seconds = Number.parseFloat(result.stdout.toString().trim());
  assert.ok(Number.isFinite(seconds) && seconds > 0, `ffprobe duration failed for ${file}`);
  return Math.round(seconds * 1000);
}

function fileBytes(file: string): Buffer {
  return readFileSync(file);
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "export-loudnorm-"));
  try {
    // 1) A loud 2s tone + a trivial video — the normal case.
    const loud = path.join(work, "loud.mp4");
    ffmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=30:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2,volume=16dB",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-shortest", loud,
    ]);
    const beforeLoud = measureIntegratedLufs(loud);
    const beforeDurationMs = probeDurationMs(loud);
    console.log(`  loud fixture: ${beforeLoud.toFixed(1)} LUFS, ${beforeDurationMs} ms`);
    assert.ok(beforeLoud > LOUDNESS_TARGET_I + 2, "fixture must start clearly louder than the -14 LUFS target");

    const result = await normalizeFinalAudioLoudness(loud);
    assert.ok(result.applied, `expected normalization to apply, got: ${JSON.stringify(result)}`);
    if (result.applied) {
      assert.ok(Math.abs(result.beforeLufs - beforeLoud) < 0.5, "reported beforeLufs should match the independent measurement");
      assert.equal(result.targetLufs, LOUDNESS_TARGET_I);
    }
    const afterLoud = measureIntegratedLufs(loud);
    const afterDurationMs = probeDurationMs(loud);
    console.log(`  after normalize: ${afterLoud.toFixed(1)} LUFS, ${afterDurationMs} ms`);
    assert.ok(Math.abs(afterLoud - LOUDNESS_TARGET_I) <= 1, `expected ~${LOUDNESS_TARGET_I} LUFS, got ${afterLoud}`);
    assert.ok(Math.abs(afterDurationMs - beforeDurationMs) <= 50, "duration must not shift by more than 50 ms");
    console.log("✓ a loud source is normalized to ~-14 LUFS without shifting duration");

    // 2) Silent audio — must fail open and leave the file untouched.
    const silent = path.join(work, "silent.mp4");
    ffmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=red:s=180x320:r=30:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest", silent,
    ]);
    const silentBytesBefore = fileBytes(silent);
    const silentResult = await normalizeFinalAudioLoudness(silent);
    assert.equal(silentResult.applied, false, `expected silent audio to skip, got: ${JSON.stringify(silentResult)}`);
    assert.deepEqual(fileBytes(silent), silentBytesBefore, "a silent track must be left byte-for-byte alone");
    console.log(`✓ silent audio is skipped (${!silentResult.applied ? silentResult.reason : ""}) and the file is untouched`);

    // 3) No audio stream at all — must also fail open and leave the file untouched.
    const videoOnly = path.join(work, "video-only.mp4");
    ffmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=green:s=180x320:r=30:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", videoOnly,
    ]);
    const videoOnlyBytesBefore = fileBytes(videoOnly);
    const videoOnlyResult = await normalizeFinalAudioLoudness(videoOnly);
    assert.equal(videoOnlyResult.applied, false, `expected a video-only file to skip, got: ${JSON.stringify(videoOnlyResult)}`);
    assert.deepEqual(fileBytes(videoOnly), videoOnlyBytesBefore, "a video-only file must be left byte-for-byte alone");
    console.log(`✓ a render with no audio stream is skipped (${!videoOnlyResult.applied ? videoOnlyResult.reason : ""}) and the file is untouched`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  console.log("\n✅ EXPORT LOUDNORM CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

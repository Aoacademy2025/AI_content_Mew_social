import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalMediaFile } from "@/lib/contained-path";
import {
  resolveEffectiveTtsSpeed,
  scaleTtsTiming,
  type TtsPaceResolution,
} from "@/lib/tts-pace";

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    `ffmpeg${ext}`,
  );
}

function runFfmpegExec(args: string[], timeoutMs = 60_000): Promise<void> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `[tts-pace] ffmpeg failed: ${err.message} ${String(stderr || "").slice(-300)}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

import type { TtsTiming } from "@/lib/tts-timing";

export async function applyTtsPaceToGeneratedAudio(input: {
  voiceUrl: string;
  audioDurationMs: number;
  timing?: TtsTiming;
  ttsSpeed?: number | null;
  targetDurationSec?: number | null;
}): Promise<{
  voiceUrl: string;
  audioDurationMs: number;
  timing?: TtsTiming;
  pace: TtsPaceResolution;
}> {
  const naturalDurationSec = Math.max(0.1, input.audioDurationMs / 1000);
  const pace = resolveEffectiveTtsSpeed({
    ttsSpeed: input.ttsSpeed,
    targetDurationSec: input.targetDurationSec,
    naturalDurationSec,
  });

  if (Math.abs(pace.effectiveSpeed - 1) < 0.005) {
    return {
      voiceUrl: input.voiceUrl,
      audioDurationMs: input.audioDurationMs,
      timing: scaleTtsTiming(input.timing, 1),
      pace,
    };
  }

  const scaledDurationMs = Math.max(
    100,
    Math.round(input.audioDurationMs / pace.effectiveSpeed),
  );
  const scaledTiming = scaleTtsTiming(input.timing, pace.effectiveSpeed);

  const local = resolveLocalMediaFile(input.voiceUrl);
  if (!local.ok) {
    return {
      voiceUrl: input.voiceUrl,
      audioDurationMs: scaledDurationMs,
      timing: scaledTiming,
      pace,
    };
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const ext = path.extname(local.path) || ".mp3";
  const outName = `tts-paced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const outPath = path.join(rendersDir, outName);
  const atempo = Number(pace.effectiveSpeed.toFixed(4));

  const codecArgs =
    ext.toLowerCase() === ".wav"
      ? ["-c:a", "pcm_s16le"]
      : ext.toLowerCase() === ".m4a" || ext.toLowerCase() === ".mp4"
        ? ["-c:a", "aac", "-b:a", "192k"]
        : ["-c:a", "libmp3lame", "-b:a", "192k"];

  await runFfmpegExec([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    local.path,
    "-filter:a",
    `atempo=${atempo}`,
    ...codecArgs,
    outPath,
  ]);

  const outUrl = input.voiceUrl.startsWith("/api/renders/")
    ? `/api/renders/${outName}`
    : `/renders/${outName}`;

  return {
    voiceUrl: outUrl,
    audioDurationMs: scaledDurationMs,
    timing: scaledTiming,
    pace,
  };
}

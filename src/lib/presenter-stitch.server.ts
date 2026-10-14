import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalMediaFile } from "@/lib/contained-path";
import {
  buildPresenterStitchFfmpegFilter,
  computeStitchedDurationMs,
  MAX_STITCH_CLIPS,
  type PresenterStitchFilterClipSpec,
} from "@/lib/presenter-stitch";

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

function runFfmpegCaptureStderr(
  args: string[],
  timeoutMs = 180_000,
): Promise<string> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `[presenter-stitch] ffmpeg failed: ${err.message} ${String(stderr || "").slice(-400)}`,
            ),
          );
          return;
        }
        resolve(String(stderr || ""));
      },
    );
  });
}

export type ProbedClipMetadata = {
  durationSec: number;
  hasAudio: boolean;
  width: number;
  height: number;
};

export async function probeClipInfoViaFfmpeg(
  filePath: string,
): Promise<ProbedClipMetadata> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ["-hide_banner", "-i", filePath],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (_err, _stdout, stderr) => {
        const text = String(stderr || "");
        const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        let durationSec = 0;
        if (durMatch) {
          const hours = Number(durMatch[1]);
          const minutes = Number(durMatch[2]);
          const seconds = Number(durMatch[3]);
          const total = hours * 3600 + minutes * 60 + seconds;
          if (Number.isFinite(total) && total > 0) {
            durationSec = total;
          }
        }
        const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(text);
        const videoMatch = text.match(
          /Stream #\d+:\d+.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/i,
        );
        const width = videoMatch ? Number(videoMatch[1]) : 0;
        const height = videoMatch ? Number(videoMatch[2]) : 0;
        resolve({ durationSec, hasAudio, width, height });
      },
    );
  });
}

export async function stitchPresenterVideoFiles(input: {
  clipUrls: readonly string[];
}): Promise<{
  clipUrl: string;
  stitched: boolean;
  clipCount: number;
  durationSec: number;
  stitchCutTimesSec: number[];
}> {
  const urls = input.clipUrls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    throw new Error("[presenter-stitch] clipUrls must contain at least 1 clip");
  }
  if (urls.length > MAX_STITCH_CLIPS) {
    throw new Error(
      `[presenter-stitch] clipUrls exceeds max ${MAX_STITCH_CLIPS} clips (got ${urls.length})`,
    );
  }

  if (urls.length === 1) {
    const singleUrl = urls[0]!;
    const local = resolveLocalMediaFile(singleUrl, { stocks: true });
    const info = local.ok
      ? await probeClipInfoViaFfmpeg(local.path)
      : { durationSec: 0, hasAudio: true, width: 0, height: 0 };
    return {
      clipUrl: singleUrl,
      stitched: false,
      clipCount: 1,
      durationSec: info.durationSec,
      stitchCutTimesSec: [],
    };
  }

  const localPaths: string[] = [];
  const specs: PresenterStitchFilterClipSpec[] = [];
  const durationsMs: number[] = [];

  for (const url of urls) {
    const local = resolveLocalMediaFile(url, { stocks: true });
    if (!local.ok) {
      throw new Error(
        `[presenter-stitch] unable to resolve local media file for ${url}`,
      );
    }
    const info = await probeClipInfoViaFfmpeg(local.path);
    if (info.durationSec <= 0.1) {
      throw new Error(
        `[presenter-stitch] clip ${url} has invalid duration (${info.durationSec}s)`,
      );
    }
    localPaths.push(local.path);
    specs.push({ durationSec: info.durationSec, hasAudio: info.hasAudio });
    durationsMs.push(Math.round(info.durationSec * 1000));
  }

  const plan = computeStitchedDurationMs(durationsMs);
  const filter = buildPresenterStitchFfmpegFilter(specs);

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const outName = `presenter-stitch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const outPath = path.join(rendersDir, outName);

  const inputArgs: string[] = [];
  for (const p of localPaths) {
    inputArgs.push("-i", p);
  }

  await runFfmpegCaptureStderr([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputArgs,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outPath,
  ]);

  return {
    clipUrl: `/api/renders/${outName}`,
    stitched: true,
    clipCount: urls.length,
    durationSec: plan.totalDurationSec,
    stitchCutTimesSec: plan.stitchCutTimesSec,
  };
}

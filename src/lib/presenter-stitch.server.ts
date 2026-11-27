import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalMediaFile } from "@/lib/contained-path";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  buildPresenterStitchFfmpegFilter,
  computeStitchedDurationMs,
  MAX_STITCH_CLIPS,
  type PresenterFitMode,
  type PresenterStitchFilterClipSpec,
} from "@/lib/presenter-stitch";

export function computePresenterStitchTimeoutMs(totalDurationSec: number): number {
  const safeSec = Number.isFinite(totalDurationSec) && totalDurationSec > 0 ? totalDurationSec : 0;
  return Math.max(180_000, Math.min(600_000, Math.ceil(safeSec * 4_000) + 120_000));
}

export function sanitizePresenterStitchError(err: { killed?: boolean; signal?: string | null; code?: unknown }): Error {
  if (err.killed || err.signal === "SIGTERM" || err.signal === "SIGKILL") {
    return new Error(
      "จัดเตรียมคลิปพิธีกรไม่สำเร็จ (ใช้เวลาประมวลผลเกินกำหนด) — กรุณาลองลดความละเอียดหรือความยาวคลิปแล้วลองใหม่",
    );
  }
  return new Error(
    "จัดเตรียมคลิปพิธีกรไม่สำเร็จ — กรุณาตรวจสอบว่าไฟล์วิดีโอไม่เสียหายและรองรับมาตรฐาน MP4/MOV แล้วลองใหม่",
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
          const execErr = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          console.error("[presenter-stitch] ffmpeg failed", {
            code: execErr.code ?? null,
            killed: Boolean(execErr.killed),
            signal: execErr.signal ?? null,
            timeoutMs,
            stderrTail: String(stderr || "").slice(-400),
          });
          reject(sanitizePresenterStitchError(execErr));
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
  codec?: string;
  pixFmt?: string;
  fps?: number;
  tbr?: number;
  hasRotation?: boolean;
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
        const videoLine = text.match(/Stream #\d+:\d+.*Video:[^\r\n]*/i)?.[0] ?? "";
        const videoMatch = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/);
        const width = videoMatch ? Number(videoMatch[1]) : 0;
        const height = videoMatch ? Number(videoMatch[2]) : 0;
        const codecMatch = videoLine.match(/Video:\s*([a-z0-9_]+)/i);
        const pixFmtMatch = videoLine.match(
          /Video:\s*[a-z0-9_]+(?:\s*\([^)]*\))*\s*,\s*([a-z0-9_]+)/i,
        );
        const fpsMatch = videoLine.match(/(\d+(?:\.\d+)?)\s*fps\b/i);
        const tbrMatch = videoLine.match(/(\d+(?:\.\d+)?)\s*tbr\b/i);
        const fps = fpsMatch ? Number(fpsMatch[1]) : tbrMatch ? Number(tbrMatch[1]) : 0;
        const tbr = tbrMatch ? Number(tbrMatch[1]) : 0;
        const hasRotation = /displaymatrix:\s*rotation|rotate\s*:\s*(?!0\b)/i.test(text);
        resolve({
          durationSec,
          hasAudio,
          width,
          height,
          codec: codecMatch?.[1]?.toLowerCase(),
          pixFmt: pixFmtMatch?.[1]?.toLowerCase(),
          fps: Number.isFinite(fps) ? fps : 0,
          tbr: Number.isFinite(tbr) ? tbr : 0,
          hasRotation,
        });
      },
    );
  });
}

export async function stitchPresenterVideoFiles(input: {
  clipUrls: readonly string[];
  presenterFit?: PresenterFitMode;
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
    const info: ProbedClipMetadata = local.ok
      ? await probeClipInfoViaFfmpeg(local.path)
      : { durationSec: 0, hasAudio: true, width: 0, height: 0 };
    const isExactPortraitCanvas = info.width === 1080 && info.height === 1920;
    const isCanonical30Cfr =
      info.codec === "h264"
      && info.pixFmt === "yuv420p"
      && !info.hasRotation
      && Boolean(info.fps && Math.abs(info.fps - 30) <= 0.05)
      && (!info.tbr || Math.abs(info.tbr - 30) <= 0.05);
    const needsSingleClipNormalization =
      local.ok
      && info.durationSec > 0.1
      && (
        !isExactPortraitCanvas
        || !isCanonical30Cfr
        || input.presenterFit === "contain"
      );
    if (!needsSingleClipNormalization) {
      return {
        clipUrl: singleUrl,
        stitched: false,
        clipCount: 1,
        durationSec: info.durationSec,
        stitchCutTimesSec: [],
      };
    }
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
  const filter = buildPresenterStitchFfmpegFilter(specs, {
    presenterFit: input.presenterFit,
  });

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const outName = `presenter-stitch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const outPath = path.join(rendersDir, outName);

  const inputArgs: string[] = [];
  for (const p of localPaths) {
    inputArgs.push("-i", p);
  }

  const timeoutMs = computePresenterStitchTimeoutMs(plan.totalDurationSec);

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
    "veryfast",
    "-crf",
    "19",
    "-r",
    "30",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-bf",
    "0",
    "-vsync",
    "cfr",
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outPath,
  ], timeoutMs);
  try {
    fs.chmodSync(outPath, 0o644);
  } catch {}

  return {
    clipUrl: `/api/renders/${outName}`,
    stitched: true,
    clipCount: urls.length,
    durationSec: plan.totalDurationSec,
    stitchCutTimesSec: plan.stitchCutTimesSec,
  };
}

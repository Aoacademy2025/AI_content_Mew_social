import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalMediaFile } from "@/lib/contained-path";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  parseFfmpegSilenceDetectIntervals,
  planTightenKeepSegments,
  resolveTightenOptions,
  TIGHTEN_CROSSFADE_MS,
  type TightenInput,
  type TightenPlan,
} from "@/lib/presenter-tighten";

/**
 * Threshold above which a multi-branch `[0:v]trim` + `concat=n=N` graph
 * clones decoded 1080p frames across too many branches (`split=N`). Above
 * this count we switch to a single-stream `select`/`aselect` expression.
 */
export const TIGHTEN_SINGLE_STREAM_SELECT_THRESHOLD = 8;

function runFfmpegCaptureStderr(args: string[], timeoutMs = 180_000): Promise<string> {
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
              `[presenter-tighten] ffmpeg failed: ${err.message} ${String(stderr || "").slice(-400)}`,
            ),
          );
          return;
        }
        resolve(String(stderr || ""));
      },
    );
  });
}

async function probeDurationAndAudioViaFfmpeg(
  filePath: string,
): Promise<{ durationSec: number; hasAudio: boolean }> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ["-hide_banner", "-i", filePath],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (_err, _stdout, stderr) => {
        const text = String(stderr || "");
        const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(text);
        const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (!m) {
          resolve({ durationSec: 0, hasAudio });
          return;
        }
        const hours = Number(m[1]);
        const minutes = Number(m[2]);
        const seconds = Number(m[3]);
        const total = hours * 3600 + minutes * 60 + seconds;
        resolve({
          durationSec: Number.isFinite(total) && total > 0 ? total : 0,
          hasAudio,
        });
      },
    );
  });
}

/**
 * Build a synchronized video+audio trim, 12ms micro-fade, concat, and speed filter_complex.
 * Each segment's video (`trim`) and audio (`atrim` + edge `afade`) have identical duration,
 * so `concat=n=N:v=1:a=1` keeps lip-sync 100% locked across every jump cut.
 */
export function buildTightenFfmpegFilter(
  plan: TightenPlan,
  speed: number,
  fadeMs = TIGHTEN_CROSSFADE_MS,
): string {
  const segments = plan.segments;
  const fadeSec = Number(Math.max(0.004, fadeMs / 1000).toFixed(4));
  const parts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const s = Number(seg.startSec.toFixed(4));
    const e = Number(seg.endSec.toFixed(4));
    const dur = Math.max(0.02, e - s);
    const fadeOutStart = Number(Math.max(0, dur - fadeSec).toFixed(4));
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    if (segments.length > 1 && dur > fadeSec * 2.5) {
      const afades: string[] = [];
      if (i > 0) afades.push(`afade=t=in:st=0:d=${fadeSec}`);
      if (i < segments.length - 1) afades.push(`afade=t=out:st=${fadeOutStart}:d=${fadeSec}`);
      parts.push(
        `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS${afades.length ? `,${afades.join(",")}` : ""}[a${i}]`,
      );
    } else {
      parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    }
    concatInputs.push(`[v${i}][a${i}]`);
  }

  const effectiveSpeed = Number(Math.max(1, Math.min(1.25, speed)).toFixed(4));
  const needsSpeed = Math.abs(effectiveSpeed - 1) >= 0.005;

  if (segments.length === 1) {
    if (needsSpeed) {
      parts.push(`[v0]setpts=PTS/${effectiveSpeed}[vout]`);
      parts.push(`[a0]atempo=${effectiveSpeed}[aout]`);
    } else {
      parts.push(`[v0]null[vout]`);
      parts.push(`[a0]anull[aout]`);
    }
  } else {
    parts.push(
      `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`,
    );
    if (needsSpeed) {
      parts.push(`[vcat]setpts=PTS/${effectiveSpeed}[vout]`);
      parts.push(`[acat]atempo=${effectiveSpeed}[aout]`);
    } else {
      parts.push(`[vcat]null[vout]`);
      parts.push(`[acat]anull[aout]`);
    }
  }

  return parts.join(";");
}

/**
 * Single-stream `select` + `aselect` filter for presenter clips with many speech
 * segments (> 8). Avoids FFmpeg's implicit `split=N` frame-cloning bottleneck on
 * long 1080p videos while keeping video and audio timestamps locked.
 */
export function buildTightenSelectFfmpegFilter(
  plan: TightenPlan,
  speed: number,
): string {
  const expr = plan.segments
    .map((seg) => {
      const s = Number(seg.startSec.toFixed(4));
      const e = Number(seg.endSec.toFixed(4));
      return `between(t,${s},${e})`;
    })
    .join("+");
  const effectiveSpeed = Number(Math.max(1, Math.min(1.25, speed)).toFixed(4));
  const needsSpeed = Math.abs(effectiveSpeed - 1) >= 0.005;
  const vSetpts = needsSpeed
    ? `setpts=N/(FRAME_RATE*TB)/${effectiveSpeed}`
    : `setpts=N/(FRAME_RATE*TB)`;
  const aFilter = needsSpeed
    ? `asetpts=N/SR/TB,atempo=${effectiveSpeed}`
    : `asetpts=N/SR/TB`;
  return `[0:v]select='${expr}',${vSetpts}[vout];[0:a]aselect='${expr}',${aFilter}[aout]`;
}

export async function tightenPresenterVideoFile(input: {
  clipUrl: string;
  tighten?: boolean | null;
  tightenMaxGapMs?: number | null;
  tightenSpeed?: number | null;
}): Promise<{
  clipUrl: string;
  tightened: boolean;
  jumpCutTimesSec: number[];
  trimmedSilenceMs: number;
  effectiveSpeed: number;
}> {
  const resolved = resolveTightenOptions(input as TightenInput);
  if (!resolved.enabled) {
    return {
      clipUrl: input.clipUrl,
      tightened: false,
      jumpCutTimesSec: [],
      trimmedSilenceMs: 0,
      effectiveSpeed: 1,
    };
  }

  const local = resolveLocalMediaFile(input.clipUrl, { stocks: true });
  if (!local.ok) {
    return {
      clipUrl: input.clipUrl,
      tightened: false,
      jumpCutTimesSec: [],
      trimmedSilenceMs: 0,
      effectiveSpeed: resolved.speed,
    };
  }

  const { durationSec, hasAudio } = await probeDurationAndAudioViaFfmpeg(local.path);
  if (durationSec <= 0.5 || !hasAudio) {
    return {
      clipUrl: input.clipUrl,
      tightened: false,
      jumpCutTimesSec: [],
      trimmedSilenceMs: 0,
      effectiveSpeed: 1,
    };
  }

  const minSilenceDetectSec = Number(Math.max(0.15, resolved.maxGapMs / 1000).toFixed(3));
  const silenceTimeoutMs = Math.min(180_000, Math.max(60_000, Math.ceil(durationSec * 400)));
  const silenceStderr = await runFfmpegCaptureStderr(
    [
      "-hide_banner",
      "-vn",
      "-sn",
      "-dn",
      "-i",
      local.path,
      "-af",
      `silencedetect=noise=-34dB:d=${minSilenceDetectSec}`,
      "-f",
      "null",
      "-",
    ],
    silenceTimeoutMs,
  );

  const silences = parseFfmpegSilenceDetectIntervals(silenceStderr, durationSec);
  const plan = planTightenKeepSegments({
    durationSec,
    silences,
    maxGapMs: resolved.maxGapMs,
    residualGapMs: resolved.residualGapMs,
    crossfadeMs: resolved.crossfadeMs,
    speed: resolved.speed,
  });

  const hasCuts =
    plan.segments.length > 1 ||
    (plan.segments.length === 1 &&
      (plan.segments[0]!.startSec > 0.05 ||
        durationSec - plan.segments[0]!.endSec > 0.05));
  const hasSpeed = Math.abs(resolved.speed - 1) >= 0.005;

  if (!hasCuts && !hasSpeed) {
    return {
      clipUrl: input.clipUrl,
      tightened: false,
      jumpCutTimesSec: [],
      trimmedSilenceMs: 0,
      effectiveSpeed: 1,
    };
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const outName = `presenter-tight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const outPath = path.join(rendersDir, outName);
  const filter =
    plan.segments.length > TIGHTEN_SINGLE_STREAM_SELECT_THRESHOLD
      ? buildTightenSelectFfmpegFilter(plan, resolved.speed)
      : buildTightenFfmpegFilter(plan, resolved.speed, resolved.crossfadeMs);
  const encodeTimeoutMs = Math.min(600_000, Math.max(240_000, Math.ceil(durationSec * 2_000)));

  await runFfmpegCaptureStderr(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      local.path,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "superfast",
      "-crf",
      "19",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ],
    encodeTimeoutMs,
  );
  try {
    fs.chmodSync(outPath, 0o644);
  } catch {}

  return {
    clipUrl: `/api/renders/${outName}`,
    tightened: true,
    jumpCutTimesSec: plan.jumpCutTimesSec,
    trimmedSilenceMs: plan.trimmedSilenceMs,
    effectiveSpeed: resolved.speed,
  };
}

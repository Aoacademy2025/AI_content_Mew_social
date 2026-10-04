// ffprobe/ffmpeg metadata probes for user-uploaded media (moved from
// /api/videos/broll-window/upload and /api/videos/upload-avatar so the routes and their
// G24 test share one implementation). Every call takes the input demuxer resolved by
// resolveSafeInputDemuxer and spreads safeInputArgs(demuxer) before the input path, so a
// playlist disguised as media cannot open other files or URLs (see media-probe-args.ts).
import { execFile, execFileSync } from "child_process";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  safeInputArgs,
  sniffSafeInputDemuxer,
  type MediaKind,
  type SafeInputDemuxer,
} from "@/lib/media-probe-args";

// ffprobe sits next to ffmpeg in the same install.
export function getFfprobePath(): string {
  return getFfmpegPath().replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

// Same derivation as /select's ffprobeDurationSec (and tts/route.ts).
export function ffprobeDurationSec(filePath: string, demuxer: SafeInputDemuxer): number {
  try {
    const out = execFileSync(
      getFfprobePath(),
      ["-v", "quiet", ...safeInputArgs(demuxer), "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { encoding: "utf-8", timeout: 10_000 },
    );
    return parseFloat(out.trim()) || 0;
  } catch {
    return 0;
  }
}

// Sibling to ffprobeDurationSec: metadata-only probe (no frame decode) so we can bound
// pixel dimensions BEFORE applyKenBurns / normalizeForRemotion ever touch the file. A
// tiny file can still be a decompression bomb (e.g. a 317 KB 10000×10000 PNG forces the
// Ken Burns ffmpeg decode to ~4.5 GB RSS; an 8000×8000 mp4 does ~3 GB in
// normalizeForRemotion) — and normalizeForRemotion runs behind the process-wide
// normalize semaphore shared with every other user's b-roll processing, so one hostile
// upload can stall the whole pipeline. Reject anything we can't confidently bound.
export function ffprobeDimensions(filePath: string, demuxer: SafeInputDemuxer): { width: number; height: number } | null {
  try {
    const out = execFileSync(
      getFfprobePath(),
      ["-v", "error", ...safeInputArgs(demuxer), "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath],
      { encoding: "utf-8", timeout: 10_000 },
    );
    const [w, h] = out.trim().split(",").map((n) => parseInt(n, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
}

/**
 * PR-B fix round 1 (N2): the DISPLAYED dimensions — what a player (and upload-avatar's browser
 * check, videoWidth/videoHeight) shows. A phone stores portrait video as landscape frames plus a
 * rotation (display-matrix side data, or the legacy `rotate` tag); at ±90° width and height
 * swap. Same G24 pins as ffprobeDimensions. null when the probe fails or the answer is not sane.
 */
export function ffprobeDisplayDimensions(filePath: string, demuxer: SafeInputDemuxer): { width: number; height: number } | null {
  try {
    const out = execFileSync(
      getFfprobePath(),
      [
        // -show_streams, not -show_entries …:stream_side_data=rotation: prod's Ubuntu ffprobe 4.4
        // has no `stream_side_data` section and rejects the whole probe (2026-10-04).
        "-v", "error", ...safeInputArgs(demuxer), "-select_streams", "v:0",
        "-show_streams", "-of", "json", filePath,
      ],
      { encoding: "utf-8", timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    const stream = (JSON.parse(out) as {
      streams?: Array<{ width?: unknown; height?: unknown; tags?: { rotate?: unknown }; side_data_list?: Array<{ rotation?: unknown }> }>;
    }).streams?.[0];
    const w = Number(stream?.width);
    const h = Number(stream?.height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
    const sideRotation = stream?.side_data_list?.find((entry) => entry && entry.rotation !== undefined)?.rotation;
    const rotation = Number(sideRotation ?? stream?.tags?.rotate ?? 0);
    const quarterTurn = Number.isFinite(rotation) && Math.abs(rotation) % 180 > 45 && Math.abs(rotation) % 180 < 135;
    return quarterTurn ? { width: h, height: w } : { width: w, height: h };
  } catch {
    return null;
  }
}

function execFileCapture(file: string, args: string[], timeout = 10_000, allowFailure = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err && !allowFailure) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

// upload-avatar's duration probe: ffprobe, then ffmpeg's "Duration:" banner as a fallback
// (the packaged Windows ffmpeg ships no ffprobe).
export async function probeDurationMs(filePath: string, demuxer: SafeInputDemuxer): Promise<number | null> {
  try {
    const { stdout } = await execFileCapture(getFfprobePath(), [
      "-v", "error",
      ...safeInputArgs(demuxer),
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ]);
    const sec = Number.parseFloat(stdout.trim());
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {}

  try {
    const { stderr } = await execFileCapture(getFfmpegPath(), [...safeInputArgs(demuxer), "-i", filePath], 10_000, true);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (!m) return null;
    const fractionMs = Math.round(Number(`0.${m[4]}`) * 1000);
    return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) + fractionMs;
  } catch {
    return null;
  }
}

export type MediaStreams = { audio: boolean; video: boolean };

// A stream only counts when it decodes to something: an mp3 forced through `-f aac` still
// "opens" as an aac stream with 0 channels, and a playlist forced through a resyncing
// demuxer can report an empty stream too.
function streamsFromBanner(stderr: string): MediaStreams {
  let audio = false;
  let video = false;
  for (const line of stderr.split("\n")) {
    const m = /Stream #\d+:\d+.*?: (Audio|Video): (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "Audio") {
      const hz = Number(/(\d+) Hz/.exec(m[2])?.[1] ?? 0);
      if (hz > 0 && !/\b0 channels\b/.test(m[2])) audio = true;
    } else {
      const size = /\b(\d{1,5})x(\d{1,5})\b/.exec(m[2]);
      if (size && Number(size[1]) > 0 && Number(size[2]) > 0) video = true;
    }
  }
  return { audio, video };
}

/**
 * Which decodable streams the file holds when read with `demuxer`. ffprobe first; ffmpeg's
 * banner only when ffprobe is not installed. null = neither tool could run.
 */
export async function probeMediaStreams(filePath: string, demuxer: SafeInputDemuxer): Promise<MediaStreams | null> {
  try {
    const { stdout } = await execFileCapture(getFfprobePath(), [
      "-v", "error",
      ...safeInputArgs(demuxer),
      "-show_entries", "stream=codec_type,width,height,sample_rate,channels",
      "-of", "json",
      filePath,
    ], 20_000);
    const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> };
    const result: MediaStreams = { audio: false, video: false };
    for (const stream of parsed.streams ?? []) {
      if (stream.codec_type === "audio" && Number(stream.sample_rate) > 0 && Number(stream.channels) > 0) result.audio = true;
      if (stream.codec_type === "video" && Number(stream.width) > 0 && Number(stream.height) > 0) result.video = true;
    }
    return result;
  } catch (error) {
    // ffprobe ran and refused the file: nothing decodable.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { audio: false, video: false };
  }
  try {
    const { stderr } = await execFileCapture(getFfmpegPath(), [...safeInputArgs(demuxer), "-i", filePath], 20_000, true);
    return streamsFromBanner(stderr);
  } catch {
    return null;
  }
}

/**
 * Ingest gate for user media that will be stored, or read later by code that still lets
 * ffmpeg auto-detect the format. The file must start with a media signature of one of
 * `kinds` (so auto-detection can never see a playlist or script) AND parse with that
 * pinned demuxer into at least one real audio or video stream. Returns the demuxer, or
 * null when the file must be refused.
 */
export async function admitUserMediaFile(filePath: string, kinds: readonly MediaKind[]): Promise<SafeInputDemuxer | null> {
  const demuxer = sniffSafeInputDemuxer(filePath, kinds);
  if (!demuxer) return null;
  const streams = await probeMediaStreams(filePath, demuxer);
  return streams && (streams.audio || streams.video) ? demuxer : null;
}

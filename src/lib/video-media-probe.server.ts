// Metadata probes for Story Film media on disk (presenter uploads, worker artifacts, final
// renders). Every ffprobe/ffmpeg call pins the input (G24: -protocol_whitelist file + an
// allowlisted -f picked from the file's bytes, else its extension), so a playlist stored
// under a media name is never opened as one; a file with no usable demuxer reads as null.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { resolveStoredMediaDemuxer, safeInputArgs } from "@/lib/media-probe-args";

const execFileAsync = promisify(execFile);

export type VideoMediaMetadata = {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

type FfprobePayload = {
  format?: { duration?: string | number };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string | number;
    tags?: { rotate?: string | number };
    side_data_list?: Array<{ rotation?: string | number }>;
  }>;
};

function rotatedDimensions(width: number, height: number, rotation: number) {
  const normalized = Math.abs(rotation) % 180;
  return normalized > 45 && normalized < 135
    ? { width: height, height: width }
    : { width, height };
}

export function parseFfprobeVideoMetadata(raw: string): VideoMediaMetadata | null {
  let payload: FfprobePayload;
  try {
    payload = JSON.parse(raw) as FfprobePayload;
  } catch {
    return null;
  }
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const rawWidth = Number(video?.width);
  const rawHeight = Number(video?.height);
  const durationSec = Number(payload.format?.duration ?? video?.duration);
  const sideRotation = video?.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation;
  const rotation = Number(sideRotation ?? video?.tags?.rotate ?? 0);
  if (!(rawWidth > 0) || !(rawHeight > 0) || !(durationSec > 0)) return null;
  const dimensions = rotatedDimensions(rawWidth, rawHeight, Number.isFinite(rotation) ? rotation : 0);
  return {
    width: Math.round(dimensions.width),
    height: Math.round(dimensions.height),
    durationMs: Math.round(durationSec * 1_000),
    hasAudio: Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")),
  };
}

export function parseFfmpegVideoMetadata(stderr: string): VideoMediaMetadata | null {
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/i);
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})(?:\b|\s)/i);
  if (!duration || !dimensions) return null;
  const durationMs = (
    Number(duration[1]) * 3_600
    + Number(duration[2]) * 60
    + Number(duration[3])
  ) * 1_000 + Math.round(Number(`0.${duration[4]}`) * 1_000);
  const rotationMatch = stderr.match(/rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i);
  const rotated = rotatedDimensions(
    Number(dimensions[1]),
    Number(dimensions[2]),
    Number(rotationMatch?.[1] ?? 0),
  );
  if (!(durationMs > 0) || !(rotated.width > 0) || !(rotated.height > 0)) return null;
  return {
    durationMs,
    width: rotated.width,
    height: rotated.height,
    hasAudio: /Stream\s+#\S+:\s+Audio:/i.test(stderr),
  };
}

function durationMsFromFfmpeg(stderr: string): number | null {
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/i);
  if (!duration) return null;
  const value = (
    Number(duration[1]) * 3_600
    + Number(duration[2]) * 60
    + Number(duration[3])
  ) * 1_000 + Math.round(Number(`0.${duration[4]}`) * 1_000);
  return value > 0 ? value : null;
}

export async function probeMediaDurationMs(filePath: string): Promise<number | null> {
  const demuxer = resolveStoredMediaDemuxer(filePath, ["audio", "video"]);
  if (!demuxer) return null;
  const input = safeInputArgs(demuxer);
  const ffmpeg = getFfmpegPath();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error",
      ...input,
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20_000 });
    const seconds = Number.parseFloat(stdout.trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1_000);
  } catch {}
  try {
    const { stderr } = await execFileAsync(ffmpeg, [...input, "-i", filePath], {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 20_000,
    }).catch((error: unknown) => ({
      stdout: "",
      stderr: (error as { stderr?: string }).stderr ?? "",
    }));
    return durationMsFromFfmpeg(stderr);
  } catch {
    return null;
  }
}

export async function probeVideoMedia(filePath: string): Promise<VideoMediaMetadata | null> {
  const demuxer = resolveStoredMediaDemuxer(filePath, ["video"]);
  if (!demuxer) return null;
  const input = safeInputArgs(demuxer);
  const ffmpeg = getFfmpegPath();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error",
      ...input,
      // Not -show_entries …:stream_side_data=rotation — ffprobe 4.4 (prod) rejects that section.
      "-show_streams", "-show_format",
      "-of", "json",
      filePath,
    ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 20_000 });
    const metadata = parseFfprobeVideoMetadata(stdout);
    if (metadata) return metadata;
  } catch {
    // The packaged Windows ffmpeg does not include ffprobe; parse ffmpeg's
    // diagnostic output as the cross-platform fallback.
  }

  try {
    const { stderr } = await execFileAsync(ffmpeg, [...input, "-i", filePath], {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 20_000,
    }).catch((error: unknown) => {
      const probeError = error as { stderr?: string };
      return { stdout: "", stderr: probeError.stderr ?? "" };
    });
    return parseFfmpegVideoMetadata(stderr);
  } catch {
    return null;
  }
}

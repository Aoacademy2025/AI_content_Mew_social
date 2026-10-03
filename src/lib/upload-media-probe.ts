// ffprobe/ffmpeg metadata probes for user-uploaded media (moved from
// /api/videos/broll-window/upload and /api/videos/upload-avatar so the routes and their
// G24 test share one implementation). Every call takes the input demuxer resolved by
// resolveSafeInputDemuxer and spreads safeInputArgs(demuxer) before the input path, so a
// playlist disguised as media cannot open other files or URLs (see media-probe-args.ts).
import { execFile, execFileSync } from "child_process";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { safeInputArgs, type SafeInputDemuxer } from "@/lib/media-probe-args";

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

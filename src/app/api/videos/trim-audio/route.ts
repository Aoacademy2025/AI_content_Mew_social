import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { resolveContainedFile } from "@/lib/contained-path";
import { resolveStoredMediaDemuxer, safeInputArgs, type SafeInputDemuxer } from "@/lib/media-probe-args";

export const maxDuration = 30;
export const runtime = "nodejs";

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(
    process.cwd(), "node_modules", "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    `ffmpeg${ext}`,
  );
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { maxBuffer: 20 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${err.message}\n${stderr?.slice(-300)}`));
      else resolve();
    });
  });
}

function probeDuration(ffmpeg: string, filePath: string, demuxer: SafeInputDemuxer): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, [...safeInputArgs(demuxer), "-i", filePath], { maxBuffer: 1024 * 1024 }, (_err, _stdout, stderr) => {
      const match = stderr?.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (match) resolve(parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]));
      else reject(new Error("Could not probe duration"));
    });
  });
}

// POST /api/videos/trim-audio
// Body: { audioUrl, durationSecs?, tailSecs?, fromEnd? }
// - durationSecs only: trim to first N seconds (bookend intro)
// - tailSecs only: trim to last T seconds (bookend outro)
// - fromEnd + durationSecs: legacy tail-only request, trim to last N seconds
// - durationSecs + tailSecs: concat first N seconds + last T seconds (bookend-both)
// Returns: { audioUrl }
export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { audioUrl } = body ?? {};
  const requestedDurationSecs = Number(body?.durationSecs ?? 0);
  const requestedTailSecs = Number(body?.tailSecs ?? 0);
  const fromEnd = body?.fromEnd === true;
  const durationSecs = Number.isFinite(requestedDurationSecs) ? requestedDurationSecs : 0;
  const tailSecs = Number.isFinite(requestedTailSecs) ? requestedTailSecs : 0;
  const effectiveDurationSecs = fromEnd ? 0 : durationSecs;
  const effectiveTailSecs = tailSecs > 0 ? tailSecs : (fromEnd ? durationSecs : 0);

  if (!audioUrl) return NextResponse.json({ error: "audioUrl required" }, { status: 400 });
  // Allow durationSecs=0 when only tailSecs is needed (tail-only extraction)
  if (effectiveDurationSecs <= 0 && effectiveTailSecs <= 0)
    return NextResponse.json({ error: "durationSecs or tailSecs required" }, { status: 400 });

  if (typeof audioUrl !== "string") return NextResponse.json({ error: "Invalid audioUrl" }, { status: 400 });
  const normalizedUrl = audioUrl.replace(/^\/api\/renders\//, "/renders/");
  // Containment guard: the file must resolve (realpath, so symlinks too) inside public/.
  const src = resolveContainedFile(path.join(process.cwd(), "public"), normalizedUrl);
  if (!src.ok && src.reason === "outside") return NextResponse.json({ error: "Invalid audioUrl" }, { status: 400 });
  if (!src.ok) return NextResponse.json({ error: `File not found: ${audioUrl}` }, { status: 404 });
  const srcPath = src.path;
  // G24: read with a pinned demuxer (its own bytes, else its own extension), never auto-detect.
  const demuxer = resolveStoredMediaDemuxer(srcPath, ["audio", "video"]);
  if (!demuxer) return NextResponse.json({ error: "Invalid audioUrl" }, { status: 400 });
  const ext = path.extname(audioUrl) || ".mp3";
  const input = [...safeInputArgs(demuxer), "-i", srcPath];

  const ffmpeg = getFfmpegPath();
  if (!fs.existsSync(ffmpeg)) return NextResponse.json({ error: "ffmpeg not found" }, { status: 500 });

  const ts = Date.now();
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  try {
    const totalDur = await probeDuration(ffmpeg, srcPath, demuxer);
    const outFile = `tts-trimmed-${ts}${ext}`;
    const outPath = path.join(rendersDir, outFile);

    if (effectiveTailSecs > 0 && effectiveDurationSecs <= 0) {
      // tail-only: extract last T seconds
      const tailStart = Math.max(0, totalDur - effectiveTailSecs);
      await runFfmpeg(ffmpeg, ["-y", ...input, "-ss", String(tailStart), "-c", "copy", outPath]);
      return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
    } else if (effectiveTailSecs > 0 && effectiveDurationSecs > 0) {
      // bookend-both concat: intro[0..N] + tail[totalDur-T..end]
      const N = Math.min(effectiveDurationSecs, totalDur);
      const tailStart = Math.max(N, totalDur - effectiveTailSecs);
      const introPath = path.join(rendersDir, `tts-intro-${ts}${ext}`);
      const tailPath  = path.join(rendersDir, `tts-tail-${ts}${ext}`);
      const listPath  = path.join(rendersDir, `tts-concat-${ts}.txt`);
      await runFfmpeg(ffmpeg, ["-y", ...input, "-t", String(N), "-c", "copy", introPath]);
      await runFfmpeg(ffmpeg, ["-y", ...input, "-ss", String(tailStart), "-c", "copy", tailPath]);
      fs.writeFileSync(listPath, `file '${introPath.replace(/\\/g, "/")}'\nfile '${tailPath.replace(/\\/g, "/")}'`);
      await runFfmpeg(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
      try { fs.unlinkSync(introPath); fs.unlinkSync(tailPath); fs.unlinkSync(listPath); } catch {}
      return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
    } else {
      // intro only: first N seconds
      await runFfmpeg(ffmpeg, ["-y", ...input, "-t", String(effectiveDurationSecs), "-c", "copy", outPath]);
      return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
    }
  } catch (e) {
    console.error("[trim-audio]", e);
    // Never echo the error: it carries server paths and the ffmpeg command line.
    return NextResponse.json({ error: "Audio trim failed" }, { status: 500 });
  }
}

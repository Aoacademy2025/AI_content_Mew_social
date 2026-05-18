import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

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

function probeDuration(ffmpeg: string, filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ["-i", filePath], { maxBuffer: 1024 * 1024 }, (_err, _stdout, stderr) => {
      const match = stderr?.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (match) resolve(parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]));
      else reject(new Error("Could not probe duration"));
    });
  });
}

// POST /api/videos/trim-audio
// Body: { audioUrl, durationSecs, tailSecs? }
// - durationSecs only: trim to first N seconds (bookend intro)
// - durationSecs + tailSecs: concat first N seconds + last T seconds (bookend-both)
// Returns: { audioUrl }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { audioUrl, durationSecs, tailSecs } = body ?? {};

  if (!audioUrl) return NextResponse.json({ error: "audioUrl required" }, { status: 400 });
  // Allow durationSecs=0 when only tailSecs is needed (tail-only extraction)
  if ((!durationSecs || durationSecs <= 0) && (!tailSecs || tailSecs <= 0))
    return NextResponse.json({ error: "durationSecs or tailSecs required" }, { status: 400 });

  const normalizedUrl = audioUrl.replace(/^\/api\/renders\//, "/renders/");
  const srcPath = path.join(process.cwd(), "public", normalizedUrl);
  if (!fs.existsSync(srcPath)) return NextResponse.json({ error: `File not found: ${audioUrl}` }, { status: 404 });

  const ffmpeg = getFfmpegPath();
  if (!fs.existsSync(ffmpeg)) return NextResponse.json({ error: "ffmpeg not found" }, { status: 500 });

  const ts = Date.now();
  const ext = path.extname(audioUrl) || ".mp3";
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  try {
    const totalDur = await probeDuration(ffmpeg, srcPath);
    const outFile = `tts-trimmed-${ts}${ext}`;
    const outPath = path.join(rendersDir, outFile);

    if (tailSecs && tailSecs > 0 && (!durationSecs || durationSecs <= 0)) {
      // tail-only: extract last T seconds
      const tailStart = Math.max(0, totalDur - tailSecs);
      await runFfmpeg(ffmpeg, ["-y", "-i", srcPath, "-ss", String(tailStart), "-c", "copy", outPath]);
      return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
    } else if (tailSecs && tailSecs > 0 && durationSecs > 0) {
      // bookend-both concat: intro[0..N] + tail[totalDur-T..end]
      const N = Math.min(durationSecs, totalDur);
      const tailStart = Math.max(N, totalDur - tailSecs);
      const introPath = path.join(rendersDir, `tts-intro-${ts}${ext}`);
      const tailPath  = path.join(rendersDir, `tts-tail-${ts}${ext}`);
      const listPath  = path.join(rendersDir, `tts-concat-${ts}.txt`);
      await runFfmpeg(ffmpeg, ["-y", "-i", srcPath, "-t", String(N), "-c", "copy", introPath]);
      await runFfmpeg(ffmpeg, ["-y", "-i", srcPath, "-ss", String(tailStart), "-c", "copy", tailPath]);
      fs.writeFileSync(listPath, `file '${introPath.replace(/\\/g, "/")}'\nfile '${tailPath.replace(/\\/g, "/")}'`);
      await runFfmpeg(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
      try { fs.unlinkSync(introPath); fs.unlinkSync(tailPath); fs.unlinkSync(listPath); } catch {}
      return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
    } else {
      // intro only: first N seconds
      await runFfmpeg(ffmpeg, ["-y", "-i", srcPath, "-t", String(durationSecs), "-c", "copy", outPath]);
      return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
    }
  } catch (e) {
    console.error("[trim-audio]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const maxDuration = 15;
export const runtime = "nodejs";

function getFfprobePath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  // ffprobe sits next to ffmpeg in the same package
  const ffmpegDir = path.join(
    process.cwd(), "node_modules", "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
  );
  const probe = path.join(ffmpegDir, `ffprobe${ext}`);
  if (fs.existsSync(probe)) return probe;
  // fallback: use ffmpeg -i which prints duration in stderr
  return path.join(ffmpegDir, `ffmpeg${ext}`);
}

function getDurationMs(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const bin = getFfprobePath();
    if (!fs.existsSync(bin)) return reject(new Error("ffprobe/ffmpeg not found"));

    if (bin.includes("ffprobe")) {
      execFile(bin, [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", filePath,
      ], (err, stdout) => {
        if (err) return reject(err);
        const sec = parseFloat(stdout.trim());
        if (isNaN(sec)) return reject(new Error("Could not parse duration"));
        resolve(Math.round(sec * 1000));
      });
    } else {
      // ffmpeg -i fallback — duration is in stderr
      execFile(bin, ["-i", filePath, "-f", "null", "-"], { maxBuffer: 5 * 1024 * 1024 }, (_err, _stdout, stderr) => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (!m) return reject(new Error("Could not parse duration from ffmpeg"));
        const ms = (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000 + parseInt(m[4]) * 10;
        resolve(ms);
      });
    }
  });
}

// POST /api/videos/audio-duration
// Body: { audioUrl: "/renders/tts-xxx.mp3" }
// Returns: { durationMs: number }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const audioUrl: string = body?.audioUrl ?? "";
  if (!audioUrl) return NextResponse.json({ error: "audioUrl required" }, { status: 400 });

  const filePath = path.join(process.cwd(), "public", audioUrl.replace(/^\/api\/renders\//, "/renders/"));
  if (!fs.existsSync(filePath)) return NextResponse.json({ error: `File not found: ${audioUrl}` }, { status: 404 });

  try {
    const durationMs = await getDurationMs(filePath);
    return NextResponse.json({ durationMs });
  } catch (e) {
    console.error("[audio-duration]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

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

function trimAudio(ffmpeg: string, src: string, dest: string, durationSecs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, [
      "-y",
      "-i", src,
      "-t", String(durationSecs),
      "-c", "copy",
      dest,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg trim failed: ${err.message}\n${stderr?.slice(-300)}`));
      else resolve();
    });
  });
}

// POST /api/videos/trim-audio
// Body: { audioUrl: "/renders/tts-xxx.mp3", durationSecs: 5 }
// Returns: { audioUrl: "/renders/tts-trimmed-xxx.mp3" }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { audioUrl, durationSecs } = body ?? {};

  if (!audioUrl) return NextResponse.json({ error: "audioUrl required" }, { status: 400 });
  if (!durationSecs || durationSecs <= 0) return NextResponse.json({ error: "durationSecs required" }, { status: 400 });

  const normalizedUrl = audioUrl.replace(/^\/api\/renders\//, "/renders/");
  const srcPath = path.join(process.cwd(), "public", normalizedUrl);
  if (!fs.existsSync(srcPath)) return NextResponse.json({ error: `File not found: ${audioUrl}` }, { status: 404 });

  const ffmpeg = getFfmpegPath();
  if (!fs.existsSync(ffmpeg)) return NextResponse.json({ error: "ffmpeg not found" }, { status: 500 });

  const ts = Date.now();
  const ext = path.extname(audioUrl) || ".mp3";
  const outFile = `tts-trimmed-${ts}${ext}`;
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const outPath = path.join(rendersDir, outFile);

  try {
    await trimAudio(ffmpeg, srcPath, outPath, durationSecs);
    return NextResponse.json({ audioUrl: `/api/renders/${outFile}` });
  } catch (e) {
    console.error("[trim-audio]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

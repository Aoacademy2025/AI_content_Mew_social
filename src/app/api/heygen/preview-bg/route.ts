import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const runtime = "nodejs";
export const maxDuration = 300;

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg: ${err.message}\n${stderr?.slice(-500)}`));
      else resolve(stderr ?? "");
    });
  });
}

// POST /api/heygen/preview-bg
// Body: { avatarVideoUrl: string }
// Returns: { previewUrl: string } — a transparent webm video served via /api/stocks/
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { avatarVideoUrl } = await req.json().catch(() => ({}));
  if (!avatarVideoUrl) return NextResponse.json({ error: "avatarVideoUrl required" }, { status: 400 });

  const ffmpeg = getFfmpegPath();
  if (!fs.existsSync(ffmpeg)) return NextResponse.json({ error: "ffmpeg not found" }, { status: 500 });

  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });

  const ts = Date.now();
  const outFile = `avatar-nobg-${ts}.webm`;
  const outPath = path.join(stocksDir, outFile);

  // Resolve input path
  let inputPath: string;
  let needsCleanup = false;

  if (avatarVideoUrl.startsWith("/api/stocks/")) {
    const filename = avatarVideoUrl.replace("/api/stocks/", "");
    inputPath = path.join(stocksDir, filename);
    if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
  } else if (avatarVideoUrl.startsWith("/renders/")) {
    inputPath = path.join(process.cwd(), "public", avatarVideoUrl);
    if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
  } else if (avatarVideoUrl.startsWith("/")) {
    inputPath = path.join(process.cwd(), "public", avatarVideoUrl);
    if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
  } else {
    inputPath = path.join(stocksDir, `tmp-avatar-${ts}.mp4`);
    const res = await fetch(avatarVideoUrl, { headers: { Accept: "video/mp4,video/*,*/*" } });
    if (!res.ok) return NextResponse.json({ error: `Download failed: ${res.status}` }, { status: 400 });
    fs.writeFileSync(inputPath, Buffer.from(await res.arrayBuffer()));
    needsCleanup = true;
  }

  try {
    // Chromakey remove green — low similarity to protect skin tones
    console.log("[preview-bg] chromakey removing green from entire video...");
    await runFfmpeg(ffmpeg, [
      "-y",
      "-i", inputPath,
      "-vf", "format=yuva444p,chromakey=color=0x00FF00:similarity=0.40:blend=0.05,chromakey=color=0x00b140:similarity=0.35:blend=0.05",
      "-c:v", "libvpx-vp9",
      "-pix_fmt", "yuva420p",
      "-crf", "30", "-b:v", "0",
      "-an",
      outPath,
    ]);

    const outSize = fs.statSync(outPath).size;
    console.log(`[preview-bg] done: ${outFile} (${outSize} bytes)`);

    return NextResponse.json({ previewUrl: `/api/stocks/${outFile}` });
  } catch (err) {
    console.error("[preview-bg] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  } finally {
    if (needsCleanup) try { fs.unlinkSync(inputPath); } catch {}
  }
}

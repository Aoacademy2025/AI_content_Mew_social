import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { resolveLocalMediaFile } from "@/lib/contained-path";
import { resolveStoredMediaDemuxer, safeInputArgs } from "@/lib/media-probe-args";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/videos/generate-thumbnail
 * Body: { videoUrl: string, seekTime?: number }
 * Returns: { thumbnailUrl: string }
 *
 * Extracts a single frame from the video at seekTime (default 1s) using ffmpeg
 * and saves it as a JPEG in public/renders/.
 */
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { videoUrl, seekTime = 1.0 } = await req.json();
    if (!videoUrl) return NextResponse.json({ error: "videoUrl required" }, { status: 400 });

    // Resolve local file path from URL. Containment guard (realpath, so a symlink inside
    // public/ cannot point out): anything outside public/ or missing gets the generic 404 —
    // never leak the resolved path.
    const publicDir = path.join(process.cwd(), "public");
    const local = typeof videoUrl === "string" ? resolveLocalMediaFile(videoUrl) : null;
    if (!local?.ok) {
      return NextResponse.json({ error: "Video file not found" }, { status: 404 });
    }
    const localVideoPath = local.path;
    // G24: read with a pinned demuxer (its own bytes, else its own extension), never auto-detect.
    const demuxer = resolveStoredMediaDemuxer(localVideoPath, ["video", "image"]);
    if (!demuxer) {
      return NextResponse.json({ error: "Unsupported video file" }, { status: 400 });
    }

    // Output thumbnail
    const filename = `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
    const outputPath = path.join(publicDir, "renders", filename);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const ffmpeg = getFfmpegPath();
    // Extract 1 frame at seekTime, scale to 720px wide (keeping aspect ratio), high quality JPEG
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, [
        "-ss", String(seekTime),
        ...safeInputArgs(demuxer),
        "-i", localVideoPath,
        "-frames:v", "1",
        "-vf", "scale=720:-2",
        "-q:v", "3",  // 1-31, lower = better (3 ≈ 90% quality)
        "-y",
        outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });

      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 && fs.existsSync(outputPath)) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
      });
      proc.on("error", reject);
    });

    return NextResponse.json({ thumbnailUrl: `/api/renders/${filename}` });
  } catch (error) {
    return apiError({ route: "POST /api/videos/generate-thumbnail", error });
  }
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");

const execFileAsync = promisify(execFile);
const FFMPEG_PATH: string = ffmpegInstaller.path;

/** Use ffmpeg -i to extract basic metadata (width, height, duration) from any media file */
async function probeFile(filePath: string): Promise<{ width?: number; height?: number; duration?: number; codec?: string }> {
  try {
    // ffmpeg -i outputs info to stderr and exits with code 1 (no output specified) — that's expected
    const { stderr } = await execFileAsync(FFMPEG_PATH, ["-i", filePath], { timeout: 10000 }).catch(e => e);
    const combined = (stderr as string) ?? "";
    const videoMatch = combined.match(/Video: (\w+)[^,]*, [^,]*, (\d+)x(\d+)/);
    const durationMatch = combined.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const result: { width?: number; height?: number; duration?: number; codec?: string } = {};
    if (videoMatch) {
      result.codec = videoMatch[1];
      result.width = parseInt(videoMatch[2]);
      result.height = parseInt(videoMatch[3]);
    }
    if (durationMatch) {
      result.duration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
    }
    return result;
  } catch {
    return {};
  }
}

export const maxDuration = 300;
export const runtime = "nodejs";

function decrypt(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

async function uploadToHeygen(
  buffer: Buffer,
  contentType: string,
  heygenKey: string
): Promise<{ id: string | null; assetUrl: string | null }> {
  try {
    const res = await fetch("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: {
        "X-API-KEY": heygenKey,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: buffer as unknown as BodyInit,
    });
    const data = await res.json();
    console.log(`[n8n-avatar] HeyGen upload status=${res.status}`, JSON.stringify(data));
    if (!res.ok) return { id: null, assetUrl: null };
    return { id: data.data?.id ?? null, assetUrl: data.data?.url ?? null };
  } catch (e) {
    console.error("[n8n-avatar] uploadToHeygen error:", e);
    return { id: null, assetUrl: null };
  }
}

function readLocalFile(url: string): Buffer | null {
  if (url.startsWith("/")) {
    const filePath = path.join(process.cwd(), "public", url);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }
  return null;
}

// POST /api/videos/n8n-avatar
// Body: { mergedAudioUrl, bgVideoUrl, avatarId, webhookUrl }
// 1. Upload audio + video to HeyGen → get asset IDs
// 2. Send { audioAssetId, videoAssetId, avatarId, heygenKey } to n8n webhook
// Returns: { videoUrl }
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const { mergedAudioUrl, bgVideoUrl, avatarId, webhookUrl } = body ?? {};

    if (!webhookUrl) return NextResponse.json({ error: "webhookUrl required" }, { status: 400 });
    if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
    if (!mergedAudioUrl) return NextResponse.json({ error: "mergedAudioUrl required" }, { status: 400 });
    if (!bgVideoUrl) return NextResponse.json({ error: "bgVideoUrl required" }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { heygenKey: true },
    });

    if (!user?.heygenKey) {
      return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
    }

    const heygenKey = decrypt(user.heygenKey);

    // Read local files
    const audioBuffer = readLocalFile(mergedAudioUrl);
    const videoBuffer = readLocalFile(bgVideoUrl);

    if (!audioBuffer) return NextResponse.json({ error: `Audio file not found: ${mergedAudioUrl}` }, { status: 404 });
    if (!videoBuffer) return NextResponse.json({ error: `BG video file not found: ${bgVideoUrl}` }, { status: 404 });

    // Probe files before upload — log for diagnostics
    const audioPath = path.join(process.cwd(), "public", mergedAudioUrl);
    const videoPath = path.join(process.cwd(), "public", bgVideoUrl);
    const [audioMeta, videoMeta] = await Promise.all([probeFile(audioPath), probeFile(videoPath)]);
    console.log(`[n8n-avatar] INPUT CHECK — audio: ${audioBuffer.length}B, duration=${audioMeta.duration?.toFixed(1)}s`);
    console.log(`[n8n-avatar] INPUT CHECK — video: ${videoBuffer.length}B, ${videoMeta.width}x${videoMeta.height}, duration=${videoMeta.duration?.toFixed(1)}s, codec=${videoMeta.codec}`);
    if (videoMeta.width && videoMeta.height && (videoMeta.width !== 1080 || videoMeta.height !== 1920)) {
      console.warn(`[n8n-avatar] WARNING: BG video is ${videoMeta.width}x${videoMeta.height}, expected 1080x1920 — HeyGen may add letterbox bars`);
    }

    // Upload both assets to HeyGen in parallel
    console.log(`[n8n-avatar] Uploading assets to HeyGen... audio=${audioBuffer.length}B, video=${videoBuffer.length}B`);
    const [audioResult, videoResult] = await Promise.all([
      uploadToHeygen(audioBuffer, "audio/mpeg", heygenKey),
      uploadToHeygen(videoBuffer, "video/mp4", heygenKey),
    ]);

    if (!audioResult.id) return NextResponse.json({ error: "Audio upload to HeyGen failed" }, { status: 500 });
    if (!videoResult.id) return NextResponse.json({ error: "BG video upload to HeyGen failed" }, { status: 500 });

    console.log(`[n8n-avatar] audioAssetId=${audioResult.id}, videoAssetId=${videoResult.id}`);

    // Send asset IDs + URLs to n8n webhook
    const payload = {
      audioAssetId: audioResult.id,
      audioAssetUrl: audioResult.assetUrl,
      videoAssetId: videoResult.id,
      videoAssetUrl: videoResult.assetUrl,
      avatarId,
      heygenKey,
    };

    console.log(`[n8n-avatar] POSTing to ${webhookUrl}`, { audioAssetId: audioResult.id, videoAssetId: videoResult.id, audioAssetUrl: audioResult.assetUrl, videoAssetUrl: videoResult.assetUrl, avatarId });

    const n8nRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const n8nData = await n8nRes.json().catch(() => ({}));
    console.log("[n8n-avatar] n8n response status:", n8nRes.status, JSON.stringify(n8nData));

    if (!n8nRes.ok) {
      return NextResponse.json(
        { error: "n8n webhook failed", detail: n8nData },
        { status: n8nRes.status || 500 }
      );
    }

    const resultUrl: string | null = n8nData.video_url ?? n8nData.videoUrl ?? null;
    if (!resultUrl) {
      return NextResponse.json(
        { error: "No video_url in n8n response", detail: n8nData },
        { status: 500 }
      );
    }

    return NextResponse.json({ videoUrl: resultUrl });
  } catch (error) {
    console.error("n8n-avatar error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "n8n avatar failed" },
      { status: 500 }
    );
  }
}

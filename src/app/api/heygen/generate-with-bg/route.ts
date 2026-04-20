import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

function getFfmpegPath(): string {
  if (process.platform !== "win32") return "/usr/bin/ffmpeg";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `win32-${process.arch}`, "ffmpeg.exe");
}

/** Convert any audio file to MP3 128k, return path to tmp mp3 */
function toMp3(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.\w+$/, "") + `-heygen-${Date.now()}.mp3`;
  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), [
      "-y", "-i", inputPath,
      "-vn", "-acodec", "libmp3lame", "-ab", "128k", "-ar", "44100", "-ac", "2",
      outPath,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg mp3 convert failed: ${stderr?.slice(-300)}`));
      else resolve(outPath);
    });
  });
}

export const maxDuration = 300;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

// Detect content type from file bytes
function detectVideoType(buf: Buffer): string {
  if (buf.length > 12) {
    const ftyp = buf.toString("ascii", 4, 8);
    if (ftyp === "ftyp") {
      const brand = buf.toString("ascii", 8, 12);
      if (brand === "qt  " || brand === "mqt ") return "video/quicktime";
    }
  }
  return "video/mp4";
}

// Upload a local file to HeyGen and return { id, url }
async function uploadAsset(localUrl: string, heygenKey: string, contentType?: string): Promise<{ id: string; url: string | null }> {
  const normalizedUrl = localUrl.replace(/^\/api\/renders\//, "/renders/");
  const localPath = path.join(process.cwd(), "public", normalizedUrl);
  if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localUrl}`);
  const buffer = fs.readFileSync(localPath);
  const ct = contentType ?? detectVideoType(buffer);
  console.log("[generate-with-bg] uploading:", localUrl, "content-type:", ct, "size:", buffer.length);

  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": ct, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  });
  const data = await res.json();
  console.log("[generate-with-bg] upload result:", res.status, JSON.stringify(data));
  if (!res.ok || !data.data?.id) throw new Error(`Upload failed: ${data.message ?? res.status}`);
  return { id: data.data.id as string, url: (data.data.url as string) ?? null };
}

// POST /api/heygen/generate-with-bg
// Mode A (video bg): { text|audioUrl, avatarId, bgVideoUrl, scale?, offsetX?, offsetY? }
// Mode B (green screen): { text|audioUrl, avatarId, greenScreen: true, scale?, offsetX?, offsetY? }
// Returns: { videoId }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    text,
    audioUrl,
    avatarId,
    voiceId = "2d5b0e6cf36f460aa7fc47e3eee4ba54",
    bgVideoUrl,
    greenScreen = false,
    removeBg = false,
    bgColor = "#000000",
    scale = 2.02,
    offsetX = 0.0,
    offsetY = 0.28,
  } = body ?? {};

  if (!text && !audioUrl) return NextResponse.json({ error: "text or audioUrl required" }, { status: 400 });
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
  if (!greenScreen && !removeBg && !bgVideoUrl) return NextResponse.json({ error: "bgVideoUrl, greenScreen, or removeBg required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = decrypt(user.heygenKey);

  // Step 1: Background — remove bg / green screen / uploaded video
  let background: Record<string, unknown> | undefined;
  let bgAssetId: string | undefined;

  if (removeBg) {
    // removeBg mode: green bg — best contrast for AI segmentation (BiRefNet)
    background = { type: "color", value: "#00FF00" };
    console.log("[generate-with-bg] using green bg for AI removal");
  } else if (greenScreen) {
    // greenScreen mode: green bg for AI removal
    background = { type: "color", value: "#00FF00" };
    console.log("[generate-with-bg] using green bg mode");
  } else {
    // Video background mode: upload bg video to HeyGen
    const bgAsset = await uploadAsset(bgVideoUrl, heygenKey);
    if (!bgAsset.url) return NextResponse.json({ error: "HeyGen upload returned no URL for BG asset" }, { status: 500 });
    bgAssetId = bgAsset.id;
    background = { type: "video", url: bgAsset.url, fit: "cover", play_style: "loop" };
  }

  // Step 2: Build voice input
  let voiceInput: Record<string, unknown>;

  if (audioUrl) {
    // Always upload as MP3 — HeyGen's asset API is strict about audio format.
    // WAV (Gemini TTS) and other formats must be converted first.
    const normalizedAudioUrl = audioUrl.replace(/^\/api\/renders\//, "/renders/");
    const localPath = path.join(process.cwd(), "public", normalizedAudioUrl);
    const audioExt = audioUrl.split(".").pop()?.toLowerCase() ?? "";
    let uploadPath = localPath;
    let tmpMp3: string | null = null;

    if (audioExt !== "mp3") {
      console.log("[generate-with-bg] converting", audioExt, "→ mp3 before HeyGen upload");
      tmpMp3 = await toMp3(localPath);
      uploadPath = tmpMp3;
    }

    // Upload the MP3 file directly (bypass uploadAsset which reads from /public path)
    const buffer = fs.readFileSync(uploadPath);
    console.log("[generate-with-bg] uploading audio as audio/mpeg, size:", buffer.length);
    const uploadRes = await fetch("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-API-KEY": heygenKey, "Content-Type": "audio/mpeg", Accept: "application/json" },
      body: buffer as unknown as BodyInit,
    });
    const uploadData = await uploadRes.json();
    console.log("[generate-with-bg] audio upload result:", uploadRes.status, JSON.stringify(uploadData));
    if (tmpMp3) try { fs.unlinkSync(tmpMp3); } catch {}
    if (!uploadRes.ok || !uploadData.data?.id) throw new Error(`Audio upload failed: ${uploadData.message ?? uploadRes.status}`);

    const audioAssetId = uploadData.data.id as string;
    console.log("[generate-with-bg] audioAssetId:", audioAssetId);
    voiceInput = { type: "audio", audio_asset_id: audioAssetId };
  } else {
    voiceInput = { type: "text", input_text: text, voice_id: voiceId, speed: 1.0 };
  }

  // Step 3: Generate
  const payload: Record<string, unknown> = {
    video_inputs: [{
      character: {
        type: "avatar",
        avatar_id: avatarId,
        avatar_style: "normal",
        offset: { x: offsetX, y: offsetY },
        scale,
        matting: true,
      },
      voice: voiceInput,
      ...(background ? { background } : {}),
    }],
    dimension: { width: 720, height: 1280 },
  };

  console.log("[generate-with-bg] generate payload:", JSON.stringify(payload));
  const genRes = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const genData = await genRes.json();
  console.log("[generate-with-bg] generate response:", genRes.status, JSON.stringify(genData));

  if (!genRes.ok || !genData.data?.video_id) {
    return NextResponse.json(
      { error: `HeyGen generate failed: ${JSON.stringify(genData.error ?? genData)}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ videoId: genData.data.video_id, bgAssetId });
}

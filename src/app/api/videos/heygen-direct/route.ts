import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { HEYGEN_GEN_FRAMING, AVATAR_GEN_DIMENSION, AVATAR_GEN_FALLBACK_DIMENSION, isResolutionFallbackError } from "@/lib/avatar-gen-framing";
import { decryptKey } from "@/lib/key-crypto";

export const maxDuration = 300;
export const runtime = "nodejs";

/* ── helpers ─────────────────────────────────────────────── */

// Containment guard: resolve a body-supplied app path under public/ and reject anything
// that escapes the webroot (path traversal, e.g. "/../prisma/dev.db"). Returns null on
// escape so callers surface the route's normal 404 without leaking the resolved path.
function containedPublicPath(url: string): string | null {
  const joined = path.join(process.cwd(), "public", url.replace(/^\/api\/renders\//, "/renders/"));
  const publicDir = path.resolve(process.cwd(), "public");
  const resolvedPath = path.resolve(joined);
  if (resolvedPath !== publicDir && !resolvedPath.startsWith(publicDir + path.sep)) return null;
  return joined;
}

function readLocalFile(url: string): Buffer | null {
  if (!url.startsWith("/")) return null;
  const fp = containedPublicPath(url);
  if (!fp || !fs.existsSync(fp)) return null;
  return fs.readFileSync(fp);
}

function localPath(url: string): string | null {
  return containedPublicPath(url);
}

function getFfmpegPath(): string {
  const platform = process.platform;   // win32 | linux | darwin
  const arch = process.arch;           // x64 | arm64
  const ext = platform === "win32" ? ".exe" : "";
  return path.join(
    process.cwd(), "node_modules", "@ffmpeg-installer",
    `${platform}-${arch}`, `ffmpeg${ext}`,
  );
}

/* ── HeyGen asset upload ─────────────────────────────────── */

async function uploadAsset(
  buffer: Buffer, contentType: string, heygenKey: string,
): Promise<{ id: string; url: string | null }> {
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": contentType, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  });
  const data = await res.json();
  console.log(`[heygen] upload ${contentType} status=${res.status}`, JSON.stringify(data));
  if (!res.ok || !data.data?.id) {
    throw new Error(`Asset upload failed (${contentType}): ${data.message ?? data.error ?? res.status}`);
  }
  return { id: data.data.id as string, url: (data.data?.url as string) ?? null };
}

/* ── HeyGen video generate ───────────────────────────────── */

interface GenerateOpts {
  audioAssetId: string;
  avatarId: string;
  heygenKey: string;
  /** If provided → BG video mode; null → green-screen mode */
  videoAssetUrl?: string | null;
}

async function generateVideo(opts: GenerateOpts): Promise<string> {
  const { audioAssetId, avatarId, heygenKey, videoAssetUrl } = opts;

  const background = videoAssetUrl
    ? { type: "video", url: videoAssetUrl, fit: "cover", play_style: "loop" }
    : { type: "color", value: "#00FF00" };

  const buildBody = (dimension: { width: number; height: number }) => ({
    video_inputs: [{
      character: {
        type: "avatar",
        avatar_id: avatarId,
        avatar_style: "normal",
        offset: { x: HEYGEN_GEN_FRAMING.offsetX, y: HEYGEN_GEN_FRAMING.offsetY },
        scale: HEYGEN_GEN_FRAMING.scale,
        matting: true,
      },
      voice: { type: "audio", audio_asset_id: audioAssetId },
      background,
    }],
    dimension,
  });

  const callGenerate = async (dimension: { width: number; height: number }) => {
    const body = buildBody(dimension);
    console.log("[heygen] generate payload:", JSON.stringify(body));
    const res = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log("[heygen] generate response:", res.status, JSON.stringify(data));
    return { res, data };
  };

  let { res, data } = await callGenerate(AVATAR_GEN_DIMENSION);

  // One-shot fallback: some accounts/plans reject 1080 — retry once at 720×1280.
  if (!res.ok && isResolutionFallbackError(JSON.stringify(data?.error ?? data))) {
    console.warn("[heygen] 1080 generate rejected (resolution/plan) — retrying once at 720x1280 fallback");
    ({ res, data } = await callGenerate(AVATAR_GEN_FALLBACK_DIMENSION));
  }

  if (!res.ok || !data.data?.video_id) {
    throw new Error(`HeyGen generate failed (${res.status}): ${JSON.stringify(data.error ?? data)}`);
  }
  return data.data.video_id as string;
}

/* ── Poll for completion ─────────────────────────────────── */

async function pollVideo(videoId: string, heygenKey: string, maxMs = 240_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { "X-Api-Key": heygenKey } },
    );
    const d = await res.json();
    const status = d.data?.status as string | undefined;
    console.log(`[heygen] poll ${videoId} → ${status}`);
    if (status === "completed" && d.data?.video_url) return d.data.video_url as string;
    if (status === "failed") throw new Error(`HeyGen failed: ${d.data?.error ?? "unknown"}`);
  }
  throw new Error("HeyGen timed out (4 min)");
}

/* ── Download remote file ────────────────────────────────── */

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/* ── ffmpeg chromakey composite (child_process — no webpack issues) ── */

function chromakeyComposite(bgPath: string, avatarPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    if (!fs.existsSync(ffmpeg)) {
      return reject(new Error(`ffmpeg not found: ${ffmpeg}`));
    }
    const filter = [
      "[0:v][1:v]scale2ref[bg][av]",
      "[av]chromakey=0x00FF00:0.15:0.1[ck]",
      "[bg][ck]overlay=0:0[out]",
    ].join(";");

    const args = [
      "-y",
      "-i", bgPath,
      "-i", avatarPath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-map", "1:a?",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-movflags", "+faststart",
      outPath,
    ];

    console.log("[ffmpeg] running:", ffmpeg, args.join(" "));
    execFile(ffmpeg, args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (stderr) console.log("[ffmpeg] stderr:", stderr.slice(-500));
      if (err) reject(new Error(`ffmpeg failed: ${err.message}`));
      else resolve();
    });
  });
}

/* ── POST /api/videos/heygen-direct ──────────────────────── */
// Body: { mergedAudioUrl, bgVideoUrl, avatarId, mode? }
// mode "direct"    → upload BG to HeyGen, HeyGen renders everything
// mode "composite" → HeyGen renders on green bg → ffmpeg chromakey onto BG

export async function POST(req: Request) {
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  let avatarTempPath = "";

  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { mergedAudioUrl, bgVideoUrl, avatarId, mode = "direct" } = body ?? {};

    if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
    if (!mergedAudioUrl) return NextResponse.json({ error: "mergedAudioUrl required" }, { status: 400 });
    if (!bgVideoUrl) return NextResponse.json({ error: "bgVideoUrl required" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
    if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
    const heygenKey = decryptKey(user.heygenKey);

    const audioBuffer = readLocalFile(mergedAudioUrl);
    if (!audioBuffer) return NextResponse.json({ error: `Audio not found: ${mergedAudioUrl}` }, { status: 404 });

    console.log(`[heygen] mode=${mode}, audio=${audioBuffer.length}B`);

    // 1. Upload audio → HeyGen asset
    const audioResult = await uploadAsset(audioBuffer, "audio/mpeg", heygenKey);
    console.log(`[heygen] audioAssetId=${audioResult.id}`);

    if (mode === "composite") {
      /* ── Composite: green-screen → return videoId immediately, client polls then calls /api/heygen/composite ── */
      const bgPath = localPath(bgVideoUrl);
      if (!bgPath || !fs.existsSync(bgPath)) return NextResponse.json({ error: `BG not found: ${bgVideoUrl}` }, { status: 404 });
      const videoId = await generateVideo({ audioAssetId: audioResult.id, avatarId, heygenKey });
      console.log(`[heygen] composite videoId=${videoId} — client will poll`);
      return NextResponse.json({ videoId, bgVideoUrl, mode: "composite", status: "pending" });

    } else {
      /* ── Direct: upload BG → return videoId immediately, client polls ── */
      const videoBuffer = readLocalFile(bgVideoUrl);
      if (!videoBuffer) return NextResponse.json({ error: `BG not found: ${bgVideoUrl}` }, { status: 404 });

      const videoResult = await uploadAsset(videoBuffer, "video/mp4", heygenKey);
      if (!videoResult.url) return NextResponse.json({ error: "BG asset URL not returned" }, { status: 500 });
      console.log(`[heygen] videoAssetUrl=${videoResult.url}`);

      const videoId = await generateVideo({ audioAssetId: audioResult.id, avatarId, heygenKey, videoAssetUrl: videoResult.url });
      console.log(`[heygen] direct videoId=${videoId} — client will poll`);
      return NextResponse.json({ videoId, mode: "direct", status: "pending" });
    }

  } catch (error) {
    console.error("[heygen] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "HeyGen failed" },
      { status: 500 },
    );
  } finally {
    if (avatarTempPath && fs.existsSync(avatarTempPath)) fs.unlinkSync(avatarTempPath);
  }
}

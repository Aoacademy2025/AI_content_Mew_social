import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";
import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";
import { decryptKey } from "@/lib/key-crypto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFfmpeg(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require(/* webpackIgnore: true */ "fluent-ffmpeg");
  if (process.platform !== "win32") {
    ffmpeg.setFfmpegPath("ffmpeg");
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const installer = require(/* webpackIgnore: true */ "@ffmpeg-installer/ffmpeg");
    ffmpeg.setFfmpegPath(installer.path);
  }
  return ffmpeg;
}

export const maxDuration = 300;
export const runtime = "nodejs";


interface SceneInput {
  scene: number;
  text: string;
  imageUrl?: string | null;
  audioUrl?: string | null;
}

// Containment guard: resolve a body-supplied app path under public/ and reject anything
// that escapes the webroot (path traversal). Returns null on escape.
function containedPublicPath(url: string): string | null {
  const joined = path.join(process.cwd(), "public", url.replace(/^\/api\/renders\//, "/renders/"));
  const publicDir = path.resolve(process.cwd(), "public");
  const resolvedPath = path.resolve(joined);
  if (resolvedPath !== publicDir && !resolvedPath.startsWith(publicDir + path.sep)) return null;
  return joined;
}

// SSRF-safe fetch of a user-supplied external URL: validates the host, then follows
// redirects MANUALLY, re-validating each hop, so a safe initial URL can't 302 into a
// private/internal target. Bounded to `maxHops`.
async function safeFetchFollow(url: string, init: RequestInit = {}, maxHops = 3): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertSafeFetchUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function readAsset(url: string, origin: string): Promise<Buffer | null> {
  if (url.startsWith("/")) {
    const filePath = containedPublicPath(url);
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }
  try {
    // Only the external http(s) case is user-controlled → SSRF guard + manual redirect
    // re-validation. The `${origin}${url}` case is a same-origin fetch of our own server
    // (origin from req.url, which may be loopback) → fetch it directly, unguarded.
    const res = url.startsWith("http")
      ? await safeFetchFollow(url)
      : await fetch(`${origin}${url}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function uploadAsset(
  url: string,
  contentType: string,
  heygenKey: string,
  origin: string
): Promise<{ id: string | null; assetUrl: string | null }> {
  try {
    const buffer = await readAsset(url, origin);
    if (!buffer) return { id: null, assetUrl: null };
    console.log(`[uploadAsset] url=${url} contentType=${contentType} bufferSize=${buffer.length}`);
    const uploadRes = await fetch("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-API-KEY": heygenKey, "Content-Type": contentType, Accept: "application/json" },
      body: buffer as unknown as BodyInit,
    });
    const data = await uploadRes.json();
    console.log(`[uploadAsset] response status=${uploadRes.status}`, JSON.stringify(data));
    if (!uploadRes.ok) {
      console.error("HeyGen asset upload failed:", JSON.stringify(data));
      return { id: null, assetUrl: null };
    }
    return { id: data.data?.id ?? null, assetUrl: data.data?.url ?? null };
  } catch (e) {
    console.error("uploadAsset error:", e);
    return { id: null, assetUrl: null };
  }
}

// Re-encode video to HeyGen-compatible H.264 baseline format
function reencodeVideo(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    getFfmpeg()(inputPath)
      .outputOptions([
        "-c:v libx264",
        "-profile:v baseline",
        "-level 3.1",
        "-pix_fmt yuv420p",
        "-an",          // no audio (BG video audio not needed)
        "-movflags +faststart",
        "-y",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

// convenience wrappers — return full { id, assetUrl }
const uploadAudioAsset = (url: string, key: string, origin: string) => uploadAsset(url, "audio/mpeg", key, origin);

// POST /api/videos/create-avatar
// Body: { scenes: SceneInput[], avatarId: string }
// Returns: { videoId: string }
export async function POST(req: Request) {
  try {
    // 1. Auth
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Parse body
    const body = await req.json().catch(() => null);
    const scenes: SceneInput[] = body?.scenes ?? [];
    const avatarId: string = body?.avatarId ?? "";
    const bgVideoUrl: string | null = body?.bgVideoUrl ?? null;
    const mergedAudioUrl: string | null = body?.mergedAudioUrl ?? null;

    if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
    if (!scenes.length) return NextResponse.json({ error: "scenes required" }, { status: 400 });

    // 3. Get HeyGen key from DB
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { heygenKey: true },
    });

    if (!user?.heygenKey) {
      return NextResponse.json({ error: "HeyGen API key ยังไม่ได้ตั้งค่า — ตั้งค่าใน Settings > API Keys", missingKey: "heygen" }, { status: 400 });
    }

    const heygenKey = decryptKey(user.heygenKey);
    const origin = new URL(req.url).origin;

    let video_inputs: object[];

    if (bgVideoUrl) {
      // 4a. BG-video mode: re-encode BG video → upload bg + merged audio → single HeyGen scene
      let reencodedPath = "";

      // Re-encode BG video to H.264 baseline for HeyGen compatibility
      const srcPath = bgVideoUrl.startsWith("/") ? containedPublicPath(bgVideoUrl) : null;
      if (srcPath) {
        reencodedPath = srcPath.replace(/\.mp4$/, `-reenc.mp4`);
        try {
          console.log("[create-avatar] re-encoding BG video for HeyGen compatibility...");
          await reencodeVideo(srcPath, reencodedPath);
          console.log("[create-avatar] re-encode done:", reencodedPath);
        } catch (e) {
          console.warn("[create-avatar] re-encode failed, using original:", e);
          reencodedPath = "";
        }
      }

      // Upload BG video (read re-encoded file directly if available)
      async function uploadBgBuffer(): Promise<{ id: string | null; assetUrl: string | null }> {
        try {
          const buffer = reencodedPath && fs.existsSync(reencodedPath)
            ? fs.readFileSync(reencodedPath)
            : await readAsset(bgVideoUrl!, origin);
          if (!buffer) return { id: null, assetUrl: null };
          const uploadRes = await fetch("https://upload.heygen.com/v1/asset", {
            method: "POST",
            headers: { "X-API-KEY": heygenKey, "Content-Type": "video/mp4", Accept: "application/json" },
            body: buffer as unknown as BodyInit,
          });
          const data = await uploadRes.json();
          console.log("[uploadBgBuffer] status:", uploadRes.status, JSON.stringify(data));
          return { id: data.data?.id ?? null, assetUrl: data.data?.url ?? null };
        } catch (e) {
          console.error("uploadBgBuffer error:", e);
          return { id: null, assetUrl: null };
        }
      }

      const [bgResult, audioResult] = await Promise.all([
        uploadBgBuffer(),
        mergedAudioUrl ? uploadAudioAsset(mergedAudioUrl, heygenKey, origin) : Promise.resolve(null),
      ]);

      // Clean up re-encoded temp file
      if (reencodedPath && fs.existsSync(reencodedPath)) fs.unlinkSync(reencodedPath);

      const bgVideoAssetUrl = bgResult?.assetUrl ?? null;
      const audioAssetId = audioResult?.id ?? null;

      if (!bgVideoAssetUrl) {
        return NextResponse.json({ error: "Background video upload to HeyGen failed" }, { status: 500 });
      }

      console.log("[create-avatar] bgVideoAssetUrl:", bgVideoAssetUrl);
      console.log("[create-avatar] audioAssetId:", audioAssetId);

      video_inputs = [{
        character: {
          type: "avatar",
          avatar_id: avatarId,
          avatar_style: "normal",
          scale: HEYGEN_GEN_FRAMING.scale,
          offset: { x: HEYGEN_GEN_FRAMING.offsetX, y: HEYGEN_GEN_FRAMING.offsetY },
          matting: true,
        },
        voice: audioAssetId
          ? { type: "audio", audio_asset_id: audioAssetId }
          : { type: "silence" },
        // Follow n8n flow exactly: video background with fit:cover + play_style:loop
        background: { type: "video", url: bgVideoAssetUrl, fit: "cover", play_style: "loop" },
      }];
    } else {
      // 4b. Per-scene mode: upload each scene audio in parallel
      const audioAssetMap: Record<number, string> = {};
      await Promise.all(
        scenes
          .filter(s => s.audioUrl)
          .map(async (s) => {
            const result = await uploadAudioAsset(s.audioUrl!, heygenKey, origin);
            if (result?.id) audioAssetMap[s.scene] = result.id;
            else console.warn(`Scene ${s.scene}: audio upload failed — will skip voice`);
          })
      );

      // 5. Build HeyGen video_inputs — skip voice entirely if no asset
      video_inputs = scenes.map((s) => {
        const assetId: string | undefined = audioAssetMap[s.scene];
        return {
          character: {
            type: "avatar",
            avatar_id: avatarId,
            avatar_style: "normal",
            scale: HEYGEN_GEN_FRAMING.scale,
            offset: { x: HEYGEN_GEN_FRAMING.offsetX, y: HEYGEN_GEN_FRAMING.offsetY },
            matting: true,
          },
          voice: assetId
            ? { type: "audio", audio_asset_id: assetId }
            : { type: "silence" },
          background: s.imageUrl
            ? { type: "image", url: s.imageUrl }
            : { type: "color", value: "#1a1a2e" },
        };
      });
    }

    // 6. Submit to HeyGen
    const requestBody = { video_inputs, dimension: { width: 1080, height: 1920 }, caption: false };
    console.log("[create-avatar] full body:", JSON.stringify(requestBody, null, 2));
    const res = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: {
        "X-Api-Key": heygenKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const data = await res.json();

    if (!res.ok || !data.data?.video_id) {
      console.error("HeyGen create error:", JSON.stringify(data));
      const errMsg = data.message ?? data.error ?? data.data?.error ?? `HeyGen ${res.status}`;
      return NextResponse.json({ error: errMsg, detail: data }, { status: res.status || 500 });
    }

    return NextResponse.json({ videoId: data.data.video_id });
  } catch (error) {
    console.error("create-avatar error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Avatar creation failed" },
      { status: 500 }
    );
  }
}

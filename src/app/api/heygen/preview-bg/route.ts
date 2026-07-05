import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { resolveChromaParams, detectChromaColor, buildKeyChain } from "@/lib/chroma-key";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const runtime = "nodejs";
export const maxDuration = 300;

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}

// 30 min bound — see composite/route.ts FFMPEG_TIMEOUT_MS.
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 50 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg: ${err.message}\n${stderr?.slice(-500)}`));
      else resolve(stderr ?? "");
    });
  });
}

// POST /api/heygen/preview-bg
// Body: { avatarVideoUrl: string }
// Returns: { previewUrl: string } — a transparent webm video served via /api/stocks/
export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { avatarVideoUrl, chromaColor, chromaSimilarity, chromaBlend } = await req.json().catch(() => ({}));
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
    inputPath = path.join(process.cwd(), "public", avatarVideoUrl.replace(/^\/api\/renders\//, "/renders/"));
    if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
  } else if (avatarVideoUrl.startsWith("/")) {
    inputPath = path.join(process.cwd(), "public", avatarVideoUrl.replace(/^\/api\/renders\//, "/renders/"));
    if (!fs.existsSync(inputPath)) return NextResponse.json({ error: "File not found" }, { status: 400 });
  } else {
    inputPath = path.join(stocksDir, `tmp-avatar-${ts}.mp4`);
    const res = await fetch(avatarVideoUrl, { headers: { Accept: "video/mp4,video/*,*/*" } });
    if (!res.ok) return NextResponse.json({ error: `Download failed: ${res.status}` }, { status: 400 });
    fs.writeFileSync(inputPath, Buffer.from(await res.arrayBuffer()));
    needsCleanup = true;
  }

  try {
    // Same detection + key chain as the render composite (lib/chroma-key) so this transparent
    // preview asset matches the final output. Auto-detects the real green shade (the old hardcoded
    // 0x00FF00/0x00b140 passes catastrophically over-keyed 0x12FF05 HeyGen greens). Keys at full
    // chroma (yuva444p) with an alpha feather, then encodes to a VP9 alpha webm.
    const resolved = resolveChromaParams({ chromaColor, chromaSimilarity, chromaBlend });
    const keyColor = resolved.autoDetect ? await detectChromaColor(inputPath, ffmpeg) : resolved.color;
    const keyChain = buildKeyChain({ color: keyColor, similarity: resolved.similarity, blend: resolved.blend });
    console.log(`[preview-bg] chromakey removing green (color=${keyColor}) from entire video...`);
    await runFfmpeg(ffmpeg, [
      "-y",
      "-i", inputPath,
      "-vf", keyChain,
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

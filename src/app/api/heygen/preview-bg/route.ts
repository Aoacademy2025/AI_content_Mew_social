import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { resolveChromaParams, detectChromaColor, buildKeyChain, featherSupported } from "@/lib/chroma-key";
import { resolveMaxSec, resolveHalfRes, previewBgOutputName, buildPreviewBgFfmpegArgs, ensureEncodedOnce } from "@/lib/preview-bg-params";
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
// Body: { avatarVideoUrl: string, maxSec?: number, halfRes?: boolean }
// Returns: { previewUrl: string } — a transparent webm video served via /api/stocks/
//
// `maxSec` (clamped 1-10) and `halfRes` (scale output to 540px wide) are optional fast-preview
// knobs for the live avatar-adjust overlay — omitted, they preserve today's full-clip behavior
// for any other caller. The output filename is a deterministic hash of the inputs (see
// lib/preview-bg-params) instead of Date.now(), so re-opening the adjust panel with the same
// avatar hits the cache on disk and skips re-keying entirely.
export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { avatarVideoUrl, chromaColor, chromaSimilarity, chromaBlend, maxSec: rawMaxSec, halfRes: rawHalfRes } = await req.json().catch(() => ({}));
  if (!avatarVideoUrl) return NextResponse.json({ error: "avatarVideoUrl required" }, { status: 400 });

  const maxSec = resolveMaxSec(rawMaxSec);
  const halfRes = resolveHalfRes(rawHalfRes);

  const ffmpeg = getFfmpegPath();
  if (!fs.existsSync(ffmpeg)) return NextResponse.json({ error: "ffmpeg not found" }, { status: 500 });

  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });

  const outFile = previewBgOutputName(avatarVideoUrl, maxSec, halfRes);
  const outPath = path.join(stocksDir, outFile);

  // Cache hit — same avatar + same fast-preview params already keyed. Re-opening the adjust
  // panel must not re-run ffmpeg, so return immediately without touching the input at all.
  if (fs.existsSync(outPath)) {
    return NextResponse.json({ previewUrl: `/api/stocks/${outFile}` });
  }

  const ts = Date.now();

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
    // ensureEncodedOnce (lib/preview-bg-params) gives us both: (1) an atomic write — `encode`
    // below writes to a temp path in the same dir, renamed onto `outPath` only on success, so a
    // crash/interleave can never leave a truncated file at the cache path readers hit; and (2) an
    // in-process lock keyed by `outPath` — if a concurrent request (StrictMode double-effect,
    // quick reopen, two tabs) is already encoding this exact key, we just await that single
    // in-flight encode instead of racing ffmpeg onto the same destination.
    await ensureEncodedOnce(outPath, async (tmpPath) => {
      // Same detection + key chain as the render composite (lib/chroma-key) so this transparent
      // preview asset matches the final output. Auto-detects the real green shade (the old
      // hardcoded 0x00FF00/0x00b140 passes catastrophically over-keyed 0x12FF05 HeyGen greens).
      // Keys at full chroma (yuva444p) with an alpha feather, then encodes to a VP9 alpha webm.
      const resolved = resolveChromaParams({ chromaColor, chromaSimilarity, chromaBlend });
      const keyColor = resolved.autoDetect ? await detectChromaColor(inputPath, ffmpeg) : resolved.color;
      // Not every ffmpeg build ships erosion/gblur (dev=darwin-arm64, prod=linux-x64 peer build) —
      // the keying path isn't fail-open, so resolve BEFORE building the filter. Cached per-process.
      const feather = await featherSupported(ffmpeg);
      const keyChain = buildKeyChain({ color: keyColor, similarity: resolved.similarity, blend: resolved.blend }, feather);
      console.log(`[preview-bg] chromakey removing green (color=${keyColor}) from entire video...`);
      await runFfmpeg(ffmpeg, buildPreviewBgFfmpegArgs({ keyChain, maxSec, halfRes, inputPath, outPath: tmpPath }));
    });

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

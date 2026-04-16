import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const maxDuration = 600;
export const runtime = "nodejs";

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}

async function downloadFile(url: string, dest: string, heygenKey?: string): Promise<void> {
  if (url.startsWith("/api/stocks/")) {
    const filename = url.replace("/api/stocks/", "");
    const src = path.join(process.cwd(), "stocks", filename);
    if (!fs.existsSync(src)) throw new Error(`Local file not found: ${url}`);
    fs.copyFileSync(src, dest);
    return;
  }
  if (url.startsWith("/")) {
    const src = path.join(process.cwd(), "public", url);
    if (!fs.existsSync(src)) throw new Error(`Local file not found: ${url}`);
    fs.copyFileSync(src, dest);
    return;
  }
  const headers: Record<string, string> = { "Accept": "video/mp4,video/*,*/*" };
  if (heygenKey && url.includes("heygen.ai")) headers["X-Api-Key"] = heygenKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 100 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("[ffmpeg stderr]", stderr?.slice(-2000));
        reject(new Error(`ffmpeg failed:\n${stderr?.slice(-1000)}`));
      } else resolve(stderr ?? "");
    });
  });
}

// ─────────────────────────────────────────────
// Mode: direct
// Input: transparent webm (already bg-removed) + bg mp4
// Avatar fills full bg, centered
// ─────────────────────────────────────────────
async function directComposite(bgPath: string, avatarPath: string, outPath: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const filter = [
    `[1:v][0:v]scale2ref=iw:ih[fg_s][bg]`,
    `[fg_s]format=yuva444p[fg]`,
    `[bg][fg]overlay=0.5*W-w/2:0.5*H-h/2:format=auto[out]`,
  ].join(";");

  console.log("[direct-composite] filter:", filter);
  await runFfmpeg(ffmpeg, [
    "-y", "-i", bgPath, "-i", avatarPath,
    "-filter_complex", filter,
    "-map", "[out]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ]);
  console.log("[direct-composite] done");
}

// ─────────────────────────────────────────────
// Mode: chromakey — pure FFmpeg pipeline
// chromakey → despill → erosion → gblur → overlay on BG
// similarity/blend can be tuned per avatar (defaults: 0.28 / 0.04)
// ─────────────────────────────────────────────
async function chromakeyComposite(
  bgPath: string,
  avatarPath: string,
  outPath: string,
  similarity = 0.28,
  blend = 0.04,
  chromaColor = "0x12FF05",
): Promise<void> {
  const ffmpeg = getFfmpegPath();

  // Chroma key filter chain — no erosion/blur to preserve face detail
  const chromaFilter = [
    `chromakey=color=${chromaColor}:similarity=${similarity}:blend=${blend}`,
    `despill=type=green:mix=0.5:expand=0`,
  ].join(",");

  let filterComplex: string;

  // Always: remove green then scale avatar to match bg exactly, overlay full cover
  console.log(`[chromakey] scale to bg size, overlay full`);
  filterComplex = [
    `[0:v]setsar=1[bg]`,
    `[1:v]${chromaFilter}[fg_key]`,
    `[fg_key][bg]scale2ref=iw:ih[fg][bg2]`,
    `[bg2][fg]overlay=0:0:format=auto[out]`,
  ].join(";");

  // Count avatar frames to estimate time
  const { execFileSync } = require("child_process");
  let frameCount = "?";
  try {
    const probe = execFileSync(ffprobe, [
      "-v", "quiet", "-print_format", "json", "-show_streams", avatarPath,
    ]).toString();
    const info = JSON.parse(probe);
    const vs = info.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
    if (vs?.nb_frames) frameCount = vs.nb_frames;
    else if (vs?.duration && vs?.r_frame_rate) {
      const [n, d] = vs.r_frame_rate.split("/").map(Number);
      frameCount = String(Math.round(parseFloat(vs.duration) * (n / d)));
    }
  } catch {}

  console.log(`[chromakey-ffmpeg] similarity=${similarity} blend=${blend} frames=${frameCount}`);

  // Use -threads 0 (auto) + ultrafast preset for max speed
  // Quality is good enough for social media at crf 20
  await runFfmpeg(ffmpeg, [
    "-y",
    "-i", bgPath,
    "-i", avatarPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", "0:a?",          // audio from bg video (TTS + BGM, full duration)
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
    "-threads", "0",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ]);

  console.log("[chromakey-ffmpeg] done");
}

// ─────────────────────────────────────────────
// Mode: rembg — AI background removal via rembg batch CLI
// Extract frames → rembg batch process → FFmpeg composite
// Requires: pip install rembg onnxruntime
// NOTE: ~30-60s for a 10s clip (much faster than frame-by-frame)
// ─────────────────────────────────────────────
async function rembgComposite(bgPath: string, avatarPath: string, outPath: string, model = "u2net"): Promise<void> {
  const scriptPath = path.join(process.cwd(), "scripts", "composite_rembg.py");
  console.log(`[rembg-composite] model=${model}`);

  // Probe avatar duration to estimate timeout (min 120s, +10s per second of video)
  let timeoutMs = 300_000; // 5 min default
  try {
    const { execFileSync } = require("child_process");
    const probe = execFileSync(getFfmpegPath(), ["-i", avatarPath], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }).toString();
    const m = probe.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) {
      const dur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      timeoutMs = Math.max(120_000, Math.ceil(dur) * 15_000); // 15s per second of video
      console.log(`[rembg] avatar duration=${dur.toFixed(1)}s timeout=${timeoutMs/1000}s`);
    }
  } catch {}

  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const py = spawn("python", [scriptPath, avatarPath, bgPath, outPath, model], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    py.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    py.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); process.stderr.write(d); });

    // Kill if exceeds timeout
    const timer = setTimeout(() => {
      py.kill("SIGTERM");
      reject(new Error(`rembg timeout after ${timeoutMs/1000}s — try a shorter clip or use Green Screen mode`));
    }, timeoutMs);

    py.on("close", (code: number) => {
      clearTimeout(timer);
      if (code === 0) { console.log("[rembg-composite] done"); resolve(); }
      else reject(new Error(`rembg composite failed (code ${code}):\n${stderr.slice(-800)}`));
    });
    py.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`rembg spawn error: ${e.message} — run: pip install rembg onnxruntime`));
    });
  });
}

// ─────────────────────────────────────────────
// Bookend: show avatar first N seconds only
// ─────────────────────────────────────────────
function probeDuration(ffmpegPath: string, filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-i", filePath], { maxBuffer: 1024 * 1024 }, (_err, _stdout, stderr) => {
      const match = stderr?.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (match) resolve(parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]));
      else reject(new Error("Could not probe duration"));
    });
  });
}

async function applyBookend(ffmpegPath: string, compositePath: string, bgPath: string, outPath: string, introSecs: number): Promise<void> {
  const totalDur = await probeDuration(ffmpegPath, bgPath);
  const N = Math.min(introSecs, totalDur);
  if (N >= totalDur) { fs.copyFileSync(compositePath, outPath); return; }

  console.log(`[bookend] total=${totalDur.toFixed(2)}s intro=0-${N}s`);
  const filter = [
    `[0:v]trim=start=0:duration=${N},setpts=PTS-STARTPTS[v1]`,
    `[1:v]trim=start=${N},setpts=PTS-STARTPTS[v2]`,
    `[v1][v2]concat=n=2:v=1[outv]`,
  ].join(";");

  await runFfmpeg(ffmpegPath, [
    "-y", "-i", compositePath, "-i", bgPath,
    "-filter_complex", filter,
    "-map", "[outv]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ]);
}

// ─────────────────────────────────────────────
// POST /api/heygen/composite
// Body: { avatarVideoUrl, bgVideoUrl, mode: "direct"|"chromakey", avatarTiming?, avatarBookendSecs? }
// ─────────────────────────────────────────────
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    avatarVideoUrl, bgVideoUrl,
    mode = "chromakey",
    avatarTiming = "full",
    avatarBookendSecs = 5,
    chromaSimilarity = 0.28,
    chromaBlend = 0.04,
    chromaColor = "0x12FF05",
    rembgModel = "u2net",
  } = body ?? {};

  if (!avatarVideoUrl) return NextResponse.json({ error: "avatarVideoUrl required" }, { status: 400 });
  if (!bgVideoUrl) return NextResponse.json({ error: "bgVideoUrl required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { heygenKey: true } });
  const heygenKey = user?.heygenKey ? Buffer.from(user.heygenKey, "base64").toString("utf-8") : undefined;

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const ts = Date.now();
  const avatarExt = avatarVideoUrl.includes(".webm") ? ".webm" : ".mp4";
  const avatarTmp = path.join(rendersDir, `avatar-tmp-${ts}${avatarExt}`);
  const bgTmp = path.join(rendersDir, `bg-tmp-${ts}.mp4`);
  const outFile = `composite-${ts}.mp4`;
  const outPath = path.join(rendersDir, outFile);

  try {
    console.log(`[composite] mode=${mode}`);

    await downloadFile(avatarVideoUrl, avatarTmp, heygenKey);
    const avatarSize = fs.statSync(avatarTmp).size;
    console.log("[composite] avatar:", avatarSize, "bytes");
    if (avatarSize < 1000) throw new Error(`Avatar too small: ${avatarSize} bytes`);

    await downloadFile(bgVideoUrl, bgTmp, heygenKey);
    const bgSize = fs.statSync(bgTmp).size;
    console.log("[composite] bg:", bgSize, "bytes");
    if (bgSize < 1000) throw new Error(`BG too small: ${bgSize} bytes`);

    if (mode === "direct") {
      await directComposite(bgTmp, avatarTmp, outPath);
    } else if (mode === "rembg") {
      await rembgComposite(bgTmp, avatarTmp, outPath, rembgModel);
    } else {
      await chromakeyComposite(bgTmp, avatarTmp, outPath, chromaSimilarity, chromaBlend, chromaColor);
    }

    const outSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    if (outSize < 1000) throw new Error(`Output too small: ${outSize} bytes`);

    let finalFile = outFile;
    let finalPath = outPath;
    if (avatarTiming === "bookend" && avatarBookendSecs > 0) {
      const ffmpeg = getFfmpegPath();
      const bookendFile = `composite-${ts}-bookend.mp4`;
      const bookendPath = path.join(rendersDir, bookendFile);
      await applyBookend(ffmpeg, outPath, bgTmp, bookendPath, avatarBookendSecs);
      try { fs.unlinkSync(outPath); } catch {}
      finalFile = bookendFile;
      finalPath = bookendPath;
    }

    console.log("[composite] output:", finalFile, fs.statSync(finalPath).size, "bytes");
    return NextResponse.json({ videoUrl: `/renders/${finalFile}`, usedMode: mode });
  } catch (error) {
    console.error("[composite] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Composite failed" }, { status: 500 });
  } finally {
    try { if (fs.existsSync(avatarTmp)) fs.unlinkSync(avatarTmp); } catch {}
    try { if (fs.existsSync(bgTmp)) fs.unlinkSync(bgTmp); } catch {}
  }
}

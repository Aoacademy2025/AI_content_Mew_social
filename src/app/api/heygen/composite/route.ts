import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const maxDuration = 3600;
export const runtime = "nodejs";

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}

function getFfprobePath(): string {
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
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
    const src = path.join(process.cwd(), "public", url.replace(/^\/api\/renders\//, "/renders/"));
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
    `[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]`,
    `[1:v]${chromaFilter}[fg_key]`,
    `[fg_key][bg]scale2ref=iw:ih[fg][bg2]`,
    `[bg2][fg]overlay=0:0:format=auto[out]`,
  ].join(";");

  // Count avatar frames to estimate time
  const { execFileSync } = require("child_process");
  const ffprobe = getFfprobePath();
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
    "-map", "0:a?",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
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

async function applyBookendBoth(
  ffmpegPath: string,
  compositePath: string,
  bgPath: string,
  outPath: string,
  introSecs: number,
  tailSecs: number,
): Promise<void> {
  const totalDur = await probeDuration(ffmpegPath, bgPath);
  const N = Math.min(introSecs, totalDur);
  const T = Math.min(tailSecs, Math.max(0, totalDur - N));
  const midStart = N;
  const midEnd = Math.max(midStart, totalDur - T);

  if (midEnd <= midStart) {
    // No middle segment — just use full composite
    fs.copyFileSync(compositePath, outPath);
    return;
  }

  // composite video has been rendered from trimmed audio = intro[0..N] + tail[T secs]
  // so composite total duration = N + T
  // We need: composite[0..N] + bg[midStart..midEnd] + composite[N..N+T]
  // Must split [0:v] before trimming (can't reuse filter input label)
  console.log(`[bookend-both] total=${totalDur.toFixed(2)}s intro=0-${N}s mid=${midStart}-${midEnd}s tail=${N}-${N+T}s (from composite)`);

  const filter = [
    `[0:v]split=2[cA][cB]`,
    `[cA]trim=start=0:duration=${N},setpts=PTS-STARTPTS[vIntro]`,
    `[1:v]trim=start=${midStart}:end=${midEnd},setpts=PTS-STARTPTS[vMid]`,
    `[cB]trim=start=${N}:end=${N + T},setpts=PTS-STARTPTS[vTail]`,
    `[vIntro][vMid][vTail]concat=n=3:v=1[outv]`,
  ].join(";");

  await runFfmpeg(ffmpegPath, [
    "-y", "-i", compositePath, "-i", bgPath,
    "-filter_complex", filter,
    "-map", "[outv]", "-map", "1:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ]);
}

// ─────────────────────────────────────────────
// bookend-both SPLIT: intro avatar + tail avatar generated separately
// Correct flow:
//   1. Slice bg into 3 segments: bg[0..N], bg[N..bgDur-T], bg[bgDur-T..bgDur]
//   2. Composite intro avatar onto bg[0..N]
//   3. Composite tail avatar onto bg[bgDur-T..bgDur]
//   4. Stitch: introComp + bgMid + tailComp, audio from full bg
// ─────────────────────────────────────────────
async function applyBookendBothSplit(
  ffmpegPath: string,
  introAvatarPath: string,  // raw green-screen intro avatar
  tailAvatarPath: string,   // raw green-screen tail avatar
  bgPath: string,           // full bg video (has TTS audio)
  outPath: string,
  introSecs: number,        // exact N from user setting
  tailSecs: number,         // exact T from user setting
  similarity: number,
  blend: number,
  chromaColor: string,
  mode: string,
): Promise<void> {
  const rendersDir = path.dirname(outPath);
  const ts = Date.now();

  const bgDur = await probeDuration(ffmpegPath, bgPath);

  // Use user-specified N and T, clamped to bg duration
  const N = Math.min(introSecs, bgDur);
  const T = Math.min(tailSecs, Math.max(0, bgDur - N));
  const midStart = N;
  const midEnd = Math.max(midStart, bgDur - T);

  console.log(`[bookend-both-split] bg=${bgDur.toFixed(2)}s N=${N}s T=${T}s`);
  console.log(`[bookend-both-split] segments: intro=0-${N}s mid=${midStart}-${midEnd}s tail=${bgDur-T}-${bgDur}s`);

  // Step 1: Slice bg into intro segment and tail segment
  const bgIntroPath = path.join(rendersDir, `bgseg-intro-${ts}.mp4`);
  const bgTailPath  = path.join(rendersDir, `bgseg-tail-${ts}.mp4`);

  await runFfmpeg(ffmpegPath, [
    "-y", "-i", bgPath, "-ss", "0", "-t", String(N),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-an",
    "-pix_fmt", "yuv420p", bgIntroPath,
  ]);
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", bgPath, "-ss", String(bgDur - T), "-t", String(T),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-an",
    "-pix_fmt", "yuv420p", bgTailPath,
  ]);

  // Step 2: Composite intro/tail avatars onto their bg segments, clamped to exact duration
  const introCompPath = path.join(rendersDir, `comp-intro-${ts}.mp4`);
  const tailCompPath  = path.join(rendersDir, `comp-tail-${ts}.mp4`);

  const chromaFilter = [
    `chromakey=color=${chromaColor}:similarity=${similarity}:blend=${blend}`,
    `despill=type=green:mix=0.5:expand=0`,
  ].join(",");

  // Composite with -shortest so output = min(bg segment, avatar) = exactly N or T secs
  for (const [bgSeg, avSeg, outSeg, dur] of [
    [bgIntroPath, introAvatarPath, introCompPath, N],
    [bgTailPath,  tailAvatarPath,  tailCompPath,  T],
  ] as [string, string, string, number][]) {
    if (mode === "direct") {
      await runFfmpeg(ffmpegPath, [
        "-y", "-i", bgSeg, "-i", avSeg,
        "-filter_complex", `[1:v][0:v]scale2ref=iw:ih[fg_s][bg];[fg_s]format=yuva444p[fg];[bg][fg]overlay=0.5*W-w/2:0.5*H-h/2:format=auto[out]`,
        "-map", "[out]", "-t", String(dur),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-an",
        "-pix_fmt", "yuv420p", outSeg,
      ]);
    } else {
      await runFfmpeg(ffmpegPath, [
        "-y", "-i", bgSeg, "-i", avSeg,
        "-filter_complex", [
          `[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]`,
          `[1:v]${chromaFilter}[fg_key]`,
          `[fg_key][bg]scale2ref=iw:ih[fg][bg2]`,
          `[bg2][fg]overlay=0:0:format=auto[out]`,
        ].join(";"),
        "-map", "[out]", "-t", String(dur),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-threads", "0", "-an", "-pix_fmt", "yuv420p", outSeg,
      ]);
    }
  }

  // Step 3: Slice bg middle segment (video only, no re-encode)
  const bgMidPath = path.join(rendersDir, `bgseg-mid-${ts}.mp4`);
  if (midEnd > midStart) {
    await runFfmpeg(ffmpegPath, [
      "-y", "-i", bgPath, "-ss", String(midStart), "-t", String(midEnd - midStart),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-an",
      "-pix_fmt", "yuv420p", bgMidPath,
    ]);
  }

  // Step 4: Stitch intro + mid + tail, audio from full bg
  const listPath = path.join(rendersDir, `concat-${ts}.txt`);
  let concatContent = `file '${introCompPath.replace(/\\/g, "/")}'\n`;
  if (midEnd > midStart) concatContent += `file '${bgMidPath.replace(/\\/g, "/")}'\n`;
  concatContent += `file '${tailCompPath.replace(/\\/g, "/")}'`;
  fs.writeFileSync(listPath, concatContent);

  // Concat video-only first, then mux audio from full bg
  const videoOnlyPath = path.join(rendersDir, `concat-video-${ts}.mp4`);
  await runFfmpeg(ffmpegPath, [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-an", videoOnlyPath,
  ]);

  // Mux audio from full bg
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", videoOnlyPath, "-i", bgPath,
    "-map", "0:v", "-map", "1:a?",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest", "-movflags", "+faststart",
    outPath,
  ]);

  // Cleanup temp files
  for (const f of [bgIntroPath, bgTailPath, introCompPath, tailCompPath, bgMidPath, listPath, videoOnlyPath]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// ─────────────────────────────────────────────
// POST /api/heygen/composite
// Body: { avatarVideoUrl, tailAvatarVideoUrl?, bgVideoUrl, mode, avatarTiming?, avatarBookendSecs?, avatarTailSecs? }
// When tailAvatarVideoUrl is provided + avatarTiming=bookend-both → use split mode
// ─────────────────────────────────────────────
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    avatarVideoUrl, tailAvatarVideoUrl, bgVideoUrl,
    mode = "chromakey",
    avatarTiming = "full",
    avatarBookendSecs = 5,
    avatarTailSecs = 5,
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
  const avatarTmp  = path.join(rendersDir, `avatar-tmp-${ts}${avatarExt}`);
  const tailTmp    = tailAvatarVideoUrl ? path.join(rendersDir, `avatar-tail-tmp-${ts}.mp4`) : null;
  const bgTmp      = path.join(rendersDir, `bg-tmp-${ts}.mp4`);
  const outFile    = `composite-${ts}.mp4`;
  const outPath    = path.join(rendersDir, outFile);

  try {
    console.log(`[composite] mode=${mode} timing=${avatarTiming} splitTail=${!!tailAvatarVideoUrl}`);

    await downloadFile(avatarVideoUrl, avatarTmp, heygenKey);
    if (fs.statSync(avatarTmp).size < 1000) throw new Error("Avatar too small");

    await downloadFile(bgVideoUrl, bgTmp, heygenKey);
    if (fs.statSync(bgTmp).size < 1000) throw new Error("BG too small");

    if (tailTmp && tailAvatarVideoUrl) {
      await downloadFile(tailAvatarVideoUrl, tailTmp, heygenKey);
      if (fs.statSync(tailTmp).size < 1000) throw new Error("Tail avatar too small");
    }

    const ffmpeg = getFfmpegPath();

    // bookend-both split: composite intro and tail separately onto bg segments, then stitch
    if (avatarTiming === "bookend-both" && tailTmp) {
      const finalFile = `composite-${ts}-bookend-both.mp4`;
      const finalPath = path.join(rendersDir, finalFile);

      await applyBookendBothSplit(
        ffmpeg,
        avatarTmp, tailTmp, bgTmp, finalPath,
        avatarBookendSecs, avatarTailSecs,
        chromaSimilarity, chromaBlend, chromaColor, mode,
      );

      console.log("[composite] split output:", finalFile, fs.statSync(finalPath).size, "bytes");
      return NextResponse.json({ videoUrl: `/api/renders/${finalFile}`, usedMode: mode });
    }

    // Standard composite (full / bookend / bookend-both legacy)
    if (mode === "direct") {
      await directComposite(bgTmp, avatarTmp, outPath);
    } else if (mode === "rembg") {
      await rembgComposite(bgTmp, avatarTmp, outPath, rembgModel);
    } else {
      await chromakeyComposite(bgTmp, avatarTmp, outPath, chromaSimilarity, chromaBlend, chromaColor);
    }

    if (fs.statSync(outPath).size < 1000) throw new Error("Output too small");

    let finalFile = outFile;
    let finalPath = outPath;
    if (avatarTiming === "bookend" && avatarBookendSecs > 0) {
      const bookendFile = `composite-${ts}-bookend.mp4`;
      const bookendPath = path.join(rendersDir, bookendFile);
      await applyBookend(ffmpeg, outPath, bgTmp, bookendPath, avatarBookendSecs);
      try { fs.unlinkSync(outPath); } catch {}
      finalFile = bookendFile;
      finalPath = bookendPath;
    } else if (avatarTiming === "bookend-both") {
      const bookendFile = `composite-${ts}-bookend-both.mp4`;
      const bookendPath = path.join(rendersDir, bookendFile);
      await applyBookendBoth(ffmpeg, outPath, bgTmp, bookendPath, avatarBookendSecs, avatarTailSecs);
      try { fs.unlinkSync(outPath); } catch {}
      finalFile = bookendFile;
      finalPath = bookendPath;
    }

    console.log("[composite] output:", finalFile, fs.statSync(finalPath).size, "bytes");
    return NextResponse.json({ videoUrl: `/api/renders/${finalFile}`, usedMode: mode });
  } catch (error) {
    console.error("[composite] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Composite failed" }, { status: 500 });
  } finally {
    try { if (fs.existsSync(avatarTmp)) fs.unlinkSync(avatarTmp); } catch {}
    try { if (tailTmp && fs.existsSync(tailTmp)) fs.unlinkSync(tailTmp); } catch {}
    try { if (fs.existsSync(bgTmp)) fs.unlinkSync(bgTmp); } catch {}
  }
}

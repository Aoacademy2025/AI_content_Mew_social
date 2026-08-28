import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-crypto";
import { recordChargedClip } from "@/lib/clip-charge";
import { clampAvatarLayout, shouldCropAvatarToVisibleCanvas, type AvatarLayout } from "@/lib/avatar-layout";
import { buildEnableExpr } from "@/lib/cutaway-plan";
import { buildCutawayCompositeFilter } from "@/lib/cutaway-fade";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";
import {
  CompositeExecutionError,
  executeCompositeFfmpeg,
  isCompositeStabilityCanary,
  resolveCompositeTimeoutMs,
} from "@/lib/composite-execution";
import {
  HeavyMediaAdmission,
  HeavyMediaAdmissionTimeoutError,
  type HeavyMediaLease,
} from "@/lib/heavy-media-admission";
import {
  resolveChromaParams,
  detectChromaColor,
  buildCompositeFilter,
  resolveCompositeEncode,
  featherSupported,
  type ChromaParams,
} from "@/lib/chroma-key";
import {
  avatarFadeBlendFilter,
  avatarSourceFadeWindows,
  normalizeAvatarFadeWindows,
  singleAvatarFadeWindow,
  type AvatarFadeWindow,
} from "@/lib/avatar-fade";
import path from "path";
import fs from "fs";
import os from "os";
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

// Composite encode knobs (env-tunable, resolved by the shared lib so this route and the verify
// script exercise the exact same code path — see resolveCompositeEncode in lib/chroma-key).
function compositeCrf(): string {
  return String(resolveCompositeEncode().crf);
}
function compositePreset(): string {
  return resolveCompositeEncode().preset;
}

// Containment guard: reject a body-supplied path that escapes `base` (path traversal).
// Returns null on escape so the caller throws its normal "not found" without leaking the path.
function containWithin(base: string, joined: string): string | null {
  const baseDir = path.resolve(process.cwd(), base);
  const resolvedPath = path.resolve(joined);
  if (resolvedPath !== baseDir && !resolvedPath.startsWith(baseDir + path.sep)) return null;
  return joined;
}

// Exact hostname match so the user's HeyGen key is only ever attached to a genuine
// heygen.ai host — not a substring lookalike (evilheygen.ai / heygen.ai.evil.com / …).
function isHeygenHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "heygen.ai" || h.endsWith(".heygen.ai");
  } catch {
    return false;
  }
}

// SSRF-safe fetch: validates the host, then follows redirects MANUALLY, re-validating
// each hop and rebuilding request headers per hop (so the HeyGen key never rides a 302
// to a non-heygen host). Bounded to `maxHops`.
async function safeFetchFollow(
  url: string,
  buildInit: (currentUrl: string) => RequestInit,
  maxHops = 3,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertSafeFetchUrl(current);
    const res = await fetch(current, { ...buildInit(current), redirect: "manual" });
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

async function downloadFile(url: string, dest: string, heygenKey?: string): Promise<void> {
  if (url.startsWith("/api/stocks/")) {
    const filename = url.replace("/api/stocks/", "");
    const src = containWithin("stocks", path.join(process.cwd(), "stocks", filename));
    if (!src || !fs.existsSync(src)) throw new Error(`Local file not found: ${url}`);
    fs.copyFileSync(src, dest);
    return;
  }
  if (url.startsWith("/")) {
    const src = containWithin("public", path.join(process.cwd(), "public", url.replace(/^\/api\/renders\//, "/renders/")));
    if (!src || !fs.existsSync(src)) throw new Error(`Local file not found: ${url}`);
    fs.copyFileSync(src, dest);
    return;
  }
  const res = await safeFetchFollow(url, (currentUrl) => {
    const headers: Record<string, string> = { "Accept": "video/mp4,video/*,*/*" };
    if (heygenKey && isHeygenHost(currentUrl)) headers["X-Api-Key"] = heygenKey;
    return { headers };
  });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}


function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs: number): Promise<string> {
  const outputPath = args.at(-1);
  if (!outputPath) return Promise.reject(new Error("ffmpeg output path missing"));
  return executeCompositeFfmpeg({ ffmpegPath, args, outputPath, timeoutMs })
    .then((result) => result.stderr);
}

async function markOwningCompositeJob(
  videoJobId: unknown,
  userId: string,
  currentStep: "composite_queue" | "composite",
  progress: number,
): Promise<void> {
  if (typeof videoJobId !== "string" || videoJobId.length === 0 || videoJobId.length > 191) return;
  // Ownership + inflight state are part of the update predicate: a caller cannot mutate
  // another user's job or resurrect a terminal job by supplying an arbitrary id.
  await prisma.videoJob.updateMany({
    where: { id: videoJobId, userId, status: "processing" },
    data: { currentStep, progress },
  }).catch((error) => {
    // Status detail is observability, not a reason to discard a valid render.
    console.warn(`[composite] could not mark ${currentStep} for job ${videoJobId}`, error);
  });
}

// ─────────────────────────────────────────────
// Mode: direct
// Input: transparent webm (already bg-removed) + bg mp4
// Avatar fills full bg, centered
// ─────────────────────────────────────────────
function buildDirectCompositeFilter(
  avatarFadeWindows: readonly AvatarFadeWindow[],
): string {
  const fadeWindows = normalizeAvatarFadeWindows(avatarFadeWindows);
  const backgroundFilter = fadeWindows.length > 0
    ? `[0:v]scale=1080:1920:flags=lanczos,setsar=1,split=2[bg][bg_fade]`
    : `[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]`;
  const overlayOutput = fadeWindows.length > 0 ? "avatar_composite" : "out";
  return [
    backgroundFilter,
    `[1:v]scale=1080:1920:flags=lanczos,setsar=1[fg]`,
    `[bg][fg]overlay=0:0:format=auto[${overlayOutput}]`,
    ...(fadeWindows.length > 0
      ? [avatarFadeBlendFilter({
          compositeLabel: overlayOutput,
          backgroundLabel: "bg_fade",
          outputLabel: "out",
          windows: fadeWindows,
        })]
      : []),
  ].join(";");
}

async function directComposite(
  bgPath: string,
  avatarPath: string,
  outPath: string,
  avatarFadeWindows: readonly AvatarFadeWindow[],
  timeoutMs: number,
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  // Scale bg to 1080x1920, overlay avatar centered, take audio from avatarPath (has TTS audio)
  const filter = buildDirectCompositeFilter(avatarFadeWindows);

  console.log("[direct-composite] filter:", filter);
  await runFfmpeg(ffmpeg, [
    "-y", "-i", bgPath, "-i", avatarPath,
    "-filter_complex", filter,
    "-map", "[out]", "-map", "1:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ], timeoutMs);
  console.log("[direct-composite] done");
}

// ─────────────────────────────────────────────
// Mode: cutaway — uploaded clip is the base video; the content-matched b-roll (bg)
// peeks through during NON-person windows. Dissolve the clip at every person-range
// edge while its source timeline keeps running continuously. Audio normally comes
// from the clip (input 1). When the base
// render contains selected BGM, use input 0 so it carries clip voice + music once.
// ─────────────────────────────────────────────
async function cutawayComposite(
  bgPath: string,
  avatarPath: string,
  outPath: string,
  personRangesSec: { start: number; end: number }[],
  timeoutMs: number,
  audioFromBackground = false,
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  if (!buildEnableExpr(personRangesSec)) {
    // Fail closed. An empty `enable=` used to fall back to a full-clip overlay, which turns
    // "show B-roll in every window" into "uploaded speaker over the whole video". Callers with
    // no person ranges must skip the composite and ship the base render instead.
    throw new Error("cutaway composite requires at least one valid person range");
  }
  const filter = buildCutawayCompositeFilter(personRangesSec);
  if (!filter) throw new Error("cutaway composite requires at least one valid person range");
  console.log("[cutaway-composite] filter:", filter);
  await runFfmpeg(ffmpeg, [
    "-y", "-i", bgPath, "-i", avatarPath,
    "-filter_complex", filter,
    "-map", "[out]", "-map", audioFromBackground ? "0:a?" : "1:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ], timeoutMs);
  console.log("[cutaway-composite] done");
}

// ─────────────────────────────────────────────
// Mode: chromakey — pure FFmpeg pipeline
// Avatar is scaled to its display size, keyed AT that resolution at full chroma (yuva444p),
// despilled, then alpha-feathered before overlay — see buildCompositeFilter in lib/chroma-key.
// Key color/similarity/blend come pre-resolved (auto-detected or honored) in ChromaParams.
// ─────────────────────────────────────────────
async function chromakeyComposite(
  bgPath: string,
  avatarPath: string,
  outPath: string,
  params: ChromaParams,
  timeoutMs: number,
  audioFromAvatar = false,
  layout: AvatarLayout | null = null,
  feather = true,
  avatarFadeWindows: readonly AvatarFadeWindow[] = [],
  cropToVisibleCanvas = false,
): Promise<void> {
  const ffmpeg = getFfmpegPath();

  const filterComplex = buildCompositeFilter(
    params,
    layout,
    feather,
    avatarFadeWindows,
    cropToVisibleCanvas,
  );
  if (layout) {
    console.log(`[chromakey] layer layout scale=${layout.scale} offsetPx=(${layout.offsetX},${layout.offsetY})`);
  } else {
    console.log(`[chromakey] full-cover overlay`);
  }

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

  console.log(`[chromakey-ffmpeg] color=${params.color} similarity=${params.similarity} blend=${params.blend} frames=${frameCount}`);

  // Encode: COMPOSITE_CRF (default 18) / COMPOSITE_PRESET (default veryfast) — quality over the
  // old crf 28 ultrafast. -threads 0 (auto), yuv420p, +faststart for progressive playback.
  await runFfmpeg(ffmpeg, [
    "-y",
    "-i", bgPath,
    "-i", avatarPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    // Direct URL mode: audio lives in avatarPath (input 1), not bgPath
    "-map", audioFromAvatar ? "1:a?" : "0:a?",
    "-c:v", "libx264", "-preset", compositePreset(), "-crf", compositeCrf(),
    "-threads", "0",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ], timeoutMs);

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

async function fadeCompositeAgainstBackground(
  ffmpegPath: string,
  compositePath: string,
  bgPath: string,
  outPath: string,
  avatarFadeWindows: readonly AvatarFadeWindow[],
  timeoutMs: number,
): Promise<void> {
  const fadeWindows = normalizeAvatarFadeWindows(avatarFadeWindows);
  if (fadeWindows.length === 0) {
    fs.copyFileSync(compositePath, outPath);
    return;
  }
  const filter = [
    `[0:v]scale=1080:1920:flags=lanczos,setsar=1[avatar_composite]`,
    `[1:v]scale=1080:1920:flags=lanczos,setsar=1[bg_fade]`,
    avatarFadeBlendFilter({
      compositeLabel: "avatar_composite",
      backgroundLabel: "bg_fade",
      outputLabel: "out",
      windows: fadeWindows,
    }),
  ].join(";");
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", compositePath, "-i", bgPath,
    "-filter_complex", filter,
    "-map", "[out]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", compositePreset(), "-crf", compositeCrf(),
    "-threads", "0",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ], timeoutMs);
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

async function applyBookend(
  ffmpegPath: string,
  compositePath: string,
  bgPath: string,
  outPath: string,
  introSecs: number,
  timeoutMs: number,
): Promise<void> {
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
  ], timeoutMs);
}

async function applyBookendBoth(
  ffmpegPath: string,
  compositePath: string,
  bgPath: string,
  outPath: string,
  introSecs: number,
  tailSecs: number,
  timeoutMs: number,
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
  ], timeoutMs);
}

// ─────────────────────────────────────────────
// Segmented bookend: intro avatar + optional separately-generated tail avatar.
// Correct flow:
//   1. Slice bg into 3 segments: bg[0..N], bg[N..bgDur-T], bg[bgDur-T..bgDur]
//   2. Composite intro avatar onto bg[0..N]
//   3. Composite tail avatar onto bg[bgDur-T..bgDur] when present
//   4. Stitch: introComp + bgMid + tailComp, audio from full bg
// ─────────────────────────────────────────────
async function applyBookendSegmented(
  ffmpegPath: string,
  introAvatarPath: string,  // raw green-screen intro avatar
  tailAvatarPath: string | null, // raw green-screen tail avatar (two-sided only)
  bgPath: string,           // full bg video (has TTS audio)
  outPath: string,
  introSecs: number,        // exact N from user setting
  tailSecs: number,         // exact T from user setting
  params: ChromaParams,     // pre-resolved key color/similarity/blend
  mode: string,
  timeoutMs: number,
  cropToVisibleCanvas: boolean,
  layout: AvatarLayout | null = null,
  feather = true,
): Promise<void> {
  const rendersDir = path.dirname(outPath);
  const ts = Date.now();
  const bgIntroPath = path.join(rendersDir, `bgseg-intro-${ts}.mp4`);
  const bgTailPath = path.join(rendersDir, `bgseg-tail-${ts}.mp4`);
  const introCompPath = path.join(rendersDir, `comp-intro-${ts}.mp4`);
  const tailCompPath = path.join(rendersDir, `comp-tail-${ts}.mp4`);
  const bgMidPath = path.join(rendersDir, `bgseg-mid-${ts}.mp4`);
  const listPath = path.join(rendersDir, `concat-${ts}.txt`);
  const videoOnlyPath = path.join(rendersDir, `concat-video-${ts}.mp4`);
  const tempPaths = [
    bgIntroPath,
    bgTailPath,
    introCompPath,
    tailCompPath,
    bgMidPath,
    listPath,
    videoOnlyPath,
  ];

  try {
    const bgDur = await probeDuration(ffmpegPath, bgPath);

  // Use user-specified N and T, clamped to bg duration
  const N = Math.min(introSecs, bgDur);
  const T = tailAvatarPath
    ? Math.min(tailSecs, Math.max(0, bgDur - N))
    : 0;
  const midStart = N;
  const midEnd = Math.max(midStart, bgDur - T);

  console.log(`[bookend-segmented] bg=${bgDur.toFixed(2)}s N=${N}s T=${T}s`);
  console.log(`[bookend-segmented] segments: intro=0-${N}s mid=${midStart}-${midEnd}s${tailAvatarPath ? ` tail=${bgDur-T}-${bgDur}s` : ""}`);

  // Step 1: Slice bg into intro segment and tail segment
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", bgPath, "-ss", "0", "-t", String(N),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-an",
    "-pix_fmt", "yuv420p", bgIntroPath,
  ], timeoutMs);
  if (tailAvatarPath && T > 0) {
    await runFfmpeg(ffmpegPath, [
      "-y", "-i", bgPath, "-ss", String(bgDur - T), "-t", String(T),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-an",
      "-pix_fmt", "yuv420p", bgTailPath,
    ], timeoutMs);
  }

  // Step 2: Composite intro/tail avatars onto their bg segments, clamped with -t to N/T.
  const avatarSegments: [string, string, string, number][] = [
    [bgIntroPath, introAvatarPath, introCompPath, N],
  ];
  if (tailAvatarPath && T > 0) {
    avatarSegments.push([bgTailPath, tailAvatarPath, tailCompPath, T]);
  }
  for (const [bgSeg, avSeg, outSeg, dur] of avatarSegments) {
    const segmentFadeWindow = singleAvatarFadeWindow(dur);
    if (mode === "direct") {
      await runFfmpeg(ffmpegPath, [
        "-y", "-i", bgSeg, "-i", avSeg,
        "-filter_complex", buildDirectCompositeFilter(segmentFadeWindow),
        "-map", "[out]", "-t", String(dur),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-an",
        "-pix_fmt", "yuv420p", outSeg,
      ], timeoutMs);
    } else {
      // Same key-at-display-resolution chain as the main composite (shared builder → can't drift).
      const segFilter = buildCompositeFilter(
        params,
        layout,
        feather,
        segmentFadeWindow,
        cropToVisibleCanvas,
      );
      await runFfmpeg(ffmpegPath, [
        "-y", "-i", bgSeg, "-i", avSeg,
        "-filter_complex", segFilter,
        "-map", "[out]", "-t", String(dur),
        "-c:v", "libx264", "-preset", compositePreset(), "-crf", compositeCrf(),
        "-threads", "0", "-an", "-pix_fmt", "yuv420p", outSeg,
      ], timeoutMs);
    }
  }

  // Step 3: Normalize the middle segment to the same codec/preset as the composited ends.
  // This makes the final concat eligible for a stream copy instead of another full-video encode.
  if (midEnd > midStart) {
    await runFfmpeg(ffmpegPath, [
      "-y", "-i", bgPath, "-ss", String(midStart), "-t", String(midEnd - midStart),
      "-c:v", "libx264", "-preset", compositePreset(), "-crf", compositeCrf(), "-an",
      "-pix_fmt", "yuv420p", bgMidPath,
    ], timeoutMs);
  }

  // Step 4: Stitch intro + mid + tail, audio from full bg
  let concatContent = `file '${introCompPath.replace(/\\/g, "/")}'\n`;
  if (midEnd > midStart) concatContent += `file '${bgMidPath.replace(/\\/g, "/")}'\n`;
  if (tailAvatarPath && T > 0) {
    concatContent += `file '${tailCompPath.replace(/\\/g, "/")}'`;
  }
  fs.writeFileSync(listPath, concatContent);

  // Concat video-only first, then mux audio from full bg
  try {
    await runFfmpeg(ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "copy", "-an", videoOnlyPath,
    ], timeoutMs);
  } catch (error) {
    // A legacy or unusual input can still produce incompatible segment headers/timebases.
    // Preserve correctness with the prior encode path while keeping the normal path O(stitch).
    console.warn("[bookend-segmented] stream-copy concat failed; falling back to encode", error);
    await runFfmpeg(ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-an", videoOnlyPath,
    ], timeoutMs);
  }

  // Mux audio from full bg
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", videoOnlyPath, "-i", bgPath,
    "-map", "0:v", "-map", "1:a?",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest", "-movflags", "+faststart",
    outPath,
  ], timeoutMs);

  } finally {
    for (const filePath of tempPaths) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
  }
}

// ─────────────────────────────────────────────
// POST /api/heygen/composite
// Body: { videoJobId?, avatarVideoUrl, tailAvatarVideoUrl?, bgVideoUrl, mode, avatarTiming?, avatarBookendSecs?, avatarTailSecs? }
// Chromakey/direct bookends use segmented mode; tailAvatarVideoUrl enables the two-sided variant.
// ─────────────────────────────────────────────
export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ffmpegTimeoutMs = resolveCompositeTimeoutMs({ userId: authUser.id });
  const stabilityCanary = isCompositeStabilityCanary({ userId: authUser.id });

  const dbUser = await prisma.user.findUnique({ where: { id: authUser.id }, select: { plan: true } });
  if (dbUser?.plan === "FREE") return NextResponse.json({ error: "Avatar composite ใช้ได้เฉพาะแผน Pro ขึ้นไป" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const {
    videoJobId,
    avatarVideoUrl, tailAvatarVideoUrl, bgVideoUrl,
    mode = "chromakey",
    avatarTiming = "full",
    avatarBookendSecs = 5,
    avatarTailSecs = 5,
    chromaSimilarity = 0.28,
    chromaBlend = 0.04,
    chromaColor = "0x12FF05",
    rembgModel = "u2net",
    audioFromAvatar = false,
    cutawayAudioFromBackground = false,
    avatarLayout = null,
    personRanges = [],
  } = body ?? {};

  const layout = clampAvatarLayout(avatarLayout);

  if (!avatarVideoUrl) return NextResponse.json({ error: "avatarVideoUrl required" }, { status: 400 });
  if (!bgVideoUrl) return NextResponse.json({ error: "bgVideoUrl required" }, { status: 400 });
  // mode:"cutaway" overlays the uploaded speaker ONLY inside personRanges. With no valid range
  // the overlay would cover the whole clip — the opposite of what an all-B-roll edit asked for.
  // Reject before downloading anything; the caller (orchestrator) must skip the composite and
  // ship the base render, which already carries the clip's audio. Other modes are untouched.
  if (mode === "cutaway" && !buildEnableExpr(personRanges)) {
    return NextResponse.json(
      { error: "cutaway requires at least one valid personRange" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
  const heygenKey = user?.heygenKey ? decryptKey(user.heygenKey) : undefined;

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const ts = Date.now();
  const avatarExt = avatarVideoUrl.includes(".webm") ? ".webm" : ".mp4";
  const avatarTmp  = path.join(rendersDir, `avatar-tmp-${ts}${avatarExt}`);
  const tailTmp    = tailAvatarVideoUrl ? path.join(rendersDir, `avatar-tail-tmp-${ts}.mp4`) : null;
  const bgTmp      = path.join(rendersDir, `bg-tmp-${ts}.mp4`);
  const outFile    = `composite-${ts}.mp4`;
  const outPath    = path.join(rendersDir, outFile);
  const attemptOutputs = new Set<string>([outPath]);
  let publishedOutput: string | null = null;
  let compositeLease: HeavyMediaLease | null = null;
  let admissionHeartbeat: ReturnType<typeof setInterval> | null = null;

  try {
    console.log(`[composite] mode=${mode} timing=${avatarTiming} splitTail=${!!tailAvatarVideoUrl} timeoutMs=${ffmpegTimeoutMs} visibleCrop=${shouldCropAvatarToVisibleCanvas(layout)} canary=${stabilityCanary}`);

    await downloadFile(avatarVideoUrl, avatarTmp, heygenKey);
    if (fs.statSync(avatarTmp).size < 1000) throw new Error("Avatar too small");

    await downloadFile(bgVideoUrl, bgTmp, heygenKey);
    if (fs.statSync(bgTmp).size < 1000) throw new Error("BG too small");

    if (tailTmp && tailAvatarVideoUrl) {
      await downloadFile(tailAvatarVideoUrl, tailTmp, heygenKey);
      if (fs.statSync(tailTmp).size < 1000) throw new Error("Tail avatar too small");
    }

    const admission = new HeavyMediaAdmission({
      rootDir: process.env.HEAVY_MEDIA_ADMISSION_DIR
        || path.join(os.tmpdir(), "ai-content-heavy-media-admission"),
      enabled: stabilityCanary && process.env.COMPOSITE_ADMISSION_ENABLED === "1",
    });
    const rawAdmissionWaitMs = Number(process.env.COMPOSITE_ADMISSION_MAX_WAIT_MS);
    const admissionWaitMs = Number.isFinite(rawAdmissionWaitMs)
      ? Math.min(20 * 60_000, Math.max(10_000, Math.floor(rawAdmissionWaitMs)))
      : 15 * 60_000;
    await markOwningCompositeJob(videoJobId, authUser.id, "composite_queue", 86);
    compositeLease = await admission.acquireComposite({ maxWaitMs: admissionWaitMs, pollMs: 1_000 });
    await markOwningCompositeJob(videoJobId, authUser.id, "composite", 87);
    admissionHeartbeat = setInterval(() => {
      void compositeLease?.heartbeat().catch(() => {});
    }, 10_000);
    admissionHeartbeat.unref?.();

    const ffmpeg = getFfmpegPath();

    // Resolve chroma key params once (auto-detect the real green shade for the legacy-default /
    // omitted case; honor deliberately-tuned slider values verbatim). Only the green-screen
    // modes key, so skip detection for direct/cutaway/rembg.
    const willKey = mode !== "direct" && mode !== "cutaway" && mode !== "rembg";
    const resolved = resolveChromaParams({ chromaColor, chromaSimilarity, chromaBlend });
    const chromaParams: ChromaParams = { color: resolved.color, similarity: resolved.similarity, blend: resolved.blend };
    if (willKey && resolved.autoDetect) {
      chromaParams.color = await detectChromaColor(avatarTmp, ffmpeg);
    }
    // One probe per ffmpeg path per process lifetime (cached in lib/chroma-key) — negligible cost.
    // Not every ffmpeg build ships erosion/gblur (dev=darwin-arm64, prod=linux-x64 peer build); the
    // keying path isn't fail-open like detection, so this must be resolved BEFORE building filters.
    const feather = willKey ? await featherSupported(ffmpeg) : true;
    if (willKey) {
      console.log(`[composite] chroma ${resolved.autoDetect ? "auto-detected" : "user-tuned"} → color=${chromaParams.color} similarity=${chromaParams.similarity} blend=${chromaParams.blend} feather=${feather}`);
    }

    // Segmented bookends: key only the short intro/tail clips. The long middle is encoded
    // without chroma filters, then all compatible segments are stitched by stream copy.
    // rembg keeps its existing path because its external Python pipeline is not segment-aware.
    const segmentedBookend = (mode === "direct" || willKey)
      && avatarBookendSecs > 0
      && (
        avatarTiming === "bookend"
        || (avatarTiming === "bookend-both" && tailTmp !== null)
      );
    if (segmentedBookend) {
      const finalFile = `composite-${ts}-${avatarTiming}.mp4`;
      const finalPath = path.join(rendersDir, finalFile);
      attemptOutputs.add(finalPath);

      await applyBookendSegmented(
        ffmpeg,
        avatarTmp,
        avatarTiming === "bookend-both" ? tailTmp : null,
        bgTmp,
        finalPath,
        avatarBookendSecs,
        avatarTiming === "bookend-both" ? avatarTailSecs : 0,
        chromaParams, mode,
        ffmpegTimeoutMs,
        shouldCropAvatarToVisibleCanvas(layout),
        layout,
        feather,
      );

      console.log("[composite] segmented output:", finalFile, fs.statSync(finalPath).size, "bytes");
      publishedOutput = finalPath;
      // Record composite output as paid so a subsequent burn of this composite is free
      // (the base render already charged the clip; composite is a processing step, not new charge).
      // Fail-open: a bookkeeping failure must never break the composite response.
      await recordChargedClip(authUser.id, `/api/renders/${finalFile}`).catch(() => {});
      return NextResponse.json({ videoUrl: `/api/renders/${finalFile}`, usedMode: mode });
    }

    // Standard composite (full / bookend / bookend-both legacy)
    const bgDuration = await probeDuration(ffmpeg, bgTmp);
    const sourceFadeWindows = avatarSourceFadeWindows({
      timing: avatarTiming,
      totalDurationSec: bgDuration,
      introSecs: avatarBookendSecs,
      tailSecs: avatarTailSecs,
    });
    if (mode === "direct") {
      await directComposite(bgTmp, avatarTmp, outPath, sourceFadeWindows, ffmpegTimeoutMs);
    } else if (mode === "cutaway") {
      await cutawayComposite(
        bgTmp,
        avatarTmp,
        outPath,
        personRanges,
        ffmpegTimeoutMs,
        cutawayAudioFromBackground === true,
      );
    } else if (mode === "rembg") {
      const rembgRawPath = path.join(rendersDir, `composite-${ts}-rembg-raw.mp4`);
      try {
        await rembgComposite(bgTmp, avatarTmp, rembgRawPath, rembgModel);
        await fadeCompositeAgainstBackground(
          ffmpeg,
          rembgRawPath,
          bgTmp,
          outPath,
          sourceFadeWindows,
          ffmpegTimeoutMs,
        );
      } finally {
        try { if (fs.existsSync(rembgRawPath)) fs.unlinkSync(rembgRawPath); } catch {}
      }
    } else {
      await chromakeyComposite(
        bgTmp,
        avatarTmp,
        outPath,
        chromaParams,
        ffmpegTimeoutMs,
        audioFromAvatar,
        layout,
        feather,
        sourceFadeWindows,
        shouldCropAvatarToVisibleCanvas(layout),
      );
    }

    if (fs.statSync(outPath).size < 1000) throw new Error("Output too small");

    let finalFile = outFile;
    let finalPath = outPath;
    if (avatarTiming === "bookend" && avatarBookendSecs > 0) {
      const bookendFile = `composite-${ts}-bookend.mp4`;
      const bookendPath = path.join(rendersDir, bookendFile);
      attemptOutputs.add(bookendPath);
      await applyBookend(ffmpeg, outPath, bgTmp, bookendPath, avatarBookendSecs, ffmpegTimeoutMs);
      try { fs.unlinkSync(outPath); } catch {}
      finalFile = bookendFile;
      finalPath = bookendPath;
    } else if (avatarTiming === "bookend-both") {
      const bookendFile = `composite-${ts}-bookend-both.mp4`;
      const bookendPath = path.join(rendersDir, bookendFile);
      attemptOutputs.add(bookendPath);
      await applyBookendBoth(
        ffmpeg,
        outPath,
        bgTmp,
        bookendPath,
        avatarBookendSecs,
        avatarTailSecs,
        ffmpegTimeoutMs,
      );
      try { fs.unlinkSync(outPath); } catch {}
      finalFile = bookendFile;
      finalPath = bookendPath;
    }

    console.log("[composite] output:", finalFile, fs.statSync(finalPath).size, "bytes");
    publishedOutput = finalPath;
    // Record composite output as paid so a subsequent burn of this composite is free
    // (the base render already charged the clip; composite is a processing step, not new charge).
    // Fail-open: a bookkeeping failure must never break the composite response.
    await recordChargedClip(authUser.id, `/api/renders/${finalFile}`).catch(() => {});
    return NextResponse.json({ videoUrl: `/api/renders/${finalFile}`, usedMode: mode });
  } catch (error) {
    console.error("[composite] error:", error);
    if (error instanceof HeavyMediaAdmissionTimeoutError) {
      return NextResponse.json(
        { error: error.message, code: "COMPOSITE_TRANSIENT", retryable: true },
        { status: 503 },
      );
    }
    if (error instanceof CompositeExecutionError) {
      return NextResponse.json(
        { error: error.message, code: error.code, retryable: error.retryable },
        { status: error.code === "COMPOSITE_TIMEOUT" ? 504 : 500 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Composite failed", code: "COMPOSITE_FAILED", retryable: false },
      { status: 500 },
    );
  } finally {
    if (admissionHeartbeat) clearInterval(admissionHeartbeat);
    await compositeLease?.release().catch(() => {});
    for (const candidate of attemptOutputs) {
      if (candidate === publishedOutput) continue;
      try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch {}
    }
    try { if (fs.existsSync(avatarTmp)) fs.unlinkSync(avatarTmp); } catch {}
    try { if (tailTmp && fs.existsSync(tailTmp)) fs.unlinkSync(tailTmp); } catch {}
    try { if (fs.existsSync(bgTmp)) fs.unlinkSync(bgTmp); } catch {}
  }
}

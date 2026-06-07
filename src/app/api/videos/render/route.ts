import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { createNotification } from "@/lib/notifications";
import { limitsForPlan } from "@/lib/plan-limits";
import { prisma } from "@/lib/prisma";
import { refundClipUsage, reserveClipUsage } from "@/lib/usage-limits";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import os from "os";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  activeRenderCancel,
  cancelByJobId,
  renderJobDoneByUser,
  getBundleInProgress,
  setBundleInProgress,
  getActiveRenderCount,
  incrementActiveRenderCount,
  decrementActiveRenderCount,
} from "./cancel-registry";

function getRenderTmpDir(): string {
  const base =
    process.env.RENDER_TMP_ROOT
      ? path.resolve(process.env.RENDER_TMP_ROOT)
      : path.join(process.cwd(), ".tmp", "remotion");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {}
  return base;
}

function runTmpCleanup(baseDir: string, pattern: string, minMinutes: number) {
  if (process.platform === "win32") return;
  try {
    const escaped = pattern.replace(/'/g, "'\\''");
    const cmd = `find '${baseDir}' -maxdepth 1 -name '${escaped}' -mmin +${minMinutes} -exec rm -rf {} + 2>/dev/null`;
    execSync(cmd);
  } catch {}
}

/** Download external image URL to local public/renders and return a full absolute URL
 *  so Remotion's Chromium (which runs on its own port) can fetch from Next.js server */
async function cacheImageLocally(url: string, rendersDir: string, baseUrl: string): Promise<string> {
  if (!url) return url;
  // Already a full URL pointing to our own server — keep as-is
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // external URL — download and re-serve via Next.js
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return url;
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = url.includes(".png") ? "png" : "jpg";
      const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      fs.writeFileSync(path.join(rendersDir, filename), buf);
      return `${baseUrl}/api/renders/${filename}`;
    } catch {
      return url;
    }
  }
  // Local path e.g. "/renders/foo.png" — make it absolute
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return url;
}

export const maxDuration = 60; // only needs to start the background job, not wait for it
export const runtime = "nodejs";

// Job state persisted to disk so hot-reload and pm2 restarts don't lose in-flight jobs.
type RenderJob = {
  status: "running" | "done" | "error";
  videoUrl?: string;
  error?: string;
  startedAt: number;
  progress?: number; // 0–100
};

// activeRenderCount is now stored in global via cancel-registry to survive hot-reloads.

function jobsDir(): string {
  const d = path.join(process.cwd(), ".tmp", "render-jobs");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function jobFilePath(jobId: string): string {
  return path.join(jobsDir(), `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function persistJob(jobId: string, job: RenderJob) {
  try { fs.writeFileSync(jobFilePath(jobId), JSON.stringify(job)); } catch {}
}

function readPersistedJob(jobId: string): RenderJob | undefined {
  try {
    const raw = fs.readFileSync(jobFilePath(jobId), "utf-8");
    return JSON.parse(raw) as RenderJob;
  } catch { return undefined; }
}

// In-memory cache so same process doesn't re-read file on every poll
const renderJobs = new Map<string, RenderJob>();

// Track the latest jobId per user — older jobs are superseded and must not write results
const latestJobPerUser = new Map<string, string>();

function setRenderJob(jobId: string, job: RenderJob) {
  renderJobs.set(jobId, job);
  persistJob(jobId, job);
}

function getRenderJob(jobId: string): RenderJob | undefined {
  if (renderJobs.has(jobId)) return renderJobs.get(jobId);
  // Fallback: read from disk (hot-reload created a new module instance)
  const persisted = readPersistedJob(jobId);
  if (persisted) {
    renderJobs.set(jobId, persisted);
    return persisted;
  }
  return undefined;
}

// Cache the Remotion webpack bundle across requests AND across pm2 restarts.
// Bundle path + mtime saved to the render tmp dir so pm2 restarts
// don't re-bundle from scratch (bundling takes 2-5 min on low-CPU VPS).
let cachedBundleLocation: string | null = null;
let cachedBundleMtime: string = "";

function loadBundleCache() {
  const tmpDir = getRenderTmpDir();
  const cacheFile = path.join(tmpDir, "remotion-bundle-cache.json");
  if (cachedBundleLocation) return; // already loaded in this process
  try {
    if (!fs.existsSync(cacheFile)) return;
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (
      data.bundleLocation &&
      data.entryMtime &&
      fs.existsSync(path.join(data.bundleLocation, "index.html"))
    ) {
      cachedBundleLocation = data.bundleLocation;
      cachedBundleMtime = data.entryMtime;
      console.log(`[Render] restored bundle cache from disk: ${cachedBundleLocation}`);
    }
  } catch {}
}

function saveBundleCache() {
  const tmpDir = getRenderTmpDir();
  const cacheFile = path.join(tmpDir, "remotion-bundle-cache.json");
  try {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ bundleLocation: cachedBundleLocation, entryMtime: cachedBundleMtime })
    );
  } catch {}
}

export async function POST(req: Request) {
  const requestStartedAt = Date.now();
  loadBundleCache();
  let quotaReserved = false;
  let reservedUserId: string | null = null;
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const renderTmpDir = getRenderTmpDir();
    // Windows uses TEMP / TMP — TMPDIR is a Unix-only convention and is ignored on Windows.
    // Set all three so Remotion picks up the correct temp dir on every platform.
    process.env.TMPDIR = renderTmpDir;
    process.env.TEMP  = renderTmpDir;
    process.env.TMP   = renderTmpDir;

    // Ensure renderTmpDir itself exists so Remotion's mkdirSync(newDir) (non-recursive) succeeds
    // when it creates its per-job subfolder inside our custom temp dir.
    try { fs.mkdirSync(renderTmpDir, { recursive: true }); } catch {}

    const userId = authUser.id;

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { scenes, audioUrl, videoDuration, captions, captionSegments, avatarVideoUrl, captionStyleId, positionY, fontSizeOverride, fontWeightOverride, customCaptionStyle, width: customWidth, height: customHeight, shortVideoConfig, subtitleOverlayConfig, fps: requestedFps, jpegQuality: requestedJpegQuality } = await req.json();

    // Support both old `captionSegments` and new `captions` field names
    const captionsData = captions ?? captionSegments ?? [];

    // avatarVideoUrl mode: render avatar video + caption overlay
    const isAvatarMode = !!avatarVideoUrl;
    const isShortVideo = !!shortVideoConfig;
    const isSubtitleOverlay = !!subtitleOverlayConfig;

    if (!isSubtitleOverlay && !isShortVideo && !isAvatarMode && (!Array.isArray(scenes) || scenes.length === 0)) {
      return NextResponse.json({ error: "scenes, avatarVideoUrl, shortVideoConfig, or subtitleOverlayConfig is required" }, { status: 400 });
    }

    const fps = [24, 30, 50, 60].includes(Number(requestedFps)) ? Number(requestedFps) : 30;
    const explicitDurationSec = Number(videoDuration);
    const configDurationFrames = Number(shortVideoConfig?.durationInFrames ?? subtitleOverlayConfig?.durationInFrames);
    const requestedDurationSec =
      Number.isFinite(explicitDurationSec) && explicitDurationSec > 0
        ? explicitDurationSec
        : Number.isFinite(configDurationFrames) && configDurationFrames > 0
          ? configDurationFrames / fps
          : null;

    const planLimits = limitsForPlan(dbUser.plan);
    if (requestedDurationSec && requestedDurationSec > planLimits.durationSec) {
      const planName = dbUser.plan === "BUSINESS" ? "Business" : dbUser.plan === "PRO" ? "Pro" : "Free";
      return NextResponse.json(
        { error: `${planName} plan จำกัดวิดีโอสูงสุด ${planLimits.durationSec / 60} นาที/คลิป` },
        { status: 403 }
      );
    }

    const jobId = `${userId}-${Date.now()}`;
    // Register this as the latest job for this user before cancelling the old one, so its
    // background catch can identify itself as superseded and refund the reserved usage.
    latestJobPerUser.set(userId, jobId);

    const prevCancel = activeRenderCancel.get(userId);
    if (prevCancel) {
      console.log(`[Render] cancelling previous job for user ${userId}`);
      prevCancel();
    }
    // Wait for the previous job to fully exit before the new one starts renderMedia.
    // Without this, both Chromium instances run concurrently → VPS OOM → one hangs.
    const prevDone = renderJobDoneByUser.get(userId);
    if (prevDone) {
      console.log(`[Render] waiting for previous job to finish before starting ${jobId}`);
      await prevDone;
      console.log(`[Render] previous job finished — starting ${jobId}`);
    }

    const quota = await reserveClipUsage(userId);
    if (!quota) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (!quota.allowed) return NextResponse.json({ error: quota.message }, { status: 403 });
    quotaReserved = true;
    reservedUserId = userId;

    const progressFile = path.join(renderTmpDir, `render-progress-${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

    const safeDuration = requestedDurationSec ?? 60;
    const durationInFrames = Math.max(Math.round(safeDuration * fps), fps);
    // Note: AvatarComposition uses calculateMetadata to auto-detect duration from video,
    // so durationInFrames below is only used as fallback for non-avatar mode.

    // webpackIgnore prevents Turbopack from statically analyzing these imports
    // and traversing into esbuild native binaries (README.md, .node files).
    // serverExternalPackages ensures they're loaded from node_modules at runtime.
    const { bundle } = await import(/* webpackIgnore: true */ "@remotion/bundler" as string);
    const { renderMedia, selectComposition, makeCancelSignal } = await import(/* webpackIgnore: true */ "@remotion/renderer" as string);

    // Ensure output directory exists (moved up so cacheImageLocally can use rendersDir)
    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Clean up stale Remotion bundles from render temp dir to prevent disk full
    try {
      if (process.platform !== "win32") {
        // Clean assets older than 30 min and webpack bundles older than 60 min
        runTmpCleanup(renderTmpDir, "remotion-*assets*", 30);
        runTmpCleanup(renderTmpDir, "remotion-webpack-bundle-*", 60);
        runTmpCleanup(renderTmpDir, "react-motion-render*", 60);
      }
    } catch {}

    // Derive base URL from request so Remotion's Chromium can fetch assets from Next.js server.
    // Force http for localhost — Next.js runs plain HTTP internally even behind an HTTPS reverse proxy.
    // Using https://localhost causes SSL handshake failures (EPROTO wrong version number).
    const reqUrl = new URL(req.url);
    const isLocalhost = reqUrl.hostname === "localhost" || reqUrl.hostname === "127.0.0.1";
    // On VPS behind nginx, req.url is localhost:3000 — use NEXTAUTH_URL (public domain) instead
    const baseUrl = (isLocalhost && process.env.NEXTAUTH_URL)
      ? process.env.NEXTAUTH_URL.replace(/\/$/, "")
      : isLocalhost
      ? `http://${reqUrl.host}`
      : `${reqUrl.protocol}//${reqUrl.host}`;


    const entryPoint = path.resolve(process.cwd(), "src/remotion/index.tsx");

    // Pre-download external image URLs so Remotion doesn't fetch them during render
    // (external URLs may expire or be rate-limited → causes white frames)
    let resolvedScenes = scenes;
    if (!isAvatarMode && Array.isArray(scenes)) {
      resolvedScenes = await Promise.all(
        scenes.map(async (sc: { imageUrl?: string | null; [key: string]: unknown }) => ({
          ...sc,
          imageUrl: sc.imageUrl ? await cacheImageLocally(sc.imageUrl, rendersDir, baseUrl) : sc.imageUrl,
        }))
      );
    }

    // For ShortVideo: resolve all relative paths → absolute URL so Remotion's Chromium can fetch
    // Remotion runs its own Chromium instance on a separate port — it cannot use relative paths.
    const stocksDir = path.join(process.cwd(), "stocks");
    function resolveStockUrl(url: string | undefined | null): string {
      if (!url) return url ?? "";
      // Normalise absolute URLs pointing to our own server → relative path
      if (url.startsWith("http://") || url.startsWith("https://")) {
        try {
          const u = new URL(url);
      if (
        u.pathname.startsWith("/api/stocks/") ||
        u.pathname.startsWith("/api/renders/stock-") ||
        u.pathname.startsWith("/renders/stock-")
      ) {
        url = u.pathname;
      } else {
        return url; // external URL, leave as-is
      }
    } catch {
      return url;
    }
  }
  // Client may send old /api/renders/stock-xxx.mp4 or /renders/stock-xxx.mp4 URLs
  // Only redirect to stocks/ if the file actually exists there — otherwise keep serving from renders/
  if (url.startsWith("/api/renders/stock-") || url.startsWith("/renders/stock-")) {
    const filename = url.startsWith("/api/renders/")
      ? url.slice("/api/renders/".length)
      : url.slice("/renders/".length);

    // Helper: find file by exact name or fuzzy numeric ID match
    function findInDir(dir: string, target: string): string | null {
      const exact = path.join(dir, target);
      if (fs.existsSync(exact) && fs.statSync(exact).size > 1_500) return target;
      // Extract numeric ID suffix e.g. "9001028" from "stock-xxx-student-studying-tex-9001028.mp4"
      const numMatch = target.match(/-(\d{5,10})\.mp4$/);
      if (!numMatch) return null;
      const numId = numMatch[1];
      try {
        const files = fs.readdirSync(dir);
        const found = files.find(f => f.endsWith(".mp4") && f.includes(numId));
        if (found) {
          const fp = path.join(dir, found);
          if (fs.statSync(fp).size > 1_500) return found;
        }
      } catch {}
      return null;
    }

    const stockFound = findInDir(stocksDir, filename);
    if (stockFound) {
      url = `/api/stocks/${stockFound}`;
    } else {
      const renderFound = findInDir(rendersDir, filename);
      if (renderFound) {
        url = `/api/renders/${renderFound}`;
      } else {
        throw new Error(`Stock file missing: ${url} — please re-fetch stock videos`);
      }
    }
  }
      if (!url.startsWith("/api/stocks/")) return url;

      const filename = url.slice("/api/stocks/".length);
      const srcPath = path.join(stocksDir, filename);
      const srcStat = fs.existsSync(srcPath) ? fs.statSync(srcPath) : null;
      if (!srcStat || srcStat.size <= 1_500) {
        throw new Error(`Stock file missing or too small: ${url} — please re-fetch stock videos`);
      }

      const symlinkPath = path.join(rendersDir, filename);
      if (!fs.existsSync(symlinkPath)) {
        try {
          fs.copyFileSync(srcPath, symlinkPath);
        } catch (copyErr) {
          console.warn(`[render] copy to renders/ failed for ${filename}, serving from stocks/ directly:`, copyErr);
        }
      }
      // Always serve from /api/stocks/ — renders/ copy is just a convenience mirror, not required
      return `${baseUrl}/api/stocks/${filename}`;
    }

    function toLocalFilePath(url: string): string | null {
      if (!url) return null;
      if (url.startsWith("/api/renders/")) return path.join(rendersDir, url.slice("/api/renders/".length));
      if (url.startsWith("/renders/")) return path.join(rendersDir, url.slice("/renders/".length));
      if (url.startsWith("/api/stocks/")) return path.join(stocksDir, url.slice("/api/stocks/".length));
      // absolute URL pointing to our own server
      try {
        const u = new URL(url);
        if (u.pathname.startsWith("/renders/")) return path.join(rendersDir, u.pathname.slice("/renders/".length));
        if (u.pathname.startsWith("/api/renders/")) return path.join(rendersDir, u.pathname.slice("/api/renders/".length));
        if (u.pathname.startsWith("/api/stocks/")) return path.join(stocksDir, u.pathname.slice("/api/stocks/".length));
      } catch {}
      return null;
    }

    function toLocalFilePathIfInternal(url: string): string | null {
      if (!url) return null;
      if (url.startsWith("/api/")) return toLocalFilePath(url);
      if (/^https?:\/\//.test(url)) {
        try {
          const parsed = new URL(url);
          if (parsed.origin === `${new URL(req.url).origin}`) {
            return toLocalFilePath(parsed.pathname);
          }
        } catch {
          return null;
        }
      }
      return null;
    }

    function assertExistingAsset(url: string, label: string) {
      const localPath = toLocalFilePathIfInternal(url);
      if (!localPath) return;
      if (!fs.existsSync(localPath) || fs.statSync(localPath).size <= 1_500) {
        throw new Error(`Missing ${label} asset: ${url}`);
      }
    }

    function toAbsolute(url: string | undefined | null): string {
      if (!url) return url ?? "";
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
      // Rewrite /music/ → /api/music/ so Next.js API route serves the file dynamically
      if (url.startsWith("/music/")) return `${baseUrl}/api/music/${url.slice("/music/".length)}`;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      return url;
    }

    // Probe actual video duration with ffmpeg — avoids "No frame found" errors
    // when config asks for a frame beyond the actual stock file length.
    // ffmpeg writes duration to stderr in format: "Duration: 00:00:51.30, ..."
    async function probeVideoDurationSec(localPath: string): Promise<number | null> {
      const ffmpeg = getFfmpegPath();
      return new Promise((resolve) => {
        const proc = spawn(ffmpeg, ["-i", localPath], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 5000);
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", () => {
          clearTimeout(timer);
          const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
          if (!m) { resolve(null); return; }
          const h = parseInt(m[1], 10), mn = parseInt(m[2], 10), s = parseFloat(m[3]);
          const total = h * 3600 + mn * 60 + s;
          resolve(Number.isFinite(total) && total > 0 ? total : null);
        });
        proc.on("error", () => { clearTimeout(timer); resolve(null); });
      });
    }

    let resolvedShortConfig = shortVideoConfig;
    if (isShortVideo && shortVideoConfig) {
      // Resolve each bgVideo — skip files that aren't in stocks/ (stale client state)
      // Also probe duration and clamp clipDuration/end-start to avoid out-of-range frames
      const resolvedBgVideos: typeof shortVideoConfig.bgVideos = [];
      for (const v of shortVideoConfig.bgVideos ?? []) {
        try {
          const resolvedSrc = toAbsolute(resolveStockUrl(v.src));
          // Probe local file for actual duration
          const localPath = toLocalFilePathIfInternal(resolvedSrc);
          let actualDur: number | null = null;
          if (localPath) actualDur = await probeVideoDurationSec(localPath);

          let safeClipDuration = v.clipDuration;
          let safeEnd = v.end;
          let safeClipOffset = v.clipOffset ?? 0;
          if (actualDur != null) {
            // 0.5s safety margin — compositor errors happen when the last frames
            // are missing from the container even though the duration header claims they exist
            const safeMax = Math.max(0.5, actualDur - 0.5);
            if (!safeClipDuration || safeClipDuration > safeMax) safeClipDuration = safeMax;
            const segLen = v.end - v.start;
            if (segLen > safeMax) {
              safeEnd = v.start + safeMax;
              console.warn(`[render] clamped bgVideo segment ${(v.end - v.start).toFixed(2)}s → ${(safeEnd - v.start).toFixed(2)}s (file is ${actualDur.toFixed(2)}s)`);
            }
            // Clamp clipOffset so startFrom never exceeds safe duration
            if (safeClipOffset >= safeMax) {
              safeClipOffset = safeClipOffset % safeMax;
            }
          }
          resolvedBgVideos.push({ ...v, src: resolvedSrc, end: safeEnd, clipDuration: safeClipDuration, clipOffset: safeClipOffset });
        } catch (e) {
          console.warn(`[render] skipping missing bgVideo: ${v.src} — ${(e as Error).message}`);
        }
      }
      if (resolvedBgVideos.length === 0) {
        throw new Error("ไม่มี stock video ที่ใช้ได้ — กรุณา RERUN ขั้นตอน Stock แล้วลองใหม่");
      }

      // Gap-fill pass: if a segment was clamped short, extend the NEXT segment's start
      // back to fill the gap — prevents black screen between clips (which makes subs
      // look out of sync even when timing is correct)
      for (let i = 0; i < resolvedBgVideos.length - 1; i++) {
        const cur  = resolvedBgVideos[i];
        const next = resolvedBgVideos[i + 1];
        if (next.start > cur.end + 0.04) {
          console.warn(`[render] gap ${cur.end.toFixed(2)}s→${next.start.toFixed(2)}s — extending next segment back`);
          next.start = cur.end;
        }
      }

      resolvedShortConfig = {
        ...shortVideoConfig,
        voiceFile: toAbsolute(resolveStockUrl(shortVideoConfig.voiceFile)),
        bgmFile: toAbsolute(resolveStockUrl(shortVideoConfig.bgmFile)),
        bgVideos: resolvedBgVideos,
      };
      if (resolvedShortConfig.voiceFile) assertExistingAsset(resolvedShortConfig.voiceFile, "voice");
      if (resolvedShortConfig.bgmFile) assertExistingAsset(resolvedShortConfig.bgmFile, "bgm");
      console.log("[render] stock assets prepared from stocks -> renders");
      console.log(`[render] voiceFile: ${resolvedShortConfig.voiceFile}`);
      console.log(`[render] bgmFile: ${resolvedShortConfig.bgmFile}`);
      resolvedShortConfig.bgVideos?.forEach((v: { src: string; start: number; end: number; clipDuration?: number; clipOffset?: number }, i: number) =>
        console.log(`[render] bgVideo[${i}]: start=${v.start.toFixed(2)} end=${v.end.toFixed(2)} dur=${((v.end-v.start)).toFixed(2)} clipDuration=${v.clipDuration ?? "?"} clipOffset=${v.clipOffset ?? 0} src=${v.src.split("/").pop()}`)
      );
    }

    // For SubtitleOverlay: resolve videoUrl → absolute URL
    let resolvedSubtitleConfig = subtitleOverlayConfig;
    if (isSubtitleOverlay && subtitleOverlayConfig) {
      const videoUrl = subtitleOverlayConfig.videoUrl;
      const resolvedUrl = videoUrl?.startsWith("/") ? `${baseUrl}${videoUrl}` : videoUrl;
      resolvedSubtitleConfig = { ...subtitleOverlayConfig, videoUrl: resolvedUrl };
      if (resolvedSubtitleConfig.videoUrl) assertExistingAsset(videoUrl!, "subtitle video");
      // Warmup /api/stocks route so Remotion doesn't timeout on first compile
      if (resolvedUrl?.includes("/api/stocks/")) {
        try { await fetch(resolvedUrl, { method: "HEAD" }); } catch {}
      }
    }

    // Clear stale progress file and register job immediately — before bundle build
    try { fs.writeFileSync(progressFile, JSON.stringify({ progress: 0 })); } catch {}
    setRenderJob(jobId, { status: "running", startedAt: Date.now() });
    incrementActiveRenderCount();

    // Fire-and-forget: bundle + render in background so HTTP response returns immediately.
    // Client polls /api/videos/render-progress for % and /api/videos/render-status?jobId= for result.
    let resolveDone!: () => void;
    const donePromise = new Promise<void>(resolve => { resolveDone = resolve; });
    renderJobDoneByUser.set(userId, donePromise);

    (async () => {
      let lastProgress = -1;
      let renderStartedAt = Date.now();
      try {
        console.log(`[Render] job=${jobId} starting, activeJobs=${getActiveRenderCount()}`);
        // Bundle (may be cached) — runs in background after jobId is returned
        // Use mtime+size fingerprint of all remotion source files to detect changes
        const remotionSrcDir = path.resolve(process.cwd(), "src/remotion");
        const remotionFingerprint = fs.readdirSync(remotionSrcDir)
          .filter(f => f.endsWith(".tsx") || f.endsWith(".ts"))
          .sort()
          .map(f => { const s = fs.statSync(path.join(remotionSrcDir, f)); return `${f}:${s.mtimeMs}:${s.size}`; })
          .join("|");
        if (
          cachedBundleLocation &&
          remotionFingerprint === cachedBundleMtime &&
          fs.existsSync(path.join(cachedBundleLocation, "index.html"))
        ) {
          console.log(`[Render] reusing cached bundle at ${cachedBundleLocation}`);
        } else {
          // Global bundle lock — if another job is already bundling, reuse that promise
          // instead of spawning a second webpack build (which would OOM the VPS).
          let inFlight = getBundleInProgress();
          if (!inFlight) {
            console.log("[Render] building new webpack bundle...");
            inFlight = bundle({ entryPoint, webpackOverride: (config: unknown) => config })
              .then((loc: string) => {
                cachedBundleLocation = loc;
                cachedBundleMtime = remotionFingerprint;
                saveBundleCache();
                setBundleInProgress(null);
                console.log(`[Render] bundle ready at ${cachedBundleLocation}`);
                return loc;
              })
              .catch((err: unknown) => { setBundleInProgress(null); throw err; });
            setBundleInProgress(inFlight);
          } else {
            console.log("[Render] waiting for concurrent bundle to finish...");
          }
          await inFlight;
        }
        const bundleLocation = cachedBundleLocation!;

        const compositionId = isSubtitleOverlay ? "SubtitleOverlayComposition" : isShortVideo ? "ShortVideoComposition" : isAvatarMode ? "AvatarComposition" : "VideoComposition";
        const inputProps = isSubtitleOverlay
          ? resolvedSubtitleConfig
          : isShortVideo
          ? resolvedShortConfig
          : isAvatarMode
          ? { avatarVideoUrl, captions: captionsData, captionStyleId: captionStyleId ?? "tiktok", customCaptionStyle: customCaptionStyle ?? null, positionY: positionY ?? 85, fontSizeOverride: fontSizeOverride ?? 0, fontWeightOverride: fontWeightOverride ?? 0 }
          : { scenes: resolvedScenes, audioUrl: audioUrl ?? null, captionSegments: captionsData };

        const composition = await selectComposition({
          serveUrl: bundleLocation,
          id: compositionId,
          inputProps,
          timeoutInMilliseconds: 120000,
        });

        if (isSubtitleOverlay && resolvedSubtitleConfig?.durationInFrames > 0) {
          composition.durationInFrames = resolvedSubtitleConfig.durationInFrames;
        } else if (isShortVideo && resolvedShortConfig?.durationInFrames > 0) {
          composition.durationInFrames = resolvedShortConfig.durationInFrames;
        } else if (!isAvatarMode && !isSubtitleOverlay) {
          composition.durationInFrames = durationInFrames;
          if (customWidth) composition.width = customWidth;
          if (customHeight) composition.height = customHeight;
        }

        const filename = `render-${Date.now()}.mp4`;
        const outputLocation = path.join(rendersDir, filename);

        const cpuCount = os.cpus().length;
        const freeMemGb = os.freemem() / (1024 * 1024 * 1024);
        const isCriticalLowMem = freeMemGb < 0.8;
        const isLowResourceHost = process.env.RENDER_LOW_RESOURCE === "1" || freeMemGb < 2.0;
        // Scale down threads-per-job as more jobs run in parallel — share CPU fairly
        const jobsNow = Math.max(1, getActiveRenderCount());
        const totalThreadBudget = Math.max(1, cpuCount - 1);
        const requestedConcurrency = Number(process.env.RENDER_CONCURRENCY);
        // RENDER_CONCURRENCY env var always wins — lets ecosystem.config.js override RAM check
        const renderConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
          ? Math.min(Math.max(1, requestedConcurrency), cpuCount)
          : isCriticalLowMem ? 1
          : isLowResourceHost ? Math.max(1, Math.floor(totalThreadBudget / jobsNow))
          : Math.max(1, Math.floor(totalThreadBudget / jobsNow));
        const requestedOffthreadCacheMb = Number(process.env.RENDER_OFFTHREAD_CACHE_MB);
        // Scale down cache per job when running many in parallel
        const baseCacheMb = isCriticalLowMem ? 32 : isLowResourceHost ? 64 : 128;
        const perJobCacheMb = Math.max(32, Math.floor(baseCacheMb / jobsNow));
        const offthreadVideoCacheSizeInBytes = Number.isFinite(requestedOffthreadCacheMb) && requestedOffthreadCacheMb >= 32
          ? Math.round(requestedOffthreadCacheMb * 1024 * 1024)
          : perJobCacheMb * 1024 * 1024;
        const jpegQualityFromEnv = process.env.RENDER_JPEG_QUALITY ? Number(process.env.RENDER_JPEG_QUALITY) : null;
        const jpegQuality = jpegQualityFromEnv ?? (Number.isFinite(Number(requestedJpegQuality)) && Number(requestedJpegQuality) > 0 ? Number(requestedJpegQuality) : (isCriticalLowMem ? 75 : isLowResourceHost ? 80 : 95));
        const isWindows = process.platform === "win32";
        const chromiumArgs = [
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
          "--no-sandbox",
          "--js-flags=--max-old-space-size=512",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-default-apps",
          "--gpu-process-limit=0",
          ...(isWindows ? [] : ["--disable-features=OutOfBlinkCors"]),
        ];
        console.log(`[Render] starting with concurrency=${renderConcurrency} (cpus=${cpuCount}), lowResource=${isLowResourceHost}, freeMemGb=${freeMemGb.toFixed(2)}, offthread=${offthreadVideoCacheSizeInBytes}`);
        renderStartedAt = Date.now();
        await recordTelemetryEvent(userId, {
          name: "render_server_started",
          category: "performance",
          source: "server",
          step: "render",
          status: "started",
          properties: {
            jobId,
            compositionId,
            activeJobs: jobsNow,
            cpuCount,
            renderConcurrency,
            freeMemGb: Number(freeMemGb.toFixed(2)),
            lowResource: isLowResourceHost,
            fps,
            jpegQuality,
          },
        }).catch(() => {});

        const { cancel, cancelSignal } = makeCancelSignal();
        activeRenderCancel.set(userId, cancel);
        cancelByJobId.set(jobId, cancel);

        await renderMedia({
          composition,
          serveUrl: bundleLocation,
          codec: "h264",
          outputLocation,
          inputProps,
          timeoutInMilliseconds: 7200000,
          concurrency: renderConcurrency,
          cancelSignal,
          x264Preset: isLowResourceHost ? "faster" : "medium",
          jpegQuality,
          offthreadVideoCacheSizeInBytes,
          chromiumOptions: {
            disableWebSecurity: true,
            ignoreCertificateErrors: true,
            gl: "swiftshader",
            args: chromiumArgs,
          },
          onProgress: ({ progress, renderedFrames }: { progress: number; renderedFrames?: number }) => {
            const p = Math.round(progress * 100);
            if (p !== lastProgress) {
              lastProgress = p;
              try {
                fs.writeFileSync(progressFile, JSON.stringify({ progress: p, jobId }));
              } catch {}
            }
            if (p % 5 === 0) {
              console.log(`[Render] ${p}% (${renderedFrames ?? "?"} frames) job=${jobId}`);
            }
          },
        });

        // Cleanup abort controller for this user if it's still ours
        activeRenderCancel.delete(userId);
        cancelByJobId.delete(jobId);
        decrementActiveRenderCount();
        resolveDone();

        // If a newer job was started for this user, discard this result silently
        if (latestJobPerUser.get(userId) !== jobId) {
          console.log(`[Render] job=${jobId} superseded by newer job — discarding result`);
          return;
        }

        const videoUrl = `/api/renders/${filename}`;
        setRenderJob(jobId, { status: "done", videoUrl, startedAt: getRenderJob(jobId)!.startedAt });
        try { fs.writeFileSync(progressFile, JSON.stringify({ progress: 100, jobId, videoUrl })); } catch {}
        await recordTelemetryEvent(userId, {
          name: "render_server_done",
          category: "performance",
          source: "server",
          step: "render",
          status: "done",
          durationMs: Date.now() - renderStartedAt,
          properties: {
            jobId,
            compositionId,
            activeJobs: jobsNow,
            renderConcurrency,
            freeMemGb: Number(freeMemGb.toFixed(2)),
            outputMb: fs.existsSync(outputLocation) ? Number((fs.statSync(outputLocation).size / (1024 * 1024)).toFixed(1)) : null,
          },
        }).catch(() => {});

        createNotification({
            userId,
            type: "VIDEO_COMPLETED",
            title: "วิดีโอสร้างเสร็จแล้ว",
            body: "วิดีโอของคุณ render เสร็จสมบูรณ์ พร้อมดาวน์โหลดได้แล้ว",
          }).catch(() => {});
      } catch (error) {
        activeRenderCancel.delete(userId);
        cancelByJobId.delete(jobId);
        decrementActiveRenderCount();
        resolveDone();

        // Intentional cancel (page refresh / new render) — not a real failure.
        // Don't log as error, don't mark job errored, don't notify the user.
        const detail = error instanceof Error ? error.message : String(error);
        const wasCancelled = /got cancelled|Request closed|cancelSignal|aborted/i.test(detail);
        await refundClipUsage(userId).catch(() => {});
        if (latestJobPerUser.get(userId) !== jobId) return; // superseded — ignore error too

        if (wasCancelled) {
          console.log(`[Render] job=${jobId} cancelled — skipping error notification`);
          const existing = getRenderJob(jobId);
          if (existing && existing.status === "running") {
            setRenderJob(jobId, { status: "error", error: "cancelled", startedAt: existing.startedAt });
          }
          await recordTelemetryEvent(userId, {
            name: "render_server_cancelled",
            category: "pipeline",
            source: "server",
            step: "render",
            status: "cancelled",
            durationMs: Date.now() - renderStartedAt,
            properties: { jobId },
          }).catch(() => {});
          return;
        }

        console.error("Render error:", error);
        setRenderJob(jobId, { status: "error", error: detail, startedAt: getRenderJob(jobId)!.startedAt });
        try { fs.writeFileSync(progressFile, JSON.stringify({ progress: -1, jobId, error: detail })); } catch {}
        await recordTelemetryEvent(userId, {
          name: "render_server_error",
          category: "error",
          source: "server",
          step: "render",
          status: "error",
          durationMs: Date.now() - renderStartedAt,
          properties: {
            jobId,
            message: detail.slice(0, 220),
          },
        }).catch(() => {});

        createNotification({
            userId,
            type: "VIDEO_FAILED",
            title: "วิดีโอสร้างไม่สำเร็จ",
            body: "เกิดข้อผิดพลาดระหว่างสร้างวิดีโอ กรุณาลองใหม่อีกครั้ง",
          }).catch(() => {});
      }
    })();

    return NextResponse.json({ jobId });
  } catch (error) {
    if (quotaReserved && reservedUserId) {
      await refundClipUsage(reservedUserId).catch(() => {});
    }
    console.error("Render setup error:", error);
    const detail = error instanceof Error ? error.message : String(error);
    if (reservedUserId) {
      await recordTelemetryEvent(reservedUserId, {
        name: "render_server_setup_error",
        category: "error",
        source: "server",
        step: "render",
        status: "error",
        durationMs: Date.now() - requestStartedAt,
        properties: { message: detail.slice(0, 220) },
      }).catch(() => {});
    }
    return NextResponse.json({ error: "เกิดข้อผิดพลาดในการสร้างวิดีโอ กรุณาลองใหม่", detail }, { status: 500 });
  }
}

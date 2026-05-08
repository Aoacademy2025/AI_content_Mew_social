import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import os from "os";

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

// In-process job registry (survives within same pm2 process)
type RenderJob = {
  status: "running" | "done" | "error";
  videoUrl?: string;
  error?: string;
  startedAt: number;
};
const renderJobs = new Map<string, RenderJob>();

export function getRenderJob(jobId: string): RenderJob | undefined {
  return renderJobs.get(jobId);
}

// Cache the Remotion webpack bundle across requests AND across pm2 restarts.
// Bundle path + mtime saved to the render tmp dir so pm2 restarts
// don't re-bundle from scratch (bundling takes 2-5 min on low-CPU VPS).
let cachedBundleLocation: string | null = null;
let cachedBundleMtime: number = 0;

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
  loadBundleCache();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const renderTmpDir = getRenderTmpDir();
    process.env.TMPDIR = renderTmpDir;
    const progressFile = path.join(renderTmpDir, `render-progress-${session.user.id}.json`);
    const { scenes, audioUrl, videoDuration, captions, captionSegments, avatarVideoUrl, captionStyleId, positionY, fontSizeOverride, fontWeightOverride, customCaptionStyle, width: customWidth, height: customHeight, shortVideoConfig, subtitleOverlayConfig } = await req.json();
    // Support both old `captionSegments` and new `captions` field names
    const captionsData = captions ?? captionSegments ?? [];

    // avatarVideoUrl mode: render avatar video + caption overlay
    const isAvatarMode = !!avatarVideoUrl;
    const isShortVideo = !!shortVideoConfig;
    const isSubtitleOverlay = !!subtitleOverlayConfig;

    if (!isSubtitleOverlay && !isShortVideo && !isAvatarMode && (!Array.isArray(scenes) || scenes.length === 0)) {
      return NextResponse.json({ error: "scenes, avatarVideoUrl, shortVideoConfig, or subtitleOverlayConfig is required" }, { status: 400 });
    }

    const fps = 30;
    const safeDuration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 60;
    const durationInFrames = Math.max(Math.round(safeDuration * fps), fps);
    // Note: AvatarComposition uses calculateMetadata to auto-detect duration from video,
    // so durationInFrames below is only used as fallback for non-avatar mode.

    // webpackIgnore prevents Turbopack from statically analyzing these imports
    // and traversing into esbuild native binaries (README.md, .node files).
    // serverExternalPackages ensures they're loaded from node_modules at runtime.
    const { bundle } = await import(/* webpackIgnore: true */ "@remotion/bundler" as string);
    const { renderMedia, selectComposition } = await import(/* webpackIgnore: true */ "@remotion/renderer" as string);

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
    const baseUrl = isLocalhost
      ? `http://${reqUrl.host}`
      : `${reqUrl.protocol}//${reqUrl.host}`;


    const entryPoint = path.resolve(process.cwd(), "src/remotion/index.tsx");

    // Reuse cached bundle if it still exists on disk (saves ~7GB per render)
    const entryMtime = fs.statSync(entryPoint).mtimeMs;
    if (
      cachedBundleLocation &&
      entryMtime === cachedBundleMtime &&
      fs.existsSync(path.join(cachedBundleLocation, "index.html"))
    ) {
      console.log(`[Render] reusing cached bundle at ${cachedBundleLocation}`);
    } else {
      console.log("[Render] building new webpack bundle...");
      cachedBundleLocation = await bundle({ entryPoint, webpackOverride: (config: unknown) => config });
      cachedBundleMtime = entryMtime;
      saveBundleCache();
      console.log(`[Render] bundle ready at ${cachedBundleLocation}`);
    }
    const bundleLocation = cachedBundleLocation;

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
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      return url;
    }

    let resolvedShortConfig = shortVideoConfig;
    if (isShortVideo && shortVideoConfig) {
      // Resolve each bgVideo — skip files that aren't in stocks/ (stale client state)
      const resolvedBgVideos: typeof shortVideoConfig.bgVideos = [];
      for (const v of shortVideoConfig.bgVideos ?? []) {
        try {
          const resolvedSrc = toAbsolute(resolveStockUrl(v.src));
          resolvedBgVideos.push({ ...v, src: resolvedSrc });
        } catch (e) {
          console.warn(`[render] skipping missing bgVideo: ${v.src} — ${(e as Error).message}`);
        }
      }
      if (resolvedBgVideos.length === 0) {
        throw new Error("ไม่มี stock video ที่ใช้ได้ — กรุณา RERUN ขั้นตอน Stock แล้วลองใหม่");
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
      resolvedSubtitleConfig = {
        ...subtitleOverlayConfig,
        videoUrl: videoUrl?.startsWith("/") ? `${baseUrl}${videoUrl}` : videoUrl,
      };
      if (resolvedSubtitleConfig.videoUrl) assertExistingAsset(resolvedSubtitleConfig.videoUrl, "subtitle video");
    }

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
      timeoutInMilliseconds: 60000,
    });

    // For non-avatar mode: override duration (and optionally dimensions) from client-supplied values.
    // For avatar mode: calculateMetadata already set the correct duration from the video.
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
    const isLowResourceHost = process.env.RENDER_LOW_RESOURCE === "1" || freeMemGb < 1.5;

    // --single-process + --no-zygote causes "Target closed" crashes on Linux VPS because
    // any one frame's crash kills all Chromium tabs. Use multi-process mode instead:
    // keep --no-zygote only, drop --single-process, and limit concurrency so we don't
    // exceed the number of stable Chromium instances the host can sustain.
    const requestedConcurrency = Number(process.env.RENDER_CONCURRENCY);
    const safeConcurrency = isLowResourceHost ? 1 : Math.min(2, Math.max(1, cpuCount - 1));
    const renderConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.min(Math.max(1, requestedConcurrency), cpuCount)
      : safeConcurrency;

    const requestedOffthreadCacheMb = Number(process.env.RENDER_OFFTHREAD_CACHE_MB);
    // OffthreadVideo cache: large enough to hold decoded frames across clips,
    // small enough to avoid OOM on VPS. Tune via RENDER_OFFTHREAD_CACHE_MB env.
    const offthreadVideoCacheSizeInBytes = Number.isFinite(requestedOffthreadCacheMb) && requestedOffthreadCacheMb >= 64
      ? Math.round(requestedOffthreadCacheMb * 1024 * 1024)
      : isLowResourceHost ? 64 * 1024 * 1024 : 128 * 1024 * 1024;

    const jpegQuality = process.env.RENDER_JPEG_QUALITY ? Number(process.env.RENDER_JPEG_QUALITY) : (isLowResourceHost ? 60 : 70);

    const isWindows = process.platform === "win32";
    const chromiumArgs = [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // --no-zygote without --single-process: each tab is its own process (stable),
      // but we avoid the zygote fork overhead that fails on many VPS kernels.
      "--no-zygote",
      // --no-sandbox required on Linux VPS (no user namespace support).
      // On Windows it's unnecessary but harmless.
      "--no-sandbox",
      // Reduce per-tab memory footprint
      "--js-flags=--max-old-space-size=512",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      // Prevent GPU process from being spawned (already disabled via --disable-gpu,
      // but this ensures the GPU host doesn't linger and consume file descriptors)
      "--gpu-process-limit=0",
      ...(isWindows ? [] : [
        // Linux: give each renderer its own shared memory namespace to avoid crashes
        "--disable-features=OutOfBlinkCors",
      ]),
    ];
    console.log(`[Render] starting with concurrency=${renderConcurrency} (cpus=${cpuCount}), lowResource=${isLowResourceHost}, freeMemGb=${freeMemGb.toFixed(2)}, offthread=${offthreadVideoCacheSizeInBytes}`);

    const jobId = `${session.user.id}-${Date.now()}`;
    renderJobs.set(jobId, { status: "running", startedAt: Date.now() });

    // Fire-and-forget: run render in background so HTTP response returns immediately.
    // Nginx default proxy_read_timeout is 60s — keeping the connection open for 2h causes 504.
    // Client polls /api/videos/render-progress for % and /api/videos/render-status?jobId= for result.
    (async () => {
      let lastProgress = -1;
      try {
        await renderMedia({
          composition,
          serveUrl: bundleLocation,
          codec: "h264",
          outputLocation,
          inputProps,
          timeoutInMilliseconds: 7200000,
          concurrency: renderConcurrency,
          x264Preset: "ultrafast",
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

        const videoUrl = `/api/renders/${filename}`;
        renderJobs.set(jobId, { status: "done", videoUrl, startedAt: renderJobs.get(jobId)!.startedAt });
        try { fs.writeFileSync(progressFile, JSON.stringify({ progress: 100, jobId, videoUrl })); } catch {}

        const session2 = await getServerSession(authOptions);
        if (session2?.user?.id) {
          createNotification({
            userId: session2.user.id,
            type: "VIDEO_COMPLETED",
            title: "วิดีโอสร้างเสร็จแล้ว",
            body: "วิดีโอของคุณ render เสร็จสมบูรณ์ พร้อมดาวน์โหลดได้แล้ว",
          }).catch(() => {});
        }
      } catch (error) {
        console.error("Render error:", error);
        const detail = error instanceof Error ? error.message : String(error);
        renderJobs.set(jobId, { status: "error", error: detail, startedAt: renderJobs.get(jobId)!.startedAt });
        try { fs.writeFileSync(progressFile, JSON.stringify({ progress: -1, jobId, error: detail })); } catch {}

        const session2 = await getServerSession(authOptions);
        if (session2?.user?.id) {
          createNotification({
            userId: session2.user.id,
            type: "VIDEO_FAILED",
            title: "วิดีโอสร้างไม่สำเร็จ",
            body: "เกิดข้อผิดพลาดระหว่างสร้างวิดีโอ กรุณาลองใหม่อีกครั้ง",
          }).catch(() => {});
        }
      }
    })();

    return NextResponse.json({ jobId });
  } catch (error) {
    console.error("Render setup error:", error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "เกิดข้อผิดพลาดในการสร้างวิดีโอ กรุณาลองใหม่", detail }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";
import path from "path";
import fs from "fs";

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
      return `${baseUrl}/renders/${filename}`;
    } catch {
      return url;
    }
  }
  // Local path e.g. "/renders/foo.png" — make it absolute
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return url;
}

export const maxDuration = 600;
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    // Derive base URL from request so Remotion's Chromium can fetch assets from Next.js server
    const reqUrl = new URL(req.url);
    const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;


    const entryPoint = path.resolve(process.cwd(), "src/remotion/index.tsx");
    const bundleLocation = await bundle({ entryPoint, webpackOverride: (config: unknown) => config });

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
    // Stock files (/api/stocks/*) are copied to public/renders/ before resolving so they survive
    // the beforeunload cleanup that deletes stocks/ while the render is still running.
    const stocksDir = path.join(process.cwd(), "stocks");
    const stockCopyMap = new Map<string, string>(); // /api/stocks/<f> → /renders/<f>

    function resolveStockUrl(url: string | undefined | null): string {
      if (!url) return url ?? "";
      if (!url.startsWith("/api/stocks/")) return url;
      if (stockCopyMap.has(url)) return stockCopyMap.get(url)!;
      const filename = url.slice("/api/stocks/".length);
      const srcPath = path.join(stocksDir, filename);
      const destPath = path.join(rendersDir, filename);
      if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
        try { fs.copyFileSync(srcPath, destPath); } catch (e) {
          console.warn(`[render] failed to copy stock file ${filename}:`, e);
        }
      }
      const resolved = `/renders/${filename}`;
      stockCopyMap.set(url, resolved);
      return resolved;
    }

    function toAbsolute(url: string | undefined | null): string {
      if (!url) return url ?? "";
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      return url;
    }

    let resolvedShortConfig = shortVideoConfig;
    if (isShortVideo && shortVideoConfig) {
      resolvedShortConfig = {
        ...shortVideoConfig,
        voiceFile: toAbsolute(resolveStockUrl(shortVideoConfig.voiceFile)),
        bgmFile: toAbsolute(resolveStockUrl(shortVideoConfig.bgmFile)),
        bgVideos: (shortVideoConfig.bgVideos ?? []).map((v: { src: string; start: number; end: number; clipOffset?: number }) => ({
          ...v,
          src: toAbsolute(resolveStockUrl(v.src)),
        })),
      };
      console.log(`[render] copied ${stockCopyMap.size} stock file(s) to renders/`);

      // Delete original stock files now that they've been copied to renders/ — safe to remove
      for (const stockUrl of stockCopyMap.keys()) {
        const filename = stockUrl.slice("/api/stocks/".length);
        const srcPath = path.join(stocksDir, filename);
        try { fs.unlinkSync(srcPath); } catch { /* ignore */ }
      }
    }

    // For SubtitleOverlay: resolve videoUrl → absolute URL
    let resolvedSubtitleConfig = subtitleOverlayConfig;
    if (isSubtitleOverlay && subtitleOverlayConfig) {
      const videoUrl = subtitleOverlayConfig.videoUrl;
      resolvedSubtitleConfig = {
        ...subtitleOverlayConfig,
        videoUrl: videoUrl?.startsWith("/") ? `${baseUrl}${videoUrl}` : videoUrl,
      };
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
    if (isSubtitleOverlay && resolvedSubtitleConfig?.durationInFrames) {
      composition.durationInFrames = resolvedSubtitleConfig.durationInFrames;
    } else if (isShortVideo && resolvedShortConfig?.durationInFrames) {
      composition.durationInFrames = resolvedShortConfig.durationInFrames;
    } else if (!isAvatarMode && !isSubtitleOverlay) {
      composition.durationInFrames = durationInFrames;
      if (customWidth) composition.width = customWidth;
      if (customHeight) composition.height = customHeight;
    }

    const filename = `render-${Date.now()}.mp4`;
    const outputLocation = path.join(rendersDir, filename);

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation,
      inputProps,
      timeoutInMilliseconds: 600000,
      concurrency: null,
      x264Preset: "ultrafast",
      jpegQuality: 80,
      chromiumOptions: { disableWebSecurity: true, ignoreCertificateErrors: true },
      onProgress: ({ progress }: { progress: number }) => {
        console.log(`[Render] ${Math.round(progress * 100)}%`);
      },
    });

    const videoUrl = `/api/renders/${filename}`;

    // Notify user that render completed
    const session2 = await getServerSession(authOptions);
    if (session2?.user?.id) {
      createNotification({
        userId: session2.user.id,
        type: "VIDEO_COMPLETED",
        title: "วิดีโอสร้างเสร็จแล้ว",
        body: "วิดีโอของคุณ render เสร็จสมบูรณ์ พร้อมดาวน์โหลดได้แล้ว",
      }).catch(() => {});
    }

    return NextResponse.json({ videoUrl });
  } catch (error) {
    console.error("Render error:", error);

    // Notify user that render failed
    const session2 = await getServerSession(authOptions);
    if (session2?.user?.id) {
      createNotification({
        userId: session2.user.id,
        type: "VIDEO_FAILED",
        title: "วิดีโอสร้างไม่สำเร็จ",
        body: "เกิดข้อผิดพลาดระหว่างสร้างวิดีโอ กรุณาลองใหม่อีกครั้ง",
      }).catch(() => {});
    }

    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "เกิดข้อผิดพลาดในการสร้างวิดีโอ กรุณาลองใหม่", detail }, { status: 500 });
  }
}

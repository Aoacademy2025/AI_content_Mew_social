import path from "path";
import fs from "fs";
import os from "os";
import { randomBytes } from "crypto";
import { resolveOffthreadCacheBytes } from "@/lib/offthread-cache";
import type { RenderResult } from "@/lib/render/types";
import type { CancelSignal } from "@remotion/renderer";
import {
  getBundleInProgress,
  setBundleInProgress,
  getActiveRenderCount,
  getActiveRenderSlots,
  getRenderSlotQueueLength,
  withRenderSlot,
  retainRemotionBundle,
} from "@/app/api/videos/render/cancel-registry";

/**
 * Fully-resolved render input the core consumes to produce an MP4. The legacy
 * route builds this (req-bound asset resolution, baseUrl, caching) and the
 * future worker will build it from the persisted RenderPayload. Everything here
 * is render-intrinsic: composition routing flags, already-resolved configs
 * (absolute URLs), duration/size overrides, and the bundle entry point.
 */
export type ResolvedRenderInput = {
  // composition routing (mutually-exclusive modes)
  isSubtitleOverlay: boolean;
  isShortVideo: boolean;
  isAvatarMode: boolean;
  // resolved per-mode input props
  resolvedSubtitleConfig: any;
  resolvedShortConfig: any;
  resolvedScenes: any;
  audioUrl: string | null;
  captionsData: unknown;
  avatarVideoUrl: string | null;
  // avatar caption-overlay overrides
  captionStyleId?: string;
  customCaptionStyle?: unknown;
  positionY?: number;
  fontSizeOverride?: number;
  fontWeightOverride?: number;
  // non-avatar size/duration overrides
  durationInFrames: number;
  customWidth?: number;
  customHeight?: number;
  fps: number;
  requestedJpegQuality?: unknown;
  // bundle + output locations
  entryPoint: string;
  bundlePublicDir: string;
  rendersDir: string;
  // shared bundle cache (process-level, lives on the caller so it is reused
  // across requests and survives hot-reloads — passed by reference)
  bundleCache: {
    get(): { location: string | null; mtime: string };
    set(location: string | null, mtime: string): void;
  };
};

/**
 * Optional render-orchestration hooks. These are NOT the render itself — they
 * let the caller observe/abort the render WITHOUT runRender ever touching the
 * job store, quota, or notifications (those stay caller-owned). All are
 * fail-open / no-op when omitted, so the core stays pure.
 */
export type RunRenderHooks = {
  /** Telemetry: a Remotion bundle had to be rebuilt mid-render. */
  recordBundleRetry?: (stage: string, reason: string) => Promise<void> | void;
  /** Telemetry: renderMedia is about to start (after slot acquired). */
  onRenderStart?: (info: {
    compositionId: string;
    activeJobs: number;
    activeRenderSlots: number;
    renderSlotLimit: number;
    renderQueueWaitMs: number;
    cpuCount: number;
    renderConcurrency: number;
    freeMemGb: number;
    fps: number;
    jpegQuality: number;
  }) => Promise<void> | void;
  /** Telemetry: render finished successfully. */
  onRenderDone?: (info: {
    compositionId: string;
    activeJobs: number;
    activeRenderSlots: number;
    renderSlotLimit: number;
    renderQueueWaitMs: number;
    renderConcurrency: number;
    freeMemGb: number;
    outputMb: number | null;
  }) => Promise<void> | void;
  /**
   * Supersession check. Returns true if this job has been superseded by a newer
   * one in the same scope; runRender then aborts cleanly by throwing a tagged
   * SupersededError (caller swallows it). Bookkeeping (job-state write, refund)
   * is fully owned by this callback in the caller.
   */
  checkSuperseded?: (stage: string) => Promise<boolean> | boolean;
  /**
   * Called inside the render slot, immediately after renderMedia succeeds and
   * BEFORE the success telemetry — the exact point where the legacy route ran
   * clearCancelHandles() + finishJob() + the "render_complete" supersession
   * check. Return true to abort cleanly (superseded): runRender throws a tagged
   * SupersededError. This preserves the legacy ordering (release bundle ref +
   * decrement active count BEFORE the render slot is released).
   */
  onRenderSucceeded?: () => Promise<boolean> | boolean;
  /** Register the renderMedia cancel handle with the caller's cancel registry. */
  onCancelHandle?: (cancel: () => void) => void;
  /**
   * The render is waiting behind the render-slot concurrency limit. Carries the
   * 1-based queue position so the caller can surface it (the legacy route wrote
   * queuePosition into the progress file here). Fired once, before slot acquire.
   */
  onQueued?: (position: number) => void;
};

/** Thrown when the caller's checkSuperseded() reports this job was superseded. */
export class SupersededError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`render superseded at ${stage}`);
    this.name = "SupersededError";
    this.stage = stage;
  }
}

function getRenderJobConcurrencyLimit(): number {
  const cpuMax = Math.max(1, Math.min(4, os.cpus().length));
  const raw = Number(process.env.RENDER_JOB_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.max(1, Math.min(cpuMax, Math.floor(raw)));
}

function remotionBundleMissingReason(error: unknown): string | null {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${error.stack ?? ""}`
      : String(error);
  const mentionsBundle =
    /remotion-webpack-bundle|index\.html|getStaticCompositions|serveUrl|Remotion project/i.test(text);
  const looksMissing =
    /does not exist|could not be found|not found|404|ENOENT|verify that it is a Remotion project/i.test(text);
  return mentionsBundle && looksMissing ? text.slice(0, 220) : null;
}

/**
 * The render core: bundle -> selectComposition -> renderMedia -> output.
 * Moved verbatim from src/app/api/videos/render/route.ts (the in-process render
 * body) so the legacy route and a future worker share ONE render implementation.
 *
 * Pure render: it never touches the job store, never reserves/refunds quota, and
 * never writes setRenderJob. Progress flows through ctx.onProgress, cancellation
 * through ctx.cancelSignal, and the result is returned (never written). Telemetry
 * and supersession are caller-owned, supplied via optional hooks.
 */
export async function runRender(
  payload: ResolvedRenderInput,
  ctx: {
    jobId: string;
    onProgress: (pct: number, phase?: string) => void;
    cancelSignal: CancelSignal;
    cancel?: () => void;
    hooks?: RunRenderHooks;
  },
): Promise<RenderResult> {
  // webpackIgnore prevents Turbopack from statically analyzing these imports
  // and traversing into esbuild native binaries (README.md, .node files).
  // serverExternalPackages ensures they're loaded from node_modules at runtime.
  const { bundle } = await import(/* webpackIgnore: true */ "@remotion/bundler" as string);
  const { renderMedia, selectComposition } = await import(
    /* webpackIgnore: true */ "@remotion/renderer" as string
  );

  const { jobId, onProgress, cancelSignal } = ctx;
  const hooks = ctx.hooks ?? {};
  const {
    isSubtitleOverlay,
    isShortVideo,
    isAvatarMode,
    resolvedSubtitleConfig,
    resolvedShortConfig,
    resolvedScenes,
    audioUrl,
    captionsData,
    avatarVideoUrl,
    captionStyleId,
    customCaptionStyle,
    positionY,
    fontSizeOverride,
    fontWeightOverride,
    durationInFrames,
    customWidth,
    customHeight,
    fps,
    requestedJpegQuality,
    entryPoint,
    bundlePublicDir,
    rendersDir,
    bundleCache,
  } = payload;

  let lastProgress = -1;

  const checkSuperseded = async (stage: string) => {
    if (hooks.checkSuperseded && (await hooks.checkSuperseded(stage))) {
      throw new SupersededError(stage);
    }
  };
  const recordBundleRetry = async (stage: string, reason: string) => {
    await hooks.recordBundleRetry?.(stage, reason);
  };

  // Bundle (may be cached). Use mtime+size fingerprint of all remotion source
  // files to detect changes.
  const remotionSrcDir = path.resolve(process.cwd(), "src/remotion");
  const remotionFingerprint = fs
    .readdirSync(remotionSrcDir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .sort()
    .map((f) => {
      const s = fs.statSync(path.join(remotionSrcDir, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    })
    .join("|");

  // Reuse the shared cached bundle when its fingerprint matches and index.html
  // is present, otherwise build once under a global lock (concurrent jobs await
  // the same build, not a 2nd one that would OOM the VPS).
  const ensureBundle = async (forceRebuild = false): Promise<string> => {
    if (forceRebuild) {
      bundleCache.set(null, "");
    }
    const cached = bundleCache.get();
    if (
      !forceRebuild &&
      cached.location &&
      remotionFingerprint === cached.mtime &&
      fs.existsSync(path.join(cached.location, "index.html"))
    ) {
      console.log(`[Render] reusing cached bundle at ${cached.location}`);
      return cached.location;
    }
    let inFlight = getBundleInProgress();
    if (!inFlight) {
      console.log("[Render] building new webpack bundle...");
      inFlight = bundle({
        entryPoint,
        publicDir: bundlePublicDir,
        webpackOverride: (config: unknown) => config,
      })
        .then((loc: string) => {
          bundleCache.set(loc, remotionFingerprint);
          setBundleInProgress(null);
          console.log(`[Render] bundle ready at ${loc}`);
          return loc;
        })
        .catch((err: unknown) => {
          setBundleInProgress(null);
          throw err;
        });
      setBundleInProgress(inFlight);
    } else {
      console.log("[Render] waiting for concurrent bundle to finish...");
    }
    return inFlight!; // non-null after the branch above (assigned or already in-flight)
  };

  // Bundle ref-counting (PR #73): hold a ref on the in-use bundle so the
  // tmp-cleanup cron / a concurrent render's cleanup cannot delete it mid-render
  // (TOCTOU). Retain on each set, release the prior, and release whatever is
  // held in the finally below — for the whole render, exactly as the legacy
  // route's useBundleLocation/releaseBundleRef did.
  let bundleLocation = "";
  const bundleRefs: { release: (() => void) | null } = { release: null };
  const useBundleLocation = (nextLocation: string) => {
    bundleRefs.release?.();
    bundleLocation = nextLocation;
    bundleRefs.release = retainRemotionBundle(nextLocation);
  };

  try {
    useBundleLocation(await ensureBundle());
    // TOCTOU guard: a concurrent render's tmp-cleanup (or the media-cleanup cron)
    // can delete the shared bundle between ensureBundle() and selectComposition()
    // below → "index.html could not be found" 404. If it vanished, drop the cache
    // and rebuild once.
    if (!fs.existsSync(path.join(bundleLocation, "index.html"))) {
      console.log(`[Render] cached bundle ${bundleLocation} vanished before composition — rebuilding`);
      await recordBundleRetry("pre_composition", "bundle index.html missing before selectComposition");
      useBundleLocation(await ensureBundle(true));
    }
    await checkSuperseded("bundle");

  const compositionId = isSubtitleOverlay
    ? "SubtitleOverlayComposition"
    : isShortVideo
    ? "ShortVideoComposition"
    : isAvatarMode
    ? "AvatarComposition"
    : "VideoComposition";
  const inputProps = isSubtitleOverlay
    ? resolvedSubtitleConfig
    : isShortVideo
    ? resolvedShortConfig
    : isAvatarMode
    ? {
        avatarVideoUrl,
        captions: captionsData,
        captionStyleId: captionStyleId ?? "tiktok",
        customCaptionStyle: customCaptionStyle ?? null,
        positionY: positionY ?? 85,
        fontSizeOverride: fontSizeOverride ?? 0,
        fontWeightOverride: fontWeightOverride ?? 0,
      }
    : { scenes: resolvedScenes, audioUrl: audioUrl ?? null, captionSegments: captionsData };

  const selectCurrentComposition = () =>
    selectComposition({
      serveUrl: bundleLocation,
      id: compositionId,
      inputProps,
      timeoutInMilliseconds: 120000,
    });
  const applyCompositionOverrides = (
    target: Awaited<ReturnType<typeof selectComposition>>,
  ) => {
    if (isSubtitleOverlay && resolvedSubtitleConfig?.durationInFrames > 0) {
      target.durationInFrames = resolvedSubtitleConfig.durationInFrames;
    } else if (isShortVideo && resolvedShortConfig?.durationInFrames > 0) {
      target.durationInFrames = resolvedShortConfig.durationInFrames;
    } else if (!isAvatarMode && !isSubtitleOverlay) {
      target.durationInFrames = durationInFrames;
      if (customWidth) target.width = customWidth;
      if (customHeight) target.height = customHeight;
    }
    return target;
  };

  let composition: Awaited<ReturnType<typeof selectComposition>>;
  try {
    composition = applyCompositionOverrides(await selectCurrentComposition());
  } catch (error) {
    const reason = remotionBundleMissingReason(error);
    if (!reason) throw error;
    console.log(`[Render] bundle missing at selectComposition for job=${jobId} — rebuilding once`);
    await recordBundleRetry("select_composition", reason);
    useBundleLocation(await ensureBundle(true));
    composition = applyCompositionOverrides(await selectCurrentComposition());
  }

  // Render outputs are served world-readable by /api/renders, so the filename is the
  // only thing protecting a paid user's private video — use 128-bit crypto randomness
  // (was 6 base36 chars, trivially guessable within the render's time window).
  const filename = `render-${Date.now()}-${randomBytes(16).toString("hex")}.mp4`;
  const outputLocation = path.join(rendersDir, filename);

  const renderSlotLimit = getRenderJobConcurrencyLimit();
  const queuePosition =
    getActiveRenderSlots() >= renderSlotLimit ? getRenderSlotQueueLength() + 1 : 0;
  if (queuePosition > 0) {
    hooks.onQueued?.(queuePosition);
    console.log(`[Render] job=${jobId} queued at position ${queuePosition} (limit=${renderSlotLimit})`);
  }

  const renderQueueStartedAt = Date.now();

  await withRenderSlot(renderSlotLimit, async () => {
    const renderQueueWaitMs = Date.now() - renderQueueStartedAt;
    await checkSuperseded("render_slot");
    onProgress(0, "rendering");

    const cpuCount = os.cpus().length;
    const freeMemGb = os.freemem() / (1024 * 1024 * 1024);
    const isCriticalLowMem = freeMemGb < 0.8;
    const isLowResourceHost = process.env.RENDER_LOW_RESOURCE === "1" || freeMemGb < 2.0;
    // Scale down threads-per-job as more CPU-heavy renderMedia slots run in parallel.
    const activeJobs = Math.max(1, getActiveRenderCount());
    const activeRenderSlots = Math.max(1, getActiveRenderSlots());
    const totalThreadBudget = Math.max(1, cpuCount - 1);
    const requestedConcurrency = Number(process.env.RENDER_CONCURRENCY);
    // RENDER_CONCURRENCY env var always wins — lets ecosystem.config.js override RAM check
    const renderConcurrency =
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.min(Math.max(1, requestedConcurrency), cpuCount)
        : isCriticalLowMem
        ? 1
        : isLowResourceHost
        ? Math.max(1, Math.floor(totalThreadBudget / activeRenderSlots))
        : Math.max(1, Math.floor(totalThreadBudget / activeRenderSlots));
    const requestedOffthreadCacheMb = Number(process.env.RENDER_OFFTHREAD_CACHE_MB);
    // Scale down cache per job when running many renderMedia slots in
    // parallel; hard-capped at 1.5GB inside the resolver (PR-4 guardrail).
    const baseCacheMb = isCriticalLowMem ? 32 : isLowResourceHost ? 64 : 128;
    const offthreadVideoCacheSizeInBytes = resolveOffthreadCacheBytes({
      requestedMb: requestedOffthreadCacheMb,
      baseCacheMb,
      activeRenderSlots,
    });
    const jpegQualityFromEnv = process.env.RENDER_JPEG_QUALITY
      ? Number(process.env.RENDER_JPEG_QUALITY)
      : null;
    const jpegQuality =
      jpegQualityFromEnv ??
      (Number.isFinite(Number(requestedJpegQuality)) && Number(requestedJpegQuality) > 0
        ? Number(requestedJpegQuality)
        : isCriticalLowMem
        ? 75
        : isLowResourceHost
        ? 80
        : 95);
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
    console.log(
      `[Render] starting with concurrency=${renderConcurrency} (cpus=${cpuCount}), slots=${activeRenderSlots}/${renderSlotLimit}, queueWaitMs=${renderQueueWaitMs}, lowResource=${isLowResourceHost}, freeMemGb=${freeMemGb.toFixed(
        2,
      )}, offthread=${offthreadVideoCacheSizeInBytes}`,
    );
    await hooks.onRenderStart?.({
      compositionId,
      activeJobs,
      activeRenderSlots,
      renderSlotLimit,
      renderQueueWaitMs,
      cpuCount,
      renderConcurrency,
      freeMemGb: Number(freeMemGb.toFixed(2)),
      fps,
      jpegQuality,
    });

    if (ctx.cancel) hooks.onCancelHandle?.(ctx.cancel);

    let renderMediaRetriedForBundle = false;
    while (true) {
      try {
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
          onProgress: ({
            progress,
            renderedFrames,
          }: {
            progress: number;
            renderedFrames?: number;
          }) => {
            const p = Math.round(progress * 100);
            if (p !== lastProgress) {
              lastProgress = p;
              onProgress(progress * 100, "rendering");
            }
            if (p % 5 === 0) {
              console.log(`[Render] ${p}% (${renderedFrames ?? "?"} frames) job=${jobId}`);
            }
          },
        });
        break;
      } catch (error) {
        const reason = remotionBundleMissingReason(error);
        if (renderMediaRetriedForBundle || !reason) throw error;
        renderMediaRetriedForBundle = true;
        console.log(`[Render] bundle missing during renderMedia for job=${jobId} — rebuilding once`);
        await recordBundleRetry("render_media", reason);
        try {
          if (fs.existsSync(outputLocation)) fs.rmSync(outputLocation, { force: true });
        } catch {}
        useBundleLocation(await ensureBundle(true));
        composition = applyCompositionOverrides(await selectCurrentComposition());
        lastProgress = -1;
        await checkSuperseded("render_bundle_retry");
      }
    }

    // Legacy ordering: clearCancelHandles() + finishJob() + the "render_complete"
    // supersession check ran here, after renderMedia and before success telemetry.
    // The caller does that bookkeeping inside this hook; true => superseded.
    if (hooks.onRenderSucceeded && (await hooks.onRenderSucceeded())) {
      throw new SupersededError("render_complete");
    }

    onProgress(100, "done");
    await hooks.onRenderDone?.({
      compositionId,
      activeJobs,
      activeRenderSlots,
      renderSlotLimit,
      renderQueueWaitMs,
      renderConcurrency,
      freeMemGb: Number(freeMemGb.toFixed(2)),
      outputMb: fs.existsSync(outputLocation)
        ? Number((fs.statSync(outputLocation).size / (1024 * 1024)).toFixed(1))
        : null,
    });
  });

    return { videoUrl: `/api/renders/${filename}` };
  } finally {
    // Always release the bundle ref for this render (legacy finishJob did this).
    bundleRefs.release?.();
    bundleRefs.release = null;
  }
}

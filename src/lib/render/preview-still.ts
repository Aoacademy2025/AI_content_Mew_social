import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { prepareRemotionBundlePublicDir } from "@/lib/render/remotion-public-dir";
import {
  defaultPreviewCacheRoot,
  readRenderWorkerBundle,
  remotionSourceFingerprint,
} from "@/lib/render/remotion-bundle-pointer";

/**
 * W4 (get_preview_frame): ONE still frame of a composition, rendered in the web process with
 * Remotion's `renderStill` — the same compositions and props the export burns, never a video.
 *
 * Built for a shared 4-vCPU box during a live: the render worker is a separate process this never
 * touches; here at most ONE still renders at a time, with ONE caller allowed to wait for it (any
 * further caller is refused at once); every render has a hard deadline; and the output is an
 * in-memory buffer — Remotion's own frame/download dirs and the browser profile are removed when
 * the browser closes, so nothing per call is left on disk. The only files kept are the bundle
 * cache (one bundle, rebuilt only when src/remotion changes). The bundle itself is the render
 * worker's when it has published one; otherwise it is built by a separate low-priority process
 * (scripts/build-preview-bundle.mjs), never by webpack on this server's event loop.
 */

export const PREVIEW_STILL_SCALE = 0.5; // 1080x1920 → 540x960
export const PREVIEW_STILL_JPEG_QUALITY = 70;
export const PREVIEW_STILL_MAX_BYTES = 200_000;
export const PREVIEW_STILL_TIMEOUT_MS = 30_000;
// Worst case a call waits bundle (10 s) + queue (8 s) + render (30 s) — inside the MCP route's
// 60 s maxDuration (and nginx's 60 s proxy timeout) with room for the DB work around it.
/** How long a caller may wait for the one render slot before it is told to retry. */
export const PREVIEW_STILL_QUEUE_WAIT_MS = 8_000;
/** How long a caller may wait for a bundle build before it is told the preview is warming up. */
export const PREVIEW_STILL_BUNDLE_WAIT_MS = 10_000;

/** Tunables + test seams. Production never changes these. */
export const previewStillRuntime = {
  cacheRoot: defaultPreviewCacheRoot(),
  /** null = Remotion's own Chrome Headless Shell (what the render worker uses). */
  browserExecutable: null as string | null,
  timeoutMs: PREVIEW_STILL_TIMEOUT_MS,
  queueWaitMs: PREVIEW_STILL_QUEUE_WAIT_MS,
  bundleWaitMs: PREVIEW_STILL_BUNDLE_WAIT_MS,
};

// Same browser settings as the export render (run-render.ts), so the still matches it.
const CHROMIUM_OPTIONS = { disableWebSecurity: true, ignoreCertificateErrors: true, gl: "swiftshader" as const };
const remotionEnvVariables = () => ({
  NEXT_PUBLIC_SUBTITLE_FIT_V2: process.env.NEXT_PUBLIC_SUBTITLE_FIT_V2 ?? "1",
});

// Process-wide state, anchored on globalThis so every route bundle in the Next process shares it.
type SlotWaiter = { resolve: (release: (() => void) | null) => void; timer: ReturnType<typeof setTimeout> };
type BundleSource = "render-worker" | "cached" | "built";
type PreviewStillState = {
  busy: boolean;
  waiter: SlotWaiter | null;
  bundle: { location: string; fingerprint: string } | null;
  building: Promise<string> | null;
};
const globalForPreview = globalThis as unknown as { __heroPreviewStill?: PreviewStillState };
function state(): PreviewStillState {
  globalForPreview.__heroPreviewStill ??= { busy: false, waiter: null, bundle: null, building: null };
  return globalForPreview.__heroPreviewStill;
}

/** Test-only: forget the in-memory bundle and slot state (a fresh process). */
export function resetPreviewStillForTests(): void {
  globalForPreview.__heroPreviewStill = { busy: false, waiter: null, bundle: null, building: null };
}

// ── the one render slot ─────────────────────────────────────────────────────────────────────

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const s = state();
    const waiter = s.waiter;
    if (waiter) {
      s.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(makeRelease()); // hand the slot straight to the waiter (stays busy)
      return;
    }
    s.busy = false;
  };
}

/**
 * Take the single render slot. Free → granted now. Taken → wait up to `waitMs` in the ONE queue
 * place; if that place is already taken (or the wait runs out) → null, immediately.
 */
export function acquirePreviewSlot(waitMs = previewStillRuntime.queueWaitMs): Promise<(() => void) | null> {
  const s = state();
  if (!s.busy) {
    s.busy = true;
    return Promise.resolve(makeRelease());
  }
  if (s.waiter || waitMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter: SlotWaiter = {
      resolve,
      timer: setTimeout(() => {
        if (state().waiter === waiter) state().waiter = null;
        resolve(null);
      }, waitMs),
    };
    s.waiter = waiter;
  });
}

// ── the bundle ──────────────────────────────────────────────────────────────────────────────

const OWN_BUNDLE_DIR = "bundle";
const FINGERPRINT_MARKER = ".hero-preview-fingerprint";

export function ownPreviewBundleDir(): string {
  return path.join(previewStillRuntime.cacheRoot, OWN_BUNDLE_DIR);
}

function bundleUsable(location: string): boolean {
  return fs.existsSync(path.join(location, "index.html"));
}

function ownBundleFor(fingerprint: string): string | null {
  const dir = ownPreviewBundleDir();
  try {
    return fs.readFileSync(path.join(dir, FINGERPRINT_MARKER), "utf8") === fingerprint && bundleUsable(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** A webpack build that runs this long is stuck; kill it. */
const BUNDLE_BUILD_KILL_MS = 5 * 60_000;

/** Runs scripts/build-preview-bundle.mjs: webpack in its own low-priority process, never on the
 *  web server's event loop. Resolves once the child exited 0. */
function runBundleBuild(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const cwd = process.cwd();
    // Plain node, no inherited NODE_OPTIONS: the web process's flags (heap caps, conditions) are
    // for the server, not for a one-off webpack build.
    const child = spawn(process.execPath, [path.join(cwd, "scripts", "build-preview-bundle.mjs"), ...args], {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // best effort: the build still runs at normal priority
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), BUNDLE_BUILD_KILL_MS);
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`bundle build exited ${code ?? signal}: ${stderr.trim().slice(-300)}`));
    });
  });
}

/** One fixed directory, wiped and rebuilt — never more than one preview bundle on disk. */
async function buildOwnBundle(fingerprint: string): Promise<string> {
  const dir = ownPreviewBundleDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const startedAt = Date.now();
  await runBundleBuild([
    path.resolve(process.cwd(), "src/remotion/index.tsx"),
    prepareRemotionBundlePublicDir(),
    dir,
  ]);
  if (!bundleUsable(dir)) throw new Error("bundle build produced no index.html");
  fs.writeFileSync(path.join(dir, FINGERPRINT_MARKER), fingerprint);
  console.log(`[preview-still] bundle built in ${Date.now() - startedAt} ms`);
  return dir;
}

export type PreviewServeUrl =
  | { ok: true; serveUrl: string; source: BundleSource; bundleMs: number }
  | { ok: false; reason: "warming_up" | "bundle_failed" };

/**
 * The bundle to render from, cheapest first: this process's cached one → the render worker's
 * (published pointer) → our own on disk from an earlier boot → a new single-flight build. A build
 * that outlasts `bundleWaitMs` keeps running in the background and the caller hears "warming up".
 */
export async function resolvePreviewServeUrl(): Promise<PreviewServeUrl> {
  const s = state();
  const fingerprint = remotionSourceFingerprint();
  if (s.bundle && s.bundle.fingerprint === fingerprint && bundleUsable(s.bundle.location)) {
    return { ok: true, serveUrl: s.bundle.location, source: "cached", bundleMs: 0 };
  }
  const workerBundle = readRenderWorkerBundle(fingerprint, previewStillRuntime.cacheRoot);
  if (workerBundle) {
    s.bundle = { location: workerBundle, fingerprint };
    return { ok: true, serveUrl: workerBundle, source: "render-worker", bundleMs: 0 };
  }
  const onDisk = ownBundleFor(fingerprint);
  if (onDisk) {
    s.bundle = { location: onDisk, fingerprint };
    return { ok: true, serveUrl: onDisk, source: "cached", bundleMs: 0 };
  }

  const startedAt = Date.now();
  if (!s.building) {
    const build = buildOwnBundle(fingerprint)
      .then((location) => {
        state().bundle = { location, fingerprint };
        return location;
      })
      .finally(() => {
        if (state().building === build) state().building = null;
      });
    build.catch((error: unknown) => {
      console.error(`[preview-still] bundle build failed: ${(error as Error)?.message ?? String(error)}`);
    });
    s.building = build;
  }
  const building = s.building;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    building.then((location) => ({ location }), () => ({ failed: true as const })),
    new Promise<{ timeout: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), previewStillRuntime.bundleWaitMs);
    }),
  ]);
  clearTimeout(timer);
  if ("timeout" in outcome) return { ok: false, reason: "warming_up" };
  if ("failed" in outcome) return { ok: false, reason: "bundle_failed" };
  return { ok: true, serveUrl: outcome.location, source: "built", bundleMs: Date.now() - startedAt };
}

// ── the still ───────────────────────────────────────────────────────────────────────────────

export type PreviewStillResult =
  | { ok: true; jpeg: Buffer; width: number; height: number; renderMs: number }
  | { ok: false; reason: "busy" | "timeout" | "failed" };

class PreviewDeadlineError extends Error {
  constructor() {
    super("preview still deadline");
    this.name = "PreviewDeadlineError";
  }
}

/** Re-encode only when Remotion's JPEG is over the byte cap (rare at 540x960). */
async function fitJpeg(buffer: Buffer): Promise<Buffer> {
  let out = buffer;
  for (const quality of [55, 40]) {
    if (out.length <= PREVIEW_STILL_MAX_BYTES) break;
    out = await sharp(buffer).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (out.length > PREVIEW_STILL_MAX_BYTES) throw new Error(`preview still is ${out.length} bytes`);
  return out;
}

/**
 * Render frame `frame` of `compositionId` as a 540x960 JPEG. Waits for the one render slot
 * (`busy` when it can't get it); answers `timeout` at the deadline and closes the browser. The
 * slot is released only once the render has actually stopped (bounded), so a timed-out render
 * can never overlap the next one for long.
 */
export async function renderPreviewStill(input: {
  serveUrl: string;
  compositionId: string;
  inputProps: Record<string, unknown>;
  frame: number;
  durationInFrames: number;
}): Promise<PreviewStillResult> {
  const release = await acquirePreviewSlot();
  if (!release) return { ok: false, reason: "busy" };

  const startedAt = Date.now();
  let remotion;
  try {
    remotion = await import(/* webpackIgnore: true */ "@remotion/renderer" as string);
  } catch (error) {
    release();
    console.error(`[preview-still] cannot load @remotion/renderer: ${(error as Error)?.message ?? String(error)}`);
    return { ok: false, reason: "failed" };
  }
  const { openBrowser, selectComposition, renderStill, makeCancelSignal } = remotion;
  const { cancelSignal, cancel } = makeCancelSignal();
  const timeoutMs = previewStillRuntime.timeoutMs;
  let timedOut = false;
  let browser: { close: (opts: { silent: boolean }) => Promise<void> } | null = null;
  const closeBrowser = async () => {
    const open = browser;
    browser = null;
    if (open) await open.close({ silent: true }).catch(() => {});
  };

  const work = (async () => {
    const opened = await openBrowser("chrome", {
      browserExecutable: previewStillRuntime.browserExecutable,
      chromiumOptions: CHROMIUM_OPTIONS,
      logLevel: "error",
    });
    browser = opened;
    if (timedOut) throw new PreviewDeadlineError();
    const envVariables = remotionEnvVariables();
    const selected = await selectComposition({
      serveUrl: input.serveUrl,
      id: input.compositionId,
      inputProps: input.inputProps,
      puppeteerInstance: opened,
      envVariables,
      chromiumOptions: CHROMIUM_OPTIONS,
      timeoutInMilliseconds: timeoutMs,
      logLevel: "error",
    });
    if (timedOut) throw new PreviewDeadlineError();
    const composition = { ...selected, durationInFrames: input.durationInFrames };
    const { buffer } = await renderStill({
      composition,
      serveUrl: input.serveUrl,
      frame: input.frame,
      inputProps: input.inputProps,
      imageFormat: "jpeg",
      jpegQuality: PREVIEW_STILL_JPEG_QUALITY,
      scale: PREVIEW_STILL_SCALE,
      output: null,
      puppeteerInstance: opened,
      envVariables,
      chromiumOptions: CHROMIUM_OPTIONS,
      cancelSignal,
      timeoutInMilliseconds: timeoutMs,
      // One frame needs a few decoded frames, not Remotion's default (half of free RAM).
      offthreadVideoCacheSizeInBytes: 64 * 1024 * 1024,
      offthreadVideoThreads: 1,
      logLevel: "error",
    });
    if (!buffer) throw new Error("renderStill returned no buffer");
    return fitJpeg(buffer as Buffer);
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
      void closeBrowser();
      reject(new PreviewDeadlineError());
    }, timeoutMs);
  });

  try {
    const jpeg = await Promise.race([work, deadline]);
    const meta = await sharp(jpeg).metadata();
    return { ok: true, jpeg, width: meta.width ?? 0, height: meta.height ?? 0, renderMs: Date.now() - startedAt };
  } catch (error) {
    if (timedOut || error instanceof PreviewDeadlineError) return { ok: false, reason: "timeout" };
    console.error(`[preview-still] render failed: ${(error as Error)?.name ?? "Error"}: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    return { ok: false, reason: "failed" };
  } finally {
    clearTimeout(timer);
    if (!timedOut) {
      // `work` has settled: close the browser, then free the slot before answering.
      await closeBrowser();
      release();
    } else {
      // Timed out: answer now, but free the slot only once the render has really stopped (or
      // after a short grace if a browser call ignores the close) — never two renders at once.
      const settled = work.then(() => undefined, () => undefined);
      void Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 10_000))])
        .then(closeBrowser)
        .finally(release);
    }
  }
}

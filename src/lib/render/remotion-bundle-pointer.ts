import fs from "node:fs";
import path from "node:path";

/**
 * W4 (get_preview_frame): lets the web process reuse the Remotion bundle the render worker
 * already built instead of running a second webpack build on the shared box.
 *
 * The render worker keeps its bundle location in memory only (scripts/render-worker.ts). When
 * it caches one it now also publishes a small pointer file here; the preview reads it, and uses
 * that bundle only when the pointer was written for the SAME Remotion sources (fingerprint) and
 * the bundle's index.html still exists. Anything else — no pointer, an older deploy's pointer, a
 * bundle swept by media-cleanup — reads as "no worker bundle" and the preview builds its own.
 * Both sides fail soft: publishing never throws into a render, reading never throws into a tool.
 */

/** Where the preview keeps its own bundle and reads the worker's pointer. NOT under
 *  `.tmp/remotion` — media-cleanup sweeps everything in that directory by age. */
export function defaultPreviewCacheRoot(cwd = process.cwd()): string {
  return path.join(cwd, ".tmp", "remotion-preview");
}

const POINTER_FILE = "render-worker-bundle.json";

/**
 * The Remotion source fingerprint, computed exactly like `runRender`'s bundle cache key
 * (src/lib/render/run-render.ts: every .ts/.tsx in src/remotion, sorted, `name:mtimeMs:size`).
 * Kept as a copy so the render core stays untouched; if the two ever drift, the pointer simply
 * never matches and the preview builds its own bundle (slower, never wrong).
 */
export function remotionSourceFingerprint(cwd = process.cwd()): string {
  const remotionSrcDir = path.resolve(cwd, "src/remotion");
  return fs
    .readdirSync(remotionSrcDir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .sort()
    .map((f) => {
      const s = fs.statSync(path.join(remotionSrcDir, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    })
    .join("|");
}

/** Render worker side: record the bundle it just cached. `null` (a forced rebuild) is ignored. */
export function publishRenderWorkerBundle(
  location: string | null,
  fingerprint: string,
  root = defaultPreviewCacheRoot(),
): void {
  if (!location || !fingerprint) return;
  try {
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, POINTER_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ location, fingerprint, writtenAt: Date.now() }));
    fs.renameSync(temp, target);
  } catch (error) {
    console.warn(`[remotion-bundle-pointer] could not publish the worker bundle: ${(error as Error).message}`);
  }
}

/** Preview side: the worker's bundle for `fingerprint`, or null when there is no usable one. */
export function readRenderWorkerBundle(fingerprint: string, root = defaultPreviewCacheRoot()): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, POINTER_FILE), "utf8")) as {
      location?: unknown;
      fingerprint?: unknown;
    };
    if (raw.fingerprint !== fingerprint) return null;
    if (typeof raw.location !== "string" || !path.isAbsolute(raw.location)) return null;
    return fs.existsSync(path.join(raw.location, "index.html")) ? raw.location : null;
  } catch {
    return null;
  }
}

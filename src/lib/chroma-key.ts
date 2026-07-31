// Shared chroma-key detection + sanitization + ffmpeg filter builder.
//
// Single source of truth so the composite RENDER (src/app/api/heygen/composite/route.ts)
// and the editor PREVIEW (preview-frame / preview-bg) use the exact same key color, params
// and filter chain → the preview is WYSIWYG for the final render and the two can never drift.
//
// The chain fixes jagged/pixelated avatar edges by (1) auto-detecting the real green shade
// from the source, (2) scaling the avatar to its final display size and keying at FULL chroma
// resolution (yuva444p / 4:4:4) instead of on 4:2:0 half-res edges, (3) despilling green, and
// (4) feathering the alpha (erode 1px then blur — on the alpha plane only, face detail intact).
import fs from "fs";
import { execFile } from "child_process";
import { layoutGeometry, CANVAS_W, CANVAS_H, type AvatarLayout } from "@/lib/avatar-layout";
import {
  avatarFadeBlendFilter,
  normalizeAvatarFadeWindows,
  type AvatarFadeWindow,
} from "@/lib/avatar-fade";

export const DEFAULT_CHROMA_COLOR = "0x12FF05";

// Legacy v1 slider defaults. When a request carries EXACTLY this triple — or omits the params,
// which resolves to it — the color was never deliberately tuned by the user → auto-detect.
// Any OTHER explicit value = deliberate v1 slider tuning → honor it verbatim (still sanitized).
export const LEGACY_CHROMA_COLORS = ["0x00FF00", "0x12FF05"];
export const LEGACY_SIMILARITY = 0.28;
export const LEGACY_BLEND = 0.04;

// Defaults used on the auto-detect path. Similarity unchanged from v1; blend raised 0.04 → 0.10
// so keyed edges are softer (helps OLD 720p avatars too, not just new 1080p gens).
export const DEFAULT_SIMILARITY = 0.28;
export const DEFAULT_BLEND = 0.1;

const COLOR_RE = /^0x[0-9A-F]{6}$/i;
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export type ChromaParams = { color: string; similarity: number; blend: number };

// ── Sanitizers (every value below becomes an ffmpeg arg → treat as an injection surface) ──

/** Accept only `0x` + 6 hex digits; normalize to uppercase. Anything else → default. */
export function sanitizeChromaColor(raw: unknown): string {
  if (typeof raw === "string" && COLOR_RE.test(raw)) return "0x" + raw.slice(2).toUpperCase();
  return DEFAULT_CHROMA_COLOR;
}

/** chromakey similarity is valid in (0,1]; we clamp to a sane [0.01, 0.6]. */
export function clampSimilarity(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(0.6, Math.max(0.01, n)) : DEFAULT_SIMILARITY;
}

/** chromakey blend is valid in [0,1]; we clamp to a sane [0, 0.3]. */
export function clampBlend(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(0.3, Math.max(0, n)) : DEFAULT_BLEND;
}

function isLegacyDefaultTriple(color: string, similarity: number, blend: number): boolean {
  return LEGACY_CHROMA_COLORS.includes(color) && approx(similarity, LEGACY_SIMILARITY) && approx(blend, LEGACY_BLEND);
}

/**
 * Decide auto-detect vs honor-verbatim, returning SANITIZED params + a flag.
 * autoDetect=true → caller should fill `color` from detectChromaColor(); similarity/blend are the
 * new defaults. autoDetect=false → user deliberately tuned the sliders, honor their values.
 *
 * An OMITTED field counts as "not tuned" (= legacy) for the triple check, so a caller that passes
 * no chroma params (e.g. the preview routes) auto-detects, exactly like the render route which
 * passes the explicit legacy defaults. Only a deliberate non-legacy value opts out of auto-detect.
 */
export function resolveChromaParams(input: {
  chromaColor?: unknown;
  chromaSimilarity?: unknown;
  chromaBlend?: unknown;
}): { autoDetect: boolean } & ChromaParams {
  const colorProvided = input.chromaColor != null;
  const simProvided = input.chromaSimilarity != null;
  const blendProvided = input.chromaBlend != null;

  const color = colorProvided ? sanitizeChromaColor(input.chromaColor) : DEFAULT_CHROMA_COLOR;
  // Omitted fields fall back to the LEGACY values — both for the triple check below AND (if this
  // turns out to be a deliberate custom-color/honor-verbatim case) as the actual resolved value.
  // An omitted field was never "tuned" by the user, so it must never silently pick up the raised
  // auto-detect-only blend default (0.10) on a non-auto-detect path — that would make "honor
  // verbatim" not verbatim. DEFAULT_SIMILARITY === LEGACY_SIMILARITY today, but DEFAULT_BLEND !==
  // LEGACY_BLEND, which is exactly the drift this fixes.
  const similarity = simProvided ? clampSimilarity(input.chromaSimilarity) : LEGACY_SIMILARITY;
  const blend = blendProvided ? clampBlend(input.chromaBlend) : LEGACY_BLEND;

  if (isLegacyDefaultTriple(color, similarity, blend)) {
    return { autoDetect: true, color: DEFAULT_CHROMA_COLOR, similarity: DEFAULT_SIMILARITY, blend: DEFAULT_BLEND };
  }
  return { autoDetect: false, color, similarity, blend };
}

// ── Composite encode knobs (env-tunable) ──
// Single source of truth for CRF/preset resolution, shared by the composite route (real encodes)
// and the verify script (so the verify assertion exercises the SAME code path instead of a
// hand-built literal). CRF/preset become ffmpeg args → sanitize even though the env is
// admin-controlled: CRF must be an int in [0,51], preset must be a known x264 preset.
const X264_PRESETS = new Set([
  "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo",
]);

export function resolveCompositeEncode(): { crf: number; preset: string } {
  const n = parseInt(process.env.COMPOSITE_CRF ?? "", 10);
  const crf = Number.isFinite(n) && n >= 0 && n <= 51 ? n : 18;
  const p = process.env.COMPOSITE_PRESET;
  const preset = p && X264_PRESETS.has(p) ? p : "veryfast";
  return { crf, preset };
}

// ── Auto-detection ──

const DETECT_WIDTH = 160;
// Cache detection per avatar file (path + mtime + size). composite may run several times per
// video for re-layout; there's no need to re-decode a frame each time. Callers use per-request tmp
// paths, so real cache hits are rare — cap the map so it can't grow unbounded across the process
// lifetime (simplest possible eviction: drop the oldest insertion once at capacity).
const DETECT_CACHE_MAX = 32;
const detectCache = new Map<string, string>();

function cacheDetectedColor(key: string, color: string): void {
  if (detectCache.size >= DETECT_CACHE_MAX && !detectCache.has(key)) {
    const oldest = detectCache.keys().next().value;
    if (oldest !== undefined) detectCache.delete(oldest);
  }
  detectCache.set(key, color);
}

/** Test-only accessor so verify scripts can assert the eviction cap without reaching into module
 * internals (the Map itself is not exported to keep it read-only from the outside). */
export function _detectCacheSizeForTest(): number {
  return detectCache.size;
}

// ── Feather-filter support probe ──
// The alpha-feather step (erosion + gblur) is a hard dependency of buildKeyChain's default chain.
// The dev-verified ffmpeg is @ffmpeg-installer darwin-arm64; prod runs the linux-x64 peer build. If
// either filter is missing from a given ffmpeg build, the composite filter_complex fails to parse
// and the ffmpeg call errors — unlike detection, the keying path is NOT fail-open by itself, so
// callers must check this first and drop feathering when unsupported.
const featherSupportCache = new Map<string, Promise<boolean>>();
let featherWarned = false;

/**
 * Probe whether `ffmpegPath`'s build lists BOTH the `erosion` and `gblur` filters (`-filters`
 * output, one filter per line, name in a fixed column). Cached per ffmpegPath — concurrent callers
 * for the same path share one in-flight probe. Fail-open: any error/timeout → false (composite still
 * works, just without feathering), logged once via console.warn.
 */
export function featherSupported(ffmpegPath: string): Promise<boolean> {
  const cached = featherSupportCache.get(ffmpegPath);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    execFile(
      ffmpegPath,
      ["-hide_banner", "-filters"],
      { maxBuffer: 4 * 1024 * 1024, encoding: "utf8", timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          if (!featherWarned) {
            featherWarned = true;
            console.warn(`[chroma-key] featherSupported probe failed for ${ffmpegPath} — feathering disabled:`, err.message);
          }
          resolve(false);
          return;
        }
        const out = stdout ?? "";
        const hasErosion = /^\s*\S*\s+erosion\b/m.test(out);
        const hasGblur = /^\s*\S*\s+gblur\b/m.test(out);
        resolve(hasErosion && hasGblur);
      },
    );
  });

  featherSupportCache.set(ffmpegPath, probe);
  return probe;
}

function runFfmpegRaw(ffmpegPath: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Detection only decodes a single ~160px frame — 30s is generous; bounds a hung/corrupt input.
    execFile(ffmpegPath, args, { maxBuffer: 32 * 1024 * 1024, encoding: "buffer", timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

function median(nums: number[]): number {
  const a = nums.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/**
 * Channel-wise median of border regions the avatar body never covers: the two top corner blocks
 * plus a thin top edge strip. Robust to a moving subject / a stray non-green pixel.
 */
function medianBorderColor(buf: Buffer, w: number): { r: number; g: number; b: number } | null {
  const h = Math.floor(buf.length / 3 / w);
  if (h < 8 || w < 8) return null;
  const R: number[] = [];
  const G: number[] = [];
  const B: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 3;
    R.push(buf[i]);
    G.push(buf[i + 1]);
    B.push(buf[i + 2]);
  };
  const cb = Math.max(4, Math.round(w * 0.15)); // corner block ~15% of width
  for (let y = 0; y < cb; y++) {
    for (let x = 0; x < cb; x++) push(x, y);
    for (let x = w - cb; x < w; x++) push(x, y);
  }
  const strip = Math.max(2, Math.round(h * 0.03)); // top edge strip
  for (let y = 0; y < strip; y++) for (let x = 0; x < w; x++) push(x, y);
  if (!R.length) return null;
  return { r: median(R), g: median(G), b: median(B) };
}

/**
 * Auto-detect the green-screen key color from an avatar video (handles both 1080p and 720p
 * sources). Decodes one ~160px frame at t≈0.5s to raw rgb24, samples the border, and returns the
 * exact detected green when it's clearly green (g > r+40 && g > b+40), else DEFAULT_CHROMA_COLOR.
 * Fail-open: any error → default. Result is cached per file (path + mtime + size).
 */
export async function detectChromaColor(avatarPath: string, ffmpegPath: string): Promise<string> {
  let cacheKey = avatarPath;
  try {
    const st = fs.statSync(avatarPath);
    cacheKey = `${avatarPath}:${st.mtimeMs}:${st.size}`;
  } catch {
    /* fall through with path-only key */
  }
  const cached = detectCache.get(cacheKey);
  if (cached) return cached;

  let color = DEFAULT_CHROMA_COLOR;
  try {
    const buf = await runFfmpegRaw(ffmpegPath, [
      "-y",
      "-ss", "0.5",
      "-i", avatarPath,
      "-frames:v", "1",
      "-vf", `scale=${DETECT_WIDTH}:-1`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-",
    ]);
    const med = medianBorderColor(buf, DETECT_WIDTH);
    if (med && med.g > med.r + 40 && med.g > med.b + 40) {
      color = "0x" + [med.r, med.g, med.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
    }
  } catch {
    /* fail-open to default */
  }

  cacheDetectedColor(cacheKey, color);
  return color;
}

// ── Filter builders ──

/**
 * The chroma-key + despill (+ optional alpha-feather) chain, applied to the avatar stream AFTER it
 * has been scaled to its final display resolution. `format=yuva444p` forces full-chroma (4:4:4)
 * keying so edges aren't halved by the source's 4:2:0 subsampling. When `feather` is true (default)
 * the matte is eroded 1px and blurred — but ONLY on the alpha plane (erosion threshold0..2=0 leave
 * Y/U/V untouched; gblur planes=8 = alpha only), so the subject's color/detail is preserved while
 * the edge softens. When `feather` is false, the chain stops after despill — the pre-feather
 * known-good filter set (still with upscale-first + full-chroma + auto-detect). Callers must resolve
 * `feather` via `featherSupported()` first: not every ffmpeg build ships `erosion`/`gblur`, and
 * unlike detection this path is not fail-open on its own — an unsupported filter errors the encode.
 *
 * Every param is re-sanitized here so no unsafe value can reach the ffmpeg args regardless of caller.
 */
export function buildKeyChain(params: ChromaParams, feather = true): string {
  const color = sanitizeChromaColor(params.color);
  const similarity = clampSimilarity(params.similarity);
  const blend = clampBlend(params.blend);
  const chain = [
    "format=yuva444p",
    `chromakey=color=${color}:similarity=${similarity}:blend=${blend}`,
    "despill=type=green:mix=0.5:expand=0",
  ];
  if (feather) {
    chain.push("erosion=threshold0=0:threshold1=0:threshold2=0:threshold3=65535");
    chain.push("gblur=sigma=1.0:planes=8");
  }
  return chain.join(",");
}

/**
 * Full composite filter_complex: bg scaled to the 1080×1920 canvas, avatar scaled to its display
 * size and keyed AT that display resolution, then overlaid. Input [0:v]=bg, [1:v]=avatar.
 * layout=null → full-cover (avatar fills the canvas). Both paths key-at-display-resolution.
 * `feather` is forwarded to buildKeyChain — see its docstring; resolve via featherSupported() first.
 */
export function buildCompositeFilter(
  params: ChromaParams,
  layout: AvatarLayout | null,
  feather = true,
  avatarFadeWindows: readonly AvatarFadeWindow[] = [],
  cropToVisibleCanvas = false,
): string {
  const keyChain = buildKeyChain(params, feather);
  const fadeWindows = normalizeAvatarFadeWindows(avatarFadeWindows);
  const geometry = layout ? layoutGeometry(layout) : null;
  if (geometry && cropToVisibleCanvas) {
    const left = Math.max(0, -geometry.x);
    const top = Math.max(0, -geometry.y);
    const right = Math.min(geometry.w, CANVAS_W - geometry.x);
    const bottom = Math.min(geometry.h, CANVAS_H - geometry.y);
    if (right <= left || bottom <= top) {
      return `[0:v]scale=${CANVAS_W}:${CANVAS_H}:flags=lanczos,setsar=1[out]`;
    }
  }
  const backgroundFilter = fadeWindows.length > 0
    ? `[0:v]scale=${CANVAS_W}:${CANVAS_H}:flags=lanczos,setsar=1,split=2[bg][bg_fade]`
    : `[0:v]scale=${CANVAS_W}:${CANVAS_H}:flags=lanczos,setsar=1[bg]`;
  const overlayOutput = fadeWindows.length > 0 ? "avatar_composite" : "out";
  const fadeFilter = fadeWindows.length > 0
    ? avatarFadeBlendFilter({
        compositeLabel: overlayOutput,
        backgroundLabel: "bg_fade",
        outputLabel: "out",
        windows: fadeWindows,
      })
    : null;
  if (layout) {
    const { w, h, x, y } = geometry ?? layoutGeometry(layout);
    if (cropToVisibleCanvas) {
      const left = Math.max(0, -x);
      const top = Math.max(0, -y);
      const right = Math.min(w, CANVAS_W - x);
      const bottom = Math.min(h, CANVAS_H - y);
      const visibleW = right - left;
      const visibleH = bottom - top;
      const avatarFilter = left > 0 || top > 0 || visibleW < w || visibleH < h
        ? `[1:v]scale=${w}:${h}:flags=lanczos,crop=${visibleW}:${visibleH}:${left}:${top},${keyChain}[fg]`
        : `[1:v]scale=${w}:${h}:flags=lanczos,${keyChain}[fg]`;
      return [
        backgroundFilter,
        avatarFilter,
        `[bg][fg]overlay=${Math.max(0, x)}:${Math.max(0, y)}:format=auto[${overlayOutput}]`,
        ...(fadeFilter ? [fadeFilter] : []),
      ].join(";");
    }
    return [
      backgroundFilter,
      `[1:v]scale=${w}:${h}:flags=lanczos,${keyChain}[fg]`,
      `[bg][fg]overlay=${x}:${y}:format=auto[${overlayOutput}]`,
      ...(fadeFilter ? [fadeFilter] : []),
    ].join(";");
  }
  return [
    backgroundFilter,
    `[1:v]scale=${CANVAS_W}:${CANVAS_H}:flags=lanczos,${keyChain}[fg]`,
    `[bg][fg]overlay=0:0:format=auto[${overlayOutput}]`,
    ...(fadeFilter ? [fadeFilter] : []),
  ].join(";");
}

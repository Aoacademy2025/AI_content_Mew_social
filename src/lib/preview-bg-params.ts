// Param sanitization + deterministic cache naming for /api/heygen/preview-bg.
//
// Colocated here (not in the route file — Next 15 route modules may only export the HTTP
// handlers) so `scripts/verify-preview-bg.ts` can assert clamp/coercion behavior as pure
// functions, without going through HTTP or ffmpeg.
import crypto from "crypto";

const MIN_MAX_SEC = 1;
const MAX_MAX_SEC = 10;

/**
 * Clamp the requested fast-preview duration to [1, 10] seconds.
 * Omitted / non-finite input (e.g. `undefined`, `"evil"`) → `null`, meaning "no cap" — the
 * route keys the full clip, exactly like today's behavior for existing callers.
 */
export function resolveMaxSec(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_MAX_SEC, Math.max(MIN_MAX_SEC, n));
}

/** Coerce `halfRes` to a boolean — any truthy value scales the keyed output to 540px wide. */
export function resolveHalfRes(raw: unknown): boolean {
  return Boolean(raw);
}

/**
 * Deterministic cache key for (avatarVideoUrl, maxSec, halfRes) so re-opening the avatar-adjust
 * panel with the same inputs reuses the previously-keyed file on disk instead of re-running
 * ffmpeg. Replaces the old `Date.now()` output name, which never allowed a cache hit.
 */
export function previewBgCacheHash(avatarVideoUrl: string, maxSec: number | null, halfRes: boolean): string {
  const key = JSON.stringify([avatarVideoUrl, maxSec, halfRes]);
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
}

/** Output filename for a given (avatarVideoUrl, maxSec, halfRes) triple. */
export function previewBgOutputName(avatarVideoUrl: string, maxSec: number | null, halfRes: boolean): string {
  return `avatar-nobg-${previewBgCacheHash(avatarVideoUrl, maxSec, halfRes)}.webm`;
}

/**
 * Build the ffmpeg args for the preview-bg keying pass, given an already-resolved `keyChain`
 * (from `buildKeyChain` — never forked here, only a final scale is appended for halfRes).
 * Exported so the verify script exercises the EXACT same arg construction the route runs,
 * instead of a hand-duplicated copy that could silently drift from the real code.
 */
export function buildPreviewBgFfmpegArgs(opts: {
  keyChain: string;
  maxSec: number | null;
  halfRes: boolean;
  inputPath: string;
  outPath: string;
}): string[] {
  const vf = opts.halfRes ? `${opts.keyChain},scale=540:-2` : opts.keyChain;
  return [
    "-y",
    // maxSec as an INPUT option (before -i) so ffmpeg stops reading past it — faster than
    // decoding + keying the full clip then truncating the output.
    ...(opts.maxSec != null ? ["-t", String(opts.maxSec)] : []),
    "-i", opts.inputPath,
    "-vf", vf,
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-crf", "30", "-b:v", "0",
    "-an",
    opts.outPath,
  ];
}

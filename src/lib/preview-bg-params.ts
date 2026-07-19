// Param sanitization + deterministic cache naming for /api/heygen/preview-bg.
//
// Colocated here (not in the route file — Next 15 route modules may only export the HTTP
// handlers) so `scripts/verify-preview-bg.ts` can assert clamp/coercion behavior as pure
// functions, without going through HTTP or ffmpeg.
import crypto from "crypto";
import fs from "fs";
import path from "path";

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

// ── Atomic cache write + in-process de-dupe lock (review fix 07-06) ──
//
// Before this, the route checked `existsSync(outPath)` then had ffmpeg write DIRECTLY to
// `outPath`. Two concurrent requests for the SAME cache key (React StrictMode's double-effect,
// a quick close/reopen of the adjust panel, or two tabs) could both pass the existence check,
// then interleave their writes onto the same destination file — permanently poisoning the disk
// cache with a truncated/corrupt webm that every future cache-hit would serve.
//
// `ensureEncodedOnce` fixes both halves:
//   1. Atomicity — `encode` must write to the TEMP path it's given, never `outPath` directly.
//      On success the temp file is `fs.renameSync`'d onto `outPath` (atomic on POSIX — a reader
//      can never observe a partially-written file at the final path). On failure the temp file
//      is unlinked and the error rethrown.
//   2. De-dupe — an in-process `Map<outPath, Promise>` ensures only ONE caller ever actually
//      invokes `encode` for a given `outPath` at a time; every other concurrent caller for the
//      same key just awaits that single in-flight promise (and gets its result/error too). The
//      map entry is removed once the promise settles, so a later, unrelated request for the same
//      key (e.g. after the file was deleted) starts a fresh encode.
const inFlightEncodes = new Map<string, Promise<void>>();
let tmpSeq = 0;

export async function ensureEncodedOnce(outPath: string, encode: (tmpPath: string) => Promise<void>): Promise<void> {
  // Fast path — already cached. No lock needed for a read-only check.
  if (fs.existsSync(outPath)) return;

  const existing = inFlightEncodes.get(outPath);
  if (existing) return existing;

  const promise = (async () => {
    // Re-check inside the lock — another request may have finished between the fast-path check
    // above and this closure actually starting.
    if (fs.existsSync(outPath)) return;
    const dir = path.dirname(outPath);
    const tmpPath = path.join(dir, `.tmp-${process.pid}-${++tmpSeq}-${path.basename(outPath)}`);
    try {
      await encode(tmpPath);
      fs.renameSync(tmpPath, outPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  })();

  inFlightEncodes.set(outPath, promise);
  try {
    await promise;
  } finally {
    inFlightEncodes.delete(outPath);
  }
}

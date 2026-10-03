// Inputs the render route hands to Remotion's Chromium and to ffmpeg (moved out of
// src/app/api/videos/render/route.ts so they can be tested; a route file may only export
// its handlers).
//
// cacheImageLocally: a scene image URL is downloaded here (every redirect hop re-checked)
// and re-served from our own origin. When that fails for ANY reason the image is dropped:
// handing the original URL to Chromium would let it fetch a URL we could not, and follow
// redirects nobody re-checks.
//
// probeVideoDurationSec: reads a stored b-roll file with a pinned demuxer (G24) so a
// playlist stored under a media name cannot make ffmpeg open other files or URLs.
//
// cacheRemoteMediaLocally: Remotion's compositor opens every audio/video src with its own
// ffmpeg, which auto-detects the format and speaks http, hls and concat. A URL handed to it
// can therefore lead anywhere: a redirect, or a public .m3u8 that lists 127.0.0.1 entries.
// An external voice / music / base video is downloaded here instead (every hop re-checked,
// byte cap), must pass the upload ingest gate (a media signature + a decodable stream under
// a pinned demuxer), and the compositor is handed our own copy under renders/.
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { resolveStoredMediaDemuxer, safeInputArgs, type SafeInputDemuxer } from "@/lib/media-probe-args";
import { moveFile, safeDownloadToFile } from "@/lib/safe-download";
import { admitUserMediaFile } from "@/lib/upload-media-probe";

const MAX_SCENE_IMAGE_BYTES = 50 * 1024 * 1024;
const SCENE_IMAGE_TIMEOUT_MS = 15_000;

/** Download an external image URL to `rendersDir` and return an absolute URL on our own
 *  server, so Remotion's Chromium (which runs on its own port) can fetch it from Next.js. */
export async function cacheImageLocally(url: string, rendersDir: string, baseUrl: string): Promise<string> {
  if (!url) return url;
  // The WHATWG parser is what Chromium uses: it lower-cases the scheme and drops leading
  // whitespace and tabs/newlines, so "HTTP://…", " http://…" and "ht\ttp://…" are all URLs.
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (parsed.protocol === "data:") return url;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const ext = url.includes(".png") ? "png" : "jpg";
    const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    try {
      await safeDownloadToFile(parsed.toString(), path.join(rendersDir, filename), {
        maxBytes: MAX_SCENE_IMAGE_BYTES,
        timeoutMs: SCENE_IMAGE_TIMEOUT_MS,
        mode: 0o666, // as writeFileSync did: nginx serves /api/renders/ straight from disk
      });
    } catch {
      return "";
    }
    return `${baseUrl}/api/renders/${filename}`;
  }
  // Local path e.g. "/renders/foo.png" — make it absolute
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return url;
}

// Probe actual video duration with ffmpeg — avoids "No frame found" errors
// when config asks for a frame beyond the actual stock file length.
// ffmpeg writes duration to stderr in format: "Duration: 00:00:51.30, ..."
export async function probeVideoDurationSec(localPath: string): Promise<number | null> {
  const demuxer = resolveStoredMediaDemuxer(localPath, ["video", "image"]);
  if (!demuxer) return null;
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, [...safeInputArgs(demuxer), "-i", localPath], { stdio: ["ignore", "ignore", "pipe"] });
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

export type RemoteMediaKind = "audio" | "video";
export type RemoteMediaRefusal = "unsupported_url" | "download_failed" | "not_media";

// Video cap = the upload routes' 500 MB. The timeout keeps the download inside the render
// route's maxDuration (60 s).
const REMOTE_MEDIA_LIMITS: Record<RemoteMediaKind, { maxBytes: number; timeoutMs: number }> = {
  audio: { maxBytes: 200 * 1024 * 1024, timeoutMs: 50_000 },
  video: { maxBytes: 500 * 1024 * 1024, timeoutMs: 50_000 },
};

// The stored copy is named by what its bytes are, never by the URL.
const STORED_EXTENSION: Record<RemoteMediaKind, Partial<Record<SafeInputDemuxer, string>>> = {
  audio: { mov: "m4a", matroska: "webm", mp3: "mp3", wav: "wav", ogg: "ogg", aac: "aac", flac: "flac" },
  video: { mov: "mp4", matroska: "webm" },
};

/** Download an external audio/video URL, admit it through the ingest gate and store it under
 *  `rendersDir`. Returns our own URL for the copy, or why the URL was refused. */
export async function cacheRemoteMediaLocally(
  url: string,
  kind: RemoteMediaKind,
  rendersDir: string,
  baseUrl: string,
): Promise<{ ok: true; src: string } | { ok: false; reason: RemoteMediaRefusal }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unsupported_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "unsupported_url" };

  const temp = path.join(os.tmpdir(), `render-media-${randomUUID()}`);
  try {
    try {
      await safeDownloadToFile(parsed.toString(), temp, {
        ...REMOTE_MEDIA_LIMITS[kind],
        mode: 0o666, // as writeFileSync does: nginx serves /api/renders/ straight from disk
      });
    } catch {
      return { ok: false, reason: "download_failed" };
    }
    const demuxer = await admitUserMediaFile(temp, [kind]);
    const ext = demuxer ? STORED_EXTENSION[kind][demuxer] : undefined;
    if (!ext) return { ok: false, reason: "not_media" };
    const filename = `render-media-${randomUUID()}.${ext}`;
    moveFile(temp, path.join(rendersDir, filename));
    return { ok: true, src: `${baseUrl}/api/renders/${filename}` };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/** A render input the compositor would have to open but that is neither our own stored media
 *  nor an external file that passed cacheRemoteMediaLocally. */
export class RenderMediaRefusedError extends Error {
  readonly code = "render_media_unusable";
  constructor(public readonly field: string) {
    super(`render media refused: ${field}`);
    this.name = "RenderMediaRefusedError";
  }
}

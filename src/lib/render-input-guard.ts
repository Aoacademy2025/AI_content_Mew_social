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
import { spawn } from "child_process";
import path from "path";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { resolveStoredMediaDemuxer, safeInputArgs } from "@/lib/media-probe-args";
import { safeDownloadToFile } from "@/lib/safe-download";

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

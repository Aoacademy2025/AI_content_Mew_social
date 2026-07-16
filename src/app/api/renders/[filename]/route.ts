import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { Readable } from "stream";

export const runtime = "nodejs";

function parseByteRange(rangeHeader: string, total: number): { start: number; end: number } | null {
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;

  const rawStart = m[1] ?? "";
  const rawEnd = m[2] ?? "";
  const start = rawStart === "" ? 0 : Number.parseInt(rawStart, 10);
  const end = rawEnd === "" ? total - 1 : Number.parseInt(rawEnd, 10);

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return null;
  }

  return { start, end: Math.min(end, total - 1) };
}

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// No `Access-Control-Allow-Origin: *`: renders are served same-origin (the editor's
// <video>/<img>, downloads, and Remotion's Chromium all fetch from this same origin),
// so dropping the wildcard stops arbitrary sites from fetch()ing a user's private render
// without affecting any legitimate same-origin use.
const cors = {
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

function streamBody(stream: fs.ReadStream) {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

function baseHeaders(contentType: string, total: number) {
  return {
    "Content-Type": contentType,
    "Content-Length": String(total),
    "Accept-Ranges": "bytes",
    // SEC-12: this route has no ownership/auth check (128-bit random filenames make
    // enumeration impractical, so we're not adding one here — see route-level note
    // below), but "public" still lets shared/CDN caches store another user's render.
    // "private" keeps caching to the requesting browser only.
    "Cache-Control": "private, max-age=86400",
    ...cors,
  };
}

// SEC-12 note (deliberately NOT adding a stricter filename allowlist here):
// this single route already serves several legitimate, heterogeneous naming
// conventions written by different producers — render-<ts>-<32hex>.mp4 (run-render.ts),
// preview-<name>-<width>p.mp4 (low-res-preview-paths.ts), voice-preview-<provider>-<24hex>
// (voice-preview-cache.ts), upload-<uuid> (videos/upload/route.ts), thumb-<ts>-<rand>.jpg
// and img-<ts>-<rand> (videos/render/route.ts), plus stock-* passthrough copies whose
// names are arbitrary Pexels/Pixabay descriptions (also videos/render/route.ts). A
// regex tight enough to be meaningful would have to allow that stock-* case anyway,
// so it wouldn't meaningfully narrow the attack surface beyond what's already enforced
// below (no path separators + fs.existsSync) — but IS tight enough to risk 404ing a
// legitimate asset the next time a producer's naming convention drifts. Given renders/
// previews/voice-previews/uploads are 128-bit-random or sha256-derived (enumeration
// already impractical) and traversal is blocked, the marginal benefit doesn't justify
// that breakage risk. Ownership/expiry is also intentionally out of scope here per the
// task brief (nginx serves prod traffic — see deploy/nginx.conf `/renders/` alias — but
// note: that alias only matches bare "/renders/…"; every URL this codebase generates is
// "/api/renders/…", which nginx's `location /` proxies straight to THIS route, so it is
// the live prod serving path, not just a dev/fallback — confirmed before deciding no
// auth/ownership change was safe to make here without risking legitimate playback).
function resolveRenderFile(filename: string) {
  if (!filename || /[/\\]/.test(filename)) {
    return { error: NextResponse.json({ error: "Invalid filename" }, { status: 400 }) };
  }

  const filePath = path.join(process.cwd(), "public", "renders", filename);
  if (!fs.existsSync(filePath)) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "application/octet-stream";

  try {
    const total = fs.statSync(filePath).size;
    return { filePath, contentType, total };
  } catch (error) {
    console.error("[renders] stat failed:", error);
    return { error: NextResponse.json({ error: "Failed to read render file" }, { status: 500 }) };
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const resolved = resolveRenderFile(filename);
  if ("error" in resolved) return resolved.error;

  return new NextResponse(null, {
    status: 200,
    headers: baseHeaders(resolved.contentType, resolved.total),
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const resolved = resolveRenderFile(filename);
  if ("error" in resolved) return resolved.error;

  const rangeHeader = req.headers.get("range");

  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, resolved.total);
    if (parsed) {
      const { start, end } = parsed;
      const chunkSize = end - start + 1;
      return new NextResponse(streamBody(fs.createReadStream(resolved.filePath, { start, end })), {
        status: 206,
        headers: {
          "Content-Type": resolved.contentType,
          "Content-Range": `bytes ${start}-${end}/${resolved.total}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          // SEC-12: see baseHeaders() above — "private" so shared/CDN caches
          // don't store another user's render.
          "Cache-Control": "private, max-age=86400",
          ...cors,
        },
      });
    }

    return NextResponse.json(
      { error: "Invalid range" },
      { status: 416, headers: { "Content-Range": `bytes */${resolved.total}`, ...cors } }
    );
  }

  return new NextResponse(streamBody(fs.createReadStream(resolved.filePath)), {
    status: 200,
    headers: baseHeaders(resolved.contentType, resolved.total),
  });
}

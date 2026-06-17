import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { Readable } from "stream";

export const runtime = "nodejs";

function parseByteRange(rangeHeader: string, total: number): { start: number; end: number } | null {
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] === "" ? 0 : Number.parseInt(m[1], 10);
  const end = m[2] === "" ? total - 1 : Number.parseInt(m[2], 10);
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
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
    "Cache-Control": "public, max-age=86400",
    ...cors,
  };
}

function resolveMusicFile(filename: string) {
  if (!filename || /[/\\]/.test(filename)) {
    return { error: NextResponse.json({ error: "Invalid filename" }, { status: 400 }) };
  }

  const filePath = path.join(process.cwd(), "public", "music", filename);
  if (!fs.existsSync(filePath)) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "audio/mpeg";
  const total = fs.statSync(filePath).size;
  return { filePath, contentType, total };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const resolved = resolveMusicFile(filename);
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
  const resolved = resolveMusicFile(filename);
  if ("error" in resolved) return resolved.error;

  const rangeHeader = req.headers.get("range");

  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, resolved.total);
    if (!parsed) {
      return NextResponse.json(
        { error: "Invalid range" },
        { status: 416, headers: { "Content-Range": `bytes */${resolved.total}`, ...cors } }
      );
    }
    const { start, end } = parsed;
    const chunkSize = end - start + 1;
    return new NextResponse(streamBody(fs.createReadStream(resolved.filePath, { start, end })), {
      status: 206,
      headers: {
        "Content-Type": resolved.contentType,
        "Content-Range": `bytes ${start}-${end}/${resolved.total}`,
        "Content-Length": String(chunkSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
        ...cors,
      },
    });
  }

  return new NextResponse(streamBody(fs.createReadStream(resolved.filePath)), {
    status: 200,
    headers: baseHeaders(resolved.contentType, resolved.total),
  });
}

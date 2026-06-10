import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  if (!filename || /[/\\]/.test(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = path.join(process.cwd(), "public", "music", filename);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "audio/mpeg";
  const total = fs.statSync(filePath).size;
  const rangeHeader = req.headers.get("range");

  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, total);
    if (!parsed) return NextResponse.json({ error: "Invalid range" }, { status: 416 });
    const { start, end } = parsed;
    const chunkSize = end - start + 1;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(chunkSize);
      const read = fs.readSync(fd, buf, 0, chunkSize, start);
      const body = read === chunkSize ? buf : buf.slice(0, read);
      return new NextResponse(body, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${start + body.length - 1}/${total}`,
          "Content-Length": String(body.length),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
          ...cors,
        },
      });
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const fileBuffer = fs.readFileSync(filePath);
  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
      ...cors,
    },
  });
}

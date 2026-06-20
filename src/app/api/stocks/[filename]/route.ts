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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

function streamBody(stream: fs.ReadStream) {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

function baseHeaders(total: number, contentType: string = "video/mp4") {
  return {
    "Content-Type": contentType,
    "Content-Length": String(total),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400",
    ...cors,
  };
}

function resolveStockFile(filename: string) {
  if (!filename || /[/\\]/.test(filename)) {
    return { error: NextResponse.json({ error: "Invalid filename" }, { status: 400 }) };
  }

  const filePath = path.join(process.cwd(), "stocks", filename);
  if (!fs.existsSync(filePath)) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  try {
    const total = fs.statSync(filePath).size;
    return { filePath, total };
  } catch (error) {
    console.error("[stocks] stat failed:", error);
    return { error: NextResponse.json({ error: "Failed to read stock file" }, { status: 500 }) };
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
  const resolved = resolveStockFile(filename);
  if ("error" in resolved) return resolved.error;

  // kie.ai Ken Burns pipeline เก็บภาพ source (.jpg/.png) ไว้ใน stocks/ → ต้อง Content-Type ตรงชนิดไฟล์
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "video/mp4";

  return new NextResponse(null, {
    status: 200,
    headers: baseHeaders(resolved.total, contentType),
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const resolved = resolveStockFile(filename);
  if ("error" in resolved) return resolved.error;

  // kie.ai Ken Burns pipeline ก็เก็บภาพ source (.jpg/.png) ไว้ใน stocks/ ด้วย
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "video/mp4";

  const rangeHeader = req.headers.get("range");

  // Support Range requests — required for Remotion/Chromium to seek into videos
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
        "Content-Type": contentType,
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
    headers: baseHeaders(resolved.total, contentType),
  });
}

import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

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
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  if (!filename || /[/\\]/.test(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = path.join(process.cwd(), "public", "renders", filename);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "application/octet-stream";

  let total = 0;
  try {
    const stat = fs.statSync(filePath);
    total = stat.size;
  } catch (error) {
    console.error("[renders] stat failed:", error);
    return NextResponse.json({ error: "Failed to read render file" }, { status: 500 });
  }
  const rangeHeader = req.headers.get("range");

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };

  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, total);
    if (parsed) {
      const { start, end } = parsed;
      const chunkSize = end - start + 1;
      let fd: number | null = null;

      try {
        fd = fs.openSync(filePath, "r");
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
      } catch (error) {
        console.error("[renders] range read failed:", error);
        return NextResponse.json({ error: "Failed to read render range" }, { status: 500 });
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
      }
    }

    return NextResponse.json({ error: "Invalid range" }, { status: 416 });
  }

  try {
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
  } catch (error) {
    console.error("[renders] full read failed:", error);
    return NextResponse.json({ error: "Failed to read render file" }, { status: 500 });
  }
}

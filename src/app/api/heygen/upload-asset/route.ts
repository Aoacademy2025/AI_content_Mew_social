import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

export const maxDuration = 120;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

// POST /api/heygen/upload-asset
// Body: { fileUrl } — local /renders/xxx.mp4 หรือ /renders/img-xxx.png
// Returns: { assetId, publicUrl }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { fileUrl } = body ?? {};
  if (!fileUrl) return NextResponse.json({ error: "fileUrl required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = decrypt(user.heygenKey);

  const localPath = path.join(process.cwd(), "public", fileUrl);
  if (!fs.existsSync(localPath)) return NextResponse.json({ error: `File not found: ${fileUrl}` }, { status: 404 });

  const buffer = fs.readFileSync(localPath);
  const ext = path.extname(fileUrl).toLowerCase();
  const contentTypeMap: Record<string, string> = {
    ".mp4": "video/mp4", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  };
  const contentType = contentTypeMap[ext] ?? "application/octet-stream";

  console.log(`[upload-asset] uploading ${fileUrl} (${buffer.length}B, ${contentType})...`);
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": contentType, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  });
  const data = await res.json();
  console.log(`[upload-asset] status=${res.status}`, JSON.stringify(data));

  if (!res.ok || !data.data?.id) {
    return NextResponse.json({ error: `Upload failed: ${data.message ?? data.error ?? res.status}` }, { status: 500 });
  }

  return NextResponse.json({
    assetId: data.data.id,
    publicUrl: data.data.url,
    fileType: data.data.file_type,
  });
}

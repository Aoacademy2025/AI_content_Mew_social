import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * POST /api/videos/thumbnail/upload
 * FormData: { image: Blob, videoId: string, thumbnailConfig?: string (JSON) }
 *
 * Receives the canvas-exported JPEG from the client and saves it.
 * This ensures Thai fonts and all text render exactly as previewed.
 */
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await req.formData();
    const image = formData.get("image") as File | null;
    const videoId = formData.get("videoId") as string | null;
    const thumbnailConfigStr = formData.get("thumbnailConfig") as string | null;

    if (!image || !videoId)
      return NextResponse.json({ error: "image and videoId required" }, { status: 400 });

    // Ownership check: a caller may only set the thumbnail of their OWN video (prevents IDOR).
    // Fail fast before writing any file to disk.
    const owns = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM Video WHERE id = ? AND userId = ? LIMIT 1`,
      videoId,
      authUser.id,
    )) as unknown[];
    if (!owns || owns.length === 0)
      return NextResponse.json({ error: "Video not found" }, { status: 404 });

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Save image file
    const buffer = Buffer.from(await image.arrayBuffer());
    const filename = `thumb-${Date.now()}.jpg`;
    const outPath = path.join(rendersDir, filename);
    fs.writeFileSync(outPath, buffer);

    const thumbnailUrl = `/api/renders/${filename}`;

    // Save to DB using raw SQL (works without prisma generate for thumbnailConfig).
    // Scope by userId (defense-in-depth alongside the ownership check above).
    await prisma.$executeRawUnsafe(
      `UPDATE Video SET thumbnail = ?, thumbnailConfig = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
      thumbnailUrl,
      thumbnailConfigStr ?? null,
      videoId,
      authUser.id,
    ).catch(() => {});

    return NextResponse.json({ thumbnailUrl });
  } catch (error) {
    console.error("[thumbnail/upload] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

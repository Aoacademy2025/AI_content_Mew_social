import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
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
    const session = await getServerSession(authOptions);
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await req.formData();
    const image = formData.get("image") as File | null;
    const videoId = formData.get("videoId") as string | null;
    const thumbnailConfigStr = formData.get("thumbnailConfig") as string | null;

    if (!image || !videoId)
      return NextResponse.json({ error: "image and videoId required" }, { status: 400 });

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Save image file
    const buffer = Buffer.from(await image.arrayBuffer());
    const filename = `thumb-${Date.now()}.jpg`;
    const outPath = path.join(rendersDir, filename);
    fs.writeFileSync(outPath, buffer);

    const thumbnailUrl = `/renders/${filename}`;

    // Save to DB using raw SQL (works without prisma generate for thumbnailConfig)
    await prisma.$executeRawUnsafe(
      `UPDATE Video SET thumbnail = ?, thumbnailConfig = ?, updatedAt = datetime('now') WHERE id = ?`,
      thumbnailUrl,
      thumbnailConfigStr ?? null,
      videoId,
    ).catch(() => {});

    return NextResponse.json({ thumbnailUrl });
  } catch (error) {
    console.error("[thumbnail/upload] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

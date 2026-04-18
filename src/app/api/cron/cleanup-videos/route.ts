import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

// GET /api/cron/cleanup-videos
// Called by a cron job (or Vercel Cron) every day to delete expired videos.
// Protected by CRON_SECRET env variable.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();

  // Find all expired videos
  const expired = await prisma.video.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true, videoUrl: true, avatarVideoUrl: true, audioUrl: true, thumbnail: true },
  });

  if (expired.length === 0) {
    return NextResponse.json({ deleted: 0, message: "No expired videos" });
  }

  // Delete local files
  const publicDir = path.join(process.cwd(), "public");
  for (const video of expired) {
    for (const url of [video.videoUrl, video.avatarVideoUrl, video.audioUrl, video.thumbnail]) {
      if (!url) continue;
      try {
        // Only delete local files (paths starting with /)
        if (url.startsWith("/")) {
          const filePath = path.join(publicDir, url);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      } catch { /* ignore file errors */ }
    }
  }

  // Delete from database
  const { count } = await prisma.video.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  console.log(`[cron/cleanup-videos] Deleted ${count} expired videos`);
  return NextResponse.json({ deleted: count, message: `Deleted ${count} expired videos` });
}

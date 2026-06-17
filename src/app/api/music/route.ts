import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";

// GET /api/music — list all music tracks (available to all logged-in users)
export async function GET() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const [tracks, userTracks] = await Promise.all([
      prisma.music.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, filename: true, duration: true, createdAt: true },
      }),
      prisma.userMusic.findMany({
        where: { userId: authUser.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, filename: true, sizeBytes: true, duration: true, createdAt: true },
      }),
    ]);
    return NextResponse.json({ tracks, userTracks });
  } catch {
    return NextResponse.json({ tracks: [], userTracks: [] });
  }
}

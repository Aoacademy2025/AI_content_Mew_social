import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/music — list all music tracks (available to all logged-in users)
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tracks = await prisma.music.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, filename: true, duration: true, createdAt: true },
    });
    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ tracks: [] });
  }
}

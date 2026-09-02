import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { parseMusicMoodInput } from "@/lib/music-mood";
import path from "path";
import fs from "fs";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return null;
  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
  return authUser?.role === "ADMIN" ? authUser : null;
}

// GET /api/admin/music — list all tracks
export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const tracks = await prisma.music.findMany({ orderBy: { createdAt: "desc" } });
    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ tracks: [] });
  }
}

// POST /api/admin/music — upload new track
export async function POST(req: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const title = (formData.get("title") as string | null)?.trim();
  const moodResult = parseMusicMoodInput(formData.get("mood"));

  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  if (!moodResult.ok) return NextResponse.json({ error: "อารมณ์เพลงไม่ถูกต้อง" }, { status: 400 });
  const mood = moodResult.provided ? moodResult.mood : null;

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp3";
  const filename = `${Date.now()}-${title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.${ext}`;
  const musicDir = path.join(process.cwd(), "public", "music");
  fs.mkdirSync(musicDir, { recursive: true });

  const bytes = await file.arrayBuffer();
  fs.writeFileSync(path.join(musicDir, filename), Buffer.from(bytes));

  const track = await prisma.music.create({ data: { title, filename, mood } });
  return NextResponse.json({ track });
}

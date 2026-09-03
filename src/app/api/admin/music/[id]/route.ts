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

// DELETE /api/admin/music/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const track = await prisma.music.findUnique({ where: { id } });
  if (!track) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Delete file
  try {
    const filePath = path.join(process.cwd(), "public", "music", track.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}

  await prisma.music.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

// PATCH /api/admin/music/[id] — rename title and/or set the mood tag
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { title } = body as { title?: unknown };
  const moodResult = parseMusicMoodInput((body as { mood?: unknown })?.mood);
  if (!moodResult.ok) return NextResponse.json({ error: "อารมณ์เพลงไม่ถูกต้อง" }, { status: 400 });

  const data: { title?: string; mood?: string | null } = {};
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }
    data.title = title.trim();
  }
  if (moodResult.provided) data.mood = moodResult.mood;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }

  const track = await prisma.music.update({ where: { id }, data });
  return NextResponse.json({ track });
}

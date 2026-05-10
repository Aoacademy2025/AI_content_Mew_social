import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  return user?.role === "ADMIN" ? session : null;
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

// PATCH /api/admin/music/[id] — rename title
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { title } = await req.json().catch(() => ({}));
  if (!title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });

  const track = await prisma.music.update({ where: { id }, data: { title: title.trim() } });
  return NextResponse.json({ track });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const track = await prisma.userMusic.findFirst({
    where: { id, userId: authUser.id },
    select: { id: true, filename: true },
  });
  if (!track) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const filePath = path.join(process.cwd(), "public", "music", track.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}

  await prisma.userMusic.delete({ where: { id: track.id } });
  return NextResponse.json({ ok: true });
}

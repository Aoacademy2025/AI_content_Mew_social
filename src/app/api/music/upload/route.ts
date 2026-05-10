import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

// POST /api/music/upload — user uploads their own music file (stored temporarily for one render)
// Returns a URL that can be used as bgmFile in render
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

  const allowedTypes = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/aac", "audio/m4a", "audio/x-m4a"];
  if (!allowedTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|ogg|aac|m4a)$/i)) {
    return NextResponse.json({ error: "ไฟล์ต้องเป็น mp3, wav, ogg, aac หรือ m4a" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp3";
  const filename = `user-${session.user.id}-${Date.now()}.${ext}`;
  const musicDir = path.join(process.cwd(), "public", "music");
  fs.mkdirSync(musicDir, { recursive: true });

  const bytes = await file.arrayBuffer();
  fs.writeFileSync(path.join(musicDir, filename), Buffer.from(bytes));

  return NextResponse.json({ url: `/music/${filename}`, filename });
}

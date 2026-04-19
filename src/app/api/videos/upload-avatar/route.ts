import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
  if (!["mp4", "mov", "webm"].includes(ext)) {
    return NextResponse.json({ error: "Only mp4/mov/webm allowed" }, { status: 400 });
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const filename = `avatar-upload-${Date.now()}.${ext}`;
  const outPath = path.join(rendersDir, filename);

  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  return NextResponse.json({ url: `/api/renders/${filename}` });
}

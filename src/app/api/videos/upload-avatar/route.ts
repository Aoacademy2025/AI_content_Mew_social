import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const maxDuration = 600; // 10 min — supports large green-screen video uploads

const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { plan: true } });
  if (dbUser?.plan === "FREE") return NextResponse.json({ error: "Avatar ใช้ได้เฉพาะแผน Pro ขึ้นไป" }, { status: 403 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
  if (!["mp4", "mov", "webm"].includes(ext)) {
    return NextResponse.json({ error: "Only mp4/mov/webm allowed" }, { status: 400 });
  }

  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: "ไฟล์ใหญ่เกิน 2 GB" }, { status: 413 });
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const filename = `avatar-upload-${Date.now()}.${ext}`;
  const outPath = path.join(rendersDir, filename);

  // Stream write — avoid loading entire file into RAM
  const stream = fs.createWriteStream(outPath);
  const reader = file.stream().getReader();

  await new Promise<void>((resolve, reject) => {
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { stream.end(); break; }
          if (!stream.write(value)) {
            await new Promise<void>(r => stream.once("drain", r));
          }
        }
        stream.on("finish", resolve);
        stream.on("error", reject);
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    };
    pump();
  });

  return NextResponse.json({ url: `/api/renders/${filename}` });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB per upload
const MAX_FORM_OVERHEAD_BYTES = 2 * 1024 * 1024;
const MUSIC_QUOTA_BYTES: Record<string, number> = {
  PRO: 200 * 1024 * 1024,
  BUSINESS: 1024 * 1024 * 1024,
};

const ALLOWED_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/aac",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
]);
const ALLOWED_EXTS = new Set(["mp3", "wav", "ogg", "aac", "m4a"]);

function titleFromFilename(name: string) {
  const base = path.basename(name).replace(/\.[^.]+$/, "");
  return (base.replace(/[_-]+/g, " ").trim() || "Uploaded music").slice(0, 80);
}

function safeExt(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "mp3";
  return ALLOWED_EXTS.has(ext) ? ext : "mp3";
}

function isAllowedAudio(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ALLOWED_TYPES.has(file.type) || ALLOWED_EXTS.has(ext);
}

function jsonError(status: number, code: string, error: string) {
  return NextResponse.json({ code, error }, { status });
}

async function writeFileStream(file: File, outPath: string) {
  const stream = fs.createWriteStream(outPath);
  const reader = file.stream().getReader();
  await new Promise<void>((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            stream.end();
            break;
          }
          if (!stream.write(value)) {
            await new Promise<void>((r) => stream.once("drain", r));
          }
        }
      } catch (error) {
        stream.destroy(error instanceof Error ? error : undefined);
        reject(error);
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    };
    void pump();
  });
}

// POST /api/music/upload — user uploads reusable background music.
// Returns a URL that can be used as bgmFile in render.
export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return jsonError(401, "unauthorized", "Unauthorized");

  const dbUser = await prisma.user.findUnique({ where: { id: authUser.id }, select: { plan: true } });
  if (!dbUser || dbUser.plan === "FREE") return jsonError(403, "plan_required", "Music upload ใช้ได้เฉพาะแผน Pro ขึ้นไป");
  const quotaBytes = MUSIC_QUOTA_BYTES[dbUser.plan] ?? MUSIC_QUOTA_BYTES.PRO;

  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES + MAX_FORM_OVERHEAD_BYTES) {
    return jsonError(413, "file_too_large", "ไฟล์เพลงใหญ่เกิน 50MB");
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const title = (formData.get("title") as string | null)?.trim();
  if (!(file instanceof File)) return jsonError(400, "file_required", "file required");

  if (!isAllowedAudio(file)) {
    return jsonError(400, "unsupported_type", "ไฟล์ต้องเป็น mp3, wav, ogg, aac หรือ m4a");
  }
  // Security: reject filenames that contain path traversal sequences or path separators.
  // The saved filename is always a server-generated UUID, but we still gate on the
  // original name to block any future code paths that might use it directly.
  if (/[/\\]|\.\./.test(file.name)) {
    return jsonError(400, "invalid_filename", "ชื่อไฟล์ไม่ถูกต้อง");
  }
  if (file.size <= 0) return jsonError(400, "empty_file", "ไฟล์เพลงว่างหรืออ่านไม่ได้");
  if (file.size > MAX_FILE_BYTES) return jsonError(413, "file_too_large", "ไฟล์เพลงใหญ่เกิน 50MB");

  const usage = await prisma.userMusic.aggregate({
    where: { userId: authUser.id },
    _sum: { sizeBytes: true },
  });
  const usedBytes = usage._sum.sizeBytes ?? 0;
  if (usedBytes + file.size > quotaBytes) {
    const quotaMb = Math.round(quotaBytes / 1024 / 1024);
    return jsonError(413, "music_quota_exceeded", `พื้นที่เก็บเพลงเต็มแล้ว (${quotaMb}MB) ลบเพลงเก่าก่อนอัปโหลดเพิ่ม`);
  }

  const ext = safeExt(file.name);
  const filename = `user-${authUser.id}-${Date.now()}-${randomUUID()}.${ext}`;
  const musicDir = path.join(process.cwd(), "public", "music");
  fs.mkdirSync(musicDir, { recursive: true });
  const outPath = path.join(musicDir, filename);

  try {
    await writeFileStream(file, outPath);
    const sizeBytes = fs.statSync(outPath).size;
    const track = await prisma.userMusic.create({
      data: {
        userId: authUser.id,
        title: title ? title.slice(0, 80) : titleFromFilename(file.name),
        filename,
        sizeBytes,
        mimeType: file.type || null,
      },
      select: { id: true, title: true, filename: true, sizeBytes: true, duration: true, createdAt: true },
    });

    return NextResponse.json({ url: `/api/music/${filename}`, filename, track });
  } catch (error) {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOSPC") {
      return jsonError(507, "disk_full", "พื้นที่จัดเก็บบนเซิร์ฟเวอร์ไม่พอสำหรับอัปโหลดไฟล์นี้");
    }
    console.error("[music-upload] failed", error);
    return jsonError(500, "upload_failed", "อัปโหลดเพลงไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}

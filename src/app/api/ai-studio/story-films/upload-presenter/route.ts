import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import {
  registerStoryFilmPresenterAsset,
  StoryFilmError,
} from "@/lib/story-film.server";
import { probeVideoMedia } from "@/lib/video-media-probe.server";

export const runtime = "nodejs";
export const maxDuration = 600;

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_FORM_OVERHEAD_BYTES = 10 * 1024 * 1024;
const VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

function removeFile(filePath: string | null) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

async function streamFile(file: File, destination: string) {
  const output = fs.createWriteStream(destination, { flags: "wx" });
  const reader = file.stream().getReader();
  await new Promise<void>((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            output.end();
            return;
          }
          if (!output.write(value)) {
            await new Promise<void>((next) => output.once("drain", next));
          }
        }
      } catch (error) {
        output.destroy(error instanceof Error ? error : undefined);
        reject(error);
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    };
    void pump();
  });
}

export async function POST(request: Request) {
  let outputPath: string | null = null;
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES + MAX_FORM_OVERHEAD_BYTES) {
      return NextResponse.json({ error: "ไฟล์ใหญ่เกิน 500 MB" }, { status: 413 });
    }

    const form = await request.formData();
    const file = form.get("video");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "กรุณาเลือกวิดีโอ Presenter" }, { status: 400 });
    }
    const ext = extension(file.name);
    if (!VIDEO_EXTS.has(ext) || (file.type && !VIDEO_MIMES.has(file.type))) {
      return NextResponse.json({ error: "รองรับเฉพาะ mp4, mov และ webm" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "ไฟล์ต้องไม่ว่างและมีขนาดไม่เกิน 500 MB" }, { status: 413 });
    }
    if (!file.name || file.name.length > 255) {
      return NextResponse.json({ error: "ชื่อไฟล์ยาวเกินกำหนด" }, { status: 400 });
    }

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });
    const filename = `story-film-presenter-${randomUUID()}.${ext}`;
    outputPath = path.join(rendersDir, filename);
    await streamFile(file, outputPath);

    const writtenBytes = fs.statSync(outputPath).size;
    if (writtenBytes !== file.size) throw new Error("uploaded byte count mismatch");
    const metadata = await probeVideoMedia(outputPath);
    if (!metadata) {
      removeFile(outputPath);
      outputPath = null;
      return NextResponse.json({ error: "อ่าน duration หรือขนาดวิดีโอไม่ได้ กรุณาเลือกไฟล์ใหม่" }, { status: 422 });
    }

    const asset = await registerStoryFilmPresenterAsset(user.id, {
      url: `/api/renders/${filename}`,
      originalName: file.name,
      mimeType: file.type || `video/${ext}`,
      sizeBytes: writtenBytes,
      ...metadata,
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    removeFile(outputPath);
    if (error instanceof StoryFilmError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    }
    console.error("[story-film/upload-presenter] failed", error);
    return NextResponse.json({ error: "อัปโหลด Presenter ไม่สำเร็จ กรุณาลองใหม่" }, { status: 500 });
  }
}

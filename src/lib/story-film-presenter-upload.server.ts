import "server-only";

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerStoryFilmPresenterAsset } from "@/lib/story-film.server";
import { probeVideoMedia } from "@/lib/video-media-probe.server";

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_FORM_OVERHEAD_BYTES = 10 * 1024 * 1024;
const VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export class StoryFilmPresenterUploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "StoryFilmPresenterUploadError";
  }
}

function fail(status: number, message: string): never {
  throw new StoryFilmPresenterUploadError(status, message);
}

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

export async function uploadStoryFilmPresenter(
  request: Request,
  userId: string,
  expected?: { originalName: string; mimeType: string; sizeBytes: number },
) {
  let outputPath: string | null = null;
  try {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES + MAX_FORM_OVERHEAD_BYTES) {
      fail(413, "ไฟล์ใหญ่เกิน 500 MB");
    }

    const form = await request.formData();
    const file = form.get("video");
    if (!(file instanceof File)) fail(400, "กรุณาเลือกวิดีโอ Presenter");
    const ext = extension(file.name);
    if (!VIDEO_EXTS.has(ext) || (file.type && !VIDEO_MIMES.has(file.type))) {
      fail(400, "รองรับเฉพาะ mp4, mov และ webm");
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      fail(413, "ไฟล์ต้องไม่ว่างและมีขนาดไม่เกิน 500 MB");
    }
    if (!file.name || file.name.length > 255) fail(400, "ชื่อไฟล์ยาวเกินกำหนด");
    if (expected && (
      file.name.normalize("NFC") !== expected.originalName
      || file.type !== expected.mimeType
      || file.size !== expected.sizeBytes
    )) {
      fail(409, "ไฟล์ Presenter ไม่ตรงกับ upload grant");
    }

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });
    const filename = `story-film-presenter-${randomUUID()}.${ext}`;
    outputPath = path.join(rendersDir, filename);
    await streamFile(file, outputPath);

    const writtenBytes = fs.statSync(outputPath).size;
    if (writtenBytes !== file.size) throw new Error("uploaded byte count mismatch");
    const metadata = await probeVideoMedia(outputPath);
    if (!metadata) fail(422, "อ่าน duration หรือขนาดวิดีโอไม่ได้ กรุณาเลือกไฟล์ใหม่");
    if (!metadata.hasAudio) fail(422, "วิดีโอ Presenter ต้องมีเสียงบรรยาย");

    return await registerStoryFilmPresenterAsset(userId, {
      url: `/api/renders/${filename}`,
      originalName: file.name,
      mimeType: file.type || `video/${ext}`,
      sizeBytes: writtenBytes,
      ...metadata,
    });
  } catch (error) {
    removeFile(outputPath);
    throw error;
  }
}

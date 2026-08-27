import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { registerStoryFilmCharacterReference } from "@/lib/story-film-character.server";
import { StoryFilmError } from "@/lib/story-film.server";
import { storyFilmCharacterReferencesDir } from "@/lib/story-film-character-storage";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);
const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

function removeFile(filePath: string | null) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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
          if (done) { output.end(); return; }
          if (!output.write(value)) await new Promise<void>((next) => output.once("drain", next));
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let outputPath: string | null = null;
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: "รูปใหญ่เกิน 25 MB" }, { status: 413 });
    }
    const { id } = await params;
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) return NextResponse.json({ error: "กรุณาเลือกรูป Reference" }, { status: 400 });
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!IMAGE_EXTS.has(ext) || file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "รองรับ png, jpg และ webp ขนาดไม่เกิน 25 MB" }, { status: 413 });
    }
    const privateDir = storyFilmCharacterReferencesDir();
    const filename = `story-film-character-${randomUUID()}.${ext}`;
    const destination = path.join(privateDir, filename);
    outputPath = destination;
    await streamFile(file, destination);
    const sizeBytes = fs.statSync(destination).size;
    if (sizeBytes !== file.size) throw new Error("uploaded byte count mismatch");
    const metadata = await sharp(destination).metadata();
    if (!metadata.width || !metadata.height) throw new Error("unreadable image");
    const reference = await registerStoryFilmCharacterReference(user.id, id, {
      url: `story-film-private:${filename}`,
      originalName: file.name,
      mimeType: MIME_BY_EXT[ext],
      sizeBytes,
      width: metadata.width,
      height: metadata.height,
      viewLabel: typeof form.get("viewLabel") === "string" ? form.get("viewLabel") as string : null,
    });
    return NextResponse.json({ reference }, { status: 201 });
  } catch (error) {
    removeFile(outputPath);
    if (error instanceof StoryFilmError) {
      const status = error.code === "not_found" ? 404 : 422;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    console.error("[story-film/character-reference] failed", error);
    return NextResponse.json({ error: "อัปโหลด Character Reference ไม่สำเร็จ" }, { status: 500 });
  }
}

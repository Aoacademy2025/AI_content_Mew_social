import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { completeStoryFilmGenerationJob } from "@/lib/story-film-generation-queue.server";
import { isStoryFilmWorkerAuthorized } from "@/lib/story-film-worker-auth.server";
import { probeMediaDurationMs, probeVideoMedia } from "@/lib/video-media-probe.server";

export const runtime = "nodejs";
export const maxDuration = 600;

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  json: "application/json",
};

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
          if (done) {
            output.end();
            return;
          }
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

function parseMetadata(value: FormDataEntryValue | null): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  if (value.length > 20_000) throw new Error("metadata_too_large");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_metadata");
  return parsed as Record<string, unknown>;
}

function maxBytesForMime(mimeType: string) {
  if (mimeType.startsWith("image/")) return MAX_IMAGE_BYTES;
  if (mimeType.startsWith("audio/")) return MAX_AUDIO_BYTES;
  if (mimeType === "application/json") return MAX_JSON_BYTES;
  return MAX_BYTES;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isStoryFilmWorkerAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let outputPath: string | null = null;
  try {
    const { id } = await params;
    const form = await request.formData();
    const workerId = form.get("workerId");
    const leaseToken = form.get("leaseToken");
    const file = form.get("artifact");
    if (typeof workerId !== "string" || typeof leaseToken !== "string" || !(file instanceof File)) {
      return NextResponse.json({ error: "workerId, leaseToken and artifact are required" }, { status: 400 });
    }
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) return NextResponse.json({ error: "unsupported artifact type" }, { status: 400 });
    const maxBytes = maxBytesForMime(mimeType);
    if (file.size <= 0 || file.size > maxBytes) {
      return NextResponse.json({
        error: "artifact_size_invalid",
        message: `artifact must be 1 byte to ${Math.floor(maxBytes / (1024 * 1024))} MB for ${mimeType}`,
      }, { status: 413 });
    }

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });
    const filename = `story-film-artifact-${id}-${randomUUID()}.${ext}`;
    outputPath = path.join(rendersDir, filename);
    await streamFile(file, outputPath);
    const sizeBytes = fs.statSync(outputPath).size;
    if (sizeBytes !== file.size) throw new Error("uploaded byte count mismatch");

    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;
    if (mimeType.startsWith("image/")) {
      const metadata = await sharp(outputPath).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
    } else if (mimeType.startsWith("video/")) {
      const metadata = await probeVideoMedia(outputPath);
      if (!metadata) throw new Error("unreadable_video_artifact");
      ({ width, height, durationMs } = metadata);
    } else if (mimeType.startsWith("audio/")) {
      durationMs = await probeMediaDurationMs(outputPath);
      if (!durationMs) throw new Error("unreadable_audio_artifact");
    } else if (mimeType === "application/json") {
      JSON.parse(fs.readFileSync(outputPath, "utf8"));
    }

    const result = await completeStoryFilmGenerationJob({
      jobId: id,
      workerId,
      leaseToken,
      artifact: {
        storageUrl: `/api/renders/${filename}`,
        mimeType,
        sizeBytes,
        width,
        height,
        durationMs,
        metadata: parseMetadata(form.get("metadata")),
      },
    });
    if (result.idempotent) {
      removeFile(outputPath);
      outputPath = null;
    }
    return NextResponse.json(result);
  } catch (error) {
    removeFile(outputPath);
    return NextResponse.json({
      error: "artifact_rejected",
      message: error instanceof Error ? error.message : "Artifact completion failed",
    }, { status: 409 });
  }
}

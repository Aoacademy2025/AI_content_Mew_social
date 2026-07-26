import "server-only";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import type { RunpodImageOutput } from "@/lib/runpod-serverless";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";

export type AiGenerationImageOutput = RunpodImageOutput | {
  filename: string;
  type: "external_url";
  data: string;
};

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function imageExtension(filename: string): { ext: string; mime: string } {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return { ext: ".jpg", mime: "image/jpeg" };
  if (ext === ".webp") return { ext: ".webp", mime: "image/webp" };
  return { ext: ".png", mime: "image/png" };
}

async function persistImageBytes(bytes: Buffer, originalFilename: string, contentType?: string): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Runpod returned an invalid or oversized image");
  }
  const inferred = imageExtension(originalFilename);
  const mime = contentType === "image/jpeg" || contentType === "image/webp" || contentType === "image/png"
    ? contentType
    : inferred.mime;
  const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : inferred.ext;
  const filename = `ai-image-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;

  if ((process.env.BLOB_READ_WRITE_TOKEN ?? "").trim()) {
    const blob = await put(`ai-studio/${filename}`, bytes, {
      access: "public",
      addRandomSuffix: false,
      contentType: mime,
    });
    return blob.url;
  }

  if (process.env.NODE_ENV === "production" && process.env.AI_STUDIO_ALLOW_LOCAL_OUTPUTS !== "1") {
    throw new Error("Configure Runpod S3 output or BLOB_READ_WRITE_TOKEN before production image generation");
  }
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  fs.writeFileSync(path.join(rendersDir, filename), bytes);
  return `/api/renders/${filename}`;
}

export async function persistAiGenerationImage(image: AiGenerationImageOutput): Promise<string> {
  if (image.type === "s3_url") {
    const url = new URL(image.data);
    if (url.protocol !== "https:") throw new Error("Runpod returned a non-HTTPS image URL");
    return url.toString();
  }

  if (image.type === "temporary_url" || image.type === "external_url") {
    const url = new URL(image.data);
    if (url.protocol !== "https:") throw new Error("Image provider returned a non-HTTPS image URL");
    if (image.type === "temporary_url" && url.hostname !== "image.runpod.ai") {
      throw new Error("Runpod returned an untrusted temporary image URL");
    }
    await assertSafeFetchUrl(url.toString());
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Runpod image download failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new Error("Runpod returned an oversized image");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
    if (contentType && !["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      throw new Error("Runpod returned a non-image payload");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return persistImageBytes(bytes, image.filename, contentType);
  }

  const base64 = image.data.replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, "");
  return persistImageBytes(Buffer.from(base64, "base64"), image.filename);
}

/** Backwards-compatible name for existing Runpod-only callers and verification. */
export const persistRunpodImage = persistAiGenerationImage;

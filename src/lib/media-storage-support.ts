import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  MediaArea,
  MediaByteRange,
  MediaIdentity,
} from "@/lib/media-storage";

const IMPLEMENTATION_MEDIA_AREAS: readonly MediaArea[] = ["renders", "stocks"];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export function safeMediaIdentity(identity: MediaIdentity): MediaIdentity {
  if (!IMPLEMENTATION_MEDIA_AREAS.includes(identity.area)) {
    const error = new Error("invalid media identity");
    error.name = "InvalidMediaIdentityError";
    throw error;
  }

  const filename = identity.filename;
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename !== path.basename(filename) ||
    /[/\\\0\r\n]/.test(filename) ||
    Buffer.byteLength(filename, "utf8") > 255
  ) {
    const error = new Error("invalid media identity");
    error.name = "InvalidMediaIdentityError";
    throw error;
  }

  return { area: identity.area, filename };
}

export function mediaContentType(filename: string): string {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export async function sha256MediaFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function mediaFileDigests(filePath: string): Promise<{
  sha256: string;
  contentMd5Base64: string;
}> {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  return {
    sha256: sha256.digest("hex"),
    contentMd5Base64: md5.digest("base64"),
  };
}

export function sha256MediaBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function safeMediaFileStat(filePath: string) {
  const stat = await lstat(filePath).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    const error = new Error("media file is not a non-empty regular file");
    error.name = "UnsafeMediaFileError";
    throw error;
  }
  return stat;
}

export function checkedMediaRange(
  totalSize: number,
  range?: MediaByteRange,
): { start: number; end: number } {
  if (!range) return { start: 0, end: totalSize - 1 };

  const start = range.start;
  const end = range.end ?? totalSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalSize
  ) {
    const error = new Error("invalid media byte range") as Error & { totalSize: number };
    error.name = "MediaRangeError";
    error.totalSize = totalSize;
    throw error;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

export function mediaWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

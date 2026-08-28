#!/usr/bin/env node

import { openAsBlob, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const MAX_BYTES = 500 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
]);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function validatedUploadUrl(value) {
  const url = new URL(value);
  const expectedPath = "/api/internal/story-film-media/presenter-upload";
  if (url.pathname !== expectedPath || url.username || url.password || url.search || url.hash) {
    throw new Error("Presenter upload URL ไม่ถูกต้อง");
  }
  const configuredOrigin = process.env.STORY_FILM_UPLOAD_ORIGIN?.trim();
  const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "https://studio.heroaiengine.com",
    ...(configuredOrigin ? [new URL(configuredOrigin).origin] : []),
  ]);
  if (!allowedOrigins.has(url.origin)) {
    throw new Error("Presenter upload URL ไม่ใช่ Hero origin ที่อนุญาต");
  }
  return url;
}

async function main() {
  const filePath = resolve(required(argument("file"), "ต้องระบุ --file <video-path>"));
  const endpoint = validatedUploadUrl(required(
    argument("upload-url"),
    "ต้องระบุ --upload-url จาก Internal Story Film MCP",
  ));
  const uploadToken = required(
    process.env.STORY_FILM_UPLOAD_TOKEN,
    "ยังไม่ได้ตั้งค่า STORY_FILM_UPLOAD_TOKEN จาก upload grant",
  );
  const extension = extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION.get(extension);
  if (!mimeType) throw new Error("รองรับเฉพาะไฟล์ mp4, mov และ webm");

  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_BYTES) {
    throw new Error("ไฟล์ต้องไม่ว่างและมีขนาดไม่เกิน 500 MB");
  }

  const form = new FormData();
  const video = await openAsBlob(filePath, { type: mimeType });
  form.append("video", video, basename(filePath));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${uploadToken}` },
    body: form,
    signal: AbortSignal.timeout(600_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.asset?.id) {
    throw new Error(payload.message || payload.error || `Presenter upload failed (${response.status})`);
  }

  process.stdout.write(`${JSON.stringify({ asset: payload.asset }, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Presenter upload failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

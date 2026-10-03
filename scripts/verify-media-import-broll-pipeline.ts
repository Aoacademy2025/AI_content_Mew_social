// Unit tests for src/lib/media-import/broll-pipeline.ts (Task 9, PR-B, 2026-10-03).
//
// This module was extracted from /api/videos/broll-window/upload/route.ts verbatim; the
// route's own behaviour is covered end to end by scripts/verify-broll-upload-admission.ts
// (validate-before-admission ordering) and scripts/verify-upload-probe-whitelist.ts (the
// G24 ffprobe guard, incl. hostile playlist-disguised-as-media inputs). This file tests
// the extracted module directly:
//   1. validateBrollUpload: type/size, in isolation, no disk access.
//   2. runBrollPipeline: real image → Ken Burns, real video → normalizeForRemotion, the
//      4096px bomb guard on both paths, and a non-media file failing closed.
//
// Needs real ffmpeg AND ffprobe (same as verify-upload-probe-whitelist.ts).
// Run: npx tsx scripts/verify-media-import-broll-pipeline.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import {
  MAX_BROLL_IMAGE_BYTES,
  MAX_BROLL_VIDEO_BYTES,
  MAX_BROLL_DIMENSION_PX,
  brollFileExt,
  detectBrollKind,
  validateBrollUpload,
  runBrollPipeline,
} from "../src/lib/media-import/broll-pipeline";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function ff(args: string[]): Promise<void> {
  await execFileAsync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 16 << 20 });
}

function makeFile(name: string, bytes: Uint8Array, type: string): File {
  return new File([bytes], name, { type });
}

// ---------------------------------------------------------------------------------------
// 1. brollFileExt / detectBrollKind / validateBrollUpload — pure, no disk access
// ---------------------------------------------------------------------------------------
function pureChecks(): void {
  console.log("\n# 1. validateBrollUpload (pure)");

  check("brollFileExt lowercases and strips the path", brollFileExt("Clip.MP4") === "mp4");
  // No "." → split(".").pop() returns the whole name (matches the original inline
  // fileExt verbatim); detectBrollKind then rejects it as an unknown extension.
  check("brollFileExt on a name with no dot returns the whole name", brollFileExt("noext") === "noext");

  check("detectBrollKind: jpg + matching mime → image", detectBrollKind("jpg", "image/jpeg") === "image");
  check("detectBrollKind: jpg + empty mime → image (some browsers send none)", detectBrollKind("jpg", "") === "image");
  check("detectBrollKind: mp4 + matching mime → video", detectBrollKind("mp4", "video/mp4") === "video");
  check("detectBrollKind: ext/mime mismatch → null", detectBrollKind("jpg", "video/mp4") === null);
  check("detectBrollKind: unknown ext → null", detectBrollKind("exe", "application/octet-stream") === null);

  const unsupported = validateBrollUpload(makeFile("virus.exe", new Uint8Array(10), "application/octet-stream"));
  check("validateBrollUpload: unsupported ext → unsupported_type/415",
    !unsupported.ok && unsupported.error.error === "unsupported_type" && unsupported.error.status === 415);

  const mismatched = validateBrollUpload(makeFile("photo.jpg", new Uint8Array(10), "video/mp4"));
  check("validateBrollUpload: ext/mime mismatch → unsupported_type/415",
    !mismatched.ok && mismatched.error.error === "unsupported_type" && mismatched.error.status === 415);

  const empty = validateBrollUpload(makeFile("photo.jpg", new Uint8Array(0), "image/jpeg"));
  check("validateBrollUpload: empty file → empty_file/400",
    !empty.ok && empty.error.error === "empty_file" && empty.error.status === 400);

  check("MAX_BROLL_IMAGE_BYTES is 20 MB", MAX_BROLL_IMAGE_BYTES === 20 * 1024 * 1024);
  check("MAX_BROLL_VIDEO_BYTES is 200 MB", MAX_BROLL_VIDEO_BYTES === 200 * 1024 * 1024);

  const oversizedImage = validateBrollUpload(
    makeFile("photo.jpg", new Uint8Array(MAX_BROLL_IMAGE_BYTES + 1), "image/jpeg"),
  );
  check("validateBrollUpload: image over 20MB → payload_too_large/413",
    !oversizedImage.ok && oversizedImage.error.error === "payload_too_large" && oversizedImage.error.status === 413);

  const okImage = validateBrollUpload(makeFile("photo.png", new Uint8Array(10), "image/png"));
  check("validateBrollUpload: a valid small image passes with kind=image",
    okImage.ok && okImage.kind === "image" && okImage.ext === "png");

  const okVideo = validateBrollUpload(makeFile("clip.webm", new Uint8Array(10), ""));
  check("validateBrollUpload: a valid video with no mime passes with kind=video",
    okVideo.ok && okVideo.kind === "video" && okVideo.ext === "webm");
}

// ---------------------------------------------------------------------------------------
// 2. runBrollPipeline — real media through the real pipeline
// ---------------------------------------------------------------------------------------
async function pipelineChecks(tmp: string): Promise<void> {
  console.log("\n# 2. runBrollPipeline (real ffmpeg)");
  const stocksDir = path.join(tmp, "stocks");

  // 2a. A real small JPEG → Ken Burns motion clip.
  const jpgPath = path.join(tmp, "real.jpg");
  await ff(["-f", "lavfi", "-i", "testsrc2=size=900x1200:rate=1:duration=1", "-frames:v", "1", "-q:v", "3", jpgPath]);
  const jpgBytes = fs.readFileSync(jpgPath);
  const jpgResult = await runBrollPipeline({
    file: makeFile("photo.jpg", jpgBytes, "image/jpeg"),
    kind: "image",
    ext: "jpg",
    stocksDir,
  });
  check("runBrollPipeline: real jpg → ok with /api/stocks/ src and Ken Burns duration",
    jpgResult.ok && jpgResult.value.src.startsWith("/api/stocks/") && jpgResult.value.clipDuration === 5,
    JSON.stringify(jpgResult));
  if (jpgResult.ok) {
    const outPath = path.join(stocksDir, jpgResult.value.src.replace("/api/stocks/", ""));
    check("runBrollPipeline: the Ken Burns output file exists on disk", fs.existsSync(outPath));
  }

  // 2b. An oversized image (> 4096px) is refused before Ken Burns ever decodes it.
  const bigPngPath = path.join(tmp, "big.png");
  await sharp({ create: { width: MAX_BROLL_DIMENSION_PX + 2, height: MAX_BROLL_DIMENSION_PX + 4, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .png()
    .toFile(bigPngPath);
  const beforeFiles = fs.existsSync(stocksDir) ? fs.readdirSync(stocksDir).length : 0;
  const bigImageResult = await runBrollPipeline({
    file: makeFile("big.png", fs.readFileSync(bigPngPath), "image/png"),
    kind: "image",
    ext: "png",
    stocksDir,
  });
  check("runBrollPipeline: image over 4096px → unsupported_type/415, no orphan output",
    !bigImageResult.ok && bigImageResult.value.error === "unsupported_type" && bigImageResult.value.status === 415
      && fs.readdirSync(stocksDir).length === beforeFiles,
    JSON.stringify(bigImageResult));

  // 2c. A real small MP4 → Remotion-safe re-encode.
  const mp4Path = path.join(tmp, "real.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4Path]);
  const mp4Bytes = fs.readFileSync(mp4Path);
  const mp4Result = await runBrollPipeline({
    file: makeFile("clip.mp4", mp4Bytes, "video/mp4"),
    kind: "video",
    ext: "mp4",
    stocksDir,
  });
  check("runBrollPipeline: real mp4 → ok with /api/stocks/ src and a positive duration",
    mp4Result.ok && mp4Result.value.src.startsWith("/api/stocks/") && mp4Result.value.clipDuration > 0,
    JSON.stringify(mp4Result));

  // 2d. An oversized video (> 4096px, single frame to stay fast) is refused before
  // normalizeForRemotion ever decodes it.
  const bigMp4Path = path.join(tmp, "big.mp4");
  await ff([
    "-f", "lavfi", "-i", `testsrc=size=${MAX_BROLL_DIMENSION_PX + 4}x${MAX_BROLL_DIMENSION_PX + 2}:rate=1:duration=1`,
    "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", bigMp4Path,
  ]);
  const beforeFilesVideo = fs.readdirSync(stocksDir).length;
  const bigVideoResult = await runBrollPipeline({
    file: makeFile("big.mp4", fs.readFileSync(bigMp4Path), "video/mp4"),
    kind: "video",
    ext: "mp4",
    stocksDir,
  });
  check("runBrollPipeline: video over 4096px → unsupported_type/415, no orphan output",
    !bigVideoResult.ok && bigVideoResult.value.error === "unsupported_type" && bigVideoResult.value.status === 415
      && fs.readdirSync(stocksDir).length === beforeFilesVideo,
    JSON.stringify(bigVideoResult));

  // 2e. A non-media file labelled .mp4 fails closed (no demuxer / no dimensions) rather
  // than crashing — the exhaustive hostile-playlist matrix lives in
  // scripts/verify-upload-probe-whitelist.ts; this just proves the pipeline's own
  // failure path for "not actually media" leaves no orphan output.
  const garbagePath = path.join(tmp, "garbage.mp4");
  fs.writeFileSync(garbagePath, Buffer.from("not a real video file, just some bytes"));
  const beforeFilesGarbage = fs.readdirSync(stocksDir).length;
  const garbageResult = await runBrollPipeline({
    file: makeFile("garbage.mp4", fs.readFileSync(garbagePath), "video/mp4"),
    kind: "video",
    ext: "mp4",
    stocksDir,
  });
  check("runBrollPipeline: non-media bytes named .mp4 fail closed, no orphan output",
    !garbageResult.ok && fs.readdirSync(stocksDir).length === beforeFilesGarbage,
    JSON.stringify(garbageResult));
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-import-broll-pipeline-"));
  try {
    pureChecks();
    await pipelineChecks(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nmedia-import broll-pipeline: ALL PASS" : `\nmedia-import broll-pipeline: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

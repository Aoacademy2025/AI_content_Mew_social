// Regression test for backlog #10 (studio-feature-backlog.md row 10): uploaded B-roll
// came back ~12 luma levels darker with crushed blacks — measured as output ≈
// 0.975 × upload − 12, full-range `yuvj420p` tagged `bt470bg`.
//
// Root cause: the still-image → Ken Burns motion-clip path (applyKenBurns in
// src/lib/broll-asset-lib.ts) decodes a still full-range (JPEG/PNG convention:
// yuvj420p/pc, often tagged with a legacy matrix like bt470bg) and that full-range tag
// + its actual 0-255 sample values rode untouched through crop/zoompan into the encode;
// ffmpeg's encoder then auto-promoted the requested "-pix_fmt yuv420p" BACK to yuvj420p
// to avoid lying about the range. Every OTHER B-roll clip in this system (uploaded video
// via normalizeForRemotion, stock downloads) is tv-range/bt709/yuv420p, so a full-range
// clip slipping through gets mis-rendered once composited alongside them.
//
// This test pushes the SAME flat grey test colour through the REAL argument builder
// (runBrollPipeline, exactly what the web upload route and the MCP
// create_upload_url + replace_broll_window media-import worker both call) for BOTH
// typical inputs:
//   1. a tv-range bt709 H.264 "phone video" upload (kind: "video" → normalizeForRemotion)
//   2. a full-range JPEG "still photo" upload (kind: "image" → applyKenBurns)
// and asserts the two outputs converge on the same canonical tv/bt709/yuv420p domain
// with the same (within ~2 levels) mean luma — i.e. an uploaded clip's levels survive.
//
// Needs real ffmpeg AND ffprobe (same as verify-media-import-broll-pipeline.ts).
// Run: npx tsx scripts/verify-broll-upload-color-levels.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBrollPipeline } from "../src/lib/media-import/broll-pipeline";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import { getFfprobePath } from "../src/lib/upload-media-probe";

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

type Tags = { pixFmt: string; colorRange: string; colorSpace: string };

async function ffprobeTags(file: string): Promise<Tags> {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=pix_fmt,color_range,color_space",
    "-of", "default=noprint_wrappers=1", file,
  ], { encoding: "utf-8" });
  const get = (key: string) => new RegExp(`${key}=(\\S+)`).exec(stdout)?.[1] ?? "unknown";
  return { pixFmt: get("pix_fmt"), colorRange: get("color_range"), colorSpace: get("color_space") };
}

// Mean luma over the whole first frame via signalstats (ffprobe side, no -f null needed).
async function meanLuma(file: string): Promise<number> {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    "-v", "error", "-f", "lavfi", "-i", `movie=${file},signalstats`,
    "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0",
  ], { encoding: "utf-8", maxBuffer: 16 << 20 });
  return parseFloat(stdout.trim().split("\n")[0].replace(",", ""));
}

// A flat mid-dark grey (R=G=B=48/255) is far enough from the 16/235 tv-range boundary
// that a full-range→tv-range confusion shows up as a clear, measurable luma shift
// (crushed-blacks direction) rather than clipping to 0/255 and hiding the bug.
const GREY = "0x303030";
const TOLERANCE_LEVELS = 2;

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "broll-upload-color-levels-"));
  try {
    const stocksDir = path.join(tmp, "stocks");

    // 1. Typical upload: tv-range bt709 H.264 "phone video" (the common case).
    const videoPath = path.join(tmp, "phone.mp4");
    await ff([
      "-f", "lavfi", "-i", `color=c=${GREY}:s=640x360:r=30:d=1`,
      "-frames:v", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", videoPath,
    ]);
    const videoResult = await runBrollPipeline({
      file: makeFile("phone.mp4", fs.readFileSync(videoPath), "video/mp4"),
      kind: "video",
      ext: "mp4",
      stocksDir,
    });
    check("video upload: runBrollPipeline ok", videoResult.ok, JSON.stringify(videoResult));
    if (!videoResult.ok) throw new Error("video pipeline failed, aborting");
    const videoOutPath = path.join(stocksDir, videoResult.value.src.replace("/api/stocks/", ""));
    const videoTags = await ffprobeTags(videoOutPath);
    const videoLuma = await meanLuma(videoOutPath);
    check("video upload output: pix_fmt=yuv420p (not yuvj420p)", videoTags.pixFmt === "yuv420p", videoTags.pixFmt);
    check("video upload output: color_range=tv", videoTags.colorRange === "tv", videoTags.colorRange);
    check("video upload output: color_space=bt709", videoTags.colorSpace === "bt709", videoTags.colorSpace);

    // 2. Typical upload: full-range still image → Ken Burns motion clip (the path that
    // was reproducibly wrong: JPEG/PNG decode is full-range by convention).
    const jpgPath = path.join(tmp, "still.jpg");
    await ff(["-f", "lavfi", "-i", `color=c=${GREY}:s=1350x2400`, "-frames:v", "1", jpgPath]);
    const sourceJpgTags = await ffprobeTags(jpgPath);
    check("source still is full-range (sanity check on the synthetic input)",
      sourceJpgTags.colorRange === "pc", JSON.stringify(sourceJpgTags));
    const imageResult = await runBrollPipeline({
      file: makeFile("still.jpg", fs.readFileSync(jpgPath), "image/jpeg"),
      kind: "image",
      ext: "jpg",
      stocksDir,
    });
    check("still upload: runBrollPipeline ok", imageResult.ok, JSON.stringify(imageResult));
    if (!imageResult.ok) throw new Error("image pipeline failed, aborting");
    const imageOutPath = path.join(stocksDir, imageResult.value.src.replace("/api/stocks/", ""));
    const imageTags = await ffprobeTags(imageOutPath);
    const imageLuma = await meanLuma(imageOutPath);
    check("still upload output: pix_fmt=yuv420p (not yuvj420p)", imageTags.pixFmt === "yuv420p", imageTags.pixFmt);
    check("still upload output: color_range=tv (not pc)", imageTags.colorRange === "tv", imageTags.colorRange);
    check("still upload output: color_space=bt709 (not bt470bg)", imageTags.colorSpace === "bt709", imageTags.colorSpace);

    // 3. The actual customer-visible symptom: the SAME grey, uploaded as a video vs. as
    // a still, must come back with the SAME levels (within rounding tolerance) — not one
    // ~12 levels darker than the other.
    const delta = Math.abs(videoLuma - imageLuma);
    check(
      `uploaded video vs. uploaded still: mean luma matches within ${TOLERANCE_LEVELS} levels`,
      Number.isFinite(videoLuma) && Number.isFinite(imageLuma) && delta <= TOLERANCE_LEVELS,
      `video YAVG=${videoLuma}, still YAVG=${imageLuma}, delta=${delta.toFixed(2)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nbroll-upload-color-levels: ALL PASS" : `\nbroll-upload-color-levels: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

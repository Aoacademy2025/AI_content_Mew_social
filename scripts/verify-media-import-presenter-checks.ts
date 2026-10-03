// Unit tests for src/lib/media-import/presenter-checks.ts (Task 9, PR-B, 2026-10-03,
// G22). MCP-only — /api/videos/upload-avatar/route.ts is untouched by this module (B6),
// so this file does not touch that route at all.
//
// Covers: ffprobe type gate, the 4096px dimension cap, portrait-only, the plan's
// audioDurationLimitViolation duration gate, and processPresenterImport's move-on-success
// into the same directory upload-avatar.ts writes to.
//
// Needs real ffmpeg AND ffprobe (same as verify-upload-probe-whitelist.ts).
// Run: npx tsx scripts/verify-media-import-presenter-checks.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import {
  MAX_PRESENTER_DIMENSION_PX,
  isAllowedPresenterVideo,
  runPresenterChecks,
  presenterUploadDir,
  presenterOutputFilename,
  processPresenterImport,
} from "../src/lib/media-import/presenter-checks";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function ff(args: string[]): Promise<void> {
  await execFileAsync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 16 << 20 });
}

// ---------------------------------------------------------------------------------------
// 1. isAllowedPresenterVideo — pure
// ---------------------------------------------------------------------------------------
function pureChecks(): void {
  console.log("\n# 1. isAllowedPresenterVideo (pure)");
  check("mp4 + matching mime → true", isAllowedPresenterVideo("mp4", "video/mp4"));
  check("mov + empty mime → true (some browsers send none)", isAllowedPresenterVideo("mov", ""));
  check("webm + matching mime → true", isAllowedPresenterVideo("webm", "video/webm"));
  check("mp4 + mismatched mime → false", !isAllowedPresenterVideo("mp4", "image/jpeg"));
  check("unknown ext → false", !isAllowedPresenterVideo("avi", "video/avi"));
}

// ---------------------------------------------------------------------------------------
// 2. runPresenterChecks — real ffmpeg/ffprobe
// ---------------------------------------------------------------------------------------
async function presenterCheckScenarios(tmp: string): Promise<void> {
  console.log("\n# 2. runPresenterChecks (real ffmpeg)");

  // A portrait clip comfortably inside the FREE plan's 120s cap.
  const portraitPath = path.join(tmp, "portrait.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", portraitPath]);
  const portraitOk = await runPresenterChecks({ filePath: portraitPath, ext: "mp4", plan: "FREE" });
  check("portrait clip within the FREE cap → ok, dims reported, portrait",
    portraitOk.ok && portraitOk.height > portraitOk.width && portraitOk.durationMs > 0,
    JSON.stringify(portraitOk));

  // A landscape clip, otherwise identical, is refused for orientation.
  const landscapePath = path.join(tmp, "landscape.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", landscapePath]);
  const landscapeResult = await runPresenterChecks({ filePath: landscapePath, ext: "mp4", plan: "FREE" });
  check("landscape clip → not_portrait",
    !landscapeResult.ok && landscapeResult.error.code === "not_portrait",
    JSON.stringify(landscapeResult));

  // Oversized dimensions are refused BEFORE the portrait check (single frame to stay fast).
  const bigPath = path.join(tmp, "big.mp4");
  await ff([
    "-f", "lavfi", "-i", `testsrc=size=${MAX_PRESENTER_DIMENSION_PX + 4}x${MAX_PRESENTER_DIMENSION_PX + 2}:rate=1:duration=1`,
    "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", bigPath,
  ]);
  const bigResult = await runPresenterChecks({ filePath: bigPath, ext: "mp4", plan: "FREE" });
  check("clip over 4096px → too_large_dimensions (checked ahead of orientation)",
    !bigResult.ok && bigResult.error.code === "too_large_dimensions",
    JSON.stringify(bigResult));

  // A portrait clip that exceeds the FREE plan's 120s duration cap is refused, but the
  // SAME clip passes on PRO (360s cap) — proves the gate is the shared, plan-aware
  // audioDurationLimitViolation and not a fixed constant.
  const longPath = path.join(tmp, "long.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=1:duration=150", "-c:v", "libx264", "-pix_fmt", "yuv420p", longPath]);
  const longFreeResult = await runPresenterChecks({ filePath: longPath, ext: "mp4", plan: "FREE" });
  check("150s portrait clip on FREE (120s cap) → duration_exceeded",
    !longFreeResult.ok && longFreeResult.error.code === "duration_exceeded" && !!longFreeResult.error.durationViolation,
    JSON.stringify(longFreeResult));
  const longProResult = await runPresenterChecks({ filePath: longPath, ext: "mp4", plan: "PRO" });
  check("the same 150s clip on PRO (360s cap) → ok",
    longProResult.ok, JSON.stringify(longProResult));

  // An unsupported extension is refused without ever touching ffprobe.
  const unsupportedResult = await runPresenterChecks({ filePath: portraitPath, ext: "avi", plan: "FREE" });
  check("unsupported extension → unsupported_type",
    !unsupportedResult.ok && unsupportedResult.error.code === "unsupported_type",
    JSON.stringify(unsupportedResult));

  // Non-media bytes named .mp4 fail closed on the probe rather than crashing.
  const garbagePath = path.join(tmp, "garbage.mp4");
  fs.writeFileSync(garbagePath, Buffer.from("not a real video file, just some bytes"));
  const garbageResult = await runPresenterChecks({ filePath: garbagePath, ext: "mp4", plan: "FREE" });
  check("non-media bytes named .mp4 → fails closed (not ok)", !garbageResult.ok, JSON.stringify(garbageResult));
}

// ---------------------------------------------------------------------------------------
// 3. processPresenterImport — moves on success, same dir as upload-avatar
// ---------------------------------------------------------------------------------------
async function importChecks(tmp: string): Promise<void> {
  console.log("\n# 3. processPresenterImport");

  check("presenterUploadDir matches upload-avatar's rendersDir",
    presenterUploadDir() === path.join(process.cwd(), "public", "renders"));
  check("presenterOutputFilename is server-named, no client input",
    /^presenter-import-\d+-[0-9a-f-]+\.mp4$/.test(presenterOutputFilename("mp4")));

  const portraitPath = path.join(tmp, "import-ok.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", portraitPath]);

  const result = await processPresenterImport({ tempFilePath: portraitPath, ext: "mp4", plan: "FREE" });
  let movedAbsPath: string | null = null;
  try {
    check("a passing clip is moved into presenterUploadDir and returns /api/renders/ src",
      result.ok && result.src.startsWith("/api/renders/"), JSON.stringify(result));
    if (result.ok) {
      movedAbsPath = path.join(presenterUploadDir(), result.src.replace("/api/renders/", ""));
      check("the moved file exists at the returned location", fs.existsSync(movedAbsPath));
      check("the original temp path no longer exists (moved, not copied)", !fs.existsSync(portraitPath));
    }
  } finally {
    if (movedAbsPath && fs.existsSync(movedAbsPath)) fs.unlinkSync(movedAbsPath);
  }

  // A clip that fails a check is left in place for the caller to clean up.
  const landscapePath = path.join(tmp, "import-fail.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", landscapePath]);
  const failResult = await processPresenterImport({ tempFilePath: landscapePath, ext: "mp4", plan: "FREE" });
  check("a failing clip is not moved; the temp file is left in place",
    !failResult.ok && fs.existsSync(landscapePath), JSON.stringify(failResult));
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-import-presenter-checks-"));
  try {
    pureChecks();
    await presenterCheckScenarios(tmp);
    await importChecks(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nmedia-import presenter-checks: ALL PASS" : `\nmedia-import presenter-checks: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

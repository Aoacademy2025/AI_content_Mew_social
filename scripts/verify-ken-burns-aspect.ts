// Verifies the applyKenBurns aspect-fix in src/lib/broll-asset-lib.ts:
// a non-9:16 still image must be COVER-CROPPED to 1080x1920, never stretched.
//
// Generates synthetic stills with ffmpeg lavfi (a centered square drawn on a
// solid background) for landscape, square, and portrait source ratios, runs
// applyKenBurns on each, then:
//   1. ffprobes the output to assert it is exactly 1080x1920.
//   2. Extracts a frame and measures the drawn square's on-screen pixel
//      bounding box. A square that survives an *anisotropic stretch* becomes
//      a visibly non-square rectangle; a square that survives a *cover crop*
//      stays square (only scaled uniformly). We assert the ratio stays ~1:1.
//
// Run: npx tsx scripts/verify-ken-burns-aspect.ts  (also: npm run verify:ken-burns-aspect)
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import { applyKenBurns } from "../src/lib/broll-asset-lib";

const execFileAsync = promisify(execFile);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

function getFfprobePath(): string {
  const ffmpeg = getFfmpegPath();
  const guess = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext ?? ""}`);
  if (guess !== ffmpeg && fs.existsSync(guess)) return guess;
  const candidates = ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return "ffprobe";
}

async function probeDims(file: string): Promise<{ w: number; h: number }> {
  const ffprobe = getFfprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=s=x:p=0",
    file,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  return { w, h };
}

// Draws a centered SQUARE (side `side`) of white on black, at the given
// canvas size — a shape whose on-screen aspect ratio we can check post-crop.
async function makeTestStill(outPath: string, canvasW: number, canvasH: number, side: number): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const x = Math.round((canvasW - side) / 2);
  const y = Math.round((canvasH - side) / 2);
  await execFileAsync(ffmpeg, [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black:s=${canvasW}x${canvasH}:d=1`,
    "-vf", `drawbox=x=${x}:y=${y}:w=${side}:h=${side}:color=white:t=fill`,
    "-frames:v", "1",
    outPath,
  ]);
}

// Extracts frame N (mid-clip) as PNG and measures the bounding box of
// near-white pixels via ffmpeg's own bbox filter (cropdetect-adjacent: we
// use `bbox` which prints the bounding box of non-black pixels to stderr).
async function measureWhiteBBox(mp4Path: string, atSec: number): Promise<{ w: number; h: number }> {
  const ffmpeg = getFfmpegPath();
  let stderr = "";
  try {
    const res = await execFileAsync(ffmpeg, [
      "-y",
      "-ss", String(atSec),
      "-i", mp4Path,
      "-frames:v", "1",
      "-vf", "bbox=min_val=200",
      "-f", "null",
      "-",
    ]);
    stderr = res.stderr ?? "";
  } catch (err: unknown) {
    stderr = (err as { stderr?: string }).stderr ?? "";
  }
  // ffmpeg bbox filter logs lines like:
  // [Parsed_bbox_0 @ ...] n:0 pts:... x1:381 x2:698 y1:678 y2:1241 w:318 h:564 ...
  const matches = [...stderr.matchAll(/w:(\d+)\s+h:(\d+)/g)];
  const m = matches[matches.length - 1];
  if (!m) throw new Error(`could not parse bbox output:\n${stderr.slice(-2000)}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ken-burns-verify-"));
  console.log(`tmp dir: ${tmpDir}`);
  try {
    const cases: { name: string; w: number; h: number; side: number }[] = [
      { name: "landscape-1600x900", w: 1600, h: 900, side: 400 },
      { name: "square-1000x1000", w: 1000, h: 1000, side: 400 },
      { name: "portrait-1080x1920", w: 1080, h: 1920, side: 400 },
    ];

    for (const c of cases) {
      const stillPath = path.join(tmpDir, `${c.name}.png`);
      const outPath = path.join(tmpDir, `${c.name}-out.mp4`);
      await makeTestStill(stillPath, c.w, c.h, c.side);

      await applyKenBurns(stillPath, outPath);
      check(`${c.name}: applyKenBurns produced output`, fs.existsSync(outPath));

      const dims = await probeDims(outPath);
      check(`${c.name}: output is 1080x1920`, dims.w === 1080 && dims.h === 1920, `got ${dims.w}x${dims.h}`);

      // sample near the start (zoompan begins at zoom=1.0, so the square's
      // proportions at t≈0 reflect the crop, not the ongoing zoom drift)
      const bbox = await measureWhiteBBox(outPath, 0.05);
      const ratio = bbox.w / bbox.h;
      check(
        `${c.name}: drawn square stays ~square (no stretch)`,
        ratio > 0.85 && ratio < 1.15,
        `bbox ${bbox.w}x${bbox.h} ratio=${ratio.toFixed(3)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`cleaned up ${tmpDir}`);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

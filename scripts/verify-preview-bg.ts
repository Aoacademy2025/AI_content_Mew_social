// Run: npx tsx scripts/verify-preview-bg.ts
//
// Verifies the /api/heygen/preview-bg fast-preview additions (spec 07-05 task 1a):
//   - resolveMaxSec / resolveHalfRes sanitizers (pure-function assertions)
//   - previewBgOutputName is a deterministic hash of (avatarVideoUrl, maxSec, halfRes)
//   - the route's core keying path (same shared chroma-key helpers the route imports), run with
//     maxSec=4/halfRes=true over a synthesized 6s green clip: output duration capped, width
//     scaled to 540, output actually carries alpha (yuva420p), and a second call with identical
//     params reuses the cached file on disk instead of re-encoding.
//
// Uses ONLY the bundled ffmpeg (the exact binary the route calls via getFfmpegPath), same pattern
// as scripts/verify-composite-quality.ts.
import fs from "fs";
import os from "os";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { resolveMaxSec, resolveHalfRes, previewBgCacheHash, previewBgOutputName, buildPreviewBgFfmpegArgs } from "../src/lib/preview-bg-params";
import { resolveChromaParams, detectChromaColor, buildKeyChain, featherSupported } from "../src/lib/chroma-key";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ " + msg); process.exit(1); }
  console.log("✓ " + msg);
  passed++;
}

function ffmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}
const FF = ffmpegPath();
if (!fs.existsSync(FF)) { console.error("❌ bundled ffmpeg not found at " + FF); process.exit(1); }

function run(args: string[]): void {
  execFileSync(FF, args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
// Decode a single frame to RGBA and report the alpha histogram. IMPORTANT: this bundled ffmpeg's
// DEFAULT "vp9" decoder (used by a plain `ffmpeg -i`) silently discards the webm alpha side-data
// and always reports/decodes yuv420p — that's a limitation of ffmpeg's native vp9 decoder, not a
// sign the file lacks alpha. The libvpx-wrapped decoder (`-c:v libvpx-vp9`) DOES reconstruct it,
// and that's the same decode path real browsers use (Chrome/Firefox use libvpx for VP9 alpha) —
// so this is the correct way to prove the output actually carries a working alpha channel.
function decodeAlphaHistogram(file: string): { transparentFrac: number; opaqueFrac: number } {
  const buf = execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-c:v", "libvpx-vp9", "-i", file, "-pix_fmt", "rgba", "-f", "rawvideo", "-frames:v", "1", "-"], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  let transparent = 0, opaque = 0, total = 0;
  for (let i = 3; i < buf.length; i += 4) {
    total++;
    const a = buf[i];
    if (a < 40) transparent++;
    else if (a > 215) opaque++;
  }
  return { transparentFrac: total ? transparent / total : 0, opaqueFrac: total ? opaque / total : 0 };
}
function runFfmpegAsync(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FF, args, { maxBuffer: 50 * 1024 * 1024, timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg: ${err.message}\n${stderr?.slice(-800)}`));
      else resolve();
    });
  });
}
// Probe codec/dims + duration from ffmpeg -i stderr (no ffprobe in the bundled install).
function probeInfo(file: string): { codec: string; w: number; h: number; durationSec: number; stderr: string } {
  let stderr = "";
  try { execFileSync(FF, ["-i", file], { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? ""; }
  const dims = stderr.match(/Video:\s*([a-z0-9]+).*?,\s*(\d{2,5})x(\d{2,5})/i);
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSec = dur ? parseInt(dur[1]) * 3600 + parseInt(dur[2]) * 60 + parseFloat(dur[3]) : NaN;
  return {
    codec: dims ? dims[1] : "?",
    w: dims ? parseInt(dims[2]) : 0,
    h: dims ? parseInt(dims[3]) : 0,
    durationSec,
    stderr,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "preview-bg-verify-"));
console.log("tmp dir:", tmp);

// ── 1. Param sanitizers (pure functions — the exact helpers the route imports) ──
assert(resolveMaxSec(undefined) === null, "resolveMaxSec(undefined) → null (no cap, today's full-clip default)");
assert(resolveMaxSec(null) === null, "resolveMaxSec(null) → null");
assert(resolveMaxSec(0) === 1, "resolveMaxSec(0) clamps up → 1");
assert(resolveMaxSec(-5) === 1, "resolveMaxSec(-5) clamps up → 1");
assert(resolveMaxSec(99) === 10, "resolveMaxSec(99) clamps down → 10");
assert(resolveMaxSec(4) === 4, "resolveMaxSec(4) passes through unchanged");
assert(resolveMaxSec("evil") === null, 'resolveMaxSec("evil") → null (non-numeric → default/no-cap)');
assert(resolveMaxSec("4") === 4, 'resolveMaxSec("4") coerces numeric string');

assert(resolveHalfRes(true) === true, "resolveHalfRes(true) === true");
assert(resolveHalfRes(false) === false, "resolveHalfRes(false) === false");
assert(resolveHalfRes(undefined) === false, "resolveHalfRes(undefined) === false");
assert(resolveHalfRes("yes") === true, 'resolveHalfRes("yes") truthy-coerces → true (non-empty string)');
assert(resolveHalfRes(0) === false, "resolveHalfRes(0) === false");
assert(resolveHalfRes(1) === true, "resolveHalfRes(1) === true");

// ── 2. Deterministic naming ──
{
  const a = previewBgOutputName("/api/stocks/avatar1.mp4", 4, true);
  const b = previewBgOutputName("/api/stocks/avatar1.mp4", 4, true);
  const c = previewBgOutputName("/api/stocks/avatar1.mp4", 4, false);
  const d = previewBgOutputName("/api/stocks/avatar1.mp4", null, false);
  const e = previewBgOutputName("/api/stocks/avatar2.mp4", 4, true);
  assert(a === b, "previewBgOutputName is deterministic for identical inputs");
  assert(a !== c, "halfRes changes the output name");
  assert(a !== d, "maxSec changes the output name");
  assert(a !== e, "avatarVideoUrl changes the output name");
  assert(/^avatar-nobg-[0-9a-f]{20}\.webm$/.test(a), `output name matches expected shape (got ${a})`);
  assert(previewBgCacheHash("x", 4, true) === previewBgCacheHash("x", 4, true), "cache hash is stable");
}

// ── 3. Real ffmpeg run: route's core keying path (same shared chroma-key helpers), maxSec=4 +
//    halfRes=true, over a synthesized 6s green clip. The route itself needs an authenticated
//    Next.js request context; we exercise the exact same import chain the route calls instead of
//    going through HTTP, mirroring the pattern in verify-composite-quality.ts. ──
async function main() {
  const green = path.join(tmp, "green.mp4");
  run([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=0x12FF05:s=720x1280:d=6:r=15",
    "-vf", "drawbox=x=210:y=440:w=300:h=560:color=0xC98A6B@1.0:t=fill,format=yuv420p",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", green,
  ]);
  assert(fs.existsSync(green), "synthesized 6s green-screen source clip");

  const stocksDir = path.join(tmp, "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });

  // Mirrors route.ts POST body → resolved params → keying invocation, 1:1.
  async function callPreviewBg(avatarVideoUrl: string, inputPath: string, rawMaxSec: unknown, rawHalfRes: unknown): Promise<{ outPath: string; reencoded: boolean }> {
    const maxSec = resolveMaxSec(rawMaxSec);
    const halfRes = resolveHalfRes(rawHalfRes);
    const outFile = previewBgOutputName(avatarVideoUrl, maxSec, halfRes);
    const outPath = path.join(stocksDir, outFile);
    if (fs.existsSync(outPath)) {
      return { outPath, reencoded: false };
    }
    const resolved = resolveChromaParams({});
    const keyColor = resolved.autoDetect ? await detectChromaColor(inputPath, FF) : resolved.color;
    const feather = await featherSupported(FF);
    const keyChain = buildKeyChain({ color: keyColor, similarity: resolved.similarity, blend: resolved.blend }, feather);
    // Same helper the route imports — exercises the REAL arg construction, not a hand-copied one.
    await runFfmpegAsync(buildPreviewBgFfmpegArgs({ keyChain, maxSec, halfRes, inputPath, outPath }));
    return { outPath, reencoded: true };
  }

  const avatarUrl = "/api/stocks/verify-preview-bg-fixture.mp4";

  // First call: must actually key + encode.
  const r1 = await callPreviewBg(avatarUrl, green, 4, true);
  assert(r1.reencoded === true, "first call re-encodes (no cache yet)");
  assert(fs.existsSync(r1.outPath), "keyed webm was written to disk");

  const info = probeInfo(r1.outPath);
  assert(info.durationSec <= 4.2, `output duration capped by maxSec=4 (got ${info.durationSec.toFixed(2)}s)`);
  assert(info.w === 540, `output width scaled to 540 by halfRes (got ${info.w}x${info.h})`);
  assert(info.codec === "vp9", `output codec is vp9 (got ${info.codec})`);
  assert(/alpha_mode\s*:\s*1/.test(info.stderr), "webm container declares alpha_mode=1");
  const hist = decodeAlphaHistogram(r1.outPath);
  assert(hist.transparentFrac > 0.3, `keyed-out green background decodes fully transparent (${(hist.transparentFrac * 100).toFixed(0)}% of pixels alpha<40)`);
  assert(hist.opaqueFrac > 0.05, `subject block decodes fully opaque (${(hist.opaqueFrac * 100).toFixed(0)}% of pixels alpha>215)`);

  // Second call, identical params: must be a pure cache hit — same path, no re-encode, mtime
  // unchanged (proves ffmpeg did not run again).
  const mtimeBefore = fs.statSync(r1.outPath).mtimeMs;
  const r2 = await callPreviewBg(avatarUrl, green, 4, true);
  const mtimeAfter = fs.statSync(r2.outPath).mtimeMs;
  assert(r2.outPath === r1.outPath, "second call with identical params resolves to the same cache path");
  assert(r2.reencoded === false, "second call is a cache hit — no re-encode");
  assert(mtimeAfter === mtimeBefore, "cached file's mtime is unchanged — ffmpeg genuinely did not re-run");

  // Different params → different file, no false cache hit.
  const r3 = await callPreviewBg(avatarUrl, green, 4, false);
  assert(r3.outPath !== r1.outPath, "different halfRes → different cache path (no re-encode collision)");
  assert(r3.reencoded === true, "different params correctly miss the cache and re-encode");
  const info3 = probeInfo(r3.outPath);
  assert(info3.w !== 540, `halfRes=false output is NOT scaled to 540 (got ${info3.w}, source is 720-wide)`);

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error("❌ unexpected error:", e); process.exit(1); });

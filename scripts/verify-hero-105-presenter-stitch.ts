import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { buildPresenterStitchFfmpegFilter } from "@/lib/presenter-stitch";
import {
  computePresenterStitchTimeoutMs,
  probeClipInfoViaFfmpeg,
  sanitizePresenterStitchError,
  stitchPresenterVideoFiles,
} from "@/lib/presenter-stitch.server";

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), args, { timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`));
      else resolve();
    });
  });
}

async function main() {
  // 1. Timeout scaling
  assert.equal(computePresenterStitchTimeoutMs(10), 180_000, "minimum timeout stays 180s");
  assert.equal(computePresenterStitchTimeoutMs(60), 360_000, "60s clip gets 360s timeout");
  assert.equal(computePresenterStitchTimeoutMs(600), 600_000, "timeout caps at 600s");

  // 2. Sanitized error messages never leak ffmpeg binary path, local paths, or filter graphs
  const killedErr = sanitizePresenterStitchError({ killed: true, signal: "SIGTERM" });
  assert.doesNotMatch(killedErr.message, /ffmpeg|\/var\/|\/usr\/|filter_complex/i);
  assert.match(killedErr.message, /เกินกำหนด/);

  const genericErr = sanitizePresenterStitchError({ code: 1 });
  assert.doesNotMatch(genericErr.message, /ffmpeg|\/var\/|\/usr\/|filter_complex/i);
  assert.match(genericErr.message, /จัดเตรียมคลิปพิธีกรไม่สำเร็จ/);

  // 3. Contain filter uses downscaled blur + yuv420p normalization + even foreground dims
  const filter = buildPresenterStitchFfmpegFilter([{ durationSec: 2, hasAudio: false }], {
    presenterFit: "contain",
  });
  assert.match(filter, /format=yuv420p/);
  assert.match(filter, /scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,scale=1080:1920/);
  assert.match(filter, /force_divisible_by=2/);
  assert.match(filter, /anullsrc=/);

  // 4. Real FFmpeg execution on odd-dimension landscape silent clip (853x481) with contain
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const oddName = `presenter-odd-${Date.now()}-hero105.mp4`;
  const oddPath = path.join(rendersDir, oddName);
  const cleanup: string[] = [oddPath];

  try {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=854x480:r=30:d=1.0",
      "-vf",
      "scale=853:481:flags=neighbor,format=yuv444p",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv444p",
      oddPath,
    ]);

    const t0 = Date.now();
    const res = await stitchPresenterVideoFiles({
      clipUrls: [`/api/renders/${oddName}`],
      presenterFit: "contain",
    });
    const elapsedMs = Date.now() - t0;
    const outPath = path.join(rendersDir, path.basename(res.clipUrl));
    cleanup.push(outPath);

    assert.equal(res.stitched, true);
    const probed = await probeClipInfoViaFfmpeg(outPath);
    assert.equal(probed.width, 1080);
    assert.equal(probed.height, 1920);
    assert.equal(probed.hasAudio, true, "silent clip receives synthesized stereo audio track");
    assert.ok(elapsedMs < 30_000, `1s odd-dim contain stitch completed quickly (${elapsedMs}ms)`);

    console.log(`verify-hero-105-presenter-stitch: PASS (odd-dim yuv444p silent contain stitched in ${elapsedMs}ms, sanitized errors verified)`);
  } finally {
    for (const p of cleanup) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

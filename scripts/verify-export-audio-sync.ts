// Export audio sync (backlog #9): the voice must line up with the picture after every
// Remotion render in the chain — the preview render AND the burn that re-renders it.
//
// Remotion encodes a render's audio with libfdk_aac into raw ADTS, then stream-copies it into
// the MP4. ADTS cannot carry the encoder's 2048-sample priming, so without a fix each render
// leaves the voice 2048 samples (42.7 ms at 48 kHz) late and the burn stacks a second one
// (85.3 ms on the export).
//
// This runs the REAL chain on synthetic media: a black clip that flashes white at frame 30 and a
// 1 kHz click at exactly 1.000 s go through renderMedia (preview-shaped composition) with the same
// codec + ffmpegOverride run-render passes, then that MP4 goes through a second renderMedia
// (burn-shaped composition). Each output is decoded the way a player does (edit lists honored) and
// the click's onset is compared with the flash frame's timestamp.
//
// Needs a system ffmpeg with lavfi + signalstats (CI installs it via apt) and Remotion's browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { signalRemotionAacPriming } from "../src/lib/render/aac-priming";

const FPS = 30;
const FLASH_FRAME = 30; // 1.000 s
const CLICK_SEC = FLASH_FRAME / FPS;
const SAMPLE_RATE = 48_000;
// One AAC frame (1024 samples) at 48 kHz is 21.3 ms; anything inside it is below what anyone hears.
const TOLERANCE_MS = 21;

function ffmpeg(args: string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} exited ${result.status}: ${result.stderr.toString().slice(-800)}`);
  }
  return result.stdout;
}

/** Timestamp (s) of the first decoded frame whose average luma says "white". */
function flashSec(file: string, workDir: string): number {
  const stats = path.join(workDir, `${path.basename(file)}.yavg.txt`);
  ffmpeg([
    "-i", file,
    "-map", "0:v:0",
    "-vf", `signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file='${stats}'`,
    "-f", "null", "-",
  ]);
  let ptsTime: number | null = null;
  for (const line of readFileSync(stats, "utf8").split("\n")) {
    const frame = line.match(/pts_time:(-?[0-9.]+)/);
    if (frame) {
      ptsTime = Number(frame[1]);
      continue;
    }
    const yavg = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (yavg && ptsTime !== null && Number(yavg[1]) > 128) return ptsTime;
  }
  throw new Error(`no flash frame found in ${file}`);
}

/** Time (s) at which the click starts, decoded from t=0 with the file's edit list honored. */
function clickSec(file: string): number {
  const pcm = ffmpeg([
    "-i", file,
    "-map", "0:a:0",
    // Pad/trim so sample 0 is t=0 even if the stream does not start there.
    "-af", "aresample=async=1:first_pts=0",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "-c:a", "pcm_s16le",
    "-",
  ]);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  assert.ok(peak > 1000, `expected an audible click in ${file} (peak ${peak})`);
  const threshold = peak * 0.3;
  const onset = samples.findIndex((s) => Math.abs(s) > threshold);
  return onset / SAMPLE_RATE;
}

function offsetMs(videoFile: string, audioFile: string, workDir: string) {
  const flash = flashSec(videoFile, workDir);
  const click = clickSec(audioFile);
  return { flash, click, offsetMs: (click - flash) * 1000 };
}

function serve(dir: string): Promise<http.Server> {
  const types: Record<string, string> = { ".mp4": "video/mp4", ".wav": "audio/wav" };
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    const file = path.join(dir, name);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(name)] ?? "application/octet-stream",
      "Content-Length": size,
      "Access-Control-Allow-Origin": "*",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function checkOverrideUnit() {
  const audio = "/tmp/remotion/audio-preprocessing/audio.aac";
  const stitcher = ["-i", "/tmp/pre-encoded.mp4", "-i", audio, "-c:a", "copy", "-c:v", "copy", "-movflags", "faststart", "out.mp4"];
  const out = signalRemotionAacPriming({ type: "stitcher", args: [...stitcher] });
  const at = out.indexOf(audio);
  assert.deepEqual(out.slice(at - 3, at + 3), ["-itsoffset", "-0.042667", "-i", audio, "-c:a", "copy"]);
  assert.equal(out.length, stitcher.length + 2, "only the itsoffset pair is added");
  console.log("✓ stitcher: the copied ADTS audio input is shifted back by 2048 samples (42.667 ms)");

  const preStitcher = ["-f", "image2pipe", "-i", "-", "-c:v", "libx264", "pre.mp4"];
  assert.deepEqual(signalRemotionAacPriming({ type: "pre-stitcher", args: [...preStitcher] }), preStitcher);
  const silent = ["-i", "/tmp/pre-encoded.mp4", "-an", "-c:v", "copy", "out.mp4"];
  assert.deepEqual(signalRemotionAacPriming({ type: "stitcher", args: [...silent] }), silent);
  console.log("✓ pre-stitcher and audio-less renders are left untouched");

  const unexpected = ["-i", "/tmp/pre-encoded.mp4", "-i", "/tmp/audio.wav", "-c:a", "copy", "out.mp4"];
  const warn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    assert.deepEqual(signalRemotionAacPriming({ type: "stitcher", args: [...unexpected] }), unexpected);
  } finally {
    console.warn = warn;
  }
  assert.ok(warned, "an unexpected stitcher shape is logged");
  console.log("✓ an unexpected Remotion audio shape renders unchanged (fail-open) and is logged");

  const runRender = readFileSync("src/lib/render/run-render.ts", "utf8");
  assert.ok(
    runRender.includes('import { signalRemotionAacPriming } from "@/lib/render/aac-priming"')
      && /renderMedia\(\{[\s\S]*?ffmpegOverride:\s*signalRemotionAacPriming,[\s\S]*?\}\);/.test(runRender),
    "run-render passes signalRemotionAacPriming to renderMedia (preview, burn, avatar — every render)",
  );
  console.log("✓ run-render passes the same override to every renderMedia");
}

async function main() {
  checkOverrideUnit();

  const work = mkdtempSync(path.join(tmpdir(), "export-audio-sync-"));
  const publicDir = mkdtempSync(path.join(tmpdir(), "export-audio-sync-public-"));
  let serveUrl: string | null = null;
  let server: http.Server | null = null;
  try {
    const flashMp4 = path.join(work, "flash.mp4");
    const clickWav = path.join(work, "click.wav");
    // Black 180x320 clip, white for frames 30–35, so the flash starts exactly at 1.000 s.
    ffmpeg([
      "-y", "-f", "lavfi",
      "-i", `color=c=black:s=180x320:r=${FPS}:d=2,format=yuv420p,geq=lum='if(between(N,${FLASH_FRAME},${FLASH_FRAME + 5}),235,16)':cb=128:cr=128`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "0", flashMp4,
    ]);
    // 10 ms 1 kHz click starting at exactly 1.000 s (sample 48000), silence elsewhere.
    ffmpeg([
      "-y", "-f", "lavfi",
      "-i", `aevalsrc='if(between(t,${CLICK_SEC},${CLICK_SEC + 0.01}),0.8*sin(2*PI*1000*(t-${CLICK_SEC})),0)':s=${SAMPLE_RATE}:d=2`,
      "-c:a", "pcm_s16le", clickWav,
    ]);

    const source = offsetMs(flashMp4, clickWav, work);
    console.log(`  source: flash ${source.flash.toFixed(4)} s, click ${source.click.toFixed(4)} s → ${source.offsetMs.toFixed(1)} ms`);
    assert.ok(Math.abs(source.offsetMs) < 1, "synthetic source is aligned (measurement calibration)");
    console.log("✓ measurement is calibrated on the synthetic source (flash and click both at 1.000 s)");

    server = await serve(work);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serveUrl = await bundle({
      entryPoint: path.resolve("scripts/fixtures/aac-priming-remotion.tsx"),
      publicDir,
      webpackOverride: (config) => config,
    });

    const render = async (id: string, inputProps: Record<string, string>, output: string) => {
      const composition = await selectComposition({ serveUrl: serveUrl!, id, inputProps });
      await renderMedia({
        composition,
        serveUrl: serveUrl!,
        // Same encode settings run-render uses for every render.
        codec: "h264",
        ffmpegOverride: signalRemotionAacPriming,
        outputLocation: output,
        inputProps,
        logLevel: "error",
      });
      return output;
    };

    const preview = await render(
      "AacPrimingPreview",
      { videoSrc: `${base}/flash.mp4`, audioSrc: `${base}/click.wav` },
      path.join(work, "preview.mp4"),
    );
    const exported = await render("AacPrimingBurn", { videoSrc: `${base}/preview.mp4` }, path.join(work, "export.mp4"));

    const results = [
      { stage: "preview (1 Remotion render)", file: preview },
      { stage: "export (preview burned again)", file: exported },
    ].map(({ stage, file }) => ({ stage, ...offsetMs(file, file, work) }));
    for (const r of results) {
      console.log(
        `  ${r.stage}: flash ${r.flash.toFixed(4)} s, click ${r.click.toFixed(4)} s → voice ${r.offsetMs >= 0 ? "lags" : "leads"} by ${Math.abs(r.offsetMs).toFixed(1)} ms (${Math.round((r.offsetMs / 1000) * SAMPLE_RATE)} samples)`,
      );
    }
    for (const r of results) {
      assert.ok(
        Math.abs(r.offsetMs) <= TOLERANCE_MS,
        `${r.stage}: voice is ${r.offsetMs.toFixed(1)} ms off the picture (allowed ±${TOLERANCE_MS} ms)`,
      );
    }
    console.log(`✓ preview and export keep the voice within ±${TOLERANCE_MS} ms of the picture`);
  } finally {
    server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }

  console.log("\n✅ EXPORT AUDIO SYNC CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

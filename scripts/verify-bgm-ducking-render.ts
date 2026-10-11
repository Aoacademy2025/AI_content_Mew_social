// EP5 U7 + #2 (HERO-71): render proof for the changed-music burn. Runs the REAL
// SubtitleOverlayComposition through renderMedia on synthetic media and measures the output:
//   base video audio = 1000 Hz tone (the "old" baked voice + music),
//   voice track      = 300 Hz tone, only between 1.0 s and 2.0 s (one speech phrase),
//   new music        = 3000 Hz tone, whole clip.
// With audioMix + ducking: the 1000 Hz base must be gone (muted), the voice present, and the
// music under the phrase must sit at ~DUCK_RATIO of its level in the silence. Without audioMix
// (an old project) the base audio must play exactly as before.
//
// Needs a system ffmpeg and Remotion's browser (like verify-export-audio-sync.ts).
//   tsx scripts/verify-bgm-ducking-render.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { DUCK_RATIO } from "../src/lib/background-music";

const SAMPLE_RATE = 48_000;
const BASE_HZ = 1000;
const VOICE_HZ = 300;
const MUSIC_HZ = 3000;

function ffmpeg(args: string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr.toString().slice(-800)}`);
  return result.stdout;
}

function decodePcm(file: string): Float32Array {
  const pcm = ffmpeg([
    "-i", file, "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0",
    "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-c:a", "pcm_s16le", "-",
  ]);
  const ints = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  return Float32Array.from(ints, (s) => s / 32768);
}

/** Amplitude of one frequency in [fromSec, toSec) (Goertzel, normalised to a sine's peak). */
function toneLevel(samples: Float32Array, hz: number, fromSec: number, toSec: number): number {
  const start = Math.floor(fromSec * SAMPLE_RATE);
  const end = Math.min(samples.length, Math.floor(toSec * SAMPLE_RATE));
  const n = end - start;
  if (n <= 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < end; i += 1) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / n;
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

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "bgm-ducking-"));
  const publicDir = mkdtempSync(path.join(tmpdir(), "bgm-ducking-public-"));
  let serveUrl: string | null = null;
  let server: http.Server | null = null;
  try {
    ffmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=gray:s=180x320:r=30:d=3",
      "-f", "lavfi", "-i", `sine=frequency=${BASE_HZ}:sample_rate=${SAMPLE_RATE}:duration=3`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(work, "base.mp4"),
    ]);
    ffmpeg([
      "-y", "-f", "lavfi",
      "-i", `aevalsrc='if(between(t,1,2),0.5*sin(2*PI*${VOICE_HZ}*t),0)':s=${SAMPLE_RATE}:d=3`,
      "-c:a", "pcm_s16le", path.join(work, "voice.wav"),
    ]);
    ffmpeg([
      "-y", "-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*${MUSIC_HZ}*t)':s=${SAMPLE_RATE}:d=3`,
      "-c:a", "pcm_s16le", path.join(work, "music.wav"),
    ]);
    // A track shorter than the clip: it loops, and the duck must stay on the video's clock.
    ffmpeg([
      "-y", "-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*${MUSIC_HZ}*t)':s=${SAMPLE_RATE}:d=0.8`,
      "-c:a", "pcm_s16le", path.join(work, "music-short.wav"),
    ]);

    server = await serve(work);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serveUrl = await bundle({
      entryPoint: path.resolve("scripts/fixtures/bgm-ducking-remotion.tsx"),
      publicDir,
      webpackOverride: (config) => config,
    });
    const render = async (inputProps: Record<string, unknown>, output: string) => {
      const composition = await selectComposition({ serveUrl: serveUrl!, id: "BgmDuckingBurn", inputProps });
      await renderMedia({ composition, serveUrl: serveUrl!, codec: "h264", outputLocation: output, inputProps, logLevel: "error" });
      return decodePcm(output);
    };
    const common = { videoUrl: `${base}/base.mp4`, keywordPopups: [], durationInFrames: 90 };

    const old = await render(common, path.join(work, "old.mp4"));
    const oldBase = toneLevel(old, BASE_HZ, 0.2, 2.8);
    console.log(`  old project: base ${oldBase.toFixed(3)}`);
    // lavfi's sine is 1/8 full scale; the render's channel mix lowers it further. Levels below
    // are compared with each other, not with absolute full scale.
    assert.ok(oldBase > 0.03, `an old project keeps its base audio (${oldBase})`);
    console.log("✓ no audioMix: the base video's own audio plays, as before");

    const mixed = await render({
      ...common,
      audioMix: {
        voiceFile: `${base}/voice.wav`,
        voiceVolume: 1,
        bgmFile: `${base}/music.wav`,
        bgmVolume: 0.5,
        ducking: true,
        duckSegments: [{ startMs: 1000, endMs: 2000 }],
      },
    }, path.join(work, "mixed.mp4"));
    const baseLeft = toneLevel(mixed, BASE_HZ, 0.2, 2.8);
    const voice = toneLevel(mixed, VOICE_HZ, 1.2, 1.8);
    const musicOpen = toneLevel(mixed, MUSIC_HZ, 0.1, 0.7);
    const musicDucked = toneLevel(mixed, MUSIC_HZ, 1.3, 1.7);
    const musicAfter = toneLevel(mixed, MUSIC_HZ, 2.4, 2.9);
    const ratio = musicDucked / musicOpen;
    console.log(`  changed music: base ${baseLeft.toFixed(4)}, voice ${voice.toFixed(3)}, music ${musicOpen.toFixed(3)} → ducked ${musicDucked.toFixed(3)} (x${ratio.toFixed(2)}) → after ${musicAfter.toFixed(3)}`);
    assert.ok(baseLeft < oldBase * 0.02, `the old baked audio is muted (${baseLeft} vs ${oldBase})`);
    console.log("✓ audioMix: the base video's baked audio (old music) is muted");
    assert.ok(voice > 0.1, `the voice track plays (${voice})`);
    console.log("✓ audioMix: the voice track plays");
    assert.ok(musicOpen > 0.05, `music plays in silence (${musicOpen})`);
    assert.ok(Math.abs(musicAfter / musicOpen - 1) < 0.06, `music back to full after the phrase (${musicAfter})`);
    console.log("✓ audioMix: the new music plays at the chosen volume outside speech");
    assert.ok(Math.abs(ratio - DUCK_RATIO) < 0.06, `music under speech at DUCK_RATIO ${DUCK_RATIO} (got ${ratio})`);
    console.log(`✓ ducking: music under speech drops to x${ratio.toFixed(2)} (target ${DUCK_RATIO})`);

    const flat = await render({
      ...common,
      audioMix: { voiceFile: `${base}/voice.wav`, bgmFile: `${base}/music.wav`, bgmVolume: 0.5, ducking: false },
    }, path.join(work, "flat.mp4"));
    const flatRatio = toneLevel(flat, MUSIC_HZ, 1.3, 1.7) / toneLevel(flat, MUSIC_HZ, 0.1, 0.7);
    assert.ok(Math.abs(flatRatio - 1) < 0.06, `ducking off keeps the music flat (x${flatRatio})`);
    console.log("✓ ducking off: the music stays flat under speech");

    // The chosen volume is honoured: 25 % renders at half the 50 % level.
    const quiet = await render({
      ...common,
      audioMix: { voiceFile: `${base}/voice.wav`, bgmFile: `${base}/music.wav`, bgmVolume: 0.25, ducking: false },
    }, path.join(work, "quiet.mp4"));
    const volumeRatio = toneLevel(quiet, MUSIC_HZ, 0.1, 0.7) / toneLevel(flat, MUSIC_HZ, 0.1, 0.7);
    assert.ok(Math.abs(volumeRatio - 0.5) < 0.04, `volume 25 % vs 50 % → x0.5 (got x${volumeRatio})`);
    console.log(`✓ volume: 25 % renders at x${volumeRatio.toFixed(2)} of 50 %`);

    const looped = await render({
      ...common,
      audioMix: {
        voiceFile: `${base}/voice.wav`, bgmFile: `${base}/music-short.wav`, bgmVolume: 0.5, ducking: true,
        duckSegments: [{ startMs: 1000, endMs: 2000 }],
      },
    }, path.join(work, "looped.mp4"));
    const loopOpen = toneLevel(looped, MUSIC_HZ, 2.45, 2.75);
    const loopDucked = toneLevel(looped, MUSIC_HZ, 1.3, 1.55);
    const loopRatio = loopDucked / loopOpen;
    console.log(`  0.8 s track looped: open ${loopOpen.toFixed(3)} → ducked ${loopDucked.toFixed(3)} (x${loopRatio.toFixed(2)})`);
    assert.ok(loopOpen > 0.05 && Math.abs(loopRatio - DUCK_RATIO) < 0.06, `a looping track still ducks on the video clock (x${loopRatio})`);
    console.log("✓ a short track loops and still ducks on the video's clock (loopVolumeCurveBehavior=extend)");

    const none = await render({ ...common, audioMix: { voiceFile: `${base}/voice.wav`, bgmVolume: 0.5, ducking: false } }, path.join(work, "none.mp4"));
    assert.ok(toneLevel(none, MUSIC_HZ, 0.1, 2.9) < 0.005 && toneLevel(none, BASE_HZ, 0.2, 2.8) < oldBase * 0.02, "no music: voice only");
    assert.ok(toneLevel(none, VOICE_HZ, 1.2, 1.8) > 0.1, "no music: the voice still plays");
    console.log("✓ \"no music\": voice only, no old or new music");
  } finally {
    server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }
  console.log("\n✅ BGM DUCKING RENDER CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

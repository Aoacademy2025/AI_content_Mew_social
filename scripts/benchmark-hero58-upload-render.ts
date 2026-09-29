/** Synthetic, local-only HERO-58 profile. Outputs remain under ignored .tmp/hero58. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { applyKenBurns, normalizeForRemotion } from "../src/lib/broll-asset-lib";
import { validateWindowEdits, mergeWindowEdits } from "../src/lib/broll-rerender";
import { prepareBrollRenderAssets } from "../src/lib/broll-coverage";
import { prepareRemotionBundlePublicDir } from "../src/lib/render/remotion-public-dir";
import { runRender } from "../src/lib/render/run-render";
import { makeCancelSignal } from "@remotion/renderer";

const root = path.resolve(".tmp/hero58");
const mediaDir = path.join(root, "media");
const outputDir = path.join(root, "renders");
const metricsPath = path.join(root, "metrics.ndjson");
const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const ffprobe = "/opt/homebrew/bin/ffprobe";
const mode = process.argv[2] ?? "smoke";
const duration = mode === "smoke" ? 2 : 60;
const fps = 30;

function command(bin: string, args: string[]) {
  const p = spawnSync(bin, args, { encoding: "utf8", timeout: 600_000 });
  if (p.status !== 0) throw new Error(`${path.basename(bin)} exit ${p.status}: ${p.stderr.slice(-1500)}`);
  return p.stdout;
}
function probe(file: string): number {
  return Number(command(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]).trim());
}
function elapsed(start: number) { return Math.round(performance.now() - start); }
function record(value: Record<string, unknown>) {
  fs.appendFileSync(metricsPath, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
  console.log(JSON.stringify(value));
}
function make(file: string, args: string[]) {
  if (!fs.existsSync(file)) command(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
}

async function fixtures() {
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const image = path.join(mediaDir, "upload-still.jpg");
  const imageMp4 = path.join(mediaDir, "broll-upload-still.mp4");
  const inputVideo = path.join(mediaDir, "upload-video-source.mp4");
  const videoMp4 = path.join(mediaDir, "broll-upload-video.mp4");
  const base = path.join(mediaDir, "base.mp4");
  const voice = path.join(mediaDir, "voice.wav");
  make(image, ["-f", "lavfi", "-i", "testsrc2=size=540x960:rate=1", "-frames:v", "1", "-q:v", "3"]);
  make(inputVideo, ["-f", "lavfi", "-i", "testsrc2=size=540x960:rate=24", "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
  make(base, ["-f", "lavfi", "-i", "smptebars=size=540x960:rate=30", "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0"]);
  make(voice, ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "60", "-c:a", "pcm_s16le"]);

  if (!fs.existsSync(imageMp4)) {
    const t = performance.now();
    await applyKenBurns(image, imageMp4);
    record({ stage: "upload_normalize_image", ms: elapsed(t), inputBytes: fs.statSync(image).size, outputBytes: fs.statSync(imageMp4).size });
  }
  if (!fs.existsSync(videoMp4)) {
    fs.copyFileSync(inputVideo, videoMp4);
    const t = performance.now();
    const result = await normalizeForRemotion(videoMp4);
    if (result.status !== "normalized") throw new Error(`video normalization: ${JSON.stringify(result)}`);
    record({ stage: "upload_normalize_video", ms: elapsed(t), inputBytes: fs.statSync(inputVideo).size, outputBytes: fs.statSync(videoMp4).size });
  }
  const imageMp4s = [imageMp4];
  const videoMp4s = [videoMp4];
  if (mode === "multi-unique" || mode === "cache-probe") {
    const extraStill = path.join(mediaDir, "broll-upload-still-2.mp4");
    if (!fs.existsSync(extraStill)) {
      const t = performance.now();
      await applyKenBurns(image, extraStill);
      record({ stage: "upload_normalize_image", variant: 2, ms: elapsed(t), outputBytes: fs.statSync(extraStill).size });
    }
    imageMp4s.push(extraStill);
    for (let i = 2; i <= 3; i++) {
      const extraVideo = path.join(mediaDir, `broll-upload-video-${i}.mp4`);
      if (!fs.existsSync(extraVideo)) {
        fs.copyFileSync(inputVideo, extraVideo);
        const t = performance.now();
        const result = await normalizeForRemotion(extraVideo);
        if (result.status !== "normalized") throw new Error(`video normalization ${i}: ${JSON.stringify(result)}`);
        record({ stage: "upload_normalize_video", variant: i, ms: elapsed(t), outputBytes: fs.statSync(extraVideo).size });
      }
      videoMp4s.push(extraVideo);
    }
  }
  return { imageMp4, videoMp4, imageMp4s, videoMp4s, base, voice };
}

function serve(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const file = path.join(mediaDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const size = fs.statSync(file).size;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? "");
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || end < start) { res.writeHead(416).end(); return; }
    res.writeHead(match ? 206 : 200, {
      "content-type": file.endsWith(".wav") ? "audio/wav" : "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "content-length": end - start + 1,
      ...(match ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    resolve({ baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
  }));
}

async function buildConfig(kind: "still" | "video" | "multi", media: Awaited<ReturnType<typeof fixtures>>, baseUrl: string) {
  const count = Math.ceil(duration / 4);
  const source = Array.from({ length: count }, (_, i) => ({
    src: `/api/stocks/${path.basename(media.base)}`, start: i * 4, end: Math.min(duration, (i + 1) * 4), clipDuration: 5,
  }));
  const replacement = (index: number, file: string) => ({ index, src: `/api/stocks/${path.basename(file)}`, clipDuration: 5, replacementKind: "upload" });
  const singleIndex = mode === "smoke" ? 0 : 1;
  const raw = kind === "still" ? [replacement(singleIndex, media.imageMp4)]
    : kind === "video" ? [replacement(singleIndex, media.videoMp4)]
    : [replacement(1, media.imageMp4s[0]), replacement(4, media.videoMp4s[0]), replacement(7, media.imageMp4s[1] ?? media.imageMp4s[0]), replacement(10, media.videoMp4s[1] ?? media.videoMp4s[0]), replacement(13, media.videoMp4s[2] ?? media.videoMp4s[0])];
  const t0 = performance.now();
  const edits = validateWindowEdits(raw);
  if ("error" in edits) throw new Error(edits.error);
  const merged = mergeWindowEdits(source, edits);
  if ("error" in merged) throw new Error(merged.error);
  const prep = await prepareBrollRenderAssets(merged.bgVideos as typeof source, duration, fps, {
    requestedWindowCount: count,
    resolveAsset: (src) => ({ src: `${baseUrl}${src}`, localPath: path.join(mediaDir, path.basename(src)) }),
    isUsableLocalFile: (localPath) => fs.existsSync(localPath) && fs.statSync(localPath).size > 1500,
    probeDurationSec: async (localPath) => probe(localPath),
  });
  const prepMs = elapsed(t0);
  if (!prep.coverage.complete) throw new Error("coverage incomplete");
  return {
    prepMs,
    config: {
      bgVideos: prep.coverage.segments,
      keywordPopups: [], voiceFile: `${baseUrl}/api/stocks/${path.basename(media.voice)}`, voiceVolume: 1,
      durationInFrames: duration * fps, watermark: false,
    },
    count: prep.coverage.segments.length,
  };
}

async function main() {
  const media = await fixtures();
  if (mode === "prepare") return;
  const server = await serve();
  process.env.RENDER_CONCURRENCY = "3";
  process.env.RENDER_JOB_CONCURRENCY = "2";
  process.env.RENDER_OFFTHREAD_CACHE_MB = process.env.HERO58_CACHE_MB ?? "128";
  process.env.RENDER_JPEG_QUALITY = "90";
  process.env.RENDER_LOW_RESOURCE = process.env.HERO58_FORCE_LOW_RESOURCE === "1" ? "1" : "0";
  let cachedLocation: string | null = null;
  let cachedMtime = "";
  const bundleCache = { get: () => ({ location: cachedLocation, mtime: cachedMtime }), set: (location: string | null, mtime: string) => { cachedLocation = location; cachedMtime = mtime; } };
  const kinds: ("still" | "video" | "multi")[] = mode === "smoke" || mode === "diagnostic" ? ["video"] : ["still", "video", "multi"];
  const cases = mode === "smoke" || mode === "diagnostic" ? [{ kind: "video" as const, jobs: 1 }]
    : mode === "multi-unique" ? [{ kind: "multi" as const, jobs: 1 }, { kind: "multi" as const, jobs: 2 }]
    : mode === "cache-probe" ? [{ kind: "multi" as const, jobs: 1 }] : [
    ...kinds.map((kind) => ({ kind, jobs: 1 })), { kind: "multi" as const, jobs: 2 },
  ];
  try {
    for (const c of cases) {
      const runs = await Promise.all(Array.from({ length: c.jobs }, async (_, index) => {
        const built = await buildConfig(c.kind, media, server.baseUrl);
        const id = `${c.kind}-${c.jobs}-${index}`;
        const { cancelSignal } = makeCancelSignal();
        const start = performance.now();
        let renderStart = 0;
        let queueWaitMs = 0;
        let lastPct = 0;
        const result = await runRender({
          isSubtitleOverlay: false, isShortVideo: true, isAvatarMode: false,
          resolvedSubtitleConfig: null, resolvedShortConfig: built.config, resolvedScenes: null,
          audioUrl: null, captionsData: null, avatarVideoUrl: null,
          durationInFrames: duration * fps, fps, requestedJpegQuality: 90,
          entryPoint: path.resolve("src/remotion/index.tsx"), bundlePublicDir: prepareRemotionBundlePublicDir(),
          rendersDir: outputDir, bundleCache,
        }, {
          jobId: id, cancelSignal,
          onProgress: (pct) => { lastPct = pct; },
          hooks: { onRenderStart: ({ renderQueueWaitMs }) => { renderStart = performance.now(); queueWaitMs = renderQueueWaitMs; } },
        });
        const totalMs = elapsed(start);
        const renderMs = Math.round(performance.now() - renderStart);
        const file = path.join(outputDir, path.basename(result.videoUrl));
        return { id, prepMs: built.prepMs, segmentCount: built.count, totalMs, renderMs, preRenderMs: totalMs - renderMs, queueWaitMs, lastPct, outputBytes: fs.statSync(file).size, outputDurationSec: probe(file) };
      }));
      for (const run of runs) record({ stage: "render", kind: c.kind, jobs: c.jobs, durationSec: duration, cacheMb: Number(process.env.RENDER_OFFTHREAD_CACHE_MB), ...run });
    }
  } finally { await server.close(); }
  record({ stage: "environment", cpus: os.cpus().length, ramBytes: os.totalmem(), platform: process.platform, arch: process.arch, node: process.version });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

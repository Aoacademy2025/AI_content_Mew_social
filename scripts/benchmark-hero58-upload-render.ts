/** Synthetic, local-only HERO-58 profile. Outputs remain under ignored .tmp/hero58. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { applyKenBurns, normalizeForRemotion } from "../src/lib/broll-asset-lib";
import { validateWindowEdits, mergeWindowEdits } from "../src/lib/broll-rerender";
import { prepareBrollRenderAssets } from "../src/lib/broll-coverage";
import { prepareRemotionBundlePublicDir } from "../src/lib/render/remotion-public-dir";
import { runRender } from "../src/lib/render/run-render";
import { makeCancelSignal, openBrowser, renderFrames, selectComposition } from "@remotion/renderer";
import { bundle } from "@remotion/bundler";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";

const root = path.resolve(".tmp/hero58");
const mediaDir = path.join(root, "media");
const outputDir = path.join(root, "renders");
const metricsPath = path.join(root, "metrics.ndjson");
const ffmpeg = getFfmpegPath();
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/u, (_match, ext: string | undefined) => `ffprobe${ext ?? ""}`);
const mode = process.argv[2] ?? "smoke";
const duration = mode === "smoke" ? 2 : mode === "component-short" ? 12 : 60;
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
  if (mode === "multi-unique" || mode === "cache-probe" || mode === "component-full") {
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

type MediaStats = { get: number; head: number; ranged: number; bytes: number; byFile: Record<string, { get: number; ranged: number; bytes: number }> };

function serve(): Promise<{ baseUrl: string; stats: () => MediaStats; close: () => Promise<void> }> {
  const stats: MediaStats = { get: 0, head: 0, ranged: 0, bytes: 0, byFile: {} };
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const file = path.join(mediaDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const size = fs.statSync(file).size;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? "");
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || end < start) { res.writeHead(416).end(); return; }
    const fileStats = (stats.byFile[name] ??= { get: 0, ranged: 0, bytes: 0 });
    if (req.method === "HEAD") stats.head++;
    else { stats.get++; fileStats.get++; }
    if (match) { stats.ranged++; fileStats.ranged++; }
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
    const stream = fs.createReadStream(file, { start, end });
    stream.on("data", (chunk: Buffer) => { stats.bytes += chunk.length; fileStats.bytes += chunk.length; });
    stream.pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    resolve({ baseUrl: `http://127.0.0.1:${address.port}`, stats: () => structuredClone(stats), close: () => new Promise<void>((done) => server.close(() => done())) });
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil((p / 100) * sorted.length) - 1] * 10) / 10;
}

function cpuSampler() {
  const samples: { browserCpu: number; browserRssMb: number; compositorCpu: number; compositorRssMb: number }[] = [];
  let active = true;
  const sample = () => execFile("ps", ["-A", "-o", "%cpu=,rss=,command="], { maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
    if (error || !active) return;
    const current = { browserCpu: 0, browserRssMb: 0, compositorCpu: 0, compositorRssMb: 0 };
    for (const line of stdout.split("\n")) {
      if (!line.includes(process.cwd())) continue;
      const match = /^\s*([\d.]+)\s+(\d+)\s+/u.exec(line);
      if (!match) continue;
      if (line.includes("node_modules/.remotion/chrome")) {
        current.browserCpu += Number(match[1]);
        current.browserRssMb += Number(match[2]) / 1024;
      } else if (line.includes("node_modules/@remotion/compositor")) {
        current.compositorCpu += Number(match[1]);
        current.compositorRssMb += Number(match[2]) / 1024;
      }
    }
    samples.push(current);
  });
  sample();
  const timer = setInterval(sample, 1000);
  return () => { active = false; clearInterval(timer); return samples; };
}

async function profileComponents(media: Awaited<ReturnType<typeof fixtures>>, server: Awaited<ReturnType<typeof serve>>) {
  const kind = mode === "component-short" ? "video" : "multi";
  const built = await buildConfig(kind, media, server.baseUrl);
  const bundlingStarted = performance.now();
  const serveUrl = await bundle({ entryPoint: path.resolve("src/remotion/index.tsx"), publicDir: prepareRemotionBundlePublicDir() });
  const bundleMs = elapsed(bundlingStarted);
  const envVariables = { NEXT_PUBLIC_SUBTITLE_FIT_V2: process.env.NEXT_PUBLIC_SUBTITLE_FIT_V2 ?? "1" };
  const composition = await selectComposition({ serveUrl, id: "ShortVideoComposition", inputProps: built.config, envVariables, timeoutInMilliseconds: 120000 });
  composition.durationInFrames = duration * fps;
  const chromiumOptions = {
    disableWebSecurity: true, ignoreCertificateErrors: true, gl: "swiftshader" as const,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--no-sandbox", "--js-flags=--max-old-space-size=512", "--disable-extensions", "--disable-background-networking", "--disable-default-apps", "--gpu-process-limit=0", "--disable-features=OutOfBlinkCors"],
  };
  const frames: { frame: number; ms: number }[] = [];
  const framesDir = path.join(root, `frames-${mode}`);
  fs.rmSync(framesDir, { recursive: true, force: true });
  const traceEnabled = mode === "component-short" && process.env.HERO58_CHROME_TRACE === "1";
  const browser = traceEnabled ? await openBrowser("chrome", { chromiumOptions }) : undefined;
  const cdp = browser?.connection as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<{ value: Record<string, unknown> }>; on: (event: string, callback: (payload: Record<string, unknown>) => void) => void } | undefined;
  if (cdp) await cdp.send("Tracing.start", { categories: "devtools.timeline,blink,cc,gpu,disabled-by-default-devtools.timeline.frame", transferMode: "ReturnAsStream" });
  const stopCpu = cpuSampler();
  const started = performance.now();
  let frameStageMs = 0;
  let samples: ReturnType<ReturnType<typeof cpuSampler>> = [];
  let trace: { bytes: number; events: number; categories: Record<string, { count: number; durationMs: number }> } | undefined;
  try {
    await renderFrames({
      composition, serveUrl, inputProps: built.config, envVariables,
      outputDir: framesDir, imageFormat: "jpeg", jpegQuality: 90,
      concurrency: 3, offthreadVideoCacheSizeInBytes: 128 * 1024 * 1024,
      chromiumOptions, puppeteerInstance: browser, timeoutInMilliseconds: 7200000,
      onStart: () => {},
      onFrameUpdate: (_count, frame, ms) => { frames.push({ frame, ms }); },
    });
    frameStageMs = elapsed(started);
    if (cdp) {
      const complete = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Chromium tracingComplete timeout")), 30_000);
        cdp.on("Tracing.tracingComplete", (event) => { clearTimeout(timer); resolve(String(event.stream)); });
      });
      await cdp.send("Tracing.end");
      const stream = await complete;
      const chunks: string[] = [];
      for (;;) {
        const { value } = await cdp.send("IO.read", { handle: stream });
        chunks.push(String(value.data ?? ""));
        if (value.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      const raw = chunks.join("");
      fs.writeFileSync(path.join(root, "chromium-component-short-trace.json"), raw);
      const events = (JSON.parse(raw) as { traceEvents: { name?: string; ph?: string; dur?: number }[] }).traceEvents;
      const categories: Record<string, { count: number; durationMs: number }> = {};
      for (const event of events) {
        if (event.ph !== "X" || !event.name || !event.dur) continue;
        const category = (categories[event.name] ??= { count: 0, durationMs: 0 });
        category.count++;
        category.durationMs += event.dur / 1000;
      }
      for (const category of Object.values(categories)) category.durationMs = Math.round(category.durationMs);
      trace = { bytes: Buffer.byteLength(raw), events: events.length, categories };
    }
  } finally { samples = stopCpu(); if (browser) await browser.close({ silent: true }); }
  if (frames.length !== duration * fps) throw new Error(`Expected ${duration * fps} frame timings, got ${frames.length}`);
  const values = frames.map((entry) => entry.ms);
  const isBoundary = (frame: number) => {
    const edge = Math.round(frame / 120) * 120;
    return edge > 0 && edge < duration * fps && Math.abs(frame - edge) <= 8;
  };
  const boundary = frames.filter(({ frame }) => isBoundary(frame)).map(({ ms }) => ms);
  const interior = frames.filter(({ frame }) => !isBoundary(frame)).map(({ ms }) => ms);
  const mediaStats = server.stats();
  const detail = { mode, durationSec: duration, kind, bundleMs, prepMs: built.prepMs, frameStageMs,
    settings: { width: composition.width, height: composition.height, fps, concurrency: 3, jpegQuality: 90, offthreadCacheMb: 128, lowResource: process.env.RENDER_LOW_RESOURCE === "1", imageFormat: "jpeg", finalEncode: false },
    frameMs: { p50: percentile(values, 50), p90: percentile(values, 90), p95: percentile(values, 95), p99: percentile(values, 99), max: Math.round(Math.max(...values) * 10) / 10 },
    boundaryMs: { p50: percentile(boundary, 50), p95: percentile(boundary, 95), n: boundary.length },
    interiorMs: { p50: percentile(interior, 50), p95: percentile(interior, 95), n: interior.length },
    cpu: { samples: samples.length, browserMedianPct: percentile(samples.map((s) => s.browserCpu), 50), browserP95Pct: percentile(samples.map((s) => s.browserCpu), 95), browserPeakRssMb: Math.round(Math.max(0, ...samples.map((s) => s.browserRssMb))), compositorMedianPct: percentile(samples.map((s) => s.compositorCpu), 50), compositorP95Pct: percentile(samples.map((s) => s.compositorCpu), 95), compositorPeakRssMb: Math.round(Math.max(0, ...samples.map((s) => s.compositorRssMb))) },
    media: mediaStats,
  };
  fs.writeFileSync(path.join(root, `component-${mode}.json`), JSON.stringify({ ...detail, frames, cpuSamples: samples, trace }, null, 2));
  record({ stage: "component_profile", ...detail });
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
  if (mode === "component-short" || mode === "component-full") {
    try { await profileComponents(media, server); } finally { await server.close(); }
    return;
  }
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

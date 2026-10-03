// Verifies G24 (docs/plans/2026-10-03-mcp-edit-before-export.md, Task 2 / PR-0):
// every ffprobe/ffmpeg run on user-uploaded media in /api/videos/broll-window/upload and
// /api/videos/upload-avatar — and in the helpers they call — uses `-protocol_whitelist file`
// plus an explicit allowlisted input demuxer, so an HLS playlist or an ffconcat script
// renamed to .mp4/.jpg cannot make ffmpeg open another local file or a network URL.
//
//   1. Unit: arg builder, container sniffing, demuxer resolution (never hls/concat).
//   2. Controls: the detectors really see access — an auto-detected ffconcat reads the
//      canary file, a forced hls/concat demuxer connects to the loopback server.
//   3. Hostile: playlists renamed to every allowed extension are rejected by the real
//      probe/transcode helpers with zero canary reads and zero loopback connections.
//  3b. upload-avatar end to end (fix round 1): the real POST handler (auth/DB/telemetry
//      stubbed with node:test mock.module) answers a disguised playlist with a 415 and
//      leaves nothing under public/renders; real mp4/mov/webm still get 200 + the same
//      durationMs the pre-change probe produced.
//   4. Legit: mp4/mov/webm/jpg/jpeg/png/webp, mislabelled real media and a motion-photo
//      JPEG still pass, and their output frames equal the auto-detect (pre-change) path.
//   5. Route source: neither route spawns ffmpeg/ffprobe itself; every call passes the
//      resolved demuxer, and the input options sit before `-i`.
//
// Needs real ffmpeg AND ffprobe (CI installs them with apt).
// Run: npm run verify:upload-probe-whitelist
//   (= node --experimental-test-module-mocks --import tsx scripts/verify-upload-probe-whitelist.ts)
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import {
  SAFE_INPUT_DEMUXERS,
  resolveSafeInputDemuxer,
  safeInputArgs,
  sniffMediaContainer,
  type SafeInputDemuxer,
  type UploadMediaKind,
} from "../src/lib/media-probe-args";
import {
  ffprobeDimensions,
  ffprobeDurationSec,
  getFfprobePath,
  probeDurationMs,
} from "../src/lib/upload-media-probe";
import {
  applyKenBurns,
  isValidMp4Path,
  KEN_BURNS_DURATION_SEC,
  normalizeForRemotion,
} from "../src/lib/broll-asset-lib";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const tick = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const FORBIDDEN_DEMUXERS = ["hls", "concat", "image2pipe", "webm_dash_manifest", "dash", "ffmetadata", "lavfi"];

// ---------------------------------------------------------------------------------------
// 1. Unit: arg builder + sniffing + resolution
// ---------------------------------------------------------------------------------------
function unitChecks(tmp: string): void {
  console.log("\n# 1. arg builder, sniffing, resolution");

  // PR-0 shipped the six video/image demuxers; PR-0b (Task 2b) added the five audio ones.
  check("allowlist has exactly the eleven G24 demuxers",
    JSON.stringify([...SAFE_INPUT_DEMUXERS].sort())
      === JSON.stringify(["aac", "flac", "image2", "jpeg_pipe", "matroska", "mov", "mp3", "ogg", "png_pipe", "wav", "webp_pipe"]));
  check("allowlist contains no playlist/concat demuxer",
    SAFE_INPUT_DEMUXERS.every((d) => !FORBIDDEN_DEMUXERS.includes(d)));

  const expected: Record<SafeInputDemuxer, string[]> = {
    mov: ["-protocol_whitelist", "file", "-f", "mov"],
    matroska: ["-protocol_whitelist", "file", "-f", "matroska"],
    image2: ["-protocol_whitelist", "file", "-f", "image2", "-pattern_type", "none"],
    jpeg_pipe: ["-protocol_whitelist", "file", "-f", "jpeg_pipe"],
    png_pipe: ["-protocol_whitelist", "file", "-f", "png_pipe"],
    webp_pipe: ["-protocol_whitelist", "file", "-f", "webp_pipe"],
    mp3: ["-protocol_whitelist", "file", "-f", "mp3"],
    wav: ["-protocol_whitelist", "file", "-f", "wav"],
    ogg: ["-protocol_whitelist", "file", "-f", "ogg"],
    aac: ["-protocol_whitelist", "file", "-f", "aac"],
    flac: ["-protocol_whitelist", "file", "-f", "flac"],
  };
  for (const demuxer of SAFE_INPUT_DEMUXERS) {
    const args = safeInputArgs(demuxer);
    check(`safeInputArgs(${demuxer})`, JSON.stringify(args) === JSON.stringify(expected[demuxer]), args.join(" "));
  }
  const first = safeInputArgs("mov");
  first.push("-mutated");
  check("safeInputArgs returns a fresh array each call", !safeInputArgs("mov").includes("-mutated"));

  const iso = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
  const qtWide = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("wide"), Buffer.alloc(8)]);
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
  const avi = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("AVI LIST")]);
  const m3u8 = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n");
  const ffconcat = Buffer.from("ffconcat version 1.0\nfile 'a.mp4'\n");
  const sniffCases: Array<[string, Buffer, string | null]> = [
    ["ISO BMFF ftyp", iso, "isobmff"],
    ["QuickTime wide atom", qtWide, "isobmff"],
    ["EBML (Matroska/WebM)", ebml, "matroska"],
    ["JPEG SOI", jpeg, "jpeg"],
    ["PNG signature", png, "png"],
    ["RIFF/WEBP", webp, "webp"],
    ["RIFF/AVI is not webp", avi, null],
    ["#EXTM3U playlist", m3u8, null],
    ["ffconcat script", ffconcat, null],
    ["empty", Buffer.alloc(0), null],
    ["3 bytes", Buffer.from([0xff, 0xd8, 0xff]), "jpeg"],
  ];
  for (const [label, buf, want] of sniffCases) {
    const got = sniffMediaContainer(buf);
    check(`sniff: ${label}`, got === want, `got ${got}`);
  }

  // resolveSafeInputDemuxer(filePath, routeExt, kind): content first (within the kind),
  // then the route's validated extension. The file's own name only matters for image2.
  const write = (name: string, head: Buffer) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, Buffer.concat([head, Buffer.alloc(64)]));
    return p;
  };
  const resolveCases: Array<[string, string, string, UploadMediaKind, SafeInputDemuxer | null]> = [
    // label, file, routeExt, kind, expected
    ["m3u8 named .mp4 → mov (ext fallback)", write("u-hls.mp4", m3u8), "mp4", "video", "mov"],
    ["m3u8 named .mov → mov", write("u-hls.mov", m3u8), "mov", "video", "mov"],
    ["m3u8 named .webm → matroska", write("u-hls.webm", m3u8), "webm", "video", "matroska"],
    ["ffconcat named .mp4 → mov", write("u-cc.mp4", ffconcat), "mp4", "video", "mov"],
    ["m3u8 named .jpg → image2", write("u-hls.jpg", m3u8), "jpg", "image", "image2"],
    ["m3u8 named .jpeg → image2", write("u-hls.jpeg", m3u8), "jpeg", "image", "image2"],
    ["m3u8 named .png → png_pipe", write("u-hls.png", m3u8), "png", "image", "png_pipe"],
    ["m3u8 named .webp → webp_pipe", write("u-hls.webp", m3u8), "webp", "image", "webp_pipe"],
    ["EBML named .mp4 → matroska", write("u-ebml.mp4", ebml), "mp4", "video", "matroska"],
    ["ISO named .webm → mov", write("u-iso.webm", iso), "webm", "video", "mov"],
    ["PNG named .jpg → png_pipe", write("u-png.jpg", png), "jpg", "image", "png_pipe"],
    ["WEBP named .jpg → webp_pipe", write("u-webp.jpg", webp), "jpg", "image", "webp_pipe"],
    ["JPEG named .png → jpeg_pipe (image2 would decode by extension)", write("u-jpeg.png", jpeg), "png", "image", "jpeg_pipe"],
    ["JPEG named .JPG → image2", write("u-jpeg.JPG", jpeg), "jpg", "image", "image2"],
    ["JPEG bytes on the video path → ext fallback mov", write("u-jpeg-v.mp4", jpeg), "mp4", "video", "mov"],
    ["ISO bytes on the image path → ext fallback image2", write("u-iso-i.jpg", iso), "jpg", "image", "image2"],
    ["broll video streamed to .mp4 but uploaded as webm → matroska", write("u-ebml-stocks.mp4", ebml), "webm", "video", "matroska"],
    ["unknown route ext gif → null", write("u.gif", m3u8), "gif", "image", null],
    ["route ext m3u8 → null", write("u.m3u8", m3u8), "m3u8", "video", null],
    ["image ext on the video kind → null", write("u-kind.png", m3u8), "png", "video", null],
    ["missing file → ext fallback", path.join(tmp, "does-not-exist.mp4"), "mp4", "video", "mov"],
  ];
  for (const [label, file, ext, kind, want] of resolveCases) {
    const got = resolveSafeInputDemuxer(file, ext, kind);
    check(`resolve: ${label}`, got === want, `got ${got}`);
    if (got) check(`resolve: ${label} stays in the allowlist`, SAFE_INPUT_DEMUXERS.includes(got) && !FORBIDDEN_DEMUXERS.includes(got));
  }
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------
async function ff(args: string[]): Promise<void> {
  await execFileAsync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 16 << 20 });
}

async function makeVideo(out: string, container: "mp4" | "mov" | "webm"): Promise<void> {
  const src = ["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=1"];
  if (container !== "webm") {
    await ff([...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    return;
  }
  try {
    await ff([...src, "-c:v", "libvpx-vp9", "-b:v", "300k", out]);
  } catch {
    await ff([...src, "-c:v", "libvpx", "-b:v", "300k", out]);
  }
}

async function makeImages(dir: string): Promise<{ jpg: string; png: string; webp: string }> {
  const jpg = path.join(dir, "real.jpg");
  const png = path.join(dir, "real.png");
  const webp = path.join(dir, "real.webp");
  // > 2 KB so ffmpeg's own auto-detection picks image2 for .jpg, as it does for real photos.
  await ff(["-f", "lavfi", "-i", "testsrc2=size=900x1200:rate=1:duration=1", "-frames:v", "1", "-q:v", "3", jpg]);
  await ff(["-f", "lavfi", "-i", "testsrc2=size=900x1200:rate=1:duration=1", "-frames:v", "1", png]);
  // The macOS Homebrew ffmpeg ships no libwebp encoder; sharp (already a dependency) does.
  await sharp(png).webp({ quality: 80 }).toFile(webp);
  return { jpg, png, webp };
}

async function framesHash(file: string): Promise<{ frames: number; hash: string }> {
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "framemd5", "-"],
    { maxBuffer: 64 << 20 },
  );
  const lines = stdout.split("\n").filter((line) => /^\d+,/.test(line));
  return { frames: lines.length, hash: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16) };
}

// ---------------------------------------------------------------------------------------
// Access detectors: a loopback HTTP server + canary files whose atime we arm to epoch 0.
// ---------------------------------------------------------------------------------------
type Detectors = {
  port: number;
  canaries: string[];
  arm: () => void;
  observed: () => Promise<{ connections: number; requests: number; canariesRead: string[] }>;
  close: () => Promise<void>;
};

async function startDetectors(dir: string, canarySource: string): Promise<Detectors> {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(404);
    res.end();
  });
  server.on("connection", () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // canary.ts = what an HLS segment line points at; canary.mp4 = what an ffconcat
  // `file` line points at (relative + "safe", so it is allowed by concat's defaults).
  const canaries = ["canary.ts", "canary.mp4"].map((name) => path.join(dir, name));
  for (const canary of canaries) fs.copyFileSync(canarySource, canary);
  return {
    port,
    canaries,
    arm() {
      connections = 0;
      requests = 0;
      for (const canary of canaries) {
        const { mtime } = fs.statSync(canary);
        fs.utimesSync(canary, new Date(0), mtime);
      }
    },
    async observed() {
      await tick(); // let queued 'connection' events from a sync probe reach the loop
      return {
        connections,
        requests,
        canariesRead: canaries.filter((c) => fs.statSync(c).atimeMs > 1_000).map((c) => path.basename(c)),
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runTool(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 16 << 20 });
    return `${stdout}${stderr}`;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

// ---------------------------------------------------------------------------------------
// 2 + 3. Controls and hostile playlists
// ---------------------------------------------------------------------------------------
// An HLS playlist (loopback URL + local canary segment), an ffconcat naming the local
// canary, and an ffconcat naming a loopback URL. Entries are relative to the playlist.
function hostilePlaylists(port: number): Array<[string, string]> {
  const url = `http://127.0.0.1:${port}`;
  const hls = [
    "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXTINF:1.0,", `${url}/seg0.ts`,
    "#EXTINF:1.0,", "canary.ts",
    "#EXT-X-ENDLIST", "",
  ].join("\n");
  const concatLocal = "ffconcat version 1.0\nfile 'canary.mp4'\n";
  const concatNet = `ffconcat version 1.0\nfile '${url}/c.mp4'\n`;
  return [["hls", hls], ["concat-local", concatLocal], ["concat-net", concatNet]];
}

async function hostileChecks(dir: string, det: Detectors): Promise<void> {
  console.log("\n# 2. detector controls");
  const playlists = hostilePlaylists(det.port);
  const at = (name: string, ext: string) => path.join(dir, `evil-${name}.${ext}`);
  for (const [name, body] of playlists) fs.writeFileSync(at(name, "mp4"), body);

  const ffprobe = getFfprobePath();
  // The exact ffprobe call the routes made before this change (no whitelist, no -f).
  det.arm();
  await runTool(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", at("concat-local", "mp4")]);
  let seen = await det.observed();
  check("control: pre-change auto-detect opens an ffconcat renamed to .mp4 and reads the canary",
    seen.canariesRead.includes("canary.mp4"), JSON.stringify(seen));

  det.arm();
  await runTool(ffprobe, ["-v", "error", "-protocol_whitelist", "file,http,tcp", "-f", "hls",
    "-show_entries", "format=duration", "-of", "csv=p=0", at("hls", "mp4")]);
  seen = await det.observed();
  check("control: a forced hls demuxer reaches the loopback server and the canary segment",
    seen.connections > 0 && seen.canariesRead.includes("canary.ts"), JSON.stringify(seen));

  det.arm();
  await runTool(ffprobe, ["-v", "error", "-safe", "0", "-protocol_whitelist", "file,http,tcp", "-f", "concat",
    "-show_entries", "format=duration", "-of", "csv=p=0", at("concat-net", "mp4")]);
  seen = await det.observed();
  check("control: an unsafe concat reaches the loopback server", seen.connections > 0, JSON.stringify(seen));

  det.arm();
  const autoHls = await runTool(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", at("hls", "mp4")]);
  seen = await det.observed();
  console.log(`  info: pre-change auto-detect on an m3u8 renamed to .mp4 → ${JSON.stringify(seen)} :: ${autoHls.replace(/\s+/g, " ").slice(0, 140)}`);
  console.log("        (ffmpeg ≤ 6 follows it; prod runs 4.4 — see the task-2 report)");

  console.log("\n# 3. hostile playlists through the real probe/transcode helpers");
  const targets: Array<[UploadMediaKind, string]> = [
    ["video", "mp4"], ["video", "mov"], ["video", "webm"],
    ["image", "jpg"], ["image", "jpeg"], ["image", "png"], ["image", "webp"],
  ];
  for (const [name, body] of playlists) {
    for (const [kind, ext] of targets) {
      const file = at(name, ext);
      fs.writeFileSync(file, body);
      det.arm();
      const demuxer = resolveSafeInputDemuxer(file, ext, kind);
      const label = `${name} renamed to .${ext} (${kind}, -f ${demuxer})`;
      check(`${label}: resolves to an allowlisted demuxer`,
        demuxer !== null && SAFE_INPUT_DEMUXERS.includes(demuxer) && !FORBIDDEN_DEMUXERS.includes(demuxer));
      if (!demuxer) continue;

      // Both routes gate on this probe before any transcode (415 on null).
      check(`${label}: ffprobeDimensions rejects`, ffprobeDimensions(file, demuxer) === null);
      if (kind === "video") {
        // upload-avatar's duration probe (ffprobe, then the ffmpeg -i fallback).
        check(`${label}: probeDurationMs rejects (ffprobe + ffmpeg fallback)`, (await probeDurationMs(file, demuxer)) === null);
        check(`${label}: ffprobeDurationSec rejects`, ffprobeDurationSec(file, demuxer) === 0);
        // The transcode itself must fail closed too, even if a caller skipped the probe.
        const copy = path.join(dir, `evil-${name}-norm.${ext}`);
        fs.copyFileSync(file, copy);
        const warn = console.warn;
        console.warn = () => {}; // the expected "[fetch-stock] normalize failed" dump
        const result = await normalizeForRemotion(copy, { inputFormat: demuxer }).finally(() => {
          console.warn = warn;
        });
        check(`${label}: normalizeForRemotion fails`, result.status === "failed", result.status);
      }
      seen = await det.observed();
      check(`${label}: no canary read, no loopback connection`,
        seen.connections === 0 && seen.requests === 0 && seen.canariesRead.length === 0, JSON.stringify(seen));
    }
  }
}

// ---------------------------------------------------------------------------------------
// 3b. upload-avatar end to end
// ---------------------------------------------------------------------------------------
type AvatarBody = { url?: string; durationMs?: number; error?: string; code?: string };
type TelemetryEvent = { name: string; properties?: { code?: string; httpStatus?: number } };
const AVATAR_MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

// The duration upload-avatar returned before G24: auto-detecting ffprobe, then the ffmpeg
// "Duration:" banner, exactly as the old probeDurationMs did. Only for legit fixtures.
async function preChangeDurationMs(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const sec = Number.parseFloat(stdout.trim());
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {}
  const banner = await execFileAsync(getFfmpegPath(), ["-i", file]).then((r) => r.stderr, (e: { stderr?: string }) => e.stderr ?? "");
  const m = banner.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return null;
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) + Math.round(Number(`0.${m[4]}`) * 1000);
}

async function avatarRouteChecks(tmp: string, canarySource: string): Promise<void> {
  console.log("\n# 3b. /api/videos/upload-avatar end to end");
  const telemetry: TelemetryEvent[] = [];
  const mocks = [
    mock.module("@/lib/clerk-auth", { namedExports: { getCurrentUser: async () => ({ id: "user_g24_test" }) } }),
    mock.module("@/lib/prisma", { namedExports: { prisma: { user: { findUnique: async () => ({ plan: "PRO" }) } } } }),
    mock.module("@/lib/telemetry", {
      namedExports: { recordTelemetryEvent: async (_userId: unknown, event: TelemetryEvent) => { telemetry.push(event); } },
    }),
  ];
  const { POST } = await import("../src/app/api/videos/upload-avatar/route");

  // The route stores uploads under <cwd>/public/renders; run it from a throwaway cwd whose
  // renders dir also holds the canaries, so the playlists' relative entries point at them.
  const cwd = path.join(tmp, "avatar-cwd");
  const rendersDir = path.join(cwd, "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const det = await startDetectors(rendersDir, canarySource);
  const canaryNames = det.canaries.map((c) => path.basename(c));
  const stored = () => fs.readdirSync(rendersDir).filter((f) => !canaryNames.includes(f));
  const post = async (name: string, bytes: Buffer): Promise<{ status: number; body: AvatarBody }> => {
    const ext = name.split(".").pop() ?? "";
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type: AVATAR_MIME[ext] ?? "" }));
    const res = await POST(new Request("http://localhost/api/videos/upload-avatar", { method: "POST", body: form }));
    return { status: res.status, body: (await res.json()) as AvatarBody };
  };

  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const playlists = hostilePlaylists(det.port);
    // Control: from this renders dir, the pre-change probe of a stored ffconcat reaches the canary.
    const controlFile = path.join(rendersDir, "control-concat.mp4");
    fs.writeFileSync(controlFile, playlists[1][1]);
    det.arm();
    await runTool(getFfprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", controlFile]);
    const control = await det.observed();
    fs.rmSync(controlFile);
    check("control: a pre-change probe of an ffconcat stored in public/renders reads the canary there",
      control.canariesRead.includes("canary.mp4"), JSON.stringify(control));

    for (const [name, text] of playlists) {
      for (const ext of ["mp4", "mov", "webm"]) {
        const label = `upload-avatar: ${name} uploaded as .${ext}`;
        telemetry.length = 0;
        det.arm();
        const { status, body } = await post(`clip-${name}.${ext}`, Buffer.from(text));
        const seen = await det.observed();
        check(`${label}: rejected with 415 unsupported_type`,
          status === 415 && body.code === "unsupported_type" && body.url === undefined, `${status} ${JSON.stringify(body)}`);
        check(`${label}: Thai error message`, /[\u0E00-\u0E7F]/.test(body.error ?? ""), body.error ?? "");
        check(`${label}: nothing left under public/renders`, stored().length === 0, JSON.stringify(stored()));
        check(`${label}: no canary read, no loopback connection`,
          seen.connections === 0 && seen.requests === 0 && seen.canariesRead.length === 0, JSON.stringify(seen));
        check(`${label}: failure telemetry (unsupported_type, 415)`,
          telemetry.some((e) => e.name === "avatar_upload_failed" && e.properties?.code === "unsupported_type" && e.properties?.httpStatus === 415),
          JSON.stringify(telemetry.map((e) => [e.name, e.properties?.code, e.properties?.httpStatus])));
      }
    }

    const fixtures = path.join(tmp, "avatar-fixtures");
    fs.mkdirSync(fixtures);
    const mp4 = path.join(fixtures, "real.mp4");
    const mov = path.join(fixtures, "real.mov");
    const webm = path.join(fixtures, "real.webm");
    await makeVideo(mp4, "mp4");
    await makeVideo(mov, "mov");
    await makeVideo(webm, "webm");
    // A WebM written by a streaming muxer (as browser MediaRecorder does) has no duration
    // header: the duration probe finds none, yet it is a real video and must still pass.
    const liveWebm = path.join(fixtures, "live.webm");
    const liveSrc = ["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=1"];
    await ff([...liveSrc, "-c:v", "libvpx-vp9", "-b:v", "300k", "-live", "1", "-f", "webm", liveWebm])
      .catch(() => ff([...liveSrc, "-c:v", "libvpx", "-b:v", "300k", "-live", "1", "-f", "webm", liveWebm]));
    const legit: Array<[string, string, string]> = [
      ["mp4", mp4, "real.mp4"],
      ["mov", mov, "real.mov"],
      ["webm", webm, "real.webm"],
      ["webm bytes named .mp4", webm, "webm-bytes.mp4"],
      ["duration-less (live) webm", liveWebm, "live.webm"],
    ];
    for (const [label, file, uploadName] of legit) {
      const before = await preChangeDurationMs(file);
      const wantDuration = before && before > 0 ? before : undefined;
      const bytes = fs.readFileSync(file);
      const { status, body } = await post(uploadName, bytes);
      const ext = uploadName.split(".").pop();
      const storedName = body.url?.replace(/^\/api\/renders\//, "") ?? "";
      check(`upload-avatar: ${label}: 200 with a renders url`,
        status === 200 && new RegExp(`^avatar-upload-\\d+-[0-9a-f-]+\\.${ext}$`).test(storedName), `${status} ${JSON.stringify(body)}`);
      check(`upload-avatar: ${label}: durationMs equals the pre-change probe`,
        body.durationMs === wantDuration && ("durationMs" in body) === (wantDuration !== undefined),
        `got ${body.durationMs}, before ${wantDuration}`);
      check(`upload-avatar: ${label}: stored bytes are the upload`,
        storedName !== "" && stored().includes(storedName) && fs.readFileSync(path.join(rendersDir, storedName)).equals(bytes));
      if (storedName && stored().includes(storedName)) fs.rmSync(path.join(rendersDir, storedName));
    }
    check("upload-avatar: the duration-less webm really has no duration header (fixture sanity)",
      (await preChangeDurationMs(liveWebm)) === null);
  } finally {
    process.chdir(originalCwd);
    await det.close();
    for (const m of mocks) m.restore();
  }
}

// ---------------------------------------------------------------------------------------
// 4. Legitimate media still pass, with the same output as before
// ---------------------------------------------------------------------------------------
async function legitChecks(dir: string): Promise<void> {
  console.log("\n# 4. legitimate media");
  const mp4 = path.join(dir, "real.mp4");
  const mov = path.join(dir, "real.mov");
  const webm = path.join(dir, "real.webm");
  await makeVideo(mp4, "mp4");
  await makeVideo(mov, "mov");
  await makeVideo(webm, "webm");
  const { jpg, png, webp } = await makeImages(dir);
  const copyAs = (src: string, name: string) => {
    const p = path.join(dir, name);
    fs.copyFileSync(src, p);
    return p;
  };
  // Samsung/Pixel "motion photo": a JPEG with an MP4 appended after EOI.
  const motion = path.join(dir, "motion-photo.jpg");
  fs.writeFileSync(motion, Buffer.concat([fs.readFileSync(jpg), fs.readFileSync(mp4)]));

  const videos: Array<[string, string, string, SafeInputDemuxer]> = [
    ["mp4", mp4, "mp4", "mov"],
    ["mov", mov, "mov", "mov"],
    ["webm", webm, "webm", "matroska"],
    ["webm bytes named .mp4", copyAs(webm, "webm-bytes.mp4"), "mp4", "matroska"],
    ["mp4 bytes named .webm", copyAs(mp4, "mp4-bytes.webm"), "webm", "mov"],
  ];
  for (const [label, file, ext, want] of videos) {
    const demuxer = resolveSafeInputDemuxer(file, ext, "video");
    check(`${label}: resolves to ${want}`, demuxer === want, `got ${demuxer}`);
    if (!demuxer) continue;
    const dims = ffprobeDimensions(file, demuxer);
    check(`${label}: ffprobeDimensions 360x640`, dims?.width === 360 && dims?.height === 640, JSON.stringify(dims));
    const ms = await probeDurationMs(file, demuxer);
    check(`${label}: probeDurationMs ≈ 1000`, ms !== null && Math.abs(ms - 1000) <= 100, String(ms));

    const forced = copyAs(file, `norm-forced-${path.basename(file)}`);
    const auto = copyAs(file, `norm-auto-${path.basename(file)}`);
    const forcedResult = await normalizeForRemotion(forced, { inputFormat: demuxer });
    const autoResult = await normalizeForRemotion(auto);
    check(`${label}: normalizeForRemotion normalizes`, forcedResult.status === "normalized" && autoResult.status === "normalized",
      `${forcedResult.status}/${autoResult.status}`);
    // After normalize the route probes its own libx264 mp4 with the mov demuxer.
    const sec = ffprobeDurationSec(forced, "mov");
    check(`${label}: ffprobeDurationSec on the normalized mp4`, sec > 0.9 && sec < 1.1, String(sec));
    const [a, b] = await Promise.all([framesHash(forced), framesHash(auto)]);
    check(`${label}: normalized frames equal the auto-detect path`, a.frames > 0 && a.hash === b.hash && a.frames === b.frames,
      `${a.frames}:${a.hash} vs ${b.frames}:${b.hash}`);
  }

  const images: Array<[string, string, string, SafeInputDemuxer]> = [
    ["jpg", jpg, "jpg", "image2"],
    ["jpeg", copyAs(jpg, "real-copy.jpeg"), "jpeg", "image2"],
    ["png", png, "png", "png_pipe"],
    ["webp", webp, "webp", "webp_pipe"],
    ["motion-photo jpg", motion, "jpg", "image2"],
    ["png bytes named .jpg", copyAs(png, "png-bytes.jpg"), "jpg", "png_pipe"],
    ["webp bytes named .jpg", copyAs(webp, "webp-bytes.jpg"), "jpg", "webp_pipe"],
    ["jpeg bytes named .png", copyAs(jpg, "jpeg-bytes.png"), "png", "jpeg_pipe"],
  ];
  for (const [label, file, ext, want] of images) {
    const demuxer = resolveSafeInputDemuxer(file, ext, "image");
    check(`${label}: resolves to ${want}`, demuxer === want, `got ${demuxer}`);
    if (!demuxer) continue;
    const dims = ffprobeDimensions(file, demuxer);
    check(`${label}: ffprobeDimensions 900x1200`, dims?.width === 900 && dims?.height === 1200, JSON.stringify(dims));

    const base = path.basename(file).replace(/\W/g, "_");
    const forcedOut = path.join(dir, `kb-forced-${base}.mp4`);
    const autoOut = path.join(dir, `kb-auto-${base}.mp4`);
    await applyKenBurns(file, forcedOut, KEN_BURNS_DURATION_SEC, { inputFormat: demuxer });
    await applyKenBurns(file, autoOut);
    check(`${label}: applyKenBurns writes a valid mp4`, isValidMp4Path(forcedOut));
    const outDims = ffprobeDimensions(forcedOut, "mov");
    check(`${label}: Ken Burns output is 1080x1920`, outDims?.width === 1080 && outDims?.height === 1920, JSON.stringify(outDims));
    const [a, b] = await Promise.all([framesHash(forcedOut), framesHash(autoOut)]);
    check(`${label}: Ken Burns frames equal the auto-detect path`, a.frames === 150 && a.hash === b.hash && a.frames === b.frames,
      `${a.frames}:${a.hash} vs ${b.frames}:${b.hash}`);
  }
}

// ---------------------------------------------------------------------------------------
// 5. Route + helper source: every invocation goes through the safe args
// ---------------------------------------------------------------------------------------
function sourceChecks(): void {
  console.log("\n# 5. route and helper source");
  const spawnsProcesses = /from\s+["'](?:node:)?child_process["']/;

  const broll = read("src/app/api/videos/broll-window/upload/route.ts");
  check("broll-window/upload spawns no ffmpeg/ffprobe itself", !spawnsProcesses.test(broll));
  for (const needle of [
    'const inputFormat = resolveSafeInputDemuxer(tempInput, ext, "image")',
    "ffprobeDimensions(tempInput, inputFormat)",
    "await applyKenBurns(tempInput, outPath, KEN_BURNS_DURATION_SEC, { inputFormat })",
    'const inputFormat = resolveSafeInputDemuxer(outPath, ext, "video")',
    "ffprobeDimensions(outPath, inputFormat)",
    "await normalizeForRemotion(outPath, { inputFormat })",
    'ffprobeDurationSec(outPath, "mov")',
  ]) check(`broll-window/upload: ${needle}`, broll.includes(needle));

  const avatar = read("src/app/api/videos/upload-avatar/route.ts");
  check("upload-avatar spawns no ffmpeg/ffprobe itself", !spawnsProcesses.test(avatar));
  for (const needle of [
    'const inputFormat = resolveSafeInputDemuxer(outPath, ext, "video")',
    "probeDurationMs(outPath, inputFormat)",
    "if (!inputFormat || (durationMs == null && !ffprobeDimensions(outPath, inputFormat))) {",
    'return jsonError(415, "unsupported_type",',
  ]) check(`upload-avatar: ${needle}`, avatar.includes(needle));
  const gate = avatar.indexOf("if (!inputFormat || (durationMs == null");
  check("upload-avatar: the G24 gate deletes the file and runs before the success telemetry",
    gate > 0 && avatar.indexOf("fs.unlinkSync(outPath)", gate) > gate
      && avatar.indexOf("fs.unlinkSync(outPath)", gate) < avatar.indexOf('status: "success"', gate));

  const probe = read("src/lib/upload-media-probe.ts");
  const execCalls = (probe.match(/execFile(?:Sync|Capture)\(/g) ?? []).length - 1; // minus the helper's own declaration
  const safeCalls = (probe.match(/\.\.\.safeInputArgs\(demuxer\)/g) ?? []).length;
  check("upload-media-probe: every ffprobe/ffmpeg call spreads safeInputArgs(demuxer)", execCalls >= 4 && safeCalls === execCalls,
    `${execCalls} calls, ${safeCalls} safe`);
  check("upload-media-probe: the ffmpeg fallback puts the input options before -i",
    probe.includes('[...safeInputArgs(demuxer), "-i", filePath]'));

  const lib = read("src/lib/broll-asset-lib.ts");
  check("normalizeForRemotion: input options before -i", lib.includes('"-y", ...inputArgs, "-i", filePath,'));
  check("applyKenBurns: input options before -i", lib.includes('"-y", ...inputArgs, "-loop", "1", "-i", imagePath,'));
}

async function main(): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  console.log(`ffmpeg: ${ffmpeg}\nffprobe: ${ffprobe}`);
  const version = await runTool(ffprobe, ["-version"]);
  if (!/ffprobe version/.test(version)) {
    console.error(`✗ ffprobe is not runnable at ${ffprobe} — install ffmpeg (apt-get install ffmpeg) before this check.`);
    process.exit(1);
  }
  console.log(version.split("\n")[0]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upload-probe-whitelist-"));
  let det: Detectors | null = null;
  try {
    unitChecks(tmp);
    const canarySource = path.join(tmp, "canary-source.mp4");
    await makeVideo(canarySource, "mp4");
    const hostileDir = path.join(tmp, "hostile");
    fs.mkdirSync(hostileDir);
    det = await startDetectors(hostileDir, canarySource);
    // The canary detector needs a filesystem that records reads (relatime/strictatime);
    // on a noatime mount every "no canary read" below would pass vacuously.
    det.arm();
    for (const canary of det.canaries) fs.readFileSync(canary);
    const selfTest = await det.observed();
    check("detector self-test: a plain read of each canary is recorded (atime works here)",
      selfTest.canariesRead.length === det.canaries.length, JSON.stringify(selfTest));
    await hostileChecks(hostileDir, det);
    await avatarRouteChecks(tmp, canarySource);
    await legitChecks(path.join(tmp));
    sourceChecks();
  } finally {
    await det?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nupload probe whitelist: ALL PASS" : `\nupload probe whitelist: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

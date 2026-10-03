// Verifies Task 2b / PR-0b (docs/plans/2026-10-03-mcp-edit-before-export.md): every ffmpeg /
// ffprobe outside the two PR-0 routes that reads user-supplied or user-fetched media runs with
// `-protocol_whitelist` + an allowlisted `-f` (G24) or refuses the input; user-named paths are
// confined with realpath; no remote URL is handed to ffmpeg; render never hands Chromium a URL
// it could not fetch itself.
//
//   0. Controls: the detectors see access — ffmpeg 4.4 (prod's version, bundled here) follows an
//      absolute HLS entry, every version follows an ffconcat sibling, ffmpeg follows a 302 on its
//      own, and a pinned resyncing demuxer (-f mp3) accepts "#EXTM3U…"+frames that auto-detect
//      opens as HLS (why stored audio needs a strict signature check).
//   1. Helpers: demuxer allowlist (every name exists in ffmpeg 4.4), strict sniffing incl. ID3,
//      stored-file resolution, the ingest gate, realpath containment, the safe downloader, the
//      render image cache and the render duration probe.
//   2. Routes: each real handler (auth/DB/provider calls stubbed with node:test mock.module)
//      refuses a disguised playlist/ffconcat, a redirect to 127.0.0.1 and a traversal path with
//      zero canary reads and zero loopback connections, and still accepts a legitimate file of
//      each type with the same response and output bytes as the pre-change command.
//   3. Source: the readers that cannot be driven here put the input options before `-i`.
//
// Needs ffmpeg + ffprobe on PATH (CI installs them with apt) and the bundled
// @ffmpeg-installer binary (ffmpeg 4.4 on darwin-arm64).
// Run: npm run verify:ffmpeg-input-hardening (preloads scripts/register-server-only-node.mjs: the routes import server-only modules)
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { promisify } from "node:util";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";

const execFileAsync = promisify(execFile);
const REPO = process.cwd();
const BUNDLED_FFMPEG = path.join(REPO, "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const SYSTEM_FFMPEG = getFfmpegPath();
const SYSTEM_FFPROBE = SYSTEM_FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
// TEST-NET-3: safe-fetch treats it as public, and it is never routed — the fetch stub answers it.
const PUBLIC_IP = "203.0.113.10";
const USER_ID = "user_t2b_test";
const FORBIDDEN_DEMUXERS = ["hls", "concat", "image2pipe", "webm_dash_manifest", "dash", "ffmetadata", "lavfi", "sdp"];

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const tick = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------------------
// Workspace: a throwaway app cwd (public/renders, public/music, stocks), an os.tmpdir(), an
// absolute-path canary dir and an "outside" dir holding the traversal targets.
// ---------------------------------------------------------------------------------------
type Workspace = {
  root: string; app: string; publicDir: string; renders: string; music: string; stocks: string;
  osTmp: string; abs: string; outside: string; fixtures: string; voiceStore: string; scratch: string;
};

function makeWorkspace(root: string): Workspace {
  const app = path.join(root, "app");
  const ws: Workspace = {
    root, app,
    publicDir: path.join(app, "public"),
    renders: path.join(app, "public", "renders"),
    music: path.join(app, "public", "music"),
    stocks: path.join(app, "stocks"),
    osTmp: path.join(root, "os-tmp"),
    abs: path.join(root, "abs"),
    outside: path.join(root, "outside"),
    fixtures: path.join(root, "fixtures"),
    voiceStore: path.join(root, "voice-store"),
    scratch: path.join(root, "scratch"),
  };
  for (const dir of [ws.renders, ws.music, ws.stocks, ws.osTmp, ws.abs, ws.outside, ws.fixtures, ws.voiceStore, ws.scratch]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Routes that locate the bundled ffmpeg from process.cwd() need node_modules there.
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(app, "node_modules"), "dir");
  return ws;
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------
async function ff(args: string[], bin = SYSTEM_FFMPEG): Promise<void> {
  await execFileAsync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 16 << 20 });
}

type Fixtures = Record<string, string>;

async function makeFixtures(dir: string): Promise<Fixtures> {
  const p = (name: string) => path.join(dir, name);
  const video = ["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=1"];
  const tone = (sec: number, rate = 44100) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=${sec}`];
  await ff([...video, "-f", "lavfi", "-i", "sine=duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", p("real.mp4")]);
  await ff([...video, "-c:v", "libx264", "-pix_fmt", "yuv420p", p("real.mov")]);
  await ff([...video, "-c:v", "libvpx-vp9", "-b:v", "300k", p("real.webm")])
    .catch(() => ff([...video, "-c:v", "libvpx", "-b:v", "300k", p("real.webm")]));
  // Browser MediaRecorder output has no duration header.
  await ff([...video, "-c:v", "libvpx-vp9", "-b:v", "300k", "-live", "1", "-f", "webm", p("live.webm")])
    .catch(() => ff([...video, "-c:v", "libvpx", "-b:v", "300k", "-live", "1", "-f", "webm", p("live.webm")]));
  await ff(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1:duration=1", "-frames:v", "1", "-q:v", "3", p("real.jpg")]);

  await ff([...tone(1.5), "-c:a", "libmp3lame", "-b:a", "64k", p("real.mp3")]); // starts with an ID3v2 tag
  await ff([...tone(1.5), "-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "0", "-write_xing", "0", p("bare.mp3")]);
  await ff([...tone(1.5), p("real.wav")]);
  await ff([...tone(1.5), "-c:a", "libvorbis", p("real.ogg")]);
  await ff([...tone(1.5), "-c:a", "aac", "-f", "adts", p("real.aac")]);
  await ff([...tone(1.5), "-c:a", "aac", p("real.m4a")]);
  await ff([...tone(1.5), "-c:a", "libopus", p("real-opus.webm")]);
  await ff([...tone(1.5), "-c:a", "flac", p("real.flac")]);
  // ID3v2 tag in front of an ADTS stream (some taggers do this).
  fs.writeFileSync(p("id3.aac"), Buffer.concat([id3Tag(32), fs.readFileSync(p("real.aac"))]));

  // Voice samples: 7 s of tone (the clone flow needs 5–15 s of non-silent audio).
  await ff([...tone(7, 24000), "-c:a", "libmp3lame", "-b:a", "64k", p("voice.mp3")]);
  await ff([...tone(7, 24000), p("voice.wav")]);
  await ff([...tone(7, 24000), "-c:a", "aac", p("voice.m4a")]);
  await ff([...tone(7, 24000), "-c:a", "libopus", p("voice-opus.webm")]);
  await ff([...tone(7, 24000), "-c:a", "libvorbis", p("voice.ogg")]);

  // > 120 s (the FREE clip cap) so transcribe's duration probe must work to return 403.
  await ff([...tone(121, 8000), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "16k", p("long.mp3")]);
  await ff([...tone(121, 8000), "-ac", "1", p("long.wav")]);
  await ff([...tone(121, 8000), "-ac", "1", "-c:a", "aac", "-b:a", "16k", "-f", "mp4", p("long-audio.mp4")]);
  await ff([...tone(121, 8000), "-ac", "1", "-c:a", "libopus", "-b:a", "16k", p("long-opus.webm")]);
  return {
    mp4: p("real.mp4"), mov: p("real.mov"), webm: p("real.webm"), liveWebm: p("live.webm"), jpg: p("real.jpg"),
    mp3: p("real.mp3"), bareMp3: p("bare.mp3"), wav: p("real.wav"), ogg: p("real.ogg"), aac: p("real.aac"),
    m4a: p("real.m4a"), opusWebm: p("real-opus.webm"), flac: p("real.flac"), id3Aac: p("id3.aac"),
    voiceMp3: p("voice.mp3"), voiceWav: p("voice.wav"), voiceM4a: p("voice.m4a"), voiceOpus: p("voice-opus.webm"), voiceOgg: p("voice.ogg"),
    longMp3: p("long.mp3"), longWav: p("long.wav"), longAudioMp4: p("long-audio.mp4"), longOpus: p("long-opus.webm"),
  };
}

function id3Tag(payloadBytes: number): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
  header[6] = (payloadBytes >> 21) & 0x7f;
  header[7] = (payloadBytes >> 14) & 0x7f;
  header[8] = (payloadBytes >> 7) & 0x7f;
  header[9] = payloadBytes & 0x7f;
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

// ---------------------------------------------------------------------------------------
// Access detectors: a loopback HTTP server + canary files whose atime is armed to epoch 0.
// ---------------------------------------------------------------------------------------
type Seen = { connections: number; requests: string[]; canariesRead: string[] };
type Detectors = { port: number; canaries: string[]; arm: () => void; observed: () => Promise<Seen>; close: () => Promise<void> };

async function startDetectors(root: string, canaries: string[]): Promise<Detectors> {
  let connections = 0;
  let requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if ((req.url ?? "").startsWith("/redirect")) {
      res.writeHead(302, { location: "/landed.mp4" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("connection", () => { connections++; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    canaries,
    arm() {
      connections = 0;
      requests = [];
      for (const canary of canaries) {
        const { mtime } = fs.statSync(canary);
        fs.utimesSync(canary, new Date(0), mtime);
      }
    },
    async observed() {
      await tick();
      return {
        connections,
        requests: [...requests],
        canariesRead: canaries.filter((c) => fs.statSync(c).atimeMs > 1_000).map((c) => path.relative(root, c)),
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const clean = (seen: Seen) => seen.connections === 0 && seen.requests.length === 0 && seen.canariesRead.length === 0;

// ---------------------------------------------------------------------------------------
// Hostile inputs. Padded past 1 KB (composite rejects smaller downloads before ffmpeg runs).
// HLS: an absolute canary (ffmpeg 4.4 opens it), a sibling canary and a loopback URL.
// ffconcat: a sibling canary (every version opens "safe" relative names) or a loopback URL.
// ---------------------------------------------------------------------------------------
function hostileVideo(port: number, absCanary: string): Array<[string, Buffer]> {
  const url = `http://127.0.0.1:${port}`;
  const pad = Array.from({ length: 30 }, (_, i) => `# pad ${i} ${"x".repeat(40)}`).join("\n");
  const hls = [
    "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:0", pad,
    "#EXTINF:1.0,", absCanary,
    "#EXTINF:1.0,", "canary.ts",
    "#EXTINF:1.0,", `${url}/seg0.ts`,
    "#EXT-X-ENDLIST", "",
  ].join("\n");
  return [
    ["hls", Buffer.from(hls)],
    ["concat-local", Buffer.from(`ffconcat version 1.0\n${pad}\nfile 'canary.mp4'\n`)],
    ["concat-net", Buffer.from(`ffconcat version 1.0\n${pad}\nfile '${url}/c.mp4'\n`)],
  ];
}

function hostileAudio(port: number, absCanary: string, bareMp3: Buffer): Array<[string, Buffer]> {
  const video = hostileVideo(port, absCanary);
  const hls = video[0][1];
  return [
    ...video,
    // ffmpeg skips an ID3v2 tag before probing, so this still auto-detects as HLS.
    ["id3-hls", Buffer.concat([id3Tag(0), hls])],
    // A resyncing demuxer (-f mp3) finds the frames after the text; auto-detect sees HLS.
    ["hls-then-mp3", Buffer.concat([hls, bareMp3])],
  ];
}

// ---------------------------------------------------------------------------------------
// fetch stub: answers only registered URLs; everything else goes to the real fetch, so a hop
// that is not re-validated would reach the loopback detector for real.
// ---------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const stubs = new Map<string, () => Response>();
function stub(url: string, respond: () => Response): string {
  const u = new URL(url);
  stubs.set(`${u.origin}${u.pathname}`, respond);
  return url;
}
function installFetchStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const respond = stubs.get(`${u.origin}${u.pathname}`);
    if (respond) return respond();
    return realFetch(input, init);
  }) as typeof fetch;
}
const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const bytesResponse = (bytes: Buffer, type = "application/octet-stream") =>
  () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type, "content-length": String(bytes.length) } });

// ---------------------------------------------------------------------------------------
// Module mocks (auth, DB, provider calls). Installed before any route is imported.
// ---------------------------------------------------------------------------------------
const state = {
  plan: "PRO",
  heygenKey: "encrypted-test-key" as string | null,
  videoRows: [] as Array<Record<string, unknown>>,
  musicCreates: [] as Array<Record<string, unknown>>,
  heygenUploads: [] as Array<{ url: string; bytes: string }>,
};

async function installMocks(): Promise<Array<{ restore: () => void }>> {
  const anyModel = () => new Proxy({}, { get: () => async () => null });
  const base: Record<string, unknown> = {
    user: {
      findUnique: async () => ({
        id: USER_ID, plan: state.plan, geminiKey: null, ttsProvider: "gemini", heygenKey: state.heygenKey, role: "USER",
      }),
    },
    userMusic: {
      aggregate: async () => ({ _sum: { sizeBytes: 0 } }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.musicCreates.push(data);
        return { id: `music-${state.musicCreates.length}`, ...data, duration: null, createdAt: new Date(0) };
      },
    },
    userVoice: { count: async () => 0 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      userVoice: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "voice-1", ...data, createdAt: new Date(0) }) },
    }),
    $queryRawUnsafe: async () => state.videoRows,
    $executeRawUnsafe: async () => 1,
  };
  const prisma = new Proxy(base, {
    get(target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return key in target ? target[key] : anyModel();
    },
  });
  const mocks: Array<{ restore: () => void }> = [
    mock.module("@/lib/clerk-auth", { namedExports: { getCurrentUser: async () => ({ id: USER_ID, email: "t2b@test.invalid", role: "USER" }) } }),
    mock.module("@/lib/prisma", { namedExports: { prisma } }),
  ];
  const coordinator = await import("../src/lib/hero-voice-deletion-coordinator.server");
  mocks.push(mock.module("@/lib/hero-voice-deletion-coordinator.server", {
    namedExports: {
      ...coordinator,
      assertHeroVoiceCanaryMutationReady: async () => undefined,
      runHeroVoiceCanarySerializedMutation: async <T>(fn: () => Promise<T>) => fn(),
      assertNoCanaryAccountDeletionInTransaction: async () => undefined,
    },
  }));
  const ownAvatars = await import("../src/lib/heygen-own-avatars");
  mocks.push(mock.module("@/lib/heygen-own-avatars", {
    namedExports: {
      ...ownAvatars,
      getHeyGenOwnAvatars: async () => ({ avatars: [{ avatar_id: "av1", supported_api_engines: ["avatar_iii", "avatar_iv", "avatar_v"] }] }),
    },
  }));
  const keyCrypto = await import("../src/lib/key-crypto");
  mocks.push(mock.module("@/lib/key-crypto", { namedExports: { ...keyCrypto, decryptKey: () => "heygen-test-key" } }));
  const fetchBudget = await import("../src/lib/fetch-budget");
  mocks.push(mock.module("@/lib/fetch-budget", {
    namedExports: {
      ...fetchBudget,
      fetchWithBudget: async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://upload.heygen.com/")) {
          const body = init?.body as Uint8Array | undefined;
          state.heygenUploads.push({ url, bytes: body ? sha(Buffer.from(body)) : "" });
          return Response.json({ data: { id: `asset-${state.heygenUploads.length}`, url: "https://files.heygen.test/a.mp4" } });
        }
        throw new Error("provider call not expected in this test");
      },
    },
  }));
  return mocks;
}

type RouteModule = { POST: (req: Request) => Promise<Response> };
type JsonBody = Record<string, unknown>;

async function postJson(route: RouteModule, url: string, body: unknown): Promise<{ status: number; body: JsonBody }> {
  const res = await route.POST(new Request(`http://localhost${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: JsonBody = {};
  try { parsed = JSON.parse(text) as JsonBody; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

async function postForm(route: RouteModule, url: string, field: string, name: string, bytes: Buffer, type: string) {
  const form = new FormData();
  form.append(field, new File([new Uint8Array(bytes)], name, { type }));
  const res = await route.POST(new Request(`http://localhost${url}`, { method: "POST", body: form }));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

const listFiles = (dir: string, ignore: string[] = []) =>
  fs.readdirSync(dir).filter((f) => !ignore.includes(f) && !f.startsWith("canary")).sort();

async function runTool(bin: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 << 20, cwd });
    return `${stdout}${stderr}`;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

function noServerPath(ws: Workspace, body: JsonBody): boolean {
  const text = JSON.stringify(body);
  return !text.includes(ws.root) && !text.includes(REPO) && !text.includes("node_modules");
}

// ---------------------------------------------------------------------------------------
// 0. Controls
// ---------------------------------------------------------------------------------------
async function controls(ws: Workspace, det: Detectors, fx: Fixtures): Promise<void> {
  console.log("\n# 0. detector controls");
  det.arm();
  for (const canary of det.canaries) fs.readFileSync(canary);
  const selfTest = await det.observed();
  check("detector self-test: a plain read of every canary is recorded (atime works here)",
    selfTest.canariesRead.length === det.canaries.length, `${selfTest.canariesRead.length}/${det.canaries.length}`);

  const [hls, concatLocal] = hostileVideo(det.port, path.join(ws.abs, "canary.ts"));
  const hlsFile = path.join(ws.renders, "control-hls.mp4");
  const concatFile = path.join(ws.renders, "control-concat.mp4");
  fs.writeFileSync(hlsFile, hls[1]);
  fs.writeFileSync(concatFile, concatLocal[1]);
  det.arm();
  await runTool(BUNDLED_FFMPEG, ["-hide_banner", "-i", hlsFile, "-f", "null", "-"]);
  let seen = await det.observed();
  check("control: bundled ffmpeg 4.4 auto-detect opens an HLS renamed .mp4 and reads the absolute canary",
    seen.canariesRead.includes("abs/canary.ts"), JSON.stringify(seen));
  det.arm();
  await runTool(SYSTEM_FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", concatFile]);
  seen = await det.observed();
  check("control: system ffprobe auto-detect opens an ffconcat renamed .mp4 and reads the sibling canary",
    seen.canariesRead.includes("app/public/renders/canary.mp4"), JSON.stringify(seen));
  fs.rmSync(hlsFile);
  fs.rmSync(concatFile);

  det.arm();
  await runTool(BUNDLED_FFMPEG, ["-hide_banner", "-i", `http://127.0.0.1:${det.port}/redirect.mp4`, "-f", "null", "-"]);
  seen = await det.observed();
  check("control: ffmpeg follows a 302 by itself (why no URL may reach ffmpeg)",
    seen.requests.includes("/redirect.mp4") && seen.requests.includes("/landed.mp4"), JSON.stringify(seen.requests));

  const resync = path.join(ws.scratch, "hls-then-mp3.mp3");
  const audioSet = hostileAudio(det.port, path.join(ws.abs, "canary.ts"), fs.readFileSync(fx.bareMp3));
  fs.writeFileSync(resync, audioSet.find(([n]) => n === "hls-then-mp3")![1]);
  const pinned = await runTool(BUNDLED_FFMPEG, ["-hide_banner", "-protocol_whitelist", "file", "-f", "mp3", "-i", resync, "-f", "null", "-"]);
  const auto = await runTool(BUNDLED_FFMPEG, ["-hide_banner", "-i", resync, "-f", "null", "-"]);
  check("control: -f mp3 resyncs past \"#EXTM3U…\" and finds an audio stream",
    /Stream #0:0: Audio: mp3, 44100 Hz/.test(pinned), pinned.split("\n").find((l) => l.includes("Stream")) ?? "");
  check("control: the same bytes auto-detect as HLS", /Input #0, hls/.test(auto));
  const id3Hls = path.join(ws.scratch, "id3-hls.mp3");
  fs.writeFileSync(id3Hls, audioSet.find(([n]) => n === "id3-hls")![1]);
  const id3Auto = await runTool(BUNDLED_FFMPEG, ["-hide_banner", "-i", id3Hls, "-f", "null", "-"]);
  check("control: ID3v2 + HLS auto-detects as HLS (a byte-0 blocklist would miss it)", /Input #0, hls/.test(id3Auto));
}

// ---------------------------------------------------------------------------------------
// 1. Helpers
// ---------------------------------------------------------------------------------------
async function helperChecks(ws: Workspace, det: Detectors, fx: Fixtures): Promise<void> {
  console.log("\n# 1. helpers");
  const probeArgs = await import("../src/lib/media-probe-args");
  const probe = await import("../src/lib/upload-media-probe");
  const contained = await import("../src/lib/contained-path");
  const download = await import("../src/lib/safe-download");
  const { SAFE_INPUT_DEMUXERS, safeInputArgs, sniffMediaBuffer, sniffSafeInputDemuxer, bufferSafeInputDemuxer,
    resolveStoredMediaDemuxer, resolveSafeInputDemuxer } = probeArgs;

  check("allowlist = PR-0's six + mp3/wav/ogg/aac/flac",
    JSON.stringify([...SAFE_INPUT_DEMUXERS].sort())
      === JSON.stringify(["aac", "flac", "image2", "jpeg_pipe", "matroska", "mov", "mp3", "ogg", "png_pipe", "wav", "webp_pipe"]));
  check("allowlist has no playlist/concat demuxer", SAFE_INPUT_DEMUXERS.every((d) => !FORBIDDEN_DEMUXERS.includes(d)));
  for (const [label, bin] of [["bundled 4.4", BUNDLED_FFMPEG], ["system", SYSTEM_FFMPEG]] as const) {
    const listing = await runTool(bin, ["-hide_banner", "-demuxers"]);
    const names = new Set(listing.split("\n").flatMap((line) => {
      const m = line.match(/^\s*D\S*\s+(\S+)/);
      return m ? m[1].split(",") : [];
    }));
    const missing = SAFE_INPUT_DEMUXERS.filter((d) => !names.has(d));
    check(`every allowlisted demuxer exists in the ${label} ffmpeg`, missing.length === 0, missing.join(",") || `${names.size} demuxers listed`);
  }
  check("safeInputArgs(mp3, pipe) whitelists only pipe",
    JSON.stringify(safeInputArgs("mp3", "pipe")) === JSON.stringify(["-protocol_whitelist", "pipe", "-f", "mp3"]));
  check("safeInputArgs(aac) defaults to the file protocol",
    JSON.stringify(safeInputArgs("aac")) === JSON.stringify(["-protocol_whitelist", "file", "-f", "aac"]));

  const read = (f: string) => fs.readFileSync(f);
  const hls = Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:1\n");
  const sniffCases: Array<[string, Buffer, string | null]> = [
    ["mp3 with ID3v2", read(fx.mp3), "mp3"],
    ["mp3 frame at byte 0", read(fx.bareMp3), "mp3"],
    ["ID3v2 + zero padding + mp3", Buffer.concat([id3Tag(16), Buffer.alloc(300), read(fx.bareMp3)]), "mp3"],
    ["two ID3v2 tags + mp3", Buffer.concat([id3Tag(8), id3Tag(8), read(fx.bareMp3)]), "mp3"],
    ["ADTS", read(fx.aac), "adts"],
    ["ID3v2 + ADTS", read(fx.id3Aac), "adts"],
    ["RIFF/WAVE", read(fx.wav), "wav"],
    ["RF64/WAVE", Buffer.concat([Buffer.from("RF64"), Buffer.alloc(4), Buffer.from("WAVEds64")]), "wav"],
    ["OggS", read(fx.ogg), "ogg"],
    ["fLaC", read(fx.flac), "flac"],
    ["m4a (ftyp)", read(fx.m4a), "isobmff"],
    ["WebM/Opus (EBML)", read(fx.opusWebm), "matroska"],
    ["JPEG still JPEG", read(fx.jpg), "jpeg"],
    ["#EXTM3U", hls, null],
    ["ID3v2 + #EXTM3U", Buffer.concat([id3Tag(0), hls]), null],
    ["ID3v2 + ID3v2 + #EXTM3U", Buffer.concat([id3Tag(4), id3Tag(4), hls]), null],
    ["#EXTM3U + mp3 frames", Buffer.concat([hls, read(fx.bareMp3)]), null],
    ["ffconcat", Buffer.from("ffconcat version 1.0\nfile 'a.mp4'\n"), null],
    ["ID3v2 whose size runs past the data", Buffer.concat([id3Tag(0).subarray(0, 6), Buffer.from([0x7f, 0x7f, 0x7f, 0x7f])]), null],
    ["RIFF/AVI", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI LIST")]), null],
    // dash/imf (libxml2 builds) probe for their manifest anywhere before the first NUL.
    ["RIFF/WAVE whose leading chunk carries a DASH manifest",
      Buffer.from(`RIFFAAAAWAVELISTAAAA<MPD profiles="urn:mpeg:dash:profile:isoff-live:2011"><BaseURL>file:///etc/</BaseURL>`), null],
    ["EBML whose leading bytes carry an IMF playlist", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("<CompositionPlaylist xmlns=\"x\">")]), null],
    ["ID3v2 + mp3 frame + DASH manifest", Buffer.concat([id3Tag(4), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.from("<mpd dash:profile>")]), null],
    ["a NUL before the marker hides it from ffmpeg → still media", Buffer.concat([read(fx.wav).subarray(0, 64), Buffer.from("<MPD dash:profile")]), "wav"],
    ["text", Buffer.from("hello world, not media"), null],
  ];
  for (const [label, buf, want] of sniffCases) {
    const got = sniffMediaBuffer(buf);
    check(`sniff: ${label}`, got === want, `got ${got}`);
  }

  const put = (name: string, bytes: Buffer) => { const f = path.join(ws.scratch, name); fs.writeFileSync(f, bytes); return f; };
  const strictCases: Array<[string, string, Array<"audio" | "video" | "image">, string | null]> = [
    ["real mp3 (audio)", fx.mp3, ["audio"], "mp3"],
    ["real wav (audio)", fx.wav, ["audio"], "wav"],
    ["real ogg (audio)", fx.ogg, ["audio"], "ogg"],
    ["real aac (audio)", fx.aac, ["audio"], "aac"],
    ["real m4a (audio)", fx.m4a, ["audio"], "mov"],
    ["real opus webm (audio)", fx.opusWebm, ["audio"], "matroska"],
    ["real flac (audio)", fx.flac, ["audio"], "flac"],
    ["real mp4 (video)", fx.mp4, ["video"], "mov"],
    ["real webm (video)", fx.webm, ["video"], "matroska"],
    ["real mp3 on a video reader", fx.mp3, ["video"], null],
    ["jpg on an audio reader", fx.jpg, ["audio"], null],
    ["#EXTM3U + frames named .mp3", put("s-hls-frames.mp3", Buffer.concat([hls, read(fx.bareMp3)])), ["audio"], null],
    ["ID3 + HLS named .mp3", put("s-id3-hls.mp3", Buffer.concat([id3Tag(0), hls])), ["audio"], null],
    ["missing file", path.join(ws.scratch, "nope.mp3"), ["audio"], null],
  ];
  for (const [label, file, kinds, want] of strictCases) {
    const got = sniffSafeInputDemuxer(file, kinds);
    check(`strict: ${label}`, got === want, `got ${got}`);
  }
  check("buffer strict: WebM/Opus voice → matroska", bufferSafeInputDemuxer(read(fx.voiceOpus), ["audio"]) === "matroska");
  check("buffer strict: ID3 + HLS → null", bufferSafeInputDemuxer(Buffer.concat([id3Tag(0), hls]), ["audio"]) === null);

  const storedCases: Array<[string, string, Array<"audio" | "video" | "image">, string | null]> = [
    ["legacy HLS named .mp3 → mp3 by extension", put("legacy.mp3", hls), ["audio", "video"], "mp3"],
    ["legacy HLS named .mp4 → mov by extension", put("legacy.mp4", hls), ["audio", "video"], "mov"],
    ["legacy HLS named .wav → wav", put("legacy.wav", hls), ["audio"], "wav"],
    ["HLS named .m3u8 → refused", put("legacy.m3u8", hls), ["audio", "video"], null],
    ["HLS named .txt → refused", put("legacy.txt", hls), ["audio", "video"], null],
    ["HLS with no extension → refused", put("legacy", hls), ["audio", "video"], null],
    ["real wav bytes named .mp3 → wav (content wins)", put("wav-bytes.mp3", read(fx.wav)), ["audio"], "wav"],
    ["real webm bytes named .mp4 → matroska", put("webm-bytes.mp4", read(fx.webm)), ["video"], "matroska"],
    ["real jpg on a video+image reader → image2", fx.jpg, ["video", "image"], "image2"],
  ];
  for (const [label, file, kinds, want] of storedCases) {
    const got = resolveStoredMediaDemuxer(file, kinds);
    check(`stored: ${label}`, got === want, `got ${got}`);
  }
  check("PR-0 contract kept: m3u8 named .mp4 on the video route → mov", resolveSafeInputDemuxer(put("pr0.mp4", hls), "mp4", "video") === "mov");
  check("PR-0 contract kept: route ext m4a is not a video ext", resolveSafeInputDemuxer(fx.m4a, "m4a", "video") === null);

  // Pinned reads of every hostile body with each allowlisted audio demuxer: no access.
  const absCanary = path.join(ws.abs, "canary.ts");
  for (const [name, body] of hostileAudio(det.port, absCanary, read(fx.bareMp3))) {
    const file = path.join(ws.renders, `pinned-${name}.bin`);
    fs.writeFileSync(file, body);
    for (const demuxer of ["mp3", "wav", "ogg", "aac", "flac", "mov", "matroska"] as const) {
      for (const [binLabel, bin] of [["4.4", BUNDLED_FFMPEG], ["system", SYSTEM_FFMPEG]] as const) {
        det.arm();
        await runTool(bin, ["-hide_banner", ...safeInputArgs(demuxer), "-i", file, "-f", "null", "-"]);
        const seen = await det.observed();
        check(`pinned ${binLabel} -f ${demuxer} on ${name}: no access`, clean(seen), JSON.stringify(seen));
      }
    }
    fs.rmSync(file);
  }

  // Ingest gate: strict signature + a pinned probe that finds a real stream.
  for (const [label, file, kinds, want] of [
    ["mp3", fx.mp3, ["audio"], "mp3"], ["bare mp3", fx.bareMp3, ["audio"], "mp3"], ["wav", fx.wav, ["audio"], "wav"],
    ["ogg", fx.ogg, ["audio"], "ogg"], ["aac", fx.aac, ["audio"], "aac"], ["ID3 aac", fx.id3Aac, ["audio"], "aac"],
    ["m4a", fx.m4a, ["audio"], "mov"], ["opus webm", fx.opusWebm, ["audio"], "matroska"], ["flac", fx.flac, ["audio"], "flac"],
    ["mp4", fx.mp4, ["video"], "mov"], ["mov", fx.mov, ["video"], "mov"], ["webm", fx.webm, ["video"], "matroska"],
    ["live webm", fx.liveWebm, ["video"], "matroska"],
  ] as Array<[string, string, Array<"audio" | "video">, string]>) {
    const got = await probe.admitUserMediaFile(file, kinds);
    check(`gate admits real ${label}`, got === want, `got ${got}`);
  }
  for (const [name, body] of hostileAudio(det.port, absCanary, read(fx.bareMp3))) {
    for (const ext of ["mp3", "mp4"]) {
      const file = path.join(ws.renders, `gate-${name}.${ext}`);
      fs.writeFileSync(file, body);
      det.arm();
      const got = await probe.admitUserMediaFile(file, ["audio", "video"]);
      const seen = await det.observed();
      check(`gate refuses ${name} named .${ext} with no access`, got === null && clean(seen), `got ${got} ${JSON.stringify(seen)}`);
      fs.rmSync(file);
    }
  }
  const zeroChannel = await probe.probeMediaStreams(fx.mp3, "aac");
  check("probeMediaStreams: an mp3 forced through -f aac has no valid stream (the 0-channel case)",
    zeroChannel !== null && !zeroChannel.audio && !zeroChannel.video, JSON.stringify(zeroChannel));

  // Realpath containment.
  const inside = path.join(ws.renders, "inside.mp4");
  fs.copyFileSync(fx.mp4, inside);
  fs.symlinkSync(path.join(ws.outside, "secret.mp4"), path.join(ws.renders, "helper-link.mp4"));
  const realRenders = fs.realpathSync.native(ws.renders);
  const containCases: Array<[string, string, string]> = [
    ["a file inside", "inside.mp4", "ok"],
    ["leading slash", "/inside.mp4", "ok"],
    ["../ escape", "../../../outside/secret.mp4", "outside"],
    ["symlink escape", "helper-link.mp4", "outside"],
    ["missing", "missing.mp4", "missing"],
    ["the root itself", "", "missing"],
    ["NUL byte", "inside.mp4\0.png", "outside"],
  ];
  for (const [label, rel, want] of containCases) {
    const got = contained.resolveContainedFile(ws.renders, rel);
    const status = got.ok ? "ok" : got.reason;
    check(`contain: ${label} → ${want}`, status === want && (!got.ok || got.path === path.join(realRenders, "inside.mp4")), JSON.stringify(got));
  }
  fs.rmSync(path.join(ws.renders, "helper-link.mp4"));
  fs.rmSync(inside);

  // Safe download.
  const dest = (name: string) => path.join(ws.scratch, name);
  const mp4Bytes = read(fx.mp4);
  stub(`http://${PUBLIC_IP}/dl/ok.mp4`, bytesResponse(mp4Bytes, "video/mp4"));
  stub(`http://${PUBLIC_IP}/dl/hop.mp4`, redirectTo(`http://${PUBLIC_IP}/dl/ok.mp4`));
  stub(`http://${PUBLIC_IP}/dl/loop.mp4`, redirectTo(`http://127.0.0.1:${det.port}/landed.mp4`));
  stub(`http://${PUBLIC_IP}/dl/loop-rel.mp4`, redirectTo(`//127.0.0.1:${det.port}/landed.mp4`));
  stub(`http://${PUBLIC_IP}/dl/a.mp4`, redirectTo(`http://${PUBLIC_IP}/dl/b.mp4`));
  stub(`http://${PUBLIC_IP}/dl/b.mp4`, redirectTo(`http://${PUBLIC_IP}/dl/a.mp4`));
  stub(`http://${PUBLIC_IP}/dl/404.mp4`, () => new Response("nope", { status: 404 }));
  stub(`http://${PUBLIC_IP}/dl/big-declared.mp4`, () => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } }));
  stub(`http://${PUBLIC_IP}/dl/big-streamed.mp4`, () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < 64; i++) controller.enqueue(new Uint8Array(64 * 1024));
      controller.close();
    },
  }), { status: 200 }));
  const dl = async (name: string, url: string, maxBytes = 50 * 1024 * 1024) => {
    det.arm();
    try {
      const result = await download.safeDownloadToFile(url, dest(name), { maxBytes });
      return { ok: true as const, result, seen: await det.observed() };
    } catch (error) {
      return { ok: false as const, reason: (error as { reason?: string }).reason ?? String(error), seen: await det.observed() };
    }
  };
  let r = await dl("ok.mp4", `http://${PUBLIC_IP}/dl/ok.mp4`);
  check("download: 200 → bytes on disk", r.ok && fs.readFileSync(dest("ok.mp4")).equals(mp4Bytes));
  r = await dl("hop.mp4", `http://${PUBLIC_IP}/dl/hop.mp4`);
  check("download: a redirect to another public URL is followed", r.ok && fs.readFileSync(dest("hop.mp4")).equals(mp4Bytes));
  for (const [name, url] of [["loop.mp4", "loop"], ["loop-rel.mp4", "loop-rel"]]) {
    r = await dl(name, `http://${PUBLIC_IP}/dl/${url}.mp4`);
    check(`download: a 302 to 127.0.0.1 (${url}) is refused before connecting`,
      !r.ok && r.reason === "unsafe_url" && clean(r.seen) && !fs.existsSync(dest(name)), JSON.stringify(r));
  }
  r = await dl("direct-loop.mp4", `http://127.0.0.1:${det.port}/x.mp4`);
  check("download: a loopback URL is refused before connecting", !r.ok && r.reason === "unsafe_url" && clean(r.seen));
  r = await dl("redirects.mp4", `http://${PUBLIC_IP}/dl/a.mp4`);
  check("download: a redirect loop stops", !r.ok && r.reason === "redirects" && !fs.existsSync(dest("redirects.mp4")), JSON.stringify(r));
  r = await dl("404.mp4", `http://${PUBLIC_IP}/dl/404.mp4`);
  check("download: a non-2xx status fails", !r.ok && r.reason === "bad_status" && !fs.existsSync(dest("404.mp4")));
  r = await dl("big-declared.mp4", `http://${PUBLIC_IP}/dl/big-declared.mp4`, 1024 * 1024);
  check("download: a declared size over the cap fails", !r.ok && r.reason === "too_large" && !fs.existsSync(dest("big-declared.mp4")));
  r = await dl("big-streamed.mp4", `http://${PUBLIC_IP}/dl/big-streamed.mp4`, 1024 * 1024);
  check("download: a streamed body over the cap fails and leaves no file", !r.ok && r.reason === "too_large" && !fs.existsSync(dest("big-streamed.mp4")));
  r = await dl("file-url.mp4", `file://${path.join(ws.outside, "secret.mp4")}`);
  check("download: a file:// URL is refused", !r.ok && r.reason === "unsafe_url" && clean(r.seen));

  await renderGuardChecks(ws, det, fx);
}

async function renderGuardChecks(ws: Workspace, det: Detectors, fx: Fixtures): Promise<void> {
  console.log("\n# 1b. render: image cache + duration probe");
  const guard = await import("../src/lib/render-input-guard");
  const base = "http://localhost:3000";
  const png = fs.readFileSync(path.join(REPO, "public", "logo.svg"));
  stub(`http://${PUBLIC_IP}/img/500.png`, () => new Response("err", { status: 500 }));
  stub(`http://${PUBLIC_IP}/img/throws.png`, () => { throw new TypeError("fetch failed"); });
  stub(`http://${PUBLIC_IP}/img/redirect.png`, redirectTo(`http://127.0.0.1:${det.port}/landed.png`));
  stub(`http://${PUBLIC_IP}/img/ok.png`, bytesResponse(png, "image/png"));
  const cases: Array<[string, string, (out: string) => boolean]> = [
    ["a 500 on the first fetch → dropped", `http://${PUBLIC_IP}/img/500.png`, (o) => o === ""],
    ["a network error → dropped", `http://${PUBLIC_IP}/img/throws.png`, (o) => o === ""],
    ["a 302 to 127.0.0.1 → dropped", `http://${PUBLIC_IP}/img/redirect.png`, (o) => o === ""],
    ["upper-case HTTP:// to loopback → dropped", `HTTP://127.0.0.1:${det.port}/x.png`, (o) => o === ""],
    ["leading whitespace before a loopback URL → dropped", `  http://127.0.0.1:${det.port}/x.png`, (o) => o === ""],
    ["tab inside the scheme → dropped", `ht\ttp://127.0.0.1:${det.port}/x.png`, (o) => o === ""],
    ["file:// → dropped", "file:///etc/passwd", (o) => o === ""],
    ["a local path → absolutized (unchanged)", "/renders/x.png", (o) => o === `${base}/renders/x.png`],
    ["a data: URL → unchanged", "data:image/png;base64,AAAA", (o) => o === "data:image/png;base64,AAAA"],
    ["a public image → cached and re-served", `http://${PUBLIC_IP}/img/ok.png`,
      (o) => /^http:\/\/localhost:3000\/api\/renders\/img-\d+-[a-z0-9]+\.png$/.test(o)
        && fs.readFileSync(path.join(ws.renders, o.split("/").pop()!)).equals(png)],
  ];
  for (const [label, url, ok] of cases) {
    det.arm();
    const out = await guard.cacheImageLocally(url, ws.renders, base);
    const seen = await det.observed();
    check(`render image: ${label}`, ok(out) && clean(seen), `${JSON.stringify(out)} ${JSON.stringify(seen)}`);
  }

  const preChange = async (file: string) => {
    const out = await runTool(SYSTEM_FFMPEG, ["-i", file]);
    const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (!m) return null;
    const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number.parseFloat(m[3]);
    return total > 0 ? total : null;
  };
  for (const [label, file] of [["mp4", fx.mp4], ["webm", fx.webm], ["jpg", fx.jpg]]) {
    const local = path.join(ws.renders, `probe-real.${path.extname(file).slice(1)}`);
    fs.copyFileSync(file, local);
    const got = await guard.probeVideoDurationSec(local);
    const want = await preChange(local);
    check(`render probe: real ${label} → same duration as before (${want})`, got === want, `got ${got}`);
    fs.rmSync(local);
  }
  for (const [name, body] of hostileVideo(det.port, path.join(ws.abs, "canary.ts"))) {
    const file = path.join(ws.renders, `probe-${name}.mp4`);
    fs.writeFileSync(file, body);
    det.arm();
    const got = await guard.probeVideoDurationSec(file);
    const seen = await det.observed();
    check(`render probe: stored ${name} → no duration, no access`, got === null && clean(seen), `${got} ${JSON.stringify(seen)}`);
    fs.rmSync(file);
  }
}

// ---------------------------------------------------------------------------------------
// 2. Routes
// ---------------------------------------------------------------------------------------
type Routes = Record<"thumbnail" | "upload" | "music" | "transcribe" | "trim" | "duration" | "composite" | "previewFrame"
  | "previewBg" | "genThumb" | "genWithBg", RouteModule>;

function plantStoredHostiles(ws: Workspace, det: Detectors, fx: Fixtures, exts: string[]): Array<[string, string, string]> {
  // [label, url, absolute path] for each hostile body stored under public/renders and stocks.
  const out: Array<[string, string, string]> = [];
  for (const [name, body] of hostileAudio(det.port, path.join(ws.abs, "canary.ts"), fs.readFileSync(fx.bareMp3))) {
    for (const ext of exts) {
      const file = `legacy-${name}.${ext}`;
      fs.writeFileSync(path.join(ws.renders, file), body);
      out.push([`stored ${name} .${ext}`, `/api/renders/${file}`, path.join(ws.renders, file)]);
    }
  }
  return out;
}

async function thumbnailChecks(ws: Workspace, det: Detectors, fx: Fixtures, route: RouteModule): Promise<void> {
  console.log("\n# 2a. /api/videos/thumbnail (render mode)");
  const call = (body: JsonBody) => postJson(route, "/api/videos/thumbnail", { mode: "render", ...body });
  const before = new Set(fs.readdirSync(ws.renders));
  const stored = plantStoredHostiles(ws, det, fx, ["mp4", "webm"]).filter(([label]) => !/id3|then-mp3/.test(label));
  for (const [label, url] of stored) {
    det.arm();
    const res = await call({ videoUrl: url });
    const seen = await det.observed();
    check(`thumbnail: ${label} refused, no access`, res.status !== 200 && clean(seen), `${res.status} ${JSON.stringify(seen)}`);
    check(`thumbnail: ${label} error carries no server path`, noServerPath(ws, res.body), JSON.stringify(res.body).slice(0, 160));
  }
  for (const [name, body] of hostileVideo(det.port, path.join(ws.abs, "canary.ts"))) {
    const url = stub(`http://${PUBLIC_IP}/thumb/${name}.mp4`, bytesResponse(body, "video/mp4"));
    det.arm();
    const res = await call({ videoUrl: url });
    const seen = await det.observed();
    check(`thumbnail: remote ${name} refused, no access`, res.status !== 200 && clean(seen), `${res.status} ${JSON.stringify(seen)}`);
  }
  const loop = stub(`http://${PUBLIC_IP}/thumb/redirect.mp4`, redirectTo(`http://127.0.0.1:${det.port}/landed.mp4`));
  det.arm();
  let res = await call({ videoUrl: loop });
  let seen = await det.observed();
  check("thumbnail: a remote 302 to 127.0.0.1 is refused with no loopback connection", res.status === 400 && clean(seen), `${res.status} ${JSON.stringify(seen)}`);

  fs.copyFileSync(fx.mp4, path.join(ws.stocks, "other-user-stock.mp4"));
  fs.symlinkSync(path.join(ws.outside, "secret.mp4"), path.join(ws.renders, "link-out.mp4"));
  for (const [label, videoUrl] of [
    ["relative path into stocks/", "stocks/other-user-stock.mp4"],
    ["relative ../ path", "../outside/secret.mp4"],
    ["/../ escape", "/../../outside/secret.mp4"],
    ["symlink out of public/", "/renders/link-out.mp4"],
  ]) {
    det.arm();
    res = await call({ videoUrl });
    seen = await det.observed();
    check(`thumbnail: ${label} refused without reading it`, res.status >= 400 && res.status < 500 && clean(seen) && !res.body.thumbnailUrl,
      `${res.status} ${JSON.stringify(res.body).slice(0, 80)} ${JSON.stringify(seen)}`);
  }

  // renderConfig.bgVideos[0].src is preferred; a traversal/symlink there must be ignored and
  // the rendered video used instead (as for any unusable stock).
  fs.copyFileSync(fx.mp4, path.join(ws.renders, "rendered.mp4"));
  const want = await preChangeFrame(ws, path.join(ws.renders, "rendered.mp4"), 0);
  for (const [label, src] of [["/api/stocks/../../outside", "/api/stocks/../../outside/secret.mp4"], ["symlink", "/renders/link-out.mp4"]]) {
    state.videoRows = [{ videoUrl: "/api/renders/rendered.mp4", avatarVideoUrl: null, script: "", thumbnailConfig: null,
      renderConfig: JSON.stringify({ bgVideos: [{ src }] }) }];
    det.arm();
    res = await call({ videoId: "video-1" });
    seen = await det.observed();
    check(`thumbnail: bgVideos src via ${label} ignored, rendered video used`,
      res.status === 200 && clean(seen) && sameFile(ws, res.body.thumbnailUrl, want), `${res.status} ${JSON.stringify(seen)}`);
  }
  state.videoRows = [];

  // Legit: local mp4/mov/webm, a stock via bgVideos, and remote (direct + one public hop).
  for (const [label, fixture, url] of [
    ["local mp4", fx.mp4, "/api/renders/thumb-src.mp4"],
    ["local mov", fx.mov, "/renders/thumb-src.mov"],
    ["local webm", fx.webm, "/api/renders/thumb-src.webm"],
  ]) {
    const local = path.join(ws.renders, path.basename(url));
    fs.copyFileSync(fixture, local);
    const expected = await preChangeFrame(ws, local, 0.5);
    res = await call({ videoUrl: url, seekTime: 0.5 });
    check(`thumbnail: ${label} → 200 and the same frame as before`, res.status === 200 && sameFile(ws, res.body.thumbnailUrl, expected),
      `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  fs.copyFileSync(fx.webm, path.join(ws.stocks, "stock-bg.mp4"));
  state.videoRows = [{ videoUrl: "/api/renders/rendered.mp4", avatarVideoUrl: null, script: "", thumbnailConfig: null,
    renderConfig: JSON.stringify({ bgVideos: [{ src: "/api/stocks/stock-bg.mp4" }] }) }];
  const stockFrame = await preChangeFrame(ws, path.join(ws.stocks, "stock-bg.mp4"), 0);
  res = await call({ videoId: "video-1" });
  check("thumbnail: bgVideos stock → 200 and the same frame as before", res.status === 200 && sameFile(ws, res.body.thumbnailUrl, stockFrame),
    `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  state.videoRows = [];
  const remote = stub(`http://${PUBLIC_IP}/thumb/real.mp4`, bytesResponse(fs.readFileSync(fx.mp4), "video/mp4"));
  const hop = stub(`http://${PUBLIC_IP}/thumb/hop.mp4`, redirectTo(remote));
  const remoteFrame = await preChangeFrame(ws, fx.mp4, 0.5);
  for (const [label, url] of [["remote mp4", remote], ["remote mp4 behind a public 302", hop]]) {
    det.arm();
    res = await call({ videoUrl: url, seekTime: 0.5 });
    seen = await det.observed();
    check(`thumbnail: ${label} → 200, same frame as the file`, res.status === 200 && clean(seen) && sameFile(ws, res.body.thumbnailUrl, remoteFrame),
      `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  check("thumbnail: no download left in os.tmpdir()", listFiles(ws.osTmp).length === 0, JSON.stringify(listFiles(ws.osTmp)));
  fs.rmSync(path.join(ws.renders, "link-out.mp4"));
  for (const f of fs.readdirSync(ws.renders)) if (!before.has(f) && /^thumb-/.test(f)) fs.rmSync(path.join(ws.renders, f));
}

async function preChangeFrame(ws: Workspace, file: string, atSec: number): Promise<string> {
  const out = path.join(ws.scratch, `expected-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  await execFileAsync(BUNDLED_FFMPEG, ["-ss", String(atSec), "-i", file, "-frames:v", "1", "-q:v", "2", "-y", out]);
  return out;
}

function sameFile(ws: Workspace, url: unknown, expectedPath: string): boolean {
  if (typeof url !== "string") return false;
  const name = url.replace(/^\/api\/renders\//, "").replace(/^\/renders\//, "");
  const actual = path.join(ws.renders, name);
  return fs.existsSync(actual) && fs.readFileSync(actual).equals(fs.readFileSync(expectedPath));
}

async function videoUploadChecks(ws: Workspace, det: Detectors, fx: Fixtures, route: RouteModule): Promise<void> {
  console.log("\n# 2b. /api/videos/upload");
  const MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
  const before = listFiles(ws.renders);
  for (const [name, body] of hostileVideo(det.port, path.join(ws.abs, "canary.ts"))) {
    for (const ext of ["mp4", "mov", "webm"]) {
      det.arm();
      const res = await postForm(route, "/api/videos/upload", "video", `clip.${ext}`, body, MIME[ext]);
      const seen = await det.observed();
      check(`videos/upload: ${name} as .${ext} → 400, nothing stored, no access`,
        res.status === 400 && res.body.url === undefined && JSON.stringify(listFiles(ws.renders)) === JSON.stringify(before)
          && listFiles(ws.osTmp).length === 0 && clean(seen),
        `${res.status} ${JSON.stringify(res.body)} ${JSON.stringify(seen)}`);
      check(`videos/upload: ${name} as .${ext} keeps the existing error text`,
        res.body.error === "Unsupported file type — only mp4/mov/webm video is accepted", String(res.body.error));
    }
  }
  for (const [label, file, name] of [
    ["mp4", fx.mp4, "a.mp4"], ["mov", fx.mov, "a.mov"], ["webm", fx.webm, "a.webm"],
    ["webm bytes named .mp4", fx.webm, "b.mp4"], ["duration-less (live) webm", fx.liveWebm, "live.webm"],
  ]) {
    const bytes = fs.readFileSync(file);
    const ext = name.split(".").pop()!;
    const res = await postForm(route, "/api/videos/upload", "video", name, bytes, MIME[ext]);
    const stored = typeof res.body.url === "string" ? res.body.url.replace(/^\/api\/renders\//, "") : "";
    check(`videos/upload: ${label} → 200, same bytes stored`,
      res.status === 200 && new RegExp(`^upload-[0-9a-f-]{36}\\.${ext}$`).test(stored)
        && fs.readFileSync(path.join(ws.renders, stored)).equals(bytes),
      `${res.status} ${JSON.stringify(res.body)}`);
    if (stored && fs.existsSync(path.join(ws.renders, stored))) fs.rmSync(path.join(ws.renders, stored));
  }
  check("videos/upload: nothing left in os.tmpdir()", listFiles(ws.osTmp).length === 0, JSON.stringify(listFiles(ws.osTmp)));
}

async function musicUploadChecks(ws: Workspace, det: Detectors, fx: Fixtures, route: RouteModule): Promise<void> {
  console.log("\n# 2c. /api/music/upload");
  const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", m4a: "audio/mp4" };
  for (const [name, body] of hostileAudio(det.port, path.join(ws.abs, "canary.ts"), fs.readFileSync(fx.bareMp3))) {
    for (const ext of ["mp3", "wav", "ogg", "aac", "m4a"]) {
      const creates = state.musicCreates.length;
      det.arm();
      const res = await postForm(route, "/api/music/upload", "file", `song.${ext}`, body, MIME[ext]);
      const seen = await det.observed();
      check(`music/upload: ${name} as .${ext} → 400 unsupported_type, nothing stored, no access`,
        res.status === 400 && res.body.code === "unsupported_type" && listFiles(ws.music).length === 0
          && listFiles(ws.osTmp).length === 0 && state.musicCreates.length === creates && clean(seen),
        `${res.status} ${JSON.stringify(res.body)} ${JSON.stringify(seen)}`);
    }
  }
  for (const [label, file, name, type] of [
    ["mp3 (ID3)", fx.mp3, "a.mp3", "audio/mpeg"], ["mp3 without ID3", fx.bareMp3, "b.mp3", "audio/mpeg"],
    ["wav", fx.wav, "c.wav", "audio/wav"], ["ogg", fx.ogg, "d.ogg", "audio/ogg"], ["aac (ADTS)", fx.aac, "e.aac", "audio/aac"],
    ["m4a", fx.m4a, "f.m4a", "audio/mp4"], ["wav bytes named .mp3", fx.wav, "g.mp3", "audio/mpeg"],
    ["mp3 with an unknown extension but an audio MIME", fx.mp3, "h.bin", "audio/mpeg"],
  ]) {
    const bytes = fs.readFileSync(file);
    const res = await postForm(route, "/api/music/upload", "file", name, bytes, type);
    const stored = typeof res.body.filename === "string" ? res.body.filename : "";
    const created = state.musicCreates.at(-1);
    check(`music/upload: ${label} → 200, same bytes stored, track created`,
      res.status === 200 && stored !== "" && res.body.url === `/api/music/${stored}`
        && fs.readFileSync(path.join(ws.music, stored)).equals(bytes) && created?.filename === stored && created?.sizeBytes === bytes.length,
      `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    if (stored && fs.existsSync(path.join(ws.music, stored))) fs.rmSync(path.join(ws.music, stored));
  }
  check("music/upload: nothing left in os.tmpdir()", listFiles(ws.osTmp).length === 0, JSON.stringify(listFiles(ws.osTmp)));
}

async function voiceChecks(ws: Workspace, det: Detectors, fx: Fixtures): Promise<void> {
  console.log("\n# 2d. voice samples (createUserVoice, legacy path)");
  const voices = await import("../src/lib/user-voices.server");
  const create = (audio: Buffer) => voices.createUserVoice({
    userId: USER_ID, name: "เสียงทดสอบ", refText: "นี่คือข้อความเสียงสำหรับทดสอบระบบ", audio, consent: true,
  });
  for (const [name, body] of hostileAudio(det.port, path.join(ws.abs, "canary.ts"), fs.readFileSync(fx.bareMp3))) {
    det.arm();
    let code = "resolved";
    let status = 0;
    try { await create(body); } catch (error) {
      code = (error as { code?: string }).code ?? String(error);
      status = (error as { status?: number }).status ?? 0;
    }
    const seen = await det.observed();
    check(`voice: ${name} → 422 USER_VOICE_AUDIO_INVALID, no access`,
      code === "USER_VOICE_AUDIO_INVALID" && status === 422 && clean(seen) && listFiles(ws.osTmp).length === 0,
      `${code} ${status} ${JSON.stringify(seen)}`);
  }
  for (const [label, file] of [["mp3", fx.voiceMp3], ["wav", fx.voiceWav], ["m4a", fx.voiceM4a], ["webm/opus", fx.voiceOpus], ["ogg", fx.voiceOgg]]) {
    const audio = fs.readFileSync(file);
    try {
      const voice = await create(audio) as { filename: string; durationMs: number };
      const stored = fs.readFileSync(path.join(ws.voiceStore, voice.filename));
      const expected = await preChangeVoiceWav(ws, audio);
      check(`voice: ${label} → created, stored WAV identical to the pre-change conversion`,
        voice.durationMs >= 5_000 && voice.durationMs <= 15_000 && stored.equals(expected), `${voice.durationMs} ms`);
    } catch (error) {
      check(`voice: ${label} → created`, false, String((error as Error).message ?? error));
    }
  }
}

async function preChangeVoiceWav(ws: Workspace, source: Buffer): Promise<Buffer> {
  const src = path.join(ws.scratch, `voice-src-${Date.now()}`);
  const out = path.join(ws.scratch, `voice-out-${Date.now()}.wav`);
  fs.writeFileSync(src, source);
  await execFileAsync(SYSTEM_FFMPEG, [
    "-y", "-i", src, "-t", "17", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1",
    "-af", "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,"
      + "areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,"
      + "areverse,loudnorm=I=-18:TP=-2:LRA=7",
    out,
  ], { maxBuffer: 2 << 20 });
  return fs.readFileSync(out);
}

async function transcribeChecks(ws: Workspace, det: Detectors, fx: Fixtures, route: RouteModule): Promise<void> {
  console.log("\n# 2e. /api/videos/transcribe");
  const call = (audioUrl: string) => postJson(route, "/api/videos/transcribe", { audioUrl, script: "" });
  fs.copyFileSync(fx.mp3, path.join(ws.outside, "secret.mp3"));
  fs.symlinkSync(path.join(ws.outside, "secret.mp3"), path.join(ws.renders, "link-out.mp3"));
  stub(`http://${PUBLIC_IP}/outside/secret.mp3`, () => new Response("no", { status: 404 }));
  for (const [label, url] of [
    ["/api/stocks/../ escape", "/api/stocks/../../outside/secret.mp3"],
    ["/../ escape", "/../../outside/secret.mp3"],
    ["own-host URL with ../", `http://${PUBLIC_IP}/../../outside/secret.mp3`],
    ["symlink out of public/", "/renders/link-out.mp3"],
  ]) {
    det.arm();
    const res = await call(url);
    const seen = await det.observed();
    check(`transcribe: ${label} refused without reading it`, res.status === 400 && clean(seen), `${res.status} ${JSON.stringify(res.body).slice(0, 100)} ${JSON.stringify(seen)}`);
  }
  // A file stored before the ingest gate is read with the demuxer its name promises. A
  // playlist then fails to parse (500); "#EXTM3U"+frames named .mp3 decodes as plain mp3
  // (409 KEY_REQUIRED = extraction worked). Either way nothing else is opened.
  for (const [label, url] of plantStoredHostiles(ws, det, fx, ["mp3", "mp4"])) {
    det.arm();
    const res = await call(url);
    const seen = await det.observed();
    const refused = res.status === 500 && res.body.error === "ไม่สามารถแกะเสียงจากไฟล์ได้";
    const plainMp3 = label === "stored hls-then-mp3 .mp3" && res.status === 409;
    check(`transcribe: ${label} refused or read as plain media, no access`, (refused || plainMp3) && clean(seen),
      `${res.status} ${JSON.stringify(res.body).slice(0, 100)} ${JSON.stringify(seen)}`);
  }
  for (const [name, body] of hostileAudio(det.port, path.join(ws.abs, "canary.ts"), fs.readFileSync(fx.bareMp3))) {
    const url = stub(`http://${PUBLIC_IP}/tr/${name}.mp3`, bytesResponse(body, "audio/mpeg"));
    det.arm();
    const res = await call(url);
    const seen = await det.observed();
    check(`transcribe: remote ${name} refused, no access, temp removed`,
      res.status === 500 && clean(seen) && !fs.readdirSync(ws.stocks).some((f) => f.startsWith("transcribe-tmp-")),
      `${res.status} ${JSON.stringify(seen)}`);
  }
  const loop = stub(`http://${PUBLIC_IP}/tr/redirect.mp3`, redirectTo(`http://127.0.0.1:${det.port}/landed.mp3`));
  det.arm();
  let res = await call(loop);
  let seen = await det.observed();
  check("transcribe: a remote 302 to 127.0.0.1 → 400, no loopback connection", res.status === 400 && clean(seen), `${res.status} ${JSON.stringify(seen)}`);

  // Legit. PRO + no Gemini key → 409 KEY_REQUIRED only after a successful extraction. FREE + a
  // 121 s file → 403 duration_exceeded, which needs the (pinned) duration probe to work.
  fs.copyFileSync(fx.mp3, path.join(ws.renders, "tr-short.mp3"));
  res = await call("/api/renders/tr-short.mp3");
  check("transcribe: short mp3, PRO, no key → 409 KEY_REQUIRED (extraction ran)", res.status === 409 && res.body.code === "KEY_REQUIRED", `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  state.plan = "FREE";
  try {
    for (const [label, file, url] of [
      ["mp3", fx.longMp3, "/renders/tr-long.mp3"], ["wav", fx.longWav, "/api/renders/tr-long.wav"],
      ["audio-only mp4", fx.longAudioMp4, "/api/renders/tr-long.mp4"], ["webm/opus", fx.longOpus, "/api/renders/tr-long.webm"],
    ]) {
      fs.copyFileSync(file, path.join(ws.renders, path.basename(url)));
      res = await call(url);
      check(`transcribe: 121 s ${label} on FREE → 403 (duration probe worked)`, res.status === 403, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
    }
    fs.copyFileSync(fx.longMp3, path.join(ws.stocks, "tr-long-stock.mp3"));
    res = await call("/api/stocks/tr-long-stock.mp3");
    check("transcribe: 121 s mp3 under /api/stocks on FREE → 403", res.status === 403, `${res.status}`);
    const remote = stub(`http://${PUBLIC_IP}/tr/long.mp3`, bytesResponse(fs.readFileSync(fx.longMp3), "audio/mpeg"));
    det.arm();
    res = await call(remote);
    seen = await det.observed();
    check("transcribe: remote 121 s mp3 on FREE → 403, temp removed", res.status === 403 && clean(seen)
      && !fs.readdirSync(ws.stocks).some((f) => f.startsWith("transcribe-tmp-")), `${res.status}`);
  } finally {
    state.plan = "PRO";
  }
  fs.rmSync(path.join(ws.renders, "link-out.mp3"));
}

async function trimAndDurationChecks(ws: Workspace, det: Detectors, fx: Fixtures, trim: RouteModule, duration: RouteModule): Promise<void> {
  console.log("\n# 2f. /api/videos/trim-audio and /api/videos/audio-duration");
  fs.symlinkSync(path.join(ws.outside, "secret.mp3"), path.join(ws.renders, "link-out.mp3"));
  for (const [label, url] of [...plantStoredHostiles(ws, det, fx, ["mp3", "wav", "m4a"]), ["symlink out of public/", "/renders/link-out.mp3", ""]]) {
    det.arm();
    const t = await postJson(trim, "/api/videos/trim-audio", { audioUrl: url, durationSecs: 1, tailSecs: 1 });
    const d = await postJson(duration, "/api/videos/audio-duration", { audioUrl: url });
    const seen = await det.observed();
    // As for transcribe: "#EXTM3U"+frames stored as .mp3 decodes as plain mp3 under -f mp3.
    const plainMp3 = label === "stored hls-then-mp3 .mp3" && t.status === 200 && d.status === 200;
    check(`trim-audio + audio-duration: ${label} refused or read as plain media, no access`,
      (plainMp3 || (t.status >= 400 && d.status >= 400 && t.body.audioUrl === undefined && d.body.durationMs === undefined)) && clean(seen),
      `${t.status}/${d.status} ${JSON.stringify(seen)}`);
    if (typeof t.body.audioUrl === "string") try { fs.rmSync(path.join(ws.renders, t.body.audioUrl.replace(/^\/api\/renders\//, ""))); } catch {}
    check(`trim-audio + audio-duration: ${label} errors carry no server path`, noServerPath(ws, t.body) && noServerPath(ws, d.body),
      `${JSON.stringify(t.body).slice(0, 120)} ${JSON.stringify(d.body).slice(0, 120)}`);
  }
  fs.rmSync(path.join(ws.renders, "link-out.mp3"));

  for (const [label, fixture, ext] of [["mp3", fx.mp3, "mp3"], ["wav", fx.wav, "wav"], ["m4a", fx.m4a, "m4a"]]) {
    const name = `tts-src.${ext}`;
    const src = path.join(ws.renders, name);
    fs.copyFileSync(fixture, src);
    const wantMs = await preChangeDurationMs(src);
    const d = await postJson(duration, "/api/videos/audio-duration", { audioUrl: `/renders/${name}` });
    check(`audio-duration: ${label} → same durationMs as before (${wantMs})`, d.status === 200 && d.body.durationMs === wantMs, `${d.status} ${JSON.stringify(d.body)}`);
    for (const [mode, body] of [
      ["intro", { durationSecs: 0.5 }], ["tail", { tailSecs: 0.5 }], ["intro+tail", { durationSecs: 0.4, tailSecs: 0.4 }],
    ] as Array<[string, JsonBody]>) {
      const t = await postJson(trim, "/api/videos/trim-audio", { audioUrl: `/api/renders/${name}`, ...body });
      const out = typeof t.body.audioUrl === "string" ? path.join(ws.renders, t.body.audioUrl.replace(/^\/api\/renders\//, "")) : "";
      const expected = await preChangeTrim(ws, src, `.${ext}`, body);
      check(`trim-audio: ${label} ${mode} → 200, output identical to the pre-change commands`,
        t.status === 200 && out !== "" && fs.readFileSync(out).equals(expected), `${t.status} ${JSON.stringify(t.body).slice(0, 120)}`);
      if (out && fs.existsSync(out)) fs.rmSync(out);
    }
  }
}

async function preChangeDurationMs(file: string): Promise<number | null> {
  const out = await runTool(BUNDLED_FFMPEG, ["-i", file, "-f", "null", "-"]);
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10;
}

async function preChangeTrim(ws: Workspace, src: string, ext: string, body: JsonBody): Promise<Buffer> {
  const ffmpeg = BUNDLED_FFMPEG;
  const out = await runTool(ffmpeg, ["-i", src]);
  const m = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)!;
  const totalDur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number.parseFloat(m[3]);
  const durationSecs = Number(body.durationSecs ?? 0);
  const tailSecs = Number(body.tailSecs ?? 0);
  const dir = fs.mkdtempSync(path.join(ws.scratch, "trim-"));
  const outPath = path.join(dir, `out${ext}`);
  if (tailSecs > 0 && durationSecs <= 0) {
    await execFileAsync(ffmpeg, ["-y", "-i", src, "-ss", String(Math.max(0, totalDur - tailSecs)), "-c", "copy", outPath]);
  } else if (tailSecs > 0) {
    const N = Math.min(durationSecs, totalDur);
    const tailStart = Math.max(N, totalDur - tailSecs);
    const intro = path.join(dir, `intro${ext}`);
    const tail = path.join(dir, `tail${ext}`);
    const list = path.join(dir, "list.txt");
    await execFileAsync(ffmpeg, ["-y", "-i", src, "-t", String(N), "-c", "copy", intro]);
    await execFileAsync(ffmpeg, ["-y", "-i", src, "-ss", String(tailStart), "-c", "copy", tail]);
    fs.writeFileSync(list, `file '${intro}'\nfile '${tail}'`);
    await execFileAsync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", outPath]);
  } else {
    await execFileAsync(ffmpeg, ["-y", "-i", src, "-t", String(durationSecs), "-c", "copy", outPath]);
  }
  return fs.readFileSync(outPath);
}

async function heygenChecks(ws: Workspace, det: Detectors, fx: Fixtures, routes: Routes): Promise<void> {
  console.log("\n# 2g. /api/heygen/composite, preview-frame, preview-bg");
  fs.copyFileSync(fx.mp4, path.join(ws.renders, "avatar-real.mp4"));
  fs.copyFileSync(fx.mp4, path.join(ws.renders, "bg-real.mp4"));
  fs.symlinkSync(path.join(ws.outside, "secret.mp4"), path.join(ws.renders, "link-out.mp4"));
  const stored = plantStoredHostiles(ws, det, fx, ["mp4"]).filter(([label]) => !/id3|then-mp3/.test(label));
  const remote = hostileVideo(det.port, path.join(ws.abs, "canary.ts")).map(([name, body]) =>
    [`remote ${name}`, stub(`http://${PUBLIC_IP}/hg/${name}.mp4`, bytesResponse(body, "video/mp4"))] as [string, string]);
  const hostile: Array<[string, string]> = [
    ...stored.map(([label, url]) => [label, url] as [string, string]),
    ...remote,
    ["remote 302 to 127.0.0.1", stub(`http://${PUBLIC_IP}/hg/redirect.mp4`, redirectTo(`http://127.0.0.1:${det.port}/landed.mp4`))],
    ["symlink out of public/", "/renders/link-out.mp4"],
  ];
  const renderOutputs = () => fs.readdirSync(ws.renders).filter((f) => /^(composite-|preview-|pf-|avatar-tmp|bg-tmp)/.test(f));
  for (const [label, url] of hostile) {
    for (const role of ["bg", "avatar"]) {
      det.arm();
      const body = role === "bg"
        ? { avatarVideoUrl: "/renders/avatar-real.mp4", bgVideoUrl: url, mode: "direct", avatarTiming: "full" }
        : { avatarVideoUrl: url, bgVideoUrl: "/renders/bg-real.mp4", mode: "direct", avatarTiming: "full" };
      const res = await postJson(routes.composite, "/api/heygen/composite", body);
      const seen = await det.observed();
      check(`composite: ${label} as the ${role} → refused, no access`,
        res.status >= 400 && res.body.videoUrl === undefined && clean(seen), `${res.status} ${JSON.stringify(res.body).slice(0, 100)} ${JSON.stringify(seen)}`);
    }
    det.arm();
    const pf = await postJson(routes.previewFrame, "/api/heygen/preview-frame", { avatarVideoUrl: url, bgVideoUrl: "/renders/bg-real.mp4" });
    const pf2 = await postJson(routes.previewFrame, "/api/heygen/preview-frame", { avatarVideoUrl: "/renders/avatar-real.mp4", bgVideoUrl: url });
    let seen = await det.observed();
    check(`preview-frame: ${label} (avatar, then bg) → refused, no access`,
      pf.status >= 400 && pf2.status >= 400 && clean(seen), `${pf.status}/${pf2.status} ${JSON.stringify(seen)}`);
    det.arm();
    const pb = await postJson(routes.previewBg, "/api/heygen/preview-bg", { avatarVideoUrl: url, maxSec: 1, halfRes: true });
    seen = await det.observed();
    check(`preview-bg: ${label} → refused, no access`, pb.status >= 400 && pb.body.previewUrl === undefined && clean(seen),
      `${pb.status} ${JSON.stringify(pb.body).slice(0, 100)} ${JSON.stringify(seen)}`);
  }
  check("heygen: no temp download left behind", renderOutputs().length === 0 && !fs.readdirSync(ws.stocks).some((f) => f.startsWith("tmp-avatar-")),
    JSON.stringify(renderOutputs()));

  // Legit.
  let res = await postJson(routes.composite, "/api/heygen/composite",
    { avatarVideoUrl: "/renders/avatar-real.mp4", bgVideoUrl: "/api/renders/bg-real.mp4", mode: "direct", avatarTiming: "full" });
  const compositeOut = typeof res.body.videoUrl === "string" ? path.join(ws.renders, res.body.videoUrl.replace(/^\/api\/renders\//, "")) : "";
  check("composite: real avatar + bg (direct, full) → 200 with an output video", res.status === 200 && compositeOut !== "" && fs.statSync(compositeOut).size > 1000,
    `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  const remoteReal = stub(`http://${PUBLIC_IP}/hg/real.mp4`, bytesResponse(fs.readFileSync(fx.mp4), "video/mp4"));
  res = await postJson(routes.composite, "/api/heygen/composite",
    { avatarVideoUrl: remoteReal, bgVideoUrl: "/renders/bg-real.mp4", mode: "direct", avatarTiming: "full" });
  check("composite: remote real avatar → 200", res.status === 200, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  res = await postJson(routes.previewFrame, "/api/heygen/preview-frame", { avatarVideoUrl: remoteReal, bgVideoUrl: "/renders/bg-real.mp4" });
  check("preview-frame: real avatar + bg → 200 with a jpg", res.status === 200 && typeof res.body.imageUrl === "string"
    && fs.existsSync(path.join(ws.publicDir, String(res.body.imageUrl))), `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  res = await postJson(routes.previewBg, "/api/heygen/preview-bg", { avatarVideoUrl: "/renders/avatar-real.mp4", maxSec: 1, halfRes: true });
  check("preview-bg: real avatar → 200 with a webm under stocks/", res.status === 200 && typeof res.body.previewUrl === "string"
    && fs.existsSync(path.join(ws.stocks, String(res.body.previewUrl).replace(/^\/api\/stocks\//, ""))), `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  fs.rmSync(path.join(ws.renders, "link-out.mp4"));
}

async function generateThumbnailChecks(ws: Workspace, det: Detectors, fx: Fixtures, route: RouteModule): Promise<void> {
  console.log("\n# 2h. /api/videos/generate-thumbnail");
  fs.symlinkSync(path.join(ws.outside, "secret.mp4"), path.join(ws.renders, "link-out.mp4"));
  const stored = plantStoredHostiles(ws, det, fx, ["mp4"]).filter(([label]) => !/id3|then-mp3/.test(label));
  for (const [label, url] of [...stored.map(([l, u]) => [l, u]), ["symlink out of public/", "/renders/link-out.mp4"]]) {
    det.arm();
    const res = await postJson(route, "/api/videos/generate-thumbnail", { videoUrl: url, seekTime: 0.5 });
    const seen = await det.observed();
    check(`generate-thumbnail: ${label} refused, no access`, res.status >= 400 && clean(seen), `${res.status} ${JSON.stringify(seen)}`);
  }
  fs.rmSync(path.join(ws.renders, "link-out.mp4"));
  for (const [label, fixture, name] of [["mp4", fx.mp4, "gt.mp4"], ["webm", fx.webm, "gt.webm"], ["mov", fx.mov, "gt.mov"]]) {
    const src = path.join(ws.renders, name);
    fs.copyFileSync(fixture, src);
    const expected = path.join(ws.scratch, `gt-expected-${name}.jpg`);
    await execFileAsync(SYSTEM_FFMPEG, ["-ss", "0.5", "-i", src, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", "-y", expected]);
    const res = await postJson(route, "/api/videos/generate-thumbnail", { videoUrl: `/api/renders/${name}`, seekTime: 0.5 });
    check(`generate-thumbnail: ${label} → 200, same jpg as before`, res.status === 200 && sameFile(ws, res.body.thumbnailUrl, expected),
      `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
}

async function generateWithBgChecks(ws: Workspace, det: Detectors, fx: Fixtures, route: RouteModule): Promise<void> {
  console.log("\n# 2i. /api/heygen/generate-with-bg (file reads that feed a HeyGen upload / ffmpeg)");
  fs.writeFileSync(path.join(ws.outside, "secret.env"), "STRIPE_SECRET_KEY=sk_live_canary\n");
  fs.symlinkSync(path.join(ws.outside, "secret.mp4"), path.join(ws.renders, "link-out.mp4"));
  const call = (body: JsonBody) => postJson(route, "/api/heygen/generate-with-bg", { avatarId: "av1", ...body });
  for (const [label, body] of [
    ["bgVideoUrl /../ to a secret file", { text: "hello", bgVideoUrl: "/../../outside/secret.env" }],
    ["bgVideoUrl symlink out of public/", { text: "hello", bgVideoUrl: "/renders/link-out.mp4" }],
    ["audioUrl /../ to an mp3 outside public/", { audioUrl: "/../../outside/secret.mp3", greenScreen: true }],
    ["audioUrl /../ to a non-mp3 outside public/ (ffmpeg path)", { audioUrl: "/../../outside/secret.mp4", greenScreen: true }],
  ] as Array<[string, JsonBody]>) {
    const uploads = state.heygenUploads.length;
    det.arm();
    const res = await call(body);
    const seen = await det.observed();
    check(`generate-with-bg: ${label} → refused, nothing uploaded, not read`,
      res.status >= 400 && state.heygenUploads.length === uploads && clean(seen), `${res.status} ${JSON.stringify(seen)}`);
  }
  fs.rmSync(path.join(ws.renders, "link-out.mp4"));
  fs.copyFileSync(fx.mp4, path.join(ws.renders, "gwb-bg.mp4"));
  fs.copyFileSync(fx.mp3, path.join(ws.renders, "gwb-voice.mp3"));
  let uploads = state.heygenUploads.length;
  await call({ text: "hello", bgVideoUrl: "/api/renders/gwb-bg.mp4" });
  check("generate-with-bg: a real bg video under public/renders is uploaded byte-for-byte",
    state.heygenUploads.length === uploads + 1 && state.heygenUploads.at(-1)?.bytes === sha(fs.readFileSync(fx.mp4)));
  uploads = state.heygenUploads.length;
  await call({ audioUrl: "/renders/gwb-voice.mp3", greenScreen: true });
  check("generate-with-bg: a real mp3 voice is uploaded byte-for-byte",
    state.heygenUploads.length === uploads + 1 && state.heygenUploads.at(-1)?.bytes === sha(fs.readFileSync(fx.mp3)));
}

// ---------------------------------------------------------------------------------------
// 3. Source: readers this script cannot drive end to end.
// ---------------------------------------------------------------------------------------
function sourceChecks(): void {
  console.log("\n# 3. source");
  const src = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
  const lowRes = src("src/lib/low-res-preview.ts");
  check("low-res-preview: the source video is read with pinned input options",
    /resolveStoredMediaDemuxer\(job\.info\.sourceFilePath, \["video"\]\)/.test(lowRes) && /\.\.\.safeInputArgs\(demuxer\),\s*"-i", job\.info\.sourceFilePath/.test(lowRes));
  const gwb = src("src/app/api/heygen/generate-with-bg/route.ts");
  check("generate-with-bg: toMp3 and probeDurationMs pin their input",
    gwb.includes('...safeInputArgs(demuxer), "-i", inputPath') && gwb.includes('...safeInputArgs(demuxer), "-i", filePath'));
  const voices = src("src/lib/user-voices.server.ts");
  check("user-voices: the canary path pins pipe:0 to the sniffed demuxer",
    voices.includes('...safeInputArgs(demuxer, "pipe"),') && /"-i", "pipe:0"/.test(voices));
  const thumb = src("src/app/api/videos/thumbnail/route.ts");
  check("thumbnail: no URL is handed to ffmpeg any more", !thumb.includes("assertSafeFetchUrl(sourceVideoSrc"));
  const render = src("src/app/api/videos/render/route.ts");
  check("render: image cache + duration probe come from the tested lib",
    render.includes('from "@/lib/render-input-guard"') && !render.includes("async function cacheImageLocally") && !render.includes("async function probeVideoDurationSec"));
}

async function main(): Promise<void> {
  console.log(`system ffmpeg: ${SYSTEM_FFMPEG}\nsystem ffprobe: ${SYSTEM_FFPROBE}\nbundled ffmpeg: ${BUNDLED_FFMPEG}`);
  for (const bin of [SYSTEM_FFMPEG, SYSTEM_FFPROBE, BUNDLED_FFMPEG]) {
    const version = (await runTool(bin, ["-version"])).split("\n")[0];
    if (!/version/.test(version)) {
      console.error(`✗ ${bin} is not runnable — install ffmpeg (apt-get install ffmpeg) and run npm ci first.`);
      process.exit(1);
    }
    console.log(version);
  }

  const originalCwd = process.cwd();
  const originalTmp = process.env.TMPDIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-input-hardening-"));
  const ws = makeWorkspace(tmp);
  const fx = await makeFixtures(ws.fixtures);
  const canaries: string[] = [];
  for (const dir of [ws.renders, ws.music, ws.stocks, ws.osTmp, ws.abs]) {
    for (const name of ["canary.ts", "canary.mp4"]) {
      const file = path.join(dir, name);
      fs.copyFileSync(fx.mp4, file);
      canaries.push(file);
    }
  }
  fs.copyFileSync(fx.mp4, path.join(ws.outside, "secret.mp4"));
  fs.copyFileSync(fx.mp3, path.join(ws.outside, "secret.mp3"));
  fs.writeFileSync(path.join(ws.outside, "secret.env"), "STRIPE_SECRET_KEY=sk_live_canary\n");
  fs.copyFileSync(fx.mp4, path.join(ws.stocks, "other-user-stock.mp4"));
  canaries.push(path.join(ws.outside, "secret.mp4"), path.join(ws.outside, "secret.mp3"), path.join(ws.outside, "secret.env"),
    path.join(ws.stocks, "other-user-stock.mp4"));
  const det = await startDetectors(tmp, canaries);
  installFetchStub();
  const mocks = await installMocks();
  process.env.USER_VOICE_STORAGE_DIR = ws.voiceStore;
  delete process.env.HERO_VOICE_CANARY_ROOT;
  delete process.env.MANAGED_GEMINI;
  try {
    await controls(ws, det, fx);
    process.chdir(ws.app);
    process.env.TMPDIR = ws.osTmp;
    try {
      await helperChecks(ws, det, fx);
    } catch (error) {
      check("helpers load and run", false, String((error as Error).stack ?? error).split("\n").slice(0, 3).join(" | "));
    }
    const routes: Routes = {
      thumbnail: await import("../src/app/api/videos/thumbnail/route"),
      upload: await import("../src/app/api/videos/upload/route"),
      music: await import("../src/app/api/music/upload/route"),
      transcribe: await import("../src/app/api/videos/transcribe/route"),
      trim: await import("../src/app/api/videos/trim-audio/route"),
      duration: await import("../src/app/api/videos/audio-duration/route"),
      composite: await import("../src/app/api/heygen/composite/route"),
      previewFrame: await import("../src/app/api/heygen/preview-frame/route"),
      previewBg: await import("../src/app/api/heygen/preview-bg/route"),
      genThumb: await import("../src/app/api/videos/generate-thumbnail/route"),
      genWithBg: await import("../src/app/api/heygen/generate-with-bg/route"),
    };
    await thumbnailChecks(ws, det, fx, routes.thumbnail);
    await videoUploadChecks(ws, det, fx, routes.upload);
    await musicUploadChecks(ws, det, fx, routes.music);
    await voiceChecks(ws, det, fx);
    await transcribeChecks(ws, det, fx, routes.transcribe);
    await trimAndDurationChecks(ws, det, fx, routes.trim, routes.duration);
    await heygenChecks(ws, det, fx, routes);
    await generateThumbnailChecks(ws, det, fx, routes.genThumb);
    await generateWithBgChecks(ws, det, fx, routes.genWithBg);
    sourceChecks();
  } finally {
    process.chdir(originalCwd);
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    globalThis.fetch = realFetch;
    for (const m of mocks) m.restore();
    await det.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nffmpeg input hardening: ALL PASS" : `\nffmpeg input hardening: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

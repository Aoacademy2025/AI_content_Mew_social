// Exercise the real transcription response and render coverage with synthetic media.
// Only auth, persistence, and provider I/O are replaced; no database or network is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import { prepareBrollRenderAssets } from "../src/lib/broll-coverage";
import { buildCutawayBackgroundTimeline, planCutaway } from "../src/lib/cutaway-plan";

const root = process.cwd();
const nativeRequire = createRequire(path.join(root, "package.json"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-source-duration-"));
const originalFetch = globalThis.fetch;
let providerCalls = 0;

function loadRoute(relativePath: string): { POST(request: Request): Promise<Response> } {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const boundaryRequire = (name: string): unknown => {
    if (name === "@/lib/clerk-auth") return { getCurrentUser: async () => ({ id: "fixture-user" }) };
    if (name === "@/lib/prisma") return { prisma: { user: { findUnique: async () => ({ plan: "PRO" }) } } };
    if (name === "@/lib/gemini-key") return {
      resolveGeminiKey: () => ({ key: "fixture-key", mode: "byok" }), KeyRequiredError: class extends Error {},
    };
    if (name === "@/lib/ai-spend-limits") return {
      reserveAiAudioMinutes: async () => ({ allowed: true }), refundAiAudioMinutes: async () => {},
    };
    if (name === "@/lib/mcp/video-job-funding") return { walletFundingForCurrentRequest: async () => ({ allowed: false }) };
    if (name === "@/lib/telemetry") return { recordTelemetryEvent: async () => {} };
    if (name === "@/lib/api-error") return { apiError: ({ error }: { error: unknown }) => { throw error; } };
    if (name === "@/lib/gemini") return { geminiGenerateText: () => { throw new Error("Unexpected text generation"); } };
    return nativeRequire(name.startsWith("@/") ? path.join(root, "src", name.slice(2)) : name);
  };
  new Function("require", "exports", compiled)(boundaryRequire, exports);
  return exports as ReturnType<typeof loadRoute>;
}

async function main() {
  const ffmpeg = getFfmpegPath();
  fs.mkdirSync(path.join(directory, "public/renders"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  const source = path.join(directory, "public/renders/presenter.mov");
  // PCM avoids platform-dependent AAC encoder padding in the original fixture.
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=25:d=72.4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=72.386",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", "-t", "72.4", "-y", source,
  ]);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://generativelanguage.googleapis.com/upload/v1beta/files") {
      return Response.json({ file: { uri: "https://example.invalid/fixture-audio" } });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/") && init?.method === "POST") {
      providerCalls++;
      const transcript = {
        fullText: "Test uploaded presenter.",
        captions: [{ text: "Test uploaded presenter.", startMs: 0, endMs: 72500 }],
        words: [{ word: "Test", startMs: 0, endMs: 1000 }, { word: "uploaded", startMs: 1000, endMs: 3000 },
          { word: "presenter.", startMs: 3000, endMs: 72500 }],
      };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(transcript) }] } }] });
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  const transcribe = loadRoute("src/app/api/videos/transcribe/route.ts");
  const generateConfig = loadRoute("src/app/api/videos/generate-config/route.ts");
  process.chdir(directory);
  const response = await transcribe.POST(new Request("http://localhost/api/videos/transcribe", {
    method: "POST", body: JSON.stringify({ audioUrl: "/api/renders/presenter.mov" }),
  }));
  assert.equal(response.status, 200);
  const transcript = await response.json();
  assert.equal(transcript.audioDurationMs, 72400, "the original clip, not padded transcription MP3, owns the timeline");
  assert.equal(providerCalls, 1, "duration correction must not request another paid transcription");
  for (const item of [...transcript.captions, ...transcript.words, ...transcript.segments]) {
    assert.ok(item.endMs <= 72400, "all response timings remain within the source clip");
  }
  const windows = Array.from({ length: 16 }, (_, i) => ({ startMs: i * 4525, endMs: (i + 1) * 4525 }));
  const cutaway = planCutaway(windows, { fillYourself: true });
  const background = buildCutawayBackgroundTimeline({
    windows, brollRanges: cutaway.broll, brollAssets: [],
    presenterAsset: { videoUrl: "/api/renders/presenter.mov", duration: 72.4, timelineAligned: true },
  });
  const configResponse = await generateConfig.POST(new Request("http://localhost/api/videos/generate-config", {
    method: "POST", body: JSON.stringify({ sceneCaptions: transcript.captions, stockVideos: background.assets,
      brollWindows: background.windows, audioDurationMs: transcript.audioDurationMs, voiceFile: "/api/renders/presenter.mov", fps: 30 }),
  }));
  assert.equal(configResponse.status, 200);
  const { config } = await configResponse.json();
  const result = await prepareBrollRenderAssets(config.bgVideos, config.durationInFrames / 30, 30, {
    resolveAsset: src => ({ src, localPath: source }),
    isUsableLocalFile: file => fs.statSync(file).size > 1500,
    probeDurationSec: async () => 72.4, // independently known duration of the generated 1810-frame fixture
  });
  assert.equal(result.coverage.complete, true, "upload with no automatic B-roll reaches render admission");
  assert.equal(result.telemetry.uncoveredTailSec, 0);
  console.log("PASS original upload duration → transcription → fill-yourself config → render coverage");
}

main().finally(() => {
  globalThis.fetch = originalFetch;
  process.chdir(root);
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });

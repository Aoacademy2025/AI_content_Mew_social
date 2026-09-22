// HERO-51: exercise the real internal caller and transcribe route with synthetic media.
// Provider, auth and persistence boundaries are replaced; no database or network is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import {
  INTERNAL_TRANSCRIBE_DEADLINE_HEADER,
  assertTranscribeDeadline,
  deriveInternalTranscribeDeadline,
} from "../src/lib/transcribe-deadline";

const root = process.cwd();
const nativeRequire = createRequire(path.join(root, "package.json"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-transcribe-"));
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let reserved = 0;
let refunded = 0;

function loadRoute(): { POST(request: Request): Promise<Response> } {
  const source = fs.readFileSync(path.join(root, "src/app/api/videos/transcribe/route.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const boundaryRequire = (name: string): unknown => {
    if (name === "@/lib/clerk-auth") return { getCurrentUser: async () => ({ id: "fixture-user" }) };
    if (name === "@/lib/mcp/service-actor") return { isServiceActorRequest: async () => true };
    if (name === "@/lib/prisma") return {
      prisma: { user: { findUnique: async () => ({ id: "fixture-user", plan: "PRO", ttsProvider: "gemini" }) } },
    };
    if (name === "@/lib/gemini-key") return {
      resolveGeminiKey: () => ({ key: "fixture-key", mode: "managed" }), KeyRequiredError: class extends Error {},
    };
    if (name === "@/lib/ai-spend-limits") return {
      reserveAiAudioMinutes: async () => { reserved += 1; return { allowed: true }; },
      refundAiAudioMinutes: async () => { refunded += 1; },
    };
    if (name === "@/lib/mcp/video-job-funding") return { walletFundingForCurrentRequest: async () => ({ allowed: false }) };
    if (name === "@/lib/api-error") return { apiError: ({ error }: { error: unknown }) => { throw error; } };
    if (name === "@/lib/gemini") return { geminiGenerateText: () => { throw new Error("Unexpected merge request"); } };
    return nativeRequire(name.startsWith("@/") ? path.join(root, "src", name.slice(2)) : name);
  };
  new Function("require", "exports", compiled)(boundaryRequire, exports);
  return exports as ReturnType<typeof loadRoute>;
}

function completedChunk(durationMs = 60_000): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    fullText: "one two",
    captions: [{ text: "one two", startMs: 0, endMs: durationMs - 100 }],
    words: [
      { word: "one", startMs: 0, endMs: Math.floor(durationMs / 2) },
      { word: "two", startMs: Math.floor(durationMs / 2), endMs: durationMs - 100 },
    ],
  }) }] } }] });
}

async function runRouteCase(firstCompletes: boolean) {
  let uploads = 0;
  let generations = 0;
  let aborted = 0;
  let lateRejectSettled = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/upload/v1beta/files")) {
      uploads += 1;
      return Response.json({ file: { uri: `https://example.invalid/file-${uploads}`, name: `files/${uploads}` } });
    }
    if (url.includes(":generateContent")) {
      generations += 1;
      if (firstCompletes && generations === 1) return completedChunk();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const fallback = setTimeout(() => reject(new Error("fixture provider did not receive an abort")), 2_000);
        const fail = () => {
          clearTimeout(fallback);
          aborted += 1;
          setTimeout(() => {
            lateRejectSettled = true;
            reject(new DOMException("deadline", "AbortError"));
          }, 10);
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (init?.method === "DELETE") return Response.json({});
    throw new Error(`Unexpected request: ${url}`);
  };

  const route = loadRoute();
  const requestedDeadline = Date.now() + 1_500;
  const response = await route.POST(new Request("http://localhost/api/videos/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_TRANSCRIBE_DEADLINE_HEADER]: String(requestedDeadline) },
    body: JSON.stringify({
      audioUrl: "/api/renders/voice.wav",
      script: "one two three four five six",
      scriptPrompt: "one two three four five six",
    }),
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
  return { response, uploads, generations, aborted, lateRejectSettled };
}

async function verifyPipelineCallerDeadline() {
  let receivedDeadline = "";
  const server = http.createServer((req, res) => {
    receivedDeadline = String(req.headers[INTERNAL_TRANSCRIBE_DEADLINE_HEADER] ?? "");
    req.on("aborted", () => res.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  process.env.MCP_INTERNAL_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MCP_SERVICE_SECRET = "fixture-service-secret-fixture-service-secret";
  const { pipelineCaller } = await import(`../src/lib/mcp/pipeline-client.ts?bounded=${Date.now()}`);
  const controller = new AbortController();
  const deadlineMs = Date.now() + 250;
  const call = pipelineCaller("fixture-user").post("/slow", {}, {
    retries: 0,
    deadlineMs,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(call, /abort/i);
  assert.equal(receivedDeadline, String(deadlineMs), "the authenticated caller carries its absolute deadline");
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function main() {
  assert.equal(
    deriveInternalTranscribeDeadline({ isServiceActor: false, requestedDeadlineMs: Date.now() + 10_000, nowMs: 100 }),
    null,
    "a public caller cannot activate the internal deadline mode",
  );
  assert.equal(
    deriveInternalTranscribeDeadline({ isServiceActor: true, requestedDeadlineMs: 999_999, nowMs: 1_000 }),
    179_000,
    "the route clamps the trusted deadline to 178s, reserving 2s of the 180s outer budget",
  );
  const expired = deriveInternalTranscribeDeadline({
    isServiceActor: true, requestedDeadlineMs: 999, nowMs: 1_000,
  });
  assert.equal(expired, 999, "an expired trusted deadline stays expired instead of disabling bounded mode");
  assert.throws(() => assertTranscribeDeadline(expired, 1_000), /deadline_exceeded/);
  fs.mkdirSync(path.join(directory, "public/renders"), { recursive: true });
  fs.mkdirSync(path.join(directory, "stocks"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  execFileSync(getFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=180",
    "-c:a", "pcm_s16le", "-y", path.join(directory, "public/renders/voice.wav"),
  ]);
  process.chdir(directory);

  const partial = await runRouteCase(true);
  assert.equal(partial.response.status, 200, "one completed chunk is returned before the deadline");
  const body = await partial.response.json() as { words: unknown[]; warnings?: Array<{ code: string }> };
  assert(body.words.length > 0, "validated words from the completed chunk survive");
  assert(body.warnings?.some(warning => warning.code === "transcribe_incomplete"), "the missing span is explicit");
  assert.equal(partial.generations, 2, "the stalled second chunk is the last provider attempt");
  assert.equal(partial.uploads, 2, "the third chunk and retry never start");
  assert.equal(partial.aborted, 1, "the in-flight provider request is aborted at the route deadline");
  assert.equal(partial.lateRejectSettled, true, "a late abort rejection is observed and contained");
  assert.equal(refunded, 0, "submitted managed work remains accounted after a usable partial response");
  assert.deepEqual(fs.readdirSync(path.join(directory, "stocks")), [], "temporary transcription files are cleaned");

  const empty = await runRouteCase(false);
  assert.equal(empty.response.status, 422, "zero completed chunks keeps the existing no-transcript fallback result");
  assert.equal(empty.generations, 1, "zero-completion timeout starts no retry or later chunk");
  assert.equal(refunded, 1, "an unusable zero-completion request refunds its managed reservation");
  assert.equal(reserved, 2, "each route request reserves once before provider work");
  assert.deepEqual(fs.readdirSync(path.join(directory, "stocks")), [], "zero-completion cleanup also removes temporary files");
  await verifyPipelineCallerDeadline();
  console.log("bounded transcribe: caller cancellation, route salvage, no-later-work, cleanup and settlement PASS");
}

main().finally(() => {
  globalThis.fetch = originalFetch;
  process.chdir(root);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });

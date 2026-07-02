// verify-preview-mode.ts — Editor v2 background render (ADR 0001, P4a)
// Proof that the orchestrator's NEW previewMode branch:
//   A. stops after the base render — NO burn render, NO gallery Video row, NO refund
//      (the base reservation stands as the single charge) — and persists outputJson v2
//      with captions/config/voiceUrl for the editor's subtitle phase, AND
//   B. the full (MCP) path WITHOUT previewMode is behaviorally unchanged:
//      2 renders (base + burn), gallery POST + PATCH, exactly 1 refund, v1 output.
//   C. parseVideoJobOutput tolerates v1 / v2 / null / garbage.
//
// Run: npx tsx scripts/verify-preview-mode.ts

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "previewmode-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

// สคริปต์สั้น (<120 ตัวอักษร) → orchestrator ข้าม split-script โดยดีไซน์
const SCRIPT = "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน เนื้อบางเบามาก ซึมไวสุดๆ";

const TIMING = {
  provider: "gemini",
  segments: [
    { text: "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน ", startMs: 0, durationMs: 2600 },
    { text: "เนื้อบางเบามาก ซึมไวสุดๆ", startMs: 2600, durationMs: 2400 },
  ],
};

interface CallLog { method: string; path: string; body?: unknown }

function makeStubCaller(log: CallLog[]) {
  let renderCount = 0;
  return {
    async post<T>(path: string, body: unknown): Promise<T> {
      log.push({ method: "POST", path, body });
      if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
        return { voiceUrl: "/api/voices/test.m4a", audioDurationMs: 5000, timing: TIMING } as T;
      }
      if (path === "/api/videos/split-script") return { cards: null } as T;
      if (path === "/api/videos/extract-keywords") {
        return { keywords: ["sunscreen"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [5], visualDirection: "", keywordAlternatives: [] } as T;
      }
      if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "sunscreen" }] } as T;
      if (path === "/api/videos/generate-config") return { config: { scenes: [], voiceUrl: "/api/voices/test.m4a" } } as T;
      if (path === "/api/videos/render") { renderCount++; return { jobId: `render-${renderCount}` } as T; }
      if (path === "/api/videos") return { id: "gallery-vid-1" } as T;
      if (path === "/api/videos/transcribe") {
        return { captions: [
          { text: "สวัสดีค่ะ วันนี้รีวิวครีมกันแดด", startMs: 0, endMs: 2500, tag: "hook" },
          { text: "เนื้อบางเบา ซึมไว", startMs: 2500, endMs: 5000, tag: "body" },
          { text: "กดติดตามไว้เลย", startMs: 5000, endMs: 7000, tag: "cta" },
        ], audioDurationMs: 7000 } as T;
      }
      if (path === "/api/heygen/composite") return { videoUrl: "/api/renders/composite-cutaway-1.mp4" } as T;
      throw new Error(`stub caller: unexpected POST ${path}`);
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      log.push({ method: "PATCH", path, body });
      return {} as T;
    },
    async get<T>(path: string): Promise<T> {
      log.push({ method: "GET", path });
      if (path.startsWith("/api/videos/render-progress")) {
        const n = /render-(\d+)/.exec(path)?.[1] ?? "0";
        return { progress: 100, videoUrl: `/renders/out-${n}.mp4`, error: null, stage: "done" } as T;
      }
      if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
      throw new Error(`stub caller: unexpected GET ${path}`);
    },
  };
}

async function main() {
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { createVideoJob, parseVideoJobOutput } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");

  const now = new Date();
  await prisma.user.create({
    data: {
      id: "u-preview", name: "Preview User", email: "preview@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
      geminiVoiceName: "Aoede",
    },
  });

  // ── A. preview mode: stops before burn, v2 output, no refund ──────────────
  {
    const log: CallLog[] = [];
    let refunds = 0;
    // voiceProvider explicit — mirrors the web route (user rows default ttsProvider="elevenlabs")
    const job = await createVideoJob("u-preview", { script: SCRIPT, previewMode: true, voiceProvider: "gemini", geminiVoiceName: "Puck", stockSource: "kie-image", targetClipCount: 7, kieModel: "gpt-image-2-text-to-image" });
    await runOrchestrator(job.id, "u-preview", {
      caller: makeStubCaller(log),
      refundOneClip: async () => { refunds++; },
      sleep: async () => {},
    });

    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "done", `A: job done (got ${done?.status} err=${done?.errorMessage ?? "-"})`);
    ok(done?.progress === 100, "A: progress 100");

    const renders = log.filter((c) => c.method === "POST" && c.path === "/api/videos/render");
    ok(renders.length === 1, `A: exactly ONE render (base, no burn) — got ${renders.length}`);
    ok(!log.some((c) => c.method === "POST" && c.path === "/api/videos"), "A: NO gallery Video row created");
    ok(!log.some((c) => c.method === "PATCH"), "A: NO gallery PATCH");
    ok(refunds === 0, `A: NO refund — base reservation stands as the single charge (got ${refunds})`);

    const ttsCall = log.find((c) => c.path === "/api/videos/tts-gemini");
    ok((ttsCall?.body as { voiceName?: string })?.voiceName === "Puck", "A: per-job geminiVoiceName override reaches TTS");
    const stockCall = log.find((c) => c.path === "/api/videos/fetch-stock");
    ok((stockCall?.body as { stockSource?: string })?.stockSource === "kie-image", "A: stockSource override reaches fetch-stock");
    ok((stockCall?.body as { kieModel?: string })?.kieModel === "gpt-image-2-text-to-image", "A: kieModel reaches fetch-stock");
    const kwCall = log.find((c) => c.path === "/api/videos/extract-keywords");
    ok((kwCall?.body as { targetClipCount?: number })?.targetClipCount === 7, "A: targetClipCount reaches extract-keywords");

    const out = parseVideoJobOutput(done?.outputJson ?? null);
    ok(out?.version === 2, `A: output version 2 (got ${out?.version})`);
    ok(out?.videoUrl === "/renders/out-1.mp4", `A: videoUrl = base render (got ${out?.videoUrl})`);
    ok(out?.videoId === undefined, "A: no videoId (gallery row comes at web burn)");
    ok((out?.preview?.captions?.length ?? 0) > 0, `A: captions present (${out?.preview?.captions?.length})`);
    ok(out?.preview?.voiceUrl === "/api/voices/test.m4a", "A: voiceUrl present");
    ok((out?.preview?.audioDurationMs ?? 0) > 0, "A: audioDurationMs present");
    ok(typeof out?.preview?.config === "object" && out?.preview?.config !== null, "A: config present");
  }

  // ── B. full path (no previewMode): behavior unchanged ─────────────────────
  {
    const log: CallLog[] = [];
    let refunds = 0;
    const job = await createVideoJob("u-preview", { script: SCRIPT });
    await runOrchestrator(job.id, "u-preview", {
      caller: makeStubCaller(log),
      refundOneClip: async () => { refunds++; },
      sleep: async () => {},
    });

    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "done", `B: job done (got ${done?.status} err=${done?.errorMessage ?? "-"})`);

    const renders = log.filter((c) => c.method === "POST" && c.path === "/api/videos/render");
    ok(renders.length === 2, `B: TWO renders (base + burn) — got ${renders.length}`);
    ok(log.some((c) => c.method === "POST" && c.path === "/api/videos"), "B: gallery Video row created");
    ok(log.some((c) => c.method === "PATCH" && c.path === "/api/videos/gallery-vid-1"), "B: gallery PATCH → COMPLETED");
    ok(refunds === 1, `B: exactly one refund (base reservation) — got ${refunds}`);

    const stockCall = log.find((c) => c.path === "/api/videos/fetch-stock");
    ok((stockCall?.body as { stockSource?: string })?.stockSource === "both", "B: MCP default stockSource unchanged (both)");

    const out = parseVideoJobOutput(done?.outputJson ?? null);
    ok(out?.version === 1, `B: output stays v1 (got ${out?.version})`);
    ok(out?.videoUrl === "/renders/out-2.mp4", `B: videoUrl = burned render (got ${out?.videoUrl})`);
    ok(out?.videoId === "gallery-vid-1", "B: videoId present");
    ok(out?.preview === undefined, "B: no preview payload");
  }

  // ── D. cooperative cancel: canceled mid-run → stops at next step boundary ──
  {
    const log: CallLog[] = [];
    const job = await createVideoJob("u-preview", { script: SCRIPT, previewMode: true, voiceProvider: "gemini" });
    const base = makeStubCaller(log);
    const cancelingCaller = {
      ...base,
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        const r = await base.post<T>(path, body);
        // user hits ยกเลิก while keywords are running → status flips to canceled
        if (path === "/api/videos/extract-keywords") {
          await prisma.videoJob.update({ where: { id: job.id }, data: { status: "canceled" } });
        }
        return r;
      },
    };
    await runOrchestrator(job.id, "u-preview", { caller: cancelingCaller, refundOneClip: async () => {}, sleep: async () => {} });
    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "canceled", `D: status stays canceled, no failJob overwrite (got ${done?.status})`);
    ok(!log.some((c) => c.method === "POST" && c.path === "/api/videos/fetch-stock"), "D: no step started after cancel (stock never called)");
    ok(!log.some((c) => c.method === "POST" && c.path === "/api/videos/render"), "D: no render after cancel");
  }

  // ── E. upload/cutaway branch: no TTS, composite cutaway, v2 preview output ──
  {
    const log: CallLog[] = [];
    let refunds = 0;
    const job = await createVideoJob("u-preview", { script: "", mode: "upload", clipUrl: "/api/renders/my-clip.mp4", previewMode: true });
    await runOrchestrator(job.id, "u-preview", {
      caller: makeStubCaller(log),
      refundOneClip: async () => { refunds++; },
      sleep: async () => {},
    });
    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "done", `E: upload job done (got ${done?.status} err=${done?.errorMessage ?? "-"})`);
    ok(!log.some((c) => c.path === "/api/videos/tts-gemini" || c.path === "/api/videos/tts"), "E: NO TTS call (voice from clip)");
    ok(log.some((c) => c.path === "/api/videos/transcribe"), "E: transcribe called on the clip");
    const compCall = log.find((c) => c.path === "/api/heygen/composite");
    const compBody = compCall?.body as { mode?: string; avatarVideoUrl?: string; bgVideoUrl?: string; personRanges?: { start: number; end: number }[] } | undefined;
    ok(compBody?.mode === "cutaway", "E: composite mode = cutaway");
    ok(compBody?.avatarVideoUrl === "/api/renders/my-clip.mp4", "E: clip is the composite foreground");
    ok(compBody?.bgVideoUrl === "/renders/out-1.mp4", "E: b-roll reel is the composite background");
    ok(Array.isArray(compBody?.personRanges) && compBody.personRanges.length > 0, "E: personRanges present");
    ok(refunds === 0, "E: no refund (preview charge stands)");
    ok(!log.some((c) => c.method === "POST" && c.path === "/api/videos"), "E: no gallery row (comes at web burn)");
    const out = parseVideoJobOutput(done?.outputJson ?? null);
    ok(out?.version === 2 && out.videoUrl === "/api/renders/composite-cutaway-1.mp4", `E: v2 output = composite url (got ${out?.videoUrl})`);
    ok((out?.preview?.captions?.length ?? 0) === 3, "E: transcribed captions in output");
  }

  // ── C. parser tolerance ────────────────────────────────────────────────────
  {
    const { parseVideoJobOutput: parse } = await import("../src/lib/mcp/video-job");
    ok(parse(null) === null, "C: null → null");
    ok(parse("not json{{") === null, "C: garbage → null");
    const v1 = parse(JSON.stringify({ videoUrl: "a.mp4", videoId: "v1" }));
    ok(v1?.version === 1 && v1.videoUrl === "a.mp4" && v1.videoId === "v1", "C: legacy v1 row parses");
    const weird = parse(JSON.stringify({ version: 2, mode: "preview", videoUrl: "b.mp4" }));
    ok(weird?.version === 2 && weird.preview === undefined, "C: v2 without preview object tolerated");
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

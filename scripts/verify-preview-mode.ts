// verify-preview-mode.ts — Editor v2 background render (ADR 0001, P4a)
// Proof that the orchestrator's NEW previewMode branch:
//   A. stops after the base render — NO burn render, NO gallery Video row, NO refund
//      (the base reservation stands as the single charge) — and persists outputJson v2
//      with captions/config/voiceUrl for the editor's subtitle phase, AND
//   B. the full (MCP) path WITHOUT previewMode: 2 renders (base + burn), gallery POST + PATCH,
//      v1 output, and — for a NON-AVATAR video — NO refund (MON-2): finalBase == baseUrl, so
//      the burn is free (isBurnAlreadyPaid) and the base's single ChargedClip is the net-1.
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
const FINAL_GAP_CANCELED_AT = new Date("2026-07-01T11:59:00.000Z");

const TIMING = {
  provider: "gemini",
  segments: [
    { text: "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน ", startMs: 0, durationMs: 2600 },
    { text: "เนื้อบางเบามาก ซึมไวสุดๆ", startMs: 2600, durationMs: 2400 },
  ],
};

const LONG_DURATION_MS = 278_439;
const LONG_WINDOW_GROUP_SIZES = [
  ...Array.from({ length: 35 }, () => 3),
  ...Array.from({ length: 18 }, () => 2),
];
const LONG_SEGMENTS = LONG_WINDOW_GROUP_SIZES.flatMap((groupSize, groupIndex) => {
  const groupStart = Math.round((LONG_DURATION_MS * groupIndex) / LONG_WINDOW_GROUP_SIZES.length);
  const groupEnd = Math.round((LONG_DURATION_MS * (groupIndex + 1)) / LONG_WINDOW_GROUP_SIZES.length);
  return Array.from({ length: groupSize }, (_, itemIndex) => {
    const startMs = Math.round(groupStart + ((groupEnd - groupStart) * itemIndex) / groupSize);
    const endMs = Math.round(groupStart + ((groupEnd - groupStart) * (itemIndex + 1)) / groupSize);
    return { text: "คำ ", startMs, durationMs: endMs - startMs };
  });
});
const LONG_TIMING = { provider: "gemini", segments: LONG_SEGMENTS };

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
      if (path.startsWith("/api/videos/render-cancel")) return {} as T;
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
  const { createVideoJob: createQueuedVideoJob, parseVideoJobOutput } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");
  const createProcessingVideoJob = async (...args: Parameters<typeof createQueuedVideoJob>) => {
    const job = await createQueuedVideoJob(...args);
    return prisma.videoJob.update({ where: { id: job.id }, data: { status: "processing" } });
  };

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
    const job = await createProcessingVideoJob("u-preview", { script: SCRIPT, previewMode: true, voiceProvider: "gemini", geminiVoiceName: "Puck", stockSource: "kie-image", targetClipCount: 7, kieModel: "gpt-image-2-text-to-image" });
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
    ok(
      renders.every((call) => (call.body as { parentJobId?: string })?.parentJobId === job.id),
      "A: every render is durably linked to its owning VideoJob",
    );
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
    ok(((kwCall?.body as { scenes?: string[] })?.scenes?.length ?? 0) === 7, "A: manual 7 creates exactly 7 semantic prompt chapters");
    ok(((stockCall?.body as { keywords?: string[] })?.keywords?.length ?? 0) === 7, "A: manual Hero sends exactly 7 image subjects to fetch-stock");
    ok((stockCall?.body as { overrideClipCount?: number })?.overrideClipCount === 7, "A: manual Hero fetch count remains exactly 7");
    const configCall = log.find((c) => c.path === "/api/videos/generate-config");
    ok(((configCall?.body as { brollWindows?: unknown[] })?.brollWindows?.length ?? 0) === 7, "A: manual Hero timeline contains exactly 7 non-cycling windows");

    const out = parseVideoJobOutput(done?.outputJson ?? null);
    ok(out?.version === 2, `A: output version 2 (got ${out?.version})`);
    ok(out?.preview?.voiceModel === "Puck", `A: exact per-job voiceModel persists in preview (got ${out?.preview?.voiceModel})`);
    ok(out?.videoUrl === "/renders/out-1.mp4", `A: videoUrl = base render (got ${out?.videoUrl})`);
    ok(out?.videoId === undefined, "A: no videoId (gallery row comes at web burn)");
    ok((out?.preview?.captions?.length ?? 0) > 0, `A: captions present (${out?.preview?.captions?.length})`);
    ok(out?.preview?.voiceUrl === "/api/voices/test.m4a", "A: voiceUrl present");
    ok((out?.preview?.audioDurationMs ?? 0) > 0, "A: audioDurationMs present");
    ok(typeof out?.preview?.config === "object" && out?.preview?.config !== null, "A: config present");
  }

  // ── P1. exact post-TTS duration guard: PRO 361s must fail before any downstream
  // captions/keyword/stock/render work starts. ───────────────────────────────
  {
    const log: CallLog[] = [];
    const base = makeStubCaller(log);
    const overCapCaller = {
      ...base,
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        if (path === "/api/videos/tts-gemini") {
          log.push({ method: "POST", path, body });
          return { voiceUrl: "/api/voices/over-cap.m4a", audioDurationMs: 361_000, timing: TIMING } as T;
        }
        return base.post<T>(path, body);
      },
    };
    const job = await createProcessingVideoJob("u-preview", {
      script: SCRIPT,
      previewMode: true,
      voiceProvider: "gemini",
    });
    await runOrchestrator(job.id, "u-preview", {
      caller: overCapCaller,
      refundOneClip: async () => {},
      sleep: async () => {},
    });
    const failed = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(failed?.status === "failed", `P1-duration: PRO 361s is failed (got ${failed?.status})`);
    ok(failed?.errorMessage?.includes("เกินเพดานแผน Pro") === true, "P1-duration: user-facing plan message is preserved");
    ok(!log.some((c) => c.path === "/api/videos/extract-keywords"), "P1-duration: keywords never start");
    ok(!log.some((c) => c.path === "/api/videos/fetch-stock"), "P1-duration: stock never starts");
    ok(!log.some((c) => c.path === "/api/videos/render"), "P1-duration: render never starts");
  }

  // Some provider fallbacks can return audio without instrumented duration/timing. The
  // worker must probe that local audio before it is allowed past the post-TTS gate.
  {
    const log: CallLog[] = [];
    const base = makeStubCaller(log);
    const missingDurationCaller = {
      ...base,
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        if (path === "/api/videos/tts-gemini") {
          log.push({ method: "POST", path, body });
          return { voiceUrl: "/api/renders/no-duration.m4a" } as T;
        }
        if (path === "/api/videos/audio-duration") {
          log.push({ method: "POST", path, body });
          return { durationMs: 361_000 } as T;
        }
        return base.post<T>(path, body);
      },
    };
    const job = await createProcessingVideoJob("u-preview", {
      script: SCRIPT,
      previewMode: true,
      voiceProvider: "gemini",
    });
    await runOrchestrator(job.id, "u-preview", {
      caller: missingDurationCaller,
      refundOneClip: async () => {},
      sleep: async () => {},
    });
    const failed = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(log.some((c) => c.path === "/api/videos/audio-duration"), "P1-duration-fallback: exact media probe runs when TTS omits duration");
    ok(failed?.errorMessage?.includes("เกินเพดานแผน Pro") === true, "P1-duration-fallback: probed 361s is blocked");
    ok(!log.some((c) => c.path === "/api/videos/extract-keywords"), "P1-duration-fallback: no expensive downstream step starts");
  }

  // ── G. window-mode b-roll parity: keywords/fetch-stock use b-roll windows, not
  // subtitle-card count. This prevents AI-gen full mode from creating one image per
  // subtitle card and timing out before fetch-stock returns. ─────────────────
  {
    const prevMode = process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE;
    const prevSec = process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC;
    process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE = "1";
    process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC = "60";
    try {
      const log: CallLog[] = [];
      const base = makeStubCaller(log);
      const windowCaller = {
        ...base,
        post: async <T,>(path: string, body: unknown): Promise<T> => {
          if (path === "/api/videos/extract-keywords") {
            log.push({ method: "POST", path, body });
            const scenes = ((body as { scenes?: string[] }).scenes ?? []).filter(Boolean);
            return {
              keywords: scenes.map((_, i) => `window keyword ${i + 1}`),
              keywordAlternatives: scenes.map((_, i) => [`window keyword ${i + 1}`]),
              keywordsPerScene: 1,
              sceneClipCounts: scenes.map(() => 1),
              sceneDurations: scenes.map(() => 5),
              visualDirection: "",
            } as T;
          }
          return base.post<T>(path, body);
        },
      };
      const job = await createProcessingVideoJob("u-preview", { script: SCRIPT, previewMode: true, voiceProvider: "gemini", stockSource: "kie-image", kieModel: "gpt-image-2-text-to-image" });
      await runOrchestrator(job.id, "u-preview", {
        caller: windowCaller,
        refundOneClip: async () => {},
        sleep: async () => {},
      });

      const kwCall = log.find((c) => c.path === "/api/videos/extract-keywords");
      const stockCall = log.find((c) => c.path === "/api/videos/fetch-stock");
      const cfgCall = log.find((c) => c.path === "/api/videos/generate-config");
      const kwScenes = (kwCall?.body as { scenes?: string[] } | undefined)?.scenes ?? [];
      const stockBody = stockCall?.body as { keywords?: string[]; overrideClipCount?: number; subtitleTexts?: string[]; perSubtitleMode?: boolean } | undefined;
      const cfgBody = cfgCall?.body as { brollWindows?: { startMs: number; endMs: number }[] } | undefined;
      ok(kwScenes.length === 1, `G: window mode sends 1 b-roll window to keywords (got ${kwScenes.length})`);
      ok(stockBody?.keywords?.length === 1, `G: fetch-stock gets 1 keyword/window (got ${stockBody?.keywords?.length ?? 0})`);
      ok(stockBody?.overrideClipCount === 1 && stockBody.perSubtitleMode === true, `G: fetch-stock overrideClipCount follows windows (got ${stockBody?.overrideClipCount})`);
      ok((stockBody?.subtitleTexts?.length ?? 0) === 1, `G: subtitleTexts follows windows (got ${stockBody?.subtitleTexts?.length ?? 0})`);
      ok((cfgBody?.brollWindows?.length ?? 0) === 1, `G: generate-config keeps the same 1 b-roll window (got ${cfgBody?.brollWindows?.length ?? 0})`);
    } finally {
      if (prevMode === undefined) delete process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE;
      else process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE = prevMode;
      if (prevSec === undefined) delete process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC;
      else process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC = prevSec;
    }
  }

  // ── I. production-shaped long window contract: 141 captions → 53 semantic
  // windows while fetch-stock returns the configured cap of 36 representative assets. ──
  {
    const prevMode = process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE;
    const prevSec = process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC;
    process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE = "1";
    process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC = "4";
    try {
      const log: CallLog[] = [];
      const base = makeStubCaller(log);
      const longCaller = {
        ...base,
        post: async <T,>(path: string, body: unknown): Promise<T> => {
          if (path === "/api/videos/tts-gemini") {
            log.push({ method: "POST", path, body });
            return {
              voiceUrl: "/api/voices/long-test.m4a",
              audioDurationMs: LONG_DURATION_MS,
              timing: LONG_TIMING,
            } as T;
          }
          if (path === "/api/videos/extract-keywords") {
            log.push({ method: "POST", path, body });
            const scenes = ((body as { scenes?: string[] }).scenes ?? []).filter(Boolean);
            const cappedScenes = scenes.slice(0, 36);
            return {
              keywords: cappedScenes.map((_, index) => `window-${index}`),
              keywordAlternatives: cappedScenes.map((_, index) => [`window-${index}`]),
              keywordsPerScene: 1,
              sceneClipCounts: cappedScenes.map(() => 1),
              sceneDurations: cappedScenes.map(() => LONG_DURATION_MS / 1000 / cappedScenes.length),
              visualDirection: "",
            } as T;
          }
          if (path === "/api/videos/fetch-stock") {
            log.push({ method: "POST", path, body });
            return {
              results: Array.from({ length: 36 }, (_, index) => {
                const sourceIndex = Math.floor(((index + 0.5) * 53) / 36);
                return {
                  keyword: `window-${sourceIndex}`,
                  sourceIndex,
                  duration: 4.5,
                  videoUrl: `/asset-${index}.mp4`,
                };
              }),
            } as T;
          }
          if (path === "/api/videos/generate-config") {
            log.push({ method: "POST", path, body });
            return { config: { bgVideos: [], voiceFile: "/api/voices/long-test.m4a" } } as T;
          }
          return base.post<T>(path, body);
        },
      };
      const job = await createProcessingVideoJob("u-preview", {
        script: SCRIPT,
        previewMode: true,
        voiceProvider: "gemini",
        subtitleMode: "1",
      });
      await runOrchestrator(job.id, "u-preview", {
        caller: longCaller,
        refundOneClip: async () => {},
        sleep: async () => {},
      });

      const stockCall = log.find((call) => call.path === "/api/videos/fetch-stock");
      const configCall = log.find((call) => call.path === "/api/videos/generate-config");
      const stockBody = stockCall?.body as { keywords?: string[] } | undefined;
      const configBody = configCall?.body as {
        brollWindows?: { startMs: number; endMs: number }[];
        stockVideos?: unknown[];
      } | undefined;
      ok(LONG_SEGMENTS.length === 141, `I: fixture has 141 captions (got ${LONG_SEGMENTS.length})`);
      ok((stockBody?.keywords?.length ?? 0) === 53, `I: long preview requests all 53 semantic windows (got ${stockBody?.keywords?.length ?? 0})`);
      ok(stockBody?.brollWindowMode === true, "I: fetch-stock receives explicit b-roll window mode");
      ok(new Set(stockBody?.keywords ?? []).size === 36, `I: missing keyword units are deterministically cycled (got ${new Set(stockBody?.keywords ?? []).size} unique)`);
      ok((configBody?.brollWindows?.length ?? 0) === 53, `I: config retains all 53 target windows (got ${configBody?.brollWindows?.length ?? 0})`);
      ok((configBody?.stockVideos?.length ?? 0) === 36, `I: config accepts the capped 36-asset pool (got ${configBody?.stockVideos?.length ?? 0})`);
    } finally {
      if (prevMode === undefined) delete process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE;
      else process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE = prevMode;
      if (prevSec === undefined) delete process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC;
      else process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC = prevSec;
    }
  }

  // ── B. full path (no previewMode): behavior unchanged ─────────────────────
  {
    const log: CallLog[] = [];
    let refunds = 0;
    const job = await createProcessingVideoJob("u-preview", { script: SCRIPT });
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
    ok(refunds === 0, `B: non-avatar → NO refund; base's single ChargedClip is the net-1 charge (burn is free) — got ${refunds}`);

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
    const job = await createProcessingVideoJob("u-preview", { script: SCRIPT, previewMode: true, voiceProvider: "gemini" });
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

  // ── F. cancel mid-RENDER (QA 07-03 Flow 4.2): the render step is the only one whose
  // cost is already committed (the render route reserved minutes at request time).
  // Cancel during the poll must (1) cancel the in-flight render job — its route's
  // cancelled path refunds the reservation — and (2) keep status=canceled (before the
  // fix, the render ran to completion and finishJob flipped the job back to done). ──
  {
    const log: CallLog[] = [];
    const job = await createProcessingVideoJob("u-preview", { script: SCRIPT, previewMode: true, voiceProvider: "gemini" });
    const base = makeStubCaller(log);
    let progressPolls = 0;
    const midRenderCancelCaller = {
      ...base,
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          log.push({ method: "GET", path });
          progressPolls++;
          if (progressPolls === 1) {
            // user hits ยกเลิก while the base render is at 50%
            await prisma.videoJob.update({ where: { id: job.id }, data: { status: "canceled" } });
            return { progress: 50, videoUrl: null, error: null, stage: "rendering" } as T;
          }
          // without the fix the render "finishes" and the charge stands
          return { progress: 100, videoUrl: "/renders/out-leak.mp4", error: null, stage: "done" } as T;
        }
        return base.get<T>(path);
      },
    };
    await runOrchestrator(job.id, "u-preview", { caller: midRenderCancelCaller, refundOneClip: async () => {}, sleep: async () => {} });
    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "canceled", `F: status stays canceled, not overwritten by finishJob (got ${done?.status})`);
    ok(log.some((c) => c.method === "POST" && c.path.startsWith("/api/videos/render-cancel") && c.path.includes("jobId=render-1")),
      "F: in-flight render job cancelled → its route refunds the reservation");
    ok(done?.outputJson === null, "F: no output persisted after cancel");
  }

  // ── H. final-gap cancel: cancellation after the last poll but before finish
  // must remain canceled instead of being caught and rewritten to failed. ────
  {
    const log: CallLog[] = [];
    const job = await createProcessingVideoJob("u-preview", { script: SCRIPT });
    const base = makeStubCaller(log);
    const finalGapCancelCaller = {
      ...base,
      patch: async <T,>(path: string, body: unknown): Promise<T> => {
        const result = await base.patch<T>(path, body);
        if (path === "/api/videos/gallery-vid-1") {
          await prisma.videoJob.update({
            where: { id: job.id },
            data: {
              status: "canceled",
              finishedAt: FINAL_GAP_CANCELED_AT,
              errorMessage: "canceled by user (editor v2)",
            },
          });
        }
        return result;
      },
    };
    await runOrchestrator(job.id, "u-preview", {
      caller: finalGapCancelCaller,
      refundOneClip: async () => {},
      sleep: async () => {},
    });
    const canceled = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(canceled?.status === "canceled", `H: final-gap cancellation stays canceled (got ${canceled?.status})`);
    ok(canceled?.finishedAt?.toISOString() === FINAL_GAP_CANCELED_AT.toISOString(), "H: cancellation timestamp stays immutable");
    ok(canceled?.errorMessage === "canceled by user (editor v2)", "H: cancellation reason stays immutable");
    ok(canceled?.outputJson === null, "H: no output persisted after final-gap cancellation");
    ok(canceled?.mediaExpiresAt === null, "H: no expiry stamped after final-gap cancellation");
  }

  // ── E. upload/cutaway branch: no TTS, composite cutaway, v2 preview output ──
  {
    const log: CallLog[] = [];
    let refunds = 0;
    const job = await createProcessingVideoJob("u-preview", {
      script: "",
      mode: "upload",
      clipUrl: "/api/renders/my-clip.mp4",
      previewMode: true,
      stockSource: "kie-image",
      stockProviders: ["pixabay"],
    });
    await runOrchestrator(job.id, "u-preview", {
      caller: makeStubCaller(log),
      refundOneClip: async () => { refunds++; },
      sleep: async () => {},
    });
    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "done", `E: upload job done (got ${done?.status} err=${done?.errorMessage ?? "-"})`);
    ok(!log.some((c) => c.path === "/api/videos/tts-gemini" || c.path === "/api/videos/tts"), "E: NO TTS call (voice from clip)");
    ok(log.some((c) => c.path === "/api/videos/transcribe"), "E: transcribe called on the clip");
    const uploadStockCall = log.find((c) => c.path === "/api/videos/fetch-stock");
    ok(
      JSON.stringify((uploadStockCall?.body as { stockProviders?: string[] })?.stockProviders) === JSON.stringify(["pixabay"]),
      "E: upload/cutaway forwards the validated per-job stock provider allowlist",
    );
    const uploadStockBody = uploadStockCall?.body as {
      keywords?: string[];
      brollWindowDurationsSec?: number[];
      overrideClipCount?: number;
    } | undefined;
    ok(uploadStockBody?.keywords?.length === 1,
      `E-credit: only the visible B-roll window is sent to image generation (got ${uploadStockBody?.keywords?.length ?? 0})`);
    ok(uploadStockBody?.brollWindowDurationsSec?.length === 1,
      `E-credit: only one visible B-roll duration can be billed (got ${uploadStockBody?.brollWindowDurationsSec?.length ?? 0})`);
    ok(uploadStockBody?.overrideClipCount === 1,
      `E-credit: image generation count excludes the presenter-covered window (got ${uploadStockBody?.overrideClipCount ?? 0})`);
    const uploadConfigCall = log.find((c) => c.path === "/api/videos/generate-config");
    ok(((uploadConfigCall?.body as { brollWindows?: unknown[] })?.brollWindows?.length ?? 0) === 1,
      "E-credit: rendered B-roll timeline contains only the visible cutaway window");
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

  // ── E2. one short window is presenter-only: skip stock/AI entirely. ────────
  {
    const log: CallLog[] = [];
    const job = await createProcessingVideoJob("u-preview", {
      script: "",
      mode: "upload",
      clipUrl: "/api/renders/short-presenter.mp4",
      previewMode: true,
      stockSource: "kie-image",
    });
    const base = makeStubCaller(log);
    const shortClipCaller = {
      ...base,
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        if (path === "/api/videos/transcribe") {
          log.push({ method: "POST", path, body });
          return {
            captions: [{ text: "คลิปสั้น", startMs: 0, endMs: 2_500, tag: "hook" }],
            audioDurationMs: 2_500,
          } as T;
        }
        return base.post<T>(path, body);
      },
    };
    await runOrchestrator(job.id, "u-preview", {
      caller: shortClipCaller,
      refundOneClip: async () => {},
      sleep: async () => {},
    });
    const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
    ok(done?.status === "done", `E2: short upload job completes (got ${done?.status})`);
    ok(!log.some((c) => c.path === "/api/videos/extract-keywords"), "E2-credit: no visible B-roll skips keyword generation");
    ok(!log.some((c) => c.path === "/api/videos/fetch-stock"), "E2-credit: no visible B-roll skips every stock/AI credit request");
    const configCall = log.find((c) => c.path === "/api/videos/generate-config");
    ok(((configCall?.body as { brollWindows?: unknown[] })?.brollWindows?.length ?? 0) === 0,
      "E2-credit: config has no billable B-roll windows");
    ok(log.filter((c) => c.path === "/api/videos/render").length === 1, "E2: base render still runs for normal minute metering");
    ok(log.some((c) => c.path === "/api/heygen/composite"), "E2: uploaded presenter is still composited into the final preview");
  }

  // ── C. parser tolerance ────────────────────────────────────────────────────
  // ── J. definitive HeyGen quota rejection after the base render: preserve the
  // structured failure and compensate the platform reservation exactly once. ──
  {
    const { PipelineHttpError } = await import("../src/lib/mcp/pipeline-client");
    for (const previewMode of [true, false]) {
      const label = previewMode ? "preview" : "full-pipeline";
      const log: CallLog[] = [];
      let refunds = 0;
      const job = await createProcessingVideoJob("u-preview", {
        script: SCRIPT,
        previewMode,
        voiceProvider: "gemini",
        avatarMode: "full",
        avatarId: "avatar-1",
      });
      const base = makeStubCaller(log);
      const quotaCaller = {
        ...base,
        post: async <T,>(path: string, body: unknown): Promise<T> => {
          if (path === "/api/heygen/generate-with-bg") {
            log.push({ method: "POST", path, body });
            throw new PipelineHttpError("POST", path, 402, {
              code: "quota",
              provider: "heygen",
              userAction: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
            });
          }
          return base.post<T>(path, body);
        },
      };
      await runOrchestrator(job.id, "u-preview", {
        caller: quotaCaller,
        refundOneClip: async () => { refunds++; },
        sleep: async () => {},
      });
      const failed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
      ok(failed.status === "failed", `J/${label}: provider quota becomes terminal failed (got ${failed.status})`);
      ok(failed.errorCode === "quota" && failed.errorProvider === "heygen", `J/${label}: structured HeyGen quota failure survives the worker`);
      ok(refunds === 1, `J/${label}: base reservation compensated exactly once (got ${refunds})`);
      ok(log.filter((call) => call.path === "/api/videos/render").length === 1, `J/${label}: only the base render ran`);
    }

    const pendingLog: CallLog[] = [];
    const pendingBase = makeStubCaller(pendingLog);
    const pendingJob = await createProcessingVideoJob("u-preview", {
      script: SCRIPT,
      previewMode: true,
      voiceProvider: "gemini",
      avatarMode: "full",
      avatarId: "avatar-1",
    });
    await runOrchestrator(pendingJob.id, "u-preview", {
      caller: {
        ...pendingBase,
        post: async <T,>(path: string, body: unknown): Promise<T> => {
          if (path === "/api/heygen/generate-with-bg") {
            throw new PipelineHttpError("POST", path, 402, {
              code: "quota",
              provider: "heygen",
              userAction: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
            });
          }
          return pendingBase.post<T>(path, body);
        },
      },
      refundOneClip: async () => { throw new Error("database busy"); },
      sleep: async () => {},
    });
    const pendingFailure = await prisma.videoJob.findUniqueOrThrow({ where: { id: pendingJob.id } });
    ok(
      pendingFailure.reservationRefundPending === true
        && pendingFailure.reservationRefundReason === "avatar-provider-quota",
      "J/refund-error: failure keeps a durable reservation-refund marker",
    );
  }

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

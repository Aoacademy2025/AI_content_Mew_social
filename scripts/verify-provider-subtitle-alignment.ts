// Provider-matrix regression for the real background create seam.
//
// Gemini must certify timestamps from the generated Narration Master even when
// ASR writes authored numbers as Thai speech. ElevenLabs must keep its native
// /with-timestamps fast path and never make an unnecessary transcribe request.

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "provider-subtitle-alignment-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`ok: ${message}`);
  else {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { parseVideoJobOutput } = await import("../src/lib/mcp/video-job");
  const { subtitleAlignmentTechnicalRetryDirective } = await import("../src/lib/mcp/subtitle-alignment-retry");

  check(
    subtitleAlignmentTechnicalRetryDirective("incomplete_alignment", 0)?.nextAttempt === 2,
    "incomplete technical alignment receives one retry",
  );
  check(
    subtitleAlignmentTechnicalRetryDirective("incomplete_alignment", 1) === null,
    "technical alignment retry budget is exhausted after one retry",
  );
  check(
    subtitleAlignmentTechnicalRetryDirective("text_mismatch", 0) === null,
    "content mismatch is excluded from the technical retry policy",
  );

  const user = await prisma.user.create({
    data: {
      id: "provider-subtitle-user",
      email: "provider-subtitle@example.com",
      name: "Provider Subtitle QA",
      plan: "PRO",
      ttsProvider: "gemini",
      geminiVoiceName: "Aoede",
      elevenlabsVoiceId: "eleven-qa",
    },
  });

  const geminiScript = "ในปี\n2026\u200Bประหยัดเงิน 5,000 บาท.....";
  const geminiSpeechScript = "ในปี 2026 ประหยัดเงิน 5,000 บาท...";
  const geminiJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "create",
      inputJson: JSON.stringify({
        script: geminiScript,
        previewMode: true,
        voiceProvider: "gemini",
      }),
    },
  });
  let geminiTranscribeCalls = 0;
  let geminiTtsCalls = 0;
  const geminiTtsTexts: string[] = [];
  const geminiCalls: string[] = [];
  await runOrchestrator(geminiJob.id, user.id, {
    caller: {
      post: async <T,>(path: string, body?: unknown): Promise<T> => {
        geminiCalls.push(path);
        if (path === "/api/videos/tts-gemini") {
          geminiTtsCalls += 1;
          geminiTtsTexts.push((body as { text?: string } | undefined)?.text ?? "");
          return {
            voiceUrl: `/api/renders/gemini-narration-${geminiTtsCalls}.wav`,
            audioDurationMs: 4_000,
            timing: {
              provider: "gemini",
              segments: [{ text: geminiSpeechScript, startMs: 0, durationMs: 4_000 }],
              chars: null,
            },
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          geminiTranscribeCalls += 1;
          const spoken = [
            "ใน", "ปี", "สอง", "พัน", "ยี่สิบ", geminiTranscribeCalls === 1 ? "ห้า" : "หก",
            "ประหยัด", "เงิน", "ห้า", "พัน", "บาท",
          ];
          return {
            words: spoken.map((word, index) => ({
              word,
              startMs: 100 + index * 330,
              endMs: 390 + index * 330,
            })),
            audioDurationMs: 4_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 3_900 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ src: "stock.mp4" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 120, voiceFile: "/api/renders/gemini-narration.wav", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") return { jobId: "gemini-base-render" } as T;
        throw new Error(`unexpected Gemini POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          return { progress: 100, stage: "done", videoUrl: "/api/renders/gemini-base.mp4", error: null } as T;
        }
        throw new Error(`unexpected Gemini GET ${path}`);
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const completedGemini = await prisma.videoJob.findUniqueOrThrow({ where: { id: geminiJob.id } });
  const geminiOutput = parseVideoJobOutput(completedGemini.outputJson);
  check(completedGemini.status === "done", "Gemini regenerates mismatched numeric speech and completes the real preview pipeline");
  check(geminiTtsCalls === 2, "Gemini retries TTS exactly once after a hard numeric mismatch");
  check(geminiTranscribeCalls === 2, "Gemini acoustically verifies both generated audio attempts");
  check(geminiTtsTexts.every((text) => text === geminiSpeechScript), "Gemini receives only persisted NarrationPlan speechText");
  check(geminiOutput?.subtitleQa?.status === "passed", "Gemini subtitle QA passes");
  check(geminiOutput?.subtitleQa?.timingSource === "forced_alignment", "Gemini persists forced-alignment evidence");
  check(geminiOutput?.preview?.fullText === geminiSpeechScript, "Gemini captions use deterministic NarrationPlan display text");
  check(geminiOutput?.preview?.voiceUrl === "/api/renders/gemini-narration-2.wav", "Gemini renders only the acoustically verified retry audio");
  check(geminiCalls.lastIndexOf("/api/videos/transcribe") < geminiCalls.indexOf("/api/videos/render"), "Gemini verifies the retry before render spend");

  // Production 2026-08-29: several jobs succeeded only after a user restarted the
  // whole job following a transient transcription/alignment failure. Retry the
  // acoustic substep once while keeping the already-generated narration master.
  const { PipelineHttpError } = await import("../src/lib/mcp/pipeline-client");
  const transientScript = "ลอง ระบบ ซับ อีก ครั้ง";
  const transientJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "create",
      inputJson: JSON.stringify({
        script: transientScript,
        previewMode: true,
        voiceProvider: "gemini",
      }),
    },
  });
  let transientTtsCalls = 0;
  let transientTranscribeCalls = 0;
  const transientTransportRetries: Array<number | undefined> = [];
  await runOrchestrator(transientJob.id, user.id, {
    caller: {
      post: async <T,>(path: string, _body?: unknown, opts?: { retries?: number }): Promise<T> => {
        if (path === "/api/videos/tts-gemini") {
          transientTtsCalls += 1;
          return {
            voiceUrl: "/api/renders/transient-narration.wav",
            audioDurationMs: 3_000,
            timing: {
              provider: "gemini",
              segments: [{ text: transientScript, startMs: 0, durationMs: 3_000 }],
              chars: null,
            },
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          transientTranscribeCalls += 1;
          transientTransportRetries.push(opts?.retries);
          if (transientTranscribeCalls === 1) {
            throw new PipelineHttpError("POST", path, 503, {
              error: "บริการถอดซับไม่พร้อมชั่วคราว",
              reason: "transcribe_request_failed",
              provider: "gemini",
            });
          }
          const words = transientScript.split(" ");
          return {
            words: words.map((word, index) => ({
              word,
              startMs: 100 + index * 520,
              endMs: 520 + index * 520,
            })),
            audioDurationMs: 3_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["subtitle"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [3] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ src: "stock.mp4" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 90, voiceFile: "/api/renders/transient-narration.wav", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") return { jobId: "transient-base-render" } as T;
        throw new Error(`unexpected transient POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          return { progress: 100, stage: "done", videoUrl: "/api/renders/transient-base.mp4", error: null } as T;
        }
        throw new Error(`unexpected transient GET ${path}`);
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const completedTransient = await prisma.videoJob.findUniqueOrThrow({ where: { id: transientJob.id } });
  check(completedTransient.status === "done", "transient transcribe failure recovers inside the same VideoJob");
  check(transientTranscribeCalls === 2, "transient alignment retries exactly once");
  check(transientTtsCalls === 1, "technical alignment retry reuses the existing narration master");
  check(
    transientTransportRetries.length === 2 && transientTransportRetries.every((retries) => retries === 0),
    "orchestrator owns the explicit alignment retry budget without hidden HTTP retries",
  );

  const exhaustedScript = "ระบบ ซับ ยัง ไม่ พร้อม";
  const exhaustedJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "create",
      inputJson: JSON.stringify({
        script: exhaustedScript,
        previewMode: true,
        voiceProvider: "gemini",
      }),
    },
  });
  let exhaustedTtsCalls = 0;
  let exhaustedTranscribeCalls = 0;
  let exhaustedRenderCalls = 0;
  await runOrchestrator(exhaustedJob.id, user.id, {
    caller: {
      post: async <T,>(path: string): Promise<T> => {
        if (path === "/api/videos/tts-gemini") {
          exhaustedTtsCalls += 1;
          return {
            voiceUrl: "/api/renders/exhausted-narration.wav",
            audioDurationMs: 3_000,
            timing: {
              provider: "gemini",
              segments: [{ text: exhaustedScript, startMs: 0, durationMs: 3_000 }],
              chars: null,
            },
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          exhaustedTranscribeCalls += 1;
          throw new PipelineHttpError("POST", path, 503, {
            error: "บริการถอดซับไม่พร้อมชั่วคราว",
            reason: "transcribe_request_failed",
            provider: "gemini",
          });
        }
        if (path === "/api/videos/render") exhaustedRenderCalls += 1;
        throw new Error(`unexpected exhausted POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        throw new Error(`unexpected exhausted GET ${path}`);
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const failedExhausted = await prisma.videoJob.findUniqueOrThrow({ where: { id: exhaustedJob.id } });
  check(failedExhausted.status === "failed", "alignment failure remains fail-closed after retry exhaustion");
  check(exhaustedTranscribeCalls === 2, "exhausted technical alignment attempts stop at two total calls");
  check(exhaustedTtsCalls === 1, "retry exhaustion never regenerates narration for a technical failure");
  check(exhaustedRenderCalls === 0, "retry exhaustion stops before render spend");

  // Production 2026-08-30: Gemini generated the narration successfully, but
  // repeated ASR projections disagreed with the long authored script. A whole
  // user retry cannot improve this deterministically. After the existing TTS
  // regeneration budget is exhausted, continue with canonical source captions
  // and explicit generated-TTS fallback timing instead of failing pre-render.
  const fallbackScript = "เพลง ดี ต้อง มี แผน คอนเทนต์ 3 มุม";
  const fallbackJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "create",
      inputJson: JSON.stringify({
        script: fallbackScript,
        previewMode: true,
        voiceProvider: "gemini",
      }),
    },
  });
  let fallbackTtsCalls = 0;
  let fallbackTranscribeCalls = 0;
  let fallbackRenderCalls = 0;
  await runOrchestrator(fallbackJob.id, user.id, {
    caller: {
      post: async <T,>(path: string): Promise<T> => {
        if (path === "/api/videos/tts-gemini") {
          fallbackTtsCalls += 1;
          return {
            voiceUrl: `/api/renders/fallback-narration-${fallbackTtsCalls}.wav`,
            audioDurationMs: 4_000,
            timing: {
              provider: "gemini",
              segments: [{ text: fallbackScript, startMs: 0, durationMs: 4_000 }],
              chars: null,
            },
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          fallbackTranscribeCalls += 1;
          return {
            words: [
              { word: "ข้อความ", startMs: 100, endMs: 900 },
              { word: "คนละ", startMs: 900, endMs: 1_500 },
              { word: "ชุด", startMs: 1_500, endMs: 2_000 },
            ],
            audioDurationMs: 4_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 2_000 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["content"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ src: "stock.mp4" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 120, voiceFile: "/api/renders/fallback-narration-2.wav", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") {
          fallbackRenderCalls += 1;
          return { jobId: "fallback-base-render" } as T;
        }
        throw new Error(`unexpected fallback POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          return { progress: 100, stage: "done", videoUrl: "/api/renders/fallback-base.mp4", error: null } as T;
        }
        throw new Error(`unexpected fallback GET ${path}`);
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const completedFallback = await prisma.videoJob.findUniqueOrThrow({ where: { id: fallbackJob.id } });
  const fallbackOutput = parseVideoJobOutput(completedFallback.outputJson);
  check(completedFallback.status === "done", "repeated Gemini ASR text drift no longer blocks preview render");
  check(fallbackTtsCalls === 2, "Gemini keeps exactly one TTS regeneration before degraded fallback");
  check(fallbackTranscribeCalls === 2, "each generated narration attempt receives one acoustic check");
  check(fallbackRenderCalls === 1, "degraded fallback reaches render exactly once");
  check(fallbackOutput?.subtitleQa?.status === "passed", "generated TTS fallback still passes canonical text and timeline QA");
  check(
    fallbackOutput?.subtitleQa?.timingSource === "generated_tts_fallback",
    "generated TTS fallback is persisted without claiming forced alignment",
  );
  check(
    fallbackOutput?.preview?.fullText === fallbackScript,
    "generated TTS fallback keeps the immutable Narration Master text",
  );

  const elevenScript = "เก็บเงิน\n5,000\u200Bบาท ทุกเดือน.....";
  const elevenSpeechScript = "เก็บเงิน 5,000 บาท ทุกเดือน...";
  const characters = Array.from(elevenSpeechScript);
  const elevenDurationMs = characters.length * 120;
  const elevenJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "create",
      inputJson: JSON.stringify({
        script: elevenScript,
        previewMode: true,
        voiceProvider: "elevenlabs",
        voiceId: "eleven-qa",
      }),
    },
  });
  let elevenTranscribeCalls = 0;
  const elevenTtsTexts: string[] = [];
  await runOrchestrator(elevenJob.id, user.id, {
    caller: {
      post: async <T,>(path: string, body?: unknown): Promise<T> => {
        if (path === "/api/videos/tts") {
          elevenTtsTexts.push((body as { text?: string } | undefined)?.text ?? "");
          return {
            voiceUrl: "/api/renders/eleven-narration.mp3",
            audioDurationMs: elevenDurationMs,
            timing: {
              provider: "elevenlabs",
              segments: [{ text: elevenSpeechScript, startMs: 0, durationMs: elevenDurationMs }],
              chars: {
                characters,
                startSec: characters.map((_, index) => index * 0.12),
                endSec: characters.map((_, index) => (index + 1) * 0.12),
              },
            },
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          elevenTranscribeCalls += 1;
          throw new Error("ElevenLabs native alignment must bypass transcribe");
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [3] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ src: "stock.mp4" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 90, voiceFile: "/api/renders/eleven-narration.mp3", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") return { jobId: "eleven-base-render" } as T;
        throw new Error(`unexpected ElevenLabs POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          return { progress: 100, stage: "done", videoUrl: "/api/renders/eleven-base.mp4", error: null } as T;
        }
        throw new Error(`unexpected ElevenLabs GET ${path}`);
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const completedEleven = await prisma.videoJob.findUniqueOrThrow({ where: { id: elevenJob.id } });
  const elevenOutput = parseVideoJobOutput(completedEleven.outputJson);
  check(completedEleven.status === "done", "ElevenLabs native timestamps complete the real preview pipeline");
  check(elevenTtsTexts.every((text) => text === elevenSpeechScript), "ElevenLabs receives only persisted NarrationPlan speechText");
  check(elevenTranscribeCalls === 0, "ElevenLabs native timestamps bypass ASR");
  check(elevenOutput?.subtitleQa?.status === "passed", "ElevenLabs subtitle QA passes");
  check(elevenOutput?.subtitleQa?.timingSource === "provider_alignment", "ElevenLabs persists provider-alignment evidence");
  const storedElevenInput = JSON.parse(completedEleven.inputJson) as { script?: string; narrationPlan?: { sourceText?: string; speechText?: string } };
  check(storedElevenInput.script === elevenScript, "legacy/background input keeps the exact authored script");
  check(storedElevenInput.narrationPlan?.speechText === elevenSpeechScript, "worker persists a missing NarrationPlan before provider spend");

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

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

  const geminiScript = "ในปี 2026 ประหยัดเงิน 5,000 บาท";
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
  const geminiCalls: string[] = [];
  await runOrchestrator(geminiJob.id, user.id, {
    caller: {
      post: async <T,>(path: string): Promise<T> => {
        geminiCalls.push(path);
        if (path === "/api/videos/tts-gemini") {
          return {
            voiceUrl: "/api/renders/gemini-narration.wav",
            audioDurationMs: 4_000,
            timing: {
              provider: "gemini",
              segments: [{ text: geminiScript, startMs: 0, durationMs: 4_000 }],
              chars: null,
            },
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          geminiTranscribeCalls += 1;
          const spoken = [
            "ใน", "ปี", "สอง", "พัน", "ยี่สิบ", "หก",
            "ประหยัด", "เงิน", "ห้า", "พัน", "บาท",
          ];
          return {
            words: spoken.map((word, index) => ({
              word,
              startMs: 100 + index * 330,
              endMs: 390 + index * 330,
            })),
            audioDurationMs: 4_000,
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
  check(completedGemini.status === "done", "Gemini numeric speech completes the real preview pipeline");
  check(geminiTranscribeCalls === 1, "Gemini verifies the generated audio exactly once");
  check(geminiOutput?.subtitleQa?.status === "passed", "Gemini subtitle QA passes");
  check(geminiOutput?.subtitleQa?.timingSource === "forced_alignment", "Gemini persists forced-alignment evidence");
  check(geminiOutput?.preview?.fullText === geminiScript, "Gemini keeps authored ASCII subtitle text");
  check(geminiCalls.indexOf("/api/videos/transcribe") < geminiCalls.indexOf("/api/videos/render"), "Gemini verifies subtitles before render spend");

  const elevenScript = "เก็บเงิน 5,000 บาท ทุกเดือน";
  const characters = Array.from(elevenScript);
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
  await runOrchestrator(elevenJob.id, user.id, {
    caller: {
      post: async <T,>(path: string): Promise<T> => {
        if (path === "/api/videos/tts") {
          return {
            voiceUrl: "/api/renders/eleven-narration.mp3",
            audioDurationMs: elevenDurationMs,
            timing: {
              provider: "elevenlabs",
              segments: [{ text: elevenScript, startMs: 0, durationMs: elevenDurationMs }],
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
  check(elevenTranscribeCalls === 0, "ElevenLabs native timestamps bypass ASR");
  check(elevenOutput?.subtitleQa?.status === "passed", "ElevenLabs subtitle QA passes");
  check(elevenOutput?.subtitleQa?.timingSource === "provider_alignment", "ElevenLabs persists provider-alignment evidence");

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

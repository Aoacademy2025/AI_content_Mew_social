// verify-export-gallery-metadata.ts
// Regression proof for Editor v2 durable export metadata:
// the worker must preserve the source preview's avatar + exact TTS voice when it creates
// the final Gallery row. Uses a throwaway SQLite DB and the real orchestrator export branch.

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "export-gallery-metadata-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`ok: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

type SourceInput = {
  script: string;
  previewMode: true;
  voiceProvider: "gemini" | "elevenlabs" | "omnivoice";
  voiceId?: string;
  geminiVoiceName?: string;
  omniVoiceId?: string;
};

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");

  const user = await prisma.user.create({
    data: {
      id: "gallery-metadata-user",
      email: "gallery-metadata@example.com",
      name: "Gallery Metadata QA",
      plan: "PRO",
      ttsProvider: "gemini",
      geminiVoiceName: "Aoede",
      elevenlabsVoiceId: "saved-eleven-voice",
    },
  });

  const cases: Array<{
    label: string;
    input: SourceInput;
    expectedVoiceModel: string;
    avatarModel: string;
    avatarVideoUrl: string | null;
  }> = [
    {
      label: "Hero Voice",
      input: {
        script: "ทดสอบ Hero Voice",
        previewMode: true,
        voiceProvider: "omnivoice",
        omniVoiceId: "voice_01",
      },
      expectedVoiceModel: "voice_01",
      avatarModel: "none",
      avatarVideoUrl: null,
    },
    {
      label: "Gemini per-job voice",
      input: {
        script: "ทดสอบ Gemini",
        previewMode: true,
        voiceProvider: "gemini",
        geminiVoiceName: "Puck",
      },
      expectedVoiceModel: "Puck",
      avatarModel: "avatar-gemini-qa",
      avatarVideoUrl: "/api/renders/avatar-gemini-qa.mp4",
    },
    {
      label: "ElevenLabs per-job voice",
      input: {
        script: "ทดสอบ ElevenLabs",
        previewMode: true,
        voiceProvider: "elevenlabs",
        voiceId: "eleven-voice-qa",
      },
      expectedVoiceModel: "eleven-voice-qa",
      avatarModel: "none",
      avatarVideoUrl: null,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    // This deliberately mirrors a preview produced before the fix: the output has no
    // voiceModel, so export must remain backward compatible by reading source inputJson.
    const source = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "done",
        type: "create",
        inputJson: JSON.stringify(testCase.input),
        outputJson: JSON.stringify({
          version: 2,
          mode: "preview",
          videoUrl: `/renders/source-${index}.mp4`,
          preview: {
            captions: [{ text: "ทดสอบ", startMs: 0, endMs: 1000 }],
            config: { durationInFrames: 30, providerCase: testCase.label },
            voiceUrl: `/api/renders/source-${index}.wav`,
            audioDurationMs: 1000,
            avatarModel: testCase.avatarModel,
            avatarVideoUrl: testCase.avatarVideoUrl,
          },
        }),
        progress: 100,
        finishedAt: new Date(),
      },
    });
    const exportJob = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "processing",
        type: "export",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: source.id,
          subtitleOverlayConfig: { videoUrl: `/renders/source-${index}.mp4`, captions: [] },
        }),
      },
    });

    let galleryBody: Record<string, unknown> | null = null;
    const caller = {
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        if (path === "/api/videos/render") return { jobId: `burn-${index}` } as T;
        if (path === "/api/videos") {
          galleryBody = body as Record<string, unknown>;
          return { id: `gallery-${index}` } as T;
        }
        throw new Error(`unexpected POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          return {
            progress: 100,
            stage: "done",
            videoUrl: `/renders/final-${index}.mp4`,
            error: null,
          } as T;
        }
        throw new Error(`unexpected GET ${path}`);
      },
    };

    await runOrchestrator(exportJob.id, user.id, {
      caller,
      refundOneClip: async () => {},
      sleep: async () => {},
    });

    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    check(completed.status === "done", `${testCase.label}: export completes`);
    check(
      galleryBody?.voiceModel === testCase.expectedVoiceModel,
      `${testCase.label}: Gallery voiceModel is ${testCase.expectedVoiceModel} (got ${String(galleryBody?.voiceModel)})`,
    );
    check(
      galleryBody?.avatarModel === testCase.avatarModel,
      `${testCase.label}: Gallery avatarModel is ${testCase.avatarModel} (got ${String(galleryBody?.avatarModel)})`,
    );
    check(
      galleryBody?.avatarVideoUrl === testCase.avatarVideoUrl,
      `${testCase.label}: Gallery preserves avatarVideoUrl`,
    );
    check(
      (galleryBody?.renderConfig as { providerCase?: string } | undefined)?.providerCase === testCase.label,
      `${testCase.label}: Gallery preserves source renderConfig`,
    );
  }

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

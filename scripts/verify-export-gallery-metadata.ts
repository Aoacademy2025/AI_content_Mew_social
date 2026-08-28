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
          subtitleQa: {
            status: "passed",
            timingSource: testCase.input.voiceProvider === "elevenlabs" ? "provider_alignment" : "forced_alignment",
            textExact: true,
            captionCount: 1,
            audioDurationMs: 1000,
          },
          preview: {
            captions: [{ text: testCase.input.script, startMs: 0, endMs: 1000 }],
            config: { durationInFrames: 30, providerCase: testCase.label },
            voiceUrl: `/api/renders/source-${index}.wav`,
            audioDurationMs: 1000,
            fullText: testCase.input.script,
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
          subtitleOverlayConfig: {
            videoUrl: `/renders/source-${index}.mp4`,
            durationInFrames: 30,
            keywordPopups: [{ text: testCase.input.script, start: 0, end: 30 }],
          },
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

  // Pre-release previews can contain exact script text but only an estimated
  // Gemini segment clock. Export must recover on the already-generated audio,
  // keep the user's caption cards/styles, and burn the acoustically retimed
  // overlay instead of asking the customer to recreate the whole video.
  const legacyScript = "ในปี 2026 ประหยัดเงิน 5,000 บาท";
  const legacySource = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "done",
      type: "create",
      inputJson: JSON.stringify({ script: legacyScript, previewMode: true, voiceProvider: "gemini" }),
      outputJson: JSON.stringify({
        version: 2,
        mode: "preview",
        videoUrl: "/renders/legacy-source.mp4",
        subtitleQa: {
          status: "passed",
          timingSource: "tts_segment_timing",
          textExact: true,
          captionCount: 2,
          audioDurationMs: 3_500,
        },
        preview: {
          captions: [
            { text: "ในปี 2026", startMs: 0, endMs: 2_000, tag: "hook" },
            { text: "ประหยัดเงิน 5,000 บาท", startMs: 2_000, endMs: 4_000, tag: "body" },
          ],
          fullText: legacyScript,
          config: { durationInFrames: 120 },
          voiceUrl: "/api/renders/legacy-source.wav",
          audioDurationMs: 3_500,
          avatarModel: "none",
          avatarVideoUrl: null,
        },
      }),
      progress: 100,
      finishedAt: new Date(),
    },
  });
  const legacyExport = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "export",
      inputJson: JSON.stringify({
        mode: "export",
        sourceJobId: legacySource.id,
        subtitleOverlayConfig: {
          videoUrl: "/renders/legacy-source.mp4",
          durationInFrames: 120,
          keywordPopups: [
            { text: "ในปี 2026", start: 0, end: 60, tag: "hook", color: "#fff" },
            { text: "ประหยัดเงิน 5,000 บาท", start: 60, end: 120, tag: "body", color: "#fff" },
          ],
        },
      }),
    },
  });
  let legacyTranscribeCalls = 0;
  let legacyBurnBody: Record<string, unknown> | null = null;
  await runOrchestrator(legacyExport.id, user.id, {
    caller: {
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        if (path === "/api/videos/transcribe") {
          legacyTranscribeCalls += 1;
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
        if (path === "/api/videos/render") {
          legacyBurnBody = body as Record<string, unknown>;
          return { jobId: "legacy-burn" } as T;
        }
        if (path === "/api/videos") return { id: "legacy-gallery" } as T;
        throw new Error(`unexpected POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/api/videos/render-progress")) {
          return {
            progress: 100,
            stage: "done",
            videoUrl: "/renders/legacy-final.mp4",
            error: null,
          } as T;
        }
        throw new Error(`unexpected GET ${path}`);
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const legacyCompleted = await prisma.videoJob.findUniqueOrThrow({ where: { id: legacyExport.id } });
  const legacyOutput = JSON.parse(legacyCompleted.outputJson ?? "{}") as {
    subtitleQa?: { timingSource?: string };
    subtitleEvidence?: { audioDurationMs?: number };
  };
  const legacyBurnPopups = ((legacyBurnBody?.subtitleOverlayConfig as Record<string, unknown> | undefined)
    ?.keywordPopups ?? []) as Array<Record<string, unknown>>;
  check(legacyCompleted.status === "done", "legacy estimated preview exports without recreating the video");
  check(legacyTranscribeCalls === 1, "legacy export verifies the existing narration audio exactly once");
  check(legacyOutput.subtitleQa?.timingSource === "forced_alignment", "legacy export persists recovered acoustic evidence");
  check(legacyOutput.subtitleEvidence?.audioDurationMs === 4_000, "legacy export trusts the measured replay-audio duration");
  check(
    legacyBurnPopups.length === 2
      && legacyBurnPopups[0]?.start === 3
      && Number(legacyBurnPopups[0]?.end) > 3
      && legacyBurnPopups[0]?.color === "#fff",
    "legacy export retimes the burn overlay while preserving card style",
  );

  const canonicalScript = "รายได้ 5,000 บาท";
  const protectedSource = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "done",
      type: "create",
      inputJson: JSON.stringify({ script: canonicalScript, previewMode: true, voiceProvider: "gemini" }),
      outputJson: JSON.stringify({
        version: 2,
        mode: "preview",
        videoUrl: "/renders/protected-source.mp4",
        subtitleQa: {
          status: "passed",
          timingSource: "forced_alignment",
          textExact: true,
          captionCount: 1,
          audioDurationMs: 1_000,
        },
        preview: {
          captions: [{ text: canonicalScript, startMs: 0, endMs: 1_000 }],
          fullText: canonicalScript,
          config: { durationInFrames: 30 },
          voiceUrl: "/api/renders/protected.wav",
          audioDurationMs: 1_000,
          avatarModel: "none",
          avatarVideoUrl: null,
        },
      }),
      progress: 100,
      finishedAt: new Date(),
    },
  });
  const corruptedExport = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "export",
      inputJson: JSON.stringify({
        mode: "export",
        sourceJobId: protectedSource.id,
        subtitleOverlayConfig: {
          videoUrl: "/renders/protected-source.mp4",
          durationInFrames: 30,
          keywordPopups: [{ text: "รายได้ 500 บาท", start: 0, end: 30 }],
        },
      }),
    },
  });
  let corruptedRenderCalls = 0;
  await runOrchestrator(corruptedExport.id, user.id, {
    caller: {
      post: async <T,>(path: string): Promise<T> => {
        if (path === "/api/videos/render") {
          corruptedRenderCalls += 1;
          return { jobId: "corrupted-burn" } as T;
        }
        if (path === "/api/videos") return { id: "must-not-save" } as T;
        throw new Error(`unexpected POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(): Promise<T> => ({
        progress: 100,
        stage: "done",
        videoUrl: "/renders/must-not-export.mp4",
        error: null,
      } as T),
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const blocked = await prisma.videoJob.findUniqueOrThrow({ where: { id: corruptedExport.id } });
  check(blocked.status === "failed", "changed subtitle text is blocked before export");
  check(corruptedRenderCalls === 0, "failed subtitle release gate spends no burn render");

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

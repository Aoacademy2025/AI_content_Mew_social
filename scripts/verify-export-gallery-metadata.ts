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
  const {
    claimNextQueuedJob,
    recoverProcessingJobsAfterWorkerRestart,
  } = await import("../src/lib/mcp/video-job");
  const { persistExportGalleryVideo } = await import("../src/lib/export-gallery");

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
            speechCoverage: { source: "silence_analysis", spokenEndMs: 1000 },
          },
          preview: {
            captions: [{ text: testCase.input.script, startMs: 0, endMs: 1000 }],
            config: { durationInFrames: 30, providerCase: testCase.label },
            voiceUrl: `/api/renders/source-${index}.wav`,
            audioDurationMs: 1000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 1000 },
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
            speechCoverage: { source: "silence_analysis", spokenEndMs: 3_900 },
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
          speechCoverage: { source: "silence_analysis", spokenEndMs: 1_000 },
        },
        preview: {
          captions: [{ text: canonicalScript, startMs: 0, endMs: 1_000 }],
          fullText: canonicalScript,
          config: { durationInFrames: 30 },
          voiceUrl: "/api/renders/protected.wav",
          audioDurationMs: 1_000,
          speechCoverage: { source: "silence_analysis", spokenEndMs: 1_000 },
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

  // Production incident 2026-08-29 23:01 BKK: Editor v2 allowed an inserted
  // caption card to remain blank, submitted an export job, then reported the
  // misleading code invalid_timing. The server fallback must identify the exact
  // card and stop before Burn for clients that do not yet have UI preflight.
  const blankCaptionExport = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "export",
      inputJson: JSON.stringify({
        mode: "export",
        sourceJobId: protectedSource.id,
        subtitleOverlayConfig: {
          videoUrl: "/renders/protected-source.mp4",
          durationInFrames: 36,
          keywordPopups: [
            { text: canonicalScript, start: 0, end: 30 },
            { text: "", start: 30, end: 36 },
          ],
        },
        editSnapshot: {
          version: 1,
          captions: [
            { text: canonicalScript, startMs: 0, endMs: 1_000, tag: "hook" },
            { text: "   ", startMs: 1_000, endMs: 1_200, tag: "body" },
          ],
        },
      }),
    },
  });
  let blankCaptionSideEffects = 0;
  await runOrchestrator(blankCaptionExport.id, user.id, {
    caller: {
      post: async <T,>(): Promise<T> => {
        blankCaptionSideEffects += 1;
        throw new Error("blank caption must fail before every pipeline POST");
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(): Promise<T> => {
        blankCaptionSideEffects += 1;
        throw new Error("blank caption must fail before every pipeline GET");
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const blankCaptionBlocked = await prisma.videoJob.findUniqueOrThrow({ where: { id: blankCaptionExport.id } });
  check(blankCaptionBlocked.status === "failed", "blank caption is blocked before export");
  check(
    blankCaptionBlocked.errorCode === "subtitle_alignment_empty_caption",
    `blank caption uses the actionable error code (got ${String(blankCaptionBlocked.errorCode)})`,
  );
  check(
    blankCaptionBlocked.errorMessage?.includes("กล่องซับ #2") === true
      && blankCaptionBlocked.errorMessage?.includes("พิมพ์ข้อความหรือลบ") === true,
    "blank caption error identifies the exact card and resolution",
  );
  check(blankCaptionSideEffects === 0, "blank caption spends no Burn/Gallery side effect");

  const hiddenSubtitleExport = await prisma.videoJob.create({
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
          keywordPopups: [],
        },
        editSnapshot: {
          version: 1,
          captions: [{ text: "", startMs: 0, endMs: 1_000, tag: "body" }],
        },
      }),
    },
  });
  let hiddenSubtitleBurnCalls = 0;
  await runOrchestrator(hiddenSubtitleExport.id, user.id, {
    caller: {
      post: async <T,>(path: string): Promise<T> => {
        if (path === "/api/videos/render") {
          hiddenSubtitleBurnCalls += 1;
          return { jobId: "hidden-subtitle-burn" } as T;
        }
        if (path === "/api/videos") return { id: "hidden-subtitle-gallery" } as T;
        throw new Error(`unexpected POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(): Promise<T> => ({
        progress: 100,
        stage: "done",
        videoUrl: "/renders/hidden-subtitle-final.mp4",
        error: null,
      } as T),
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const hiddenSubtitleCompleted = await prisma.videoJob.findUniqueOrThrow({ where: { id: hiddenSubtitleExport.id } });
  check(hiddenSubtitleCompleted.status === "done", "a deliberately hidden subtitle layer may export with draft blank cards");
  check(hiddenSubtitleBurnCalls === 1, "hidden-subtitle export still performs exactly one free Burn");

  // Production incident 2026-08-29: deploy restarted both workers while an Editor v2
  // export was burning subtitles. The RenderJob resumed and finished, but startup
  // recovery failed its parent VideoJob, leaving a valid file outside Gallery and the
  // project stuck in Exporting. Recovery must reuse that exact child without another
  // render, another Gallery row, or another charge.
  const restartProject = await prisma.editorProject.create({
    data: {
      userId: user.id,
      title: "Burn restart recovery",
      status: "exporting",
    },
  });
  const restartSource = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: restartProject.id,
      status: "done",
      type: "create",
      inputJson: JSON.stringify({ script: "กู้ไฟล์เดิมหลัง deploy", previewMode: true, voiceProvider: "gemini" }),
      outputJson: JSON.stringify({
        version: 2,
        mode: "preview",
        videoUrl: "/renders/restart-source.mp4",
        subtitleQa: {
          status: "passed",
          timingSource: "provider_alignment",
          textExact: true,
          captionCount: 1,
          audioDurationMs: 1_000,
          speechCoverage: { source: "provider_alignment", spokenEndMs: 1_000 },
        },
        preview: {
          captions: [{ text: "กู้ไฟล์เดิมหลัง deploy", startMs: 0, endMs: 1_000 }],
          fullText: "กู้ไฟล์เดิมหลัง deploy",
          config: { durationInFrames: 30 },
          voiceUrl: "/api/renders/restart-source.wav",
          audioDurationMs: 1_000,
          speechCoverage: { source: "provider_alignment", spokenEndMs: 1_000 },
          avatarModel: "none",
          avatarVideoUrl: null,
        },
      }),
      progress: 100,
      finishedAt: new Date(),
    },
  });
  const restartExport = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: restartProject.id,
      status: "processing",
      type: "export",
      currentStep: "burn",
      progress: 42,
      inputJson: JSON.stringify({
        mode: "export",
        sourceJobId: restartSource.id,
        subtitleOverlayConfig: {
          videoUrl: "/renders/restart-source.mp4",
          durationInFrames: 30,
          keywordPopups: [{ text: "กู้ไฟล์เดิมหลัง deploy", start: 0, end: 30 }],
        },
      }),
      startedAt: new Date(),
    },
  });
  await prisma.editorProject.update({
    where: { id: restartProject.id },
    data: { activeJobId: restartSource.id, activeExportJobId: restartExport.id },
  });
  const finishedBurn = await prisma.renderJob.create({
    data: {
      userId: user.id,
      parentJobId: restartExport.id,
      type: "BURN",
      status: "QUEUED",
      payload: JSON.stringify({ subtitleOverlayConfig: {} }),
      progress: 42,
      attempts: 1,
      reservedQuota: false,
      finishedAt: new Date(),
    },
  });
  const balanceBefore = {
    user: await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { usageCount: true, minutesUsed: true },
    }),
    credits: await prisma.creditBalance.findUnique({ where: { userId: user.id } }),
  };
  const restartRecovery = await recoverProcessingJobsAfterWorkerRestart({ now: new Date("2026-08-29T15:46:35Z") });
  const recoveredParent = await prisma.videoJob.findUniqueOrThrow({ where: { id: restartExport.id } });
  check(
    restartRecovery.requeued === 1 && recoveredParent.status === "queued",
    "burn restart recovery requeues an export whose durable child can resume",
  );

  let resumedRenderPosts = 0;
  let resumedRenderPolls = 0;
  let resumedGalleryPosts = 0;
  if (recoveredParent.status === "queued") {
    const claimed = await claimNextQueuedJob();
    check(claimed?.id === restartExport.id, "recovered export is claimable by the restarted MCP worker");
    await runOrchestrator(restartExport.id, user.id, {
      caller: {
        post: async <T,>(path: string): Promise<T> => {
          if (path === "/api/videos/render") {
            resumedRenderPosts += 1;
            return { jobId: "duplicate-burn-must-not-run" } as T;
          }
          if (path === "/api/videos") {
            resumedGalleryPosts += 1;
            return { id: "recovered-gallery" } as T;
          }
          throw new Error(`unexpected POST ${path}`);
        },
        patch: async <T,>(): Promise<T> => ({} as T),
        get: async <T,>(): Promise<T> => {
          resumedRenderPolls += 1;
          await prisma.renderJob.update({
            where: { id: finishedBurn.id },
            data: {
              status: "DONE",
              videoUrl: "/api/renders/recovered-final.mp4",
              progress: 100,
              finishedAt: new Date(),
            },
          });
          return {
            progress: 100,
            stage: "done",
            videoUrl: "/api/renders/recovered-final.mp4",
            error: null,
          } as T;
        },
      },
      refundOneClip: async () => {},
      sleep: async () => {},
    });
  }
  const restartCompleted = await prisma.videoJob.findUniqueOrThrow({ where: { id: restartExport.id } });
  const restartProjectAfter = await prisma.editorProject.findUniqueOrThrow({ where: { id: restartProject.id } });
  const balanceAfter = {
    user: await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { usageCount: true, minutesUsed: true },
    }),
    credits: await prisma.creditBalance.findUnique({ where: { userId: user.id } }),
  };
  check(restartCompleted.status === "done", "recovered burn finishes the parent export");
  check(restartCompleted.videoId === "recovered-gallery", "recovered burn links the one Gallery result");
  check(restartProjectAfter.status === "exported", "recovered burn clears the project's Exporting state");
  check(resumedRenderPosts === 0, "recovered burn never enqueues a duplicate RenderJob");
  check(resumedRenderPolls === 1, "recovered export polls the original queued child until it finishes");
  check(resumedGalleryPosts === 1, "recovered burn creates exactly one Gallery row");
  check(
    (await prisma.renderJob.count({ where: { parentJobId: restartExport.id } })) === 1
      && (await prisma.renderJob.findUnique({ where: { id: finishedBurn.id } }))?.videoUrl === "/api/renders/recovered-final.mp4",
    "recovered burn preserves the original child RenderJob and output",
  );
  check(JSON.stringify(balanceAfter) === JSON.stringify(balanceBefore), "recovered free Burn changes no quota or credit balance");

  const legacyFailedProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Legacy orphaned export", status: "exporting" },
  });
  const legacyFailedExport = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: legacyFailedProject.id,
      status: "failed",
      type: "export",
      currentStep: "burn",
      progress: 42,
      errorMessage: "worker restarted during burn - not auto-requeued to avoid duplicate gallery rows",
      inputJson: JSON.stringify({
        mode: "export",
        sourceJobId: restartSource.id,
        subtitleOverlayConfig: {
          videoUrl: "/renders/restart-source.mp4",
          durationInFrames: 30,
          keywordPopups: [{ text: "กู้ไฟล์เดิมหลัง deploy", start: 0, end: 30 }],
        },
      }),
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  await prisma.editorProject.update({
    where: { id: legacyFailedProject.id },
    data: { activeExportJobId: legacyFailedExport.id },
  });
  await prisma.renderJob.create({
    data: {
      userId: user.id,
      parentJobId: legacyFailedExport.id,
      type: "BURN",
      status: "DONE",
      payload: JSON.stringify({ subtitleOverlayConfig: {} }),
      videoUrl: "/api/renders/legacy-orphan-final.mp4",
      progress: 100,
      attempts: 2,
      reservedQuota: false,
      finishedAt: new Date(),
    },
  });
  const legacyRecovery = await recoverProcessingJobsAfterWorkerRestart({ now: new Date("2026-08-29T16:00:00Z") });
  const legacyRecoveredParent = await prisma.videoJob.findUniqueOrThrow({ where: { id: legacyFailedExport.id } });
  check(
    legacyRecovery.requeued === 1 && legacyRecoveredParent.status === "queued",
    "the first fixed worker boot automatically recovers the exact legacy failed-burn signature",
  );
  await prisma.videoJob.update({ where: { id: legacyFailedExport.id }, data: { status: "canceled" } });

  const checkpointProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Idempotent Gallery checkpoint", status: "exporting" },
  });
  const checkpointExport = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: checkpointProject.id,
      status: "processing",
      type: "export",
      currentStep: "save",
      inputJson: JSON.stringify({
        mode: "export",
        sourceJobId: restartSource.id,
        subtitleOverlayConfig: {
          videoUrl: "/renders/restart-source.mp4",
          durationInFrames: 30,
          keywordPopups: [{ text: "กู้ไฟล์เดิมหลัง deploy", start: 0, end: 30 }],
        },
      }),
    },
  });
  const galleryInput = {
    userId: user.id,
    parentVideoJobId: checkpointExport.id,
    projectId: checkpointProject.id,
    contentId: null,
    avatarModel: "none",
    voiceModel: "Puck",
    imageModel: null,
    sceneCount: 1,
    script: "บันทึกครั้งเดียว",
    sceneMapping: null,
    videoUrl: "/api/renders/checkpoint-final.mp4",
    audioUrl: "/api/renders/checkpoint.wav",
    avatarVideoUrl: null,
    renderConfig: JSON.stringify({ durationInFrames: 30 }),
    status: "COMPLETED" as const,
    expiresAt: new Date("2026-09-05T00:00:00Z"),
  };
  const firstGallerySave = await persistExportGalleryVideo(galleryInput);
  const retriedGallerySave = await persistExportGalleryVideo(galleryInput);
  let checkpointParent = await prisma.videoJob.findUniqueOrThrow({ where: { id: checkpointExport.id } });
  check(firstGallerySave.created, "first export Gallery save creates a row");
  check(!retriedGallerySave.created, "retry after a save-stage restart reuses the checkpoint");
  check(firstGallerySave.video.id === retriedGallerySave.video.id, "Gallery retry returns the original row id");
  check(checkpointParent.videoId === firstGallerySave.video.id, "Gallery id is checkpointed atomically on the parent export");
  check(
    (await prisma.video.count({ where: { projectId: checkpointProject.id } })) === 1,
    "save-stage restart leaves exactly one Gallery row",
  );
  await prisma.renderJob.create({
    data: {
      userId: user.id,
      parentJobId: checkpointExport.id,
      type: "BURN",
      status: "DONE",
      payload: JSON.stringify({ subtitleOverlayConfig: {} }),
      videoUrl: galleryInput.videoUrl,
      progress: 100,
      reservedQuota: false,
      finishedAt: new Date(),
    },
  });
  const saveStageRecovery = await recoverProcessingJobsAfterWorkerRestart();
  checkpointParent = await prisma.videoJob.findUniqueOrThrow({ where: { id: checkpointExport.id } });
  check(
    saveStageRecovery.requeued === 1 && checkpointParent.status === "queued",
    "restart after Gallery commit requeues the checkpointed save stage",
  );
  await claimNextQueuedJob();
  let saveStageDuplicateCalls = 0;
  await runOrchestrator(checkpointExport.id, user.id, {
    caller: {
      post: async <T,>(): Promise<T> => {
        saveStageDuplicateCalls += 1;
        throw new Error("checkpointed save must not POST again");
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(): Promise<T> => {
        saveStageDuplicateCalls += 1;
        throw new Error("checkpointed save must not poll again");
      },
    },
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  checkpointParent = await prisma.videoJob.findUniqueOrThrow({ where: { id: checkpointExport.id } });
  check(checkpointParent.status === "done", "checkpointed save stage finishes its parent after restart");
  check(saveStageDuplicateCalls === 0, "checkpointed save stage repeats neither Burn nor Gallery side effects");
  check(
    (await prisma.video.count({ where: { projectId: checkpointProject.id } })) === 1,
    "checkpointed save-stage recovery still leaves one Gallery row",
  );

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

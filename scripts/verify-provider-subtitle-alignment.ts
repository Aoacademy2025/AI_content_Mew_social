// Provider-matrix regression for the real background create/export seam (ADR 0056).
//
// The render clock is the provider's own TTS clock. ONE bounded acoustic alignment call
// may promote it to forced alignment; when that call fails, times out or is unavailable
// the clip still ships on the deterministic clock and the outcome is recorded as
// evidence. No subtitle verdict may fail a job, retry a provider, or spend on a second
// TTS generation, and Export never re-aligns.

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

type Call = { path: string; body?: unknown; atMs: number };
type TimedWord = { word: string; startMs: number; endMs: number };
type SubtitleVerificationEvidence = {
  status?: string;
  code?: string;
  method?: string;
  similarityPermille?: number;
  durationMs?: number;
  ttsCaptions?: Array<{ startMs: number; endMs: number }>;
  medianAbsStartDeltaMs?: number;
  maxAbsStartDeltaMs?: number;
  routeWarnings?: Array<{ code?: string; fromMs?: number; toMs?: number }>;
};
type JobOutput = {
  subtitleQa?: { status?: string; code?: string; timingSource?: string };
  subtitleEvidence?: {
    timingSource?: string;
    captions?: Array<{ text: string; startMs: number; endMs: number }>;
    verification?: SubtitleVerificationEvidence;
    overlayRetimed?: boolean;
  };
  preview?: {
    captions?: Array<{ text: string; startMs: number; endMs: number }>;
    fullText?: string;
    voiceUrl?: string;
  };
};

function countCalls(calls: Call[], path: string): number {
  return calls.filter((call) => call.path === path).length;
}
function firstCallAt(calls: Call[], path: string): number | null {
  const found = calls.find((call) => call.path === path);
  return found ? found.atMs : null;
}
function parseOutput(outputJson: string | null): JobOutput {
  return JSON.parse(outputJson ?? "{}") as JobOutput;
}
function verificationOf(output: JobOutput): SubtitleVerificationEvidence {
  return output.subtitleEvidence?.verification ?? {};
}
function renderedCaptions(output: JobOutput): Array<{ text: string; startMs: number; endMs: number }> {
  return output.preview?.captions ?? output.subtitleEvidence?.captions ?? [];
}

/** The real Gemini create pipeline with a scriptable /api/videos/transcribe seam. */
function geminiPipeline(options: {
  calls: Call[];
  speech: string;
  durationMs: number;
  voiceUrl: string;
  /** `null` reproduces the tts-gemini fail-open response that carries no timing. */
  timing?: unknown;
  transcribe: (attempt: number) => Promise<unknown>;
  transcribeRetries?: Array<number | undefined>;
}) {
  const startedAt = Date.now();
  let transcribeCalls = 0;
  const defaultTiming = {
    provider: "gemini",
    segments: [{ text: options.speech, startMs: 0, durationMs: options.durationMs }],
    chars: null,
  };
  return {
    startedAt,
    caller: {
      post: async <T,>(path: string, body?: unknown, opts?: { retries?: number }): Promise<T> => {
        options.calls.push({ path, body, atMs: Date.now() - startedAt });
        if (path === "/api/videos/tts-gemini") {
          return {
            voiceUrl: options.voiceUrl,
            audioDurationMs: options.durationMs,
            timing: options.timing === undefined ? defaultTiming : options.timing,
          } as T;
        }
        if (path === "/api/videos/transcribe") {
          transcribeCalls += 1;
          options.transcribeRetries?.push(opts?.retries);
          return await options.transcribe(transcribeCalls) as T;
        }
        if (path === "/api/videos/audio-duration") return { durationMs: options.durationMs } as T;
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [options.durationMs / 1_000] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ src: "stock.mp4" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 120, voiceFile: options.voiceUrl, bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") return { jobId: "gemini-base-render" } as T;
        throw new Error(`unexpected Gemini POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        options.calls.push({ path, atMs: Date.now() - startedAt });
        if (path.startsWith("/api/videos/render-progress")) {
          return { progress: 100, stage: "done", videoUrl: "/api/renders/gemini-base.mp4", error: null } as T;
        }
        throw new Error(`unexpected Gemini GET ${path}`);
      },
    },
  };
}

/** Exact word timings for a script whose tokens are separated by single spaces. */
function spokenWords(speech: string, durationMs: number): TimedWord[] {
  const tokens = speech.split(" ").filter(Boolean);
  const slot = Math.floor(durationMs / Math.max(1, tokens.length));
  return tokens.map((word, index) => ({
    word,
    startMs: index * slot + 20,
    endMs: (index + 1) * slot - 20,
  }));
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { claimNextRunnableJob } = await import("../src/lib/mcp/video-job");
  const { PipelineHttpError } = await import("../src/lib/mcp/pipeline-client");

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

  const createJob = async (input: Record<string, unknown>) => prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "processing",
      type: "create",
      inputJson: JSON.stringify(input),
    },
  });

  // ── A. Alignment fails (ASR text drift) → ship on the TTS clock, report a warning ──
  {
    const speech = "ลองระบบซับอีกครั้งวันนี้";
    const calls: Call[] = [];
    const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 3_000,
      voiceUrl: "/api/renders/drift-narration.wav",
      transcribe: async () => ({
        words: ["ข้อความ", "คนละ", "ชุด"].map((word, index) => ({
          word,
          startMs: 100 + index * 600,
          endMs: 500 + index * 600,
        })),
        audioDurationMs: 3_000,
        speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
      }),
    });
    await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `A: ASR text drift still delivers the clip (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "tts_segment_timing", "A: the provider's segment clock renders");
    check(output.subtitleQa?.status === "warning" && output.subtitleQa?.code === "unverified_alignment",
      `A: unverified timing is a warning (got ${output.subtitleQa?.status}/${output.subtitleQa?.code})`);
    check(verification.status === "failed" && typeof verification.code === "string" && verification.code.length > 0,
      `A: the failed verification is persisted with its code (got ${JSON.stringify(verification.status)}/${String(verification.code)})`);
    check(countCalls(calls, "/api/videos/transcribe") === 1, "A: exactly one transcribe call per create job");
    check(countCalls(calls, "/api/videos/tts-gemini") === 1, "A: an alignment verdict never regenerates the narration");
    check(
      JSON.stringify(verification.ttsCaptions)
        === JSON.stringify(renderedCaptions(output).map((caption) => ({ startMs: caption.startMs, endMs: caption.endMs }))),
      "A: the rendered cards are the provider-clock cards recorded as evidence",
    );
  }

  // ── B. Alignment exceeds its wall-clock budget → abandon it, render immediately ──
  {
    const previousBudget = process.env.SUBTITLE_VERIFY_BUDGET_MS;
    process.env.SUBTITLE_VERIFY_BUDGET_MS = "1000";
    try {
      const speech = "ระบบซับต้องไม่รอนาน";
      const calls: Call[] = [];
      const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
      const pipeline = geminiPipeline({
        calls,
        speech,
        durationMs: 3_000,
        voiceUrl: "/api/renders/slow-narration.wav",
        transcribe: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return {
            words: spokenWords(speech, 3_000),
            audioDurationMs: 3_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
          };
        },
      });
      await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
      const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
      const output = parseOutput(completed.outputJson);
      const verification = verificationOf(output);
      const renderAt = firstCallAt(calls, "/api/videos/render") ?? Number.POSITIVE_INFINITY;
      check(completed.status === "done", `B: a slow alignment still delivers the clip (got ${completed.status})`);
      check(verification.status === "timeout", `B: the abandoned alignment is recorded as a timeout (got ${String(verification.status)})`);
      check(output.subtitleQa?.timingSource === "tts_segment_timing", "B: the timed-out job renders on the TTS clock");
      check(renderAt < 3_000, `B: render starts on the alignment budget, not on the provider (render at ${renderAt}ms)`);
      check(renderAt >= 900, `B: the alignment budget is actually awaited (render at ${renderAt}ms)`);
      check(countCalls(calls, "/api/videos/transcribe") === 1, "B: a timeout never retries transcription");
      check(countCalls(calls, "/api/videos/tts-gemini") === 1, "B: a timeout never regenerates the narration");
    } finally {
      if (previousBudget === undefined) delete process.env.SUBTITLE_VERIFY_BUDGET_MS;
      else process.env.SUBTITLE_VERIFY_BUDGET_MS = previousBudget;
    }
  }

  // ── C. Alignment succeeds → its word timing becomes the render clock ──
  {
    const speech = "ประหยัดเงิน 5,000 บาท ทุกเดือน";
    const calls: Call[] = [];
    const transcribeRetries: Array<number | undefined> = [];
    const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 3_000,
      voiceUrl: "/api/renders/aligned-narration.wav",
      transcribeRetries,
      transcribe: async () => ({
        words: [
          { word: "ประหยัด", startMs: 100, endMs: 550 },
          { word: "เงิน", startMs: 550, endMs: 850 },
          { word: "5,000", startMs: 900, endMs: 1_300 },
          { word: "บาท", startMs: 1_350, endMs: 1_700 },
          { word: "ทุก", startMs: 1_750, endMs: 2_050 },
          { word: "เดือน", startMs: 2_050, endMs: 2_600 },
        ],
        audioDurationMs: 3_000,
        speechCoverage: { source: "silence_analysis", spokenEndMs: 2_600 },
      }),
    });
    await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `C: an aligned job completes (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "forced_alignment", "C: the acoustic clock becomes the render clock");
    check(output.subtitleQa?.status === "passed", `C: an aligned job passes subtitle QA (got ${output.subtitleQa?.status})`);
    check(verification.status === "aligned", `C: the verification records success (got ${String(verification.status)})`);
    check((verification.ttsCaptions?.length ?? 0) > 0, "C: the clock that was NOT rendered is kept for comparison");
    check(typeof verification.medianAbsStartDeltaMs === "number", "C: per-card start deltas are measured");
    check(typeof verification.durationMs === "number", "C: the verification duration is measured");
    check(
      !("capRes" in verification) && !("words" in verification) && !("speechCoverage" in verification),
      `C: only the evidence half of the attempt is persisted (keys: ${Object.keys(verification).join(",")})`,
    );
    check(countCalls(calls, "/api/videos/transcribe") === 1, "C: alignment costs exactly one transcribe call");
    check(transcribeRetries.length === 1 && transcribeRetries.every((retries) => retries === 0),
      "C: the alignment call carries no hidden HTTP retries");
    check(output.preview?.fullText === speech, "C: captions keep the immutable Narration Master text");
  }

  // ── D. No provider timing AND no alignment → the spoken-script clock still ships ──
  {
    const speech = "ทำคอนเทนต์ให้ต่อเนื่องทุกสัปดาห์";
    const calls: Call[] = [];
    const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 4_000,
      voiceUrl: "/api/renders/no-timing-narration.wav",
      timing: null,
      transcribe: async () => {
        throw new PipelineHttpError("POST", "/api/videos/transcribe", 503, {
          error: "บริการถอดซับไม่พร้อมชั่วคราว",
          reason: "transcribe_request_failed",
          provider: "gemini",
        });
      },
    });
    await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `D: a missing provider clock still delivers the clip (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "avatar_script_clock", `D: the spoken-script clock renders (got ${output.subtitleQa?.timingSource})`);
    check(output.subtitleQa?.status === "warning", `D: the degraded clock is a warning (got ${output.subtitleQa?.status})`);
    check(verification.status === "failed" && verification.code === "transcribe_request_failed",
      `D: the transport failure is recorded verbatim (got ${String(verification.code)})`);
    check(renderedCaptions(output).length > 0, "D: the clip still has captions to show");
    check(countCalls(calls, "/api/videos/transcribe") === 1, "D: a failed alignment is never retried");
    check(countCalls(calls, "/api/videos/tts-gemini") === 1, "D: a failed alignment never regenerates the narration");
  }

  // ── E. ElevenLabs keeps its native alignment and never calls ASR ──
  {
    const elevenScript = "เก็บเงิน\n5,000​บาท ทุกเดือน.....";
    const elevenSpeechScript = "เก็บเงิน 5,000 บาท ทุกเดือน...";
    const characters = Array.from(elevenSpeechScript);
    const elevenDurationMs = characters.length * 120;
    const calls: Call[] = [];
    const elevenTtsTexts: string[] = [];
    const job = await createJob({
      script: elevenScript,
      previewMode: true,
      voiceProvider: "elevenlabs",
      voiceId: "eleven-qa",
    });
    await runOrchestrator(job.id, user.id, {
      caller: {
        post: async <T,>(path: string, body?: unknown): Promise<T> => {
          calls.push({ path, body, atMs: 0 });
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
          if (path === "/api/videos/transcribe") throw new Error("ElevenLabs native alignment must bypass transcribe");
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
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    check(completed.status === "done", "E: ElevenLabs native timestamps complete the real preview pipeline");
    check(elevenTtsTexts.every((text) => text === elevenSpeechScript), "E: ElevenLabs receives only persisted NarrationPlan speechText");
    check(countCalls(calls, "/api/videos/transcribe") === 0, "E: ElevenLabs native timestamps bypass ASR");
    check(output.subtitleQa?.status === "passed", "E: ElevenLabs subtitle QA passes");
    check(output.subtitleQa?.timingSource === "provider_alignment", "E: ElevenLabs persists provider-alignment evidence");
    check(verificationOf(output).status === "skipped", `E: ElevenLabs records a skipped verification (got ${String(verificationOf(output).status)})`);
    const storedElevenInput = JSON.parse(completed.inputJson) as {
      script?: string;
      narrationPlan?: { sourceText?: string; speechText?: string };
    };
    check(storedElevenInput.script === elevenScript, "E: legacy/background input keeps the exact authored script");
    check(storedElevenInput.narrationPlan?.speechText === elevenSpeechScript, "E: worker persists a missing NarrationPlan before provider spend");
  }

  // ── Export fixtures (F–H): Export never re-aligns and never refuses a text edit ──
  const exportScript = "รายได้ 5,000 บาท";
  const exportSource = await prisma.videoJob.create({
    data: {
      userId: user.id,
      status: "done",
      type: "create",
      inputJson: JSON.stringify({ script: exportScript, previewMode: true, voiceProvider: "gemini" }),
      outputJson: JSON.stringify({
        version: 2,
        mode: "preview",
        videoUrl: "/renders/export-source.mp4",
        // No subtitleQa at all — the shape of a preview rendered before subtitle QA existed.
        preview: {
          captions: [{ text: exportScript, startMs: 0, endMs: 3_000, tag: "hook" }],
          fullText: exportScript,
          config: { durationInFrames: 90 },
          voiceUrl: "/api/renders/export-source.wav",
          audioDurationMs: 3_000,
          avatarModel: "none",
          avatarVideoUrl: null,
        },
      }),
      progress: 100,
      finishedAt: new Date(),
    },
  });

  const exportPipeline = (calls: Call[]) => ({
    post: async <T,>(path: string, body?: unknown): Promise<T> => {
      calls.push({ path, body, atMs: 0 });
      if (path === "/api/videos/render") return { jobId: "export-burn" } as T;
      if (path === "/api/videos") return { id: "export-gallery" } as T;
      if (path === "/api/videos/transcribe") throw new Error("export must never re-align");
      throw new Error(`unexpected export POST ${path}`);
    },
    patch: async <T,>(): Promise<T> => ({} as T),
    get: async <T,>(): Promise<T> => ({
      progress: 100,
      stage: "done",
      videoUrl: "/renders/export-final.mp4",
      error: null,
    } as T),
  });

  // F. A legacy preview with no QA evidence exports untouched.
  {
    const calls: Call[] = [];
    const submittedPopups = [{ text: exportScript, start: 0, end: 90 }];
    const job = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "processing",
        type: "export",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: exportSource.id,
          subtitleOverlayConfig: {
            videoUrl: "/renders/export-source.mp4",
            durationInFrames: 90,
            keywordPopups: submittedPopups,
          },
        }),
      },
    });
    await runOrchestrator(job.id, user.id, { caller: exportPipeline(calls), refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const burn = calls.find((call) => call.path === "/api/videos/render")?.body as
      { subtitleOverlayConfig?: { keywordPopups?: unknown } } | undefined;
    check(completed.status === "done", `F: a legacy preview without subtitle QA exports (got ${completed.status}: ${completed.errorMessage ?? ""})`);
    check(countCalls(calls, "/api/videos/transcribe") === 0, "F: export performs zero transcribe calls");
    check(
      JSON.stringify(burn?.subtitleOverlayConfig?.keywordPopups) === JSON.stringify(submittedPopups),
      "F: export burns exactly the submitted subtitle track",
    );
  }

  // G. An edited caption is the creator's decision, not a refusal.
  {
    const calls: Call[] = [];
    const job = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "processing",
        type: "export",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: exportSource.id,
          subtitleOverlayConfig: {
            videoUrl: "/renders/export-source.mp4",
            durationInFrames: 90,
            keywordPopups: [{ text: "รายได้ 500 บาท", start: 0, end: 90 }],
          },
        }),
      },
    });
    await runOrchestrator(job.id, user.id, { caller: exportPipeline(calls), refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    check(completed.status === "done", `G: an edited caption still exports (got ${completed.status})`);
    check(output.subtitleQa?.status === "warning" && output.subtitleQa?.code === "text_mismatch",
      `G: the text edit is reported as a warning (got ${output.subtitleQa?.status}/${output.subtitleQa?.code})`);
    check(countCalls(calls, "/api/videos/render") === 1, "G: an edited caption performs exactly one Burn");
  }

  // H. A blank card is dropped, never refused.
  {
    const calls: Call[] = [];
    const job = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "processing",
        type: "export",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: exportSource.id,
          subtitleOverlayConfig: {
            videoUrl: "/renders/export-source.mp4",
            durationInFrames: 108,
            keywordPopups: [
              { text: exportScript, start: 0, end: 90 },
              { text: "", start: 90, end: 108 },
            ],
          },
          editSnapshot: {
            version: 1,
            captions: [
              { text: exportScript, startMs: 0, endMs: 3_000, tag: "hook" },
              { text: "   ", startMs: 3_000, endMs: 3_600, tag: "body" },
            ],
          },
        }),
      },
    });
    await runOrchestrator(job.id, user.id, { caller: exportPipeline(calls), refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    check(completed.status === "done", `H: a blank card still exports (got ${completed.status}: ${completed.errorMessage ?? ""})`);
    check(output.subtitleEvidence?.captions?.length === 1, `H: the blank card is dropped (kept ${output.subtitleEvidence?.captions?.length})`);
    check(output.subtitleQa?.code !== "empty_caption", "H: a blank card is never reported as a blocking finding");
    check(countCalls(calls, "/api/videos/render") === 1, "H: a blank card performs exactly one Burn");
    check(
      output.subtitleEvidence?.overlayRetimed === true,
      `H: the burned track and the reported captions agree (overlayRetimed=${String(output.subtitleEvidence?.overlayRetimed)})`,
    );
    check(
      output.subtitleEvidence?.verification?.status === "skipped"
        && output.subtitleEvidence?.verification?.durationMs === 0,
      "H: an export row says for itself that no alignment happened",
    );
  }

  // H2. The popup-derived route (no editSnapshot) must not burn an empty card either.
  {
    const calls: Call[] = [];
    const job = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "processing",
        type: "export",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: exportSource.id,
          subtitleOverlayConfig: {
            videoUrl: "/renders/export-source.mp4",
            durationInFrames: 108,
            keywordPopups: [
              { text: exportScript, start: 0, end: 90, color: "#fff" },
              { text: "   ", start: 90, end: 108, color: "#fff" },
            ],
          },
        }),
      },
    });
    await runOrchestrator(job.id, user.id, { caller: exportPipeline(calls), refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const burn = calls.find((call) => call.path === "/api/videos/render")?.body as
      { subtitleOverlayConfig?: { keywordPopups?: Array<{ text?: string }> } } | undefined;
    const burnedPopups = burn?.subtitleOverlayConfig?.keywordPopups ?? [];
    check(completed.status === "done", `H2: an empty popup without an edit snapshot still exports (got ${completed.status})`);
    check(
      burnedPopups.length === 1 && burnedPopups[0]?.text === exportScript,
      `H2: the empty popup is never burned (burned ${JSON.stringify(burnedPopups.map((popup) => popup?.text))})`,
    );
    check(countCalls(calls, "/api/videos/render") === 1, "H2: an empty popup performs exactly one Burn");
  }

  // H3. When the overlay cannot be re-projected onto the repaired cards the burn keeps the
  // submitted card times while the report describes the repaired ones — record the divergence.
  {
    const calls: Call[] = [];
    const job = await prisma.videoJob.create({
      data: {
        userId: user.id,
        status: "processing",
        type: "export",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: exportSource.id,
          subtitleOverlayConfig: {
            videoUrl: "/renders/export-source.mp4",
            durationInFrames: 120,
            keywordPopups: [{ text: exportScript, start: 0, end: 120 }],
          },
          editSnapshot: {
            version: 1,
            captions: [
              { text: "รายได้", startMs: 0, endMs: 3_000, tag: "hook" },
              { text: " 5,000 บาท", startMs: 3_000, endMs: 4_000, tag: "body" },
            ],
          },
        }),
      },
    });
    await runOrchestrator(job.id, user.id, { caller: exportPipeline(calls), refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    check(completed.status === "done", `H3: an unprojectable overlay still exports (got ${completed.status})`);
    check(
      output.subtitleEvidence?.overlayRetimed === false,
      `H3: the burn/report divergence is recorded (overlayRetimed=${String(output.subtitleEvidence?.overlayRetimed)})`,
    );
    check(
      (output.subtitleEvidence?.captions?.at(-1)?.endMs ?? 0) <= 3_000,
      "H3: the reported captions are the repaired ones",
    );
  }

  // ── I. A numeric ASR disagreement reports, it never buys another narration ──
  {
    const speech = "ในปี 2026 ประหยัดเงิน 5,000 บาท...";
    const authored = "ในปี\n2026​ประหยัดเงิน 5,000 บาท.....";
    const calls: Call[] = [];
    const ttsTexts: string[] = [];
    const job = await createJob({ script: authored, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 4_000,
      voiceUrl: "/api/renders/numeric-narration.wav",
      transcribe: async () => ({
        words: ["ใน", "ปี", "สอง", "พัน", "ยี่สิบ", "ห้า", "ประหยัด", "เงิน", "ห้า", "พัน", "บาท"].map((word, index) => ({
          word,
          startMs: 100 + index * 330,
          endMs: 390 + index * 330,
        })),
        audioDurationMs: 4_000,
        speechCoverage: { source: "silence_analysis", spokenEndMs: 3_900 },
      }),
    });
    const trackedCaller = {
      ...pipeline.caller,
      post: async <T,>(path: string, body?: unknown, opts?: { retries?: number }): Promise<T> => {
        if (path === "/api/videos/tts-gemini") ttsTexts.push((body as { text?: string } | undefined)?.text ?? "");
        return pipeline.caller.post<T>(path, body, opts);
      },
    };
    await runOrchestrator(job.id, user.id, { caller: trackedCaller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `I: a numeric ASR disagreement still delivers the clip (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "tts_segment_timing", "I: the numeric disagreement renders on the TTS clock");
    check(output.subtitleQa?.status === "warning", `I: the numeric disagreement is a warning (got ${output.subtitleQa?.status})`);
    check(verification.code === "numeric_claim_mismatch", `I: the alignment verdict is kept as evidence (got ${String(verification.code)})`);
    check(countCalls(calls, "/api/videos/tts-gemini") === 1, "I: an alignment verdict never buys a second narration");
    check(countCalls(calls, "/api/videos/transcribe") === 1, "I: an alignment verdict never buys a second transcription");
    check(ttsTexts.every((text) => text === speech), "I: Gemini receives only persisted NarrationPlan speechText");
    check(output.preview?.fullText === speech, "I: captions keep the deterministic NarrationPlan display text");
  }

  // ── J. An avatar job on the spoken-script clock survives the provider wait ──
  // Production hazard: the checkpoint is re-parsed on resume, AFTER HeyGen has already been
  // paid for. A timing source the parser rejects would fail the job with the avatar spend
  // already made, so rung 3 must round-trip and the resume must not re-align.
  {
    const speech = "พรีเซนต์งานให้ปังในสามสิบวินาที";
    const calls: Call[] = [];
    const job = await createJob({
      script: speech,
      previewMode: true,
      voiceProvider: "gemini",
      avatarMode: "full",
      avatarId: "qa-avatar",
    });
    const avatarCaller = {
      post: async <T,>(path: string, body?: unknown): Promise<T> => {
        calls.push({ path, body, atMs: 0 });
        if (path === "/api/videos/tts-gemini") {
          // tts-gemini fail-open: audio, no timing at all → rung 3.
          return { voiceUrl: "/api/renders/avatar-no-timing.wav", audioDurationMs: 4_000 } as T;
        }
        if (path === "/api/videos/transcribe") {
          throw new PipelineHttpError("POST", path, 503, {
            error: "บริการถอดซับไม่พร้อมชั่วคราว",
            reason: "transcribe_request_failed",
            provider: "gemini",
          });
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["present"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ src: "stock.mp4" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 120, voiceFile: "/api/renders/avatar-no-timing.wav", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") return { jobId: "avatar-base-render" } as T;
        if (path === "/api/videos/trim-audio") return { audioUrl: "/api/renders/avatar-intro.wav" } as T;
        if (path === "/api/heygen/generate-with-bg") return { videoId: "qa-heygen-video" } as T;
        if (path === "/api/videos/poll-avatar") {
          return { status: "completed", videoUrl: "https://avatar.example/qa.mp4", thumbnailUrl: null, errorMsg: null } as T;
        }
        if (path === "/api/heygen/composite") {
          return { videoUrl: "/api/renders/avatar-composite.mp4", usedMode: "chromakey" } as T;
        }
        throw new Error(`unexpected avatar POST ${path}`);
      },
      patch: async <T,>(): Promise<T> => ({} as T),
      get: async <T,>(path: string): Promise<T> => {
        calls.push({ path, atMs: 0 });
        if (path.startsWith("/api/videos/render-progress")) {
          return { progress: 100, stage: "done", videoUrl: "/api/renders/avatar-base.mp4", error: null } as T;
        }
        throw new Error(`unexpected avatar GET ${path}`);
      },
    };
    await runOrchestrator(job.id, user.id, { caller: avatarCaller, refundOneClip: async () => {}, sleep: async () => {} });
    const parked = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    check(parked.status === "waiting_provider", `J: the avatar job parks at its provider checkpoint (got ${parked.status})`);
    const transcribeBeforeResume = countCalls(calls, "/api/videos/transcribe");

    const claimed = await claimNextRunnableJob(new Date(Date.now() + 3 * 60 * 60_000));
    check(claimed?.id === job.id, "J: the parked avatar job is claimable again after the provider wait");
    await runOrchestrator(job.id, user.id, { caller: avatarCaller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    check(
      completed.status === "done",
      `J: the resumed script-clock avatar job completes (got ${completed.status}: ${completed.errorMessage ?? ""})`,
    );
    check(
      output.subtitleQa?.timingSource === "avatar_script_clock"
        && output.subtitleEvidence?.timingSource === "avatar_script_clock",
      `J: the spoken-script clock round-trips through the avatar checkpoint (got ${output.subtitleQa?.timingSource})`,
    );
    check(verificationOf(output).status === "failed", `J: the resumed job replays the checkpointed verification (got ${String(verificationOf(output).status)})`);
    check(
      countCalls(calls, "/api/videos/transcribe") === transcribeBeforeResume,
      "J: resuming an avatar job never re-runs the acoustic alignment",
    );
  }

  // ── K. The transcribe route reports a drifted transcript instead of refusing it ──
  // Since ADR 0056 the route answers 200 with a `transcribe_desynced` warning where it used
  // to answer 422. The 422 was what kept a drifted ASR clock off the render; that verdict now
  // lives here. Failing the alignment is NOT a refusal — the provider clock renders — and the
  // route's own findings are persisted as evidence.
  {
    const speech = "ทดสอบซับที่ไม่ตรงจังหวะ";
    const calls: Call[] = [];
    const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 3_000,
      voiceUrl: "/api/renders/desynced-narration.wav",
      // Text-perfect words that WOULD align — only the route's verdict may stop them.
      transcribe: async () => ({
        words: spokenWords(speech, 3_000),
        audioDurationMs: 3_000,
        speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
        warnings: [{ code: "transcribe_desynced", fromMs: 3_000, toMs: 3_900 }],
      }),
    });
    await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `K: a desynced-transcript warning still delivers the clip (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "tts_segment_timing",
      `K: the drifted ASR clock never becomes the render clock (got ${output.subtitleQa?.timingSource})`);
    check(verification.status === "failed", `K: the alignment is recorded as failed (got ${String(verification.status)})`);
    check(verification.code === "transcribe_desynced",
      `K: the route's own verdict is the recorded code (got ${String(verification.code)})`);
    check(verification.routeWarnings?.length === 1 && verification.routeWarnings[0]?.code === "transcribe_desynced",
      `K: every route warning is persisted as evidence (got ${JSON.stringify(verification.routeWarnings)})`);
    check(countCalls(calls, "/api/videos/transcribe") === 1, "K: the route verdict never buys a second transcribe call");
    check(countCalls(calls, "/api/videos/tts-gemini") === 1, "K: the route verdict never regenerates the narration");
  }

  // ── L. A partial-tail warning is evidence only — it may still promote the clock ──
  // `transcribe_incomplete` means the tail was not covered; speechCoverage already carries
  // that, and the words that WERE returned are real. Refusing them would be the gate ADR 0056
  // removed, so the alignment proceeds and the warning rides along as evidence.
  {
    const speech = "ซับส่วนใหญ่ตรงเสียงอยู่แล้ว";
    const calls: Call[] = [];
    const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 3_000,
      voiceUrl: "/api/renders/partial-tail-narration.wav",
      transcribe: async () => ({
        words: spokenWords(speech, 3_000),
        audioDurationMs: 3_000,
        speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
        warnings: [{ code: "transcribe_incomplete", fromMs: 2_400, toMs: 2_800 }],
      }),
    });
    await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `L: a partial-tail warning still delivers the clip (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "forced_alignment",
      `L: transcribe_incomplete does not disqualify the acoustic clock (got ${output.subtitleQa?.timingSource})`);
    check(verification.status === "aligned", `L: the alignment is recorded as aligned (got ${String(verification.status)})`);
    check(verification.routeWarnings?.[0]?.code === "transcribe_incomplete",
      `L: the warning still rides along as evidence (got ${JSON.stringify(verification.routeWarnings)})`);
    check(countCalls(calls, "/api/videos/transcribe") === 1, "L: exactly one transcribe call");
  }

  // ── M. No word clock at all (word_timing_incomplete) fails naturally ──
  {
    const speech = "ไม่มีเวลาแต่ละคำให้ใช้";
    const calls: Call[] = [];
    const job = await createJob({ script: speech, previewMode: true, voiceProvider: "gemini" });
    const pipeline = geminiPipeline({
      calls,
      speech,
      durationMs: 3_000,
      voiceUrl: "/api/renders/no-word-clock.wav",
      transcribe: async () => ({
        words: [],
        audioDurationMs: 3_000,
        speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
        warnings: [{ code: "word_timing_incomplete" }],
      }),
    });
    await runOrchestrator(job.id, user.id, { caller: pipeline.caller, refundOneClip: async () => {}, sleep: async () => {} });
    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    const output = parseOutput(completed.outputJson);
    const verification = verificationOf(output);
    check(completed.status === "done", `M: an empty word clock still delivers the clip (got ${completed.status})`);
    check(output.subtitleQa?.timingSource === "tts_segment_timing",
      `M: an empty word clock renders on the provider clock (got ${output.subtitleQa?.timingSource})`);
    check(verification.status === "failed" && verification.code === "word_timing_incomplete",
      `M: the empty word clock is recorded by name (got ${String(verification.status)}/${String(verification.code)})`);
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

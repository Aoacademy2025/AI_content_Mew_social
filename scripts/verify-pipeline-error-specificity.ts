/**
 * TDD for Task 5 (subtitle-shadow-mode-hotfix): specific failure codes end-to-end
 * (route error envelope → PipelineApiError → orchestrator failJob → API `detail`) +
 * `captions` step telemetry. Five cases, matching the task brief verbatim:
 *
 *  1. STEP_TELEMETRY_NAME maps "captions" → "captions" (no longer skipped) —
 *     the captions step now emits pipeline_step_done with a numeric durationMs.
 *  2. A route error envelope `{ error: { code, message } }` thrown by decodePipelineResponse
 *     (the function `caller.post` uses under the hood) surfaces as PipelineApiError
 *     { code, message, status }.
 *  3. pollRender with p.stage === "error" throws PipelineApiError { code: "render_worker_failed" }.
 *  4. failJob mapping: an Error without a code at step "render" stores errorCode "render_unknown"
 *     and a specific Thai errorMessage — never the bare generic fallback.
 *  5. api-error friendlyMessage(err) returns { message, detail } and the JSON envelope
 *     built by apiError() includes `detail`.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pipeline-error-specificity-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const SCRIPT_TEXT = "ทดสอบข้อผิดพลาดเฉพาะจุด";

/** A happy-path fake caller mirroring scripts/verify-mcp-release-gates.ts, driving a full
 *  create job through tts → captions(transcribe) → keywords → stock → config → render(x2) →
 *  save. `failRenderWith`, when set, makes the FIRST /api/videos/render POST throw a plain
 *  (uncoded) Error instead of succeeding — used by case 4 to reach the "render" phase with
 *  an unknown error. */
function buildHappyCaller(
  prismaMod: typeof import("../src/lib/prisma"),
  userId: string,
  jobId: string,
  opts: { failRenderWith?: Error } = {},
) {
  const { prisma } = prismaMod;
  let renderCount = 0;
  return {
    post: async (path: string, body?: unknown) => {
      const key = path.split("?")[0];
      if (key === "/api/videos/transcribe") {
        return {
          captions: [{ text: SCRIPT_TEXT, startMs: 120, endMs: 2_800 }],
          words: [{ word: SCRIPT_TEXT, startMs: 120, endMs: 2_800 }],
          audioDurationMs: 3_000,
          speechCoverage: { source: "silence_analysis", spokenEndMs: 2_800 },
        } as never;
      }
      if (key === "/api/videos/render") {
        if (opts.failRenderWith) throw opts.failRenderWith;
        renderCount += 1;
        const type = renderCount === 1 ? "RENDER" : "BURN";
        const renderId = `pes-${jobId}-${type.toLowerCase()}`;
        await prisma.renderJob.create({
          data: {
            id: renderId,
            userId,
            parentJobId: jobId,
            type,
            status: "DONE",
            payload: JSON.stringify(body ?? {}),
            videoUrl: `/api/renders/${renderId}.mp4`,
            reservedQuota: type === "RENDER",
            reservedMinutes: type === "RENDER" ? 1 : null,
          },
        });
        return { jobId: renderId } as never;
      }
      const responses: Record<string, unknown> = {
        "/api/videos/tts-gemini": {
          voiceUrl: `/api/renders/${jobId}.wav`,
          audioDurationMs: 3000,
          timing: {
            provider: "gemini",
            segments: [{ text: SCRIPT_TEXT, startMs: 0, durationMs: 3000 }],
            chars: null,
          },
        },
        "/api/videos/extract-keywords": { keywords: ["test"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [3] },
        "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
        "/api/videos/generate-config": { config: { durationInFrames: 90, voiceFile: `/api/renders/${jobId}.wav`, bgVideos: [] } },
        "/api/videos": { id: `${jobId}-video` },
      };
      return (responses[key] ?? {}) as never;
    },
    patch: async () => ({} as never),
    get: async (path: string) => {
      const id = new URL(path, "http://local").searchParams.get("jobId");
      return { progress: 100, stage: "done", videoUrl: `/api/renders/${id}.mp4`, error: null } as never;
    },
  };
}

async function main() {
  // ---- Case 2: coded route error envelope thrown by the shared caller.post decode path ----
  {
    const { decodePipelineResponse, PipelineApiError } = await import("../src/lib/mcp/pipeline-client");
    let thrown: unknown;
    try {
      decodePipelineResponse(
        "POST",
        "/api/videos/render",
        503,
        JSON.stringify({ error: { code: "render_maintenance", message: "ระบบเรนเดอร์ปิดปรับปรุงชั่วคราว" } }),
      );
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof PipelineApiError, "a coded envelope must throw PipelineApiError");
    const err = thrown as InstanceType<typeof PipelineApiError>;
    assert.equal(err.code, "render_maintenance");
    assert.equal(err.message, "ระบบเรนเดอร์ปิดปรับปรุงชั่วคราว");
    assert.equal(err.status, 503);
    // Backward compatibility: PipelineApiError must still satisfy every existing
    // `instanceof PipelineHttpError` / `.name === "PipelineHttpError"` call site
    // (avatar-steps.ts, hero-image-pipeline-retry.ts, pipelineFailureDetails).
    const { PipelineHttpError, pipelineFailureDetails } = await import("../src/lib/mcp/pipeline-client");
    assert.ok(err instanceof PipelineHttpError, "PipelineApiError must remain instanceof PipelineHttpError");
    assert.equal(err.name, "PipelineHttpError", "PipelineApiError must keep .name === \"PipelineHttpError\"");
    assert.deepEqual(pipelineFailureDetails(err), { message: "ระบบเรนเดอร์ปิดปรับปรุงชั่วคราว", code: "render_maintenance" });
    console.log("✓ case 2: coded envelope → PipelineApiError{code,message,status}, still instanceof PipelineHttpError");
  }

  // A body with NO code must still throw the plain PipelineHttpError — zero behavior
  // change for the vast majority of existing routes/tests that never set one.
  {
    const { decodePipelineResponse, PipelineHttpError, PipelineApiError } = await import("../src/lib/mcp/pipeline-client");
    let thrown: unknown;
    try {
      decodePipelineResponse("POST", "/api/videos/tts-gemini", 500, JSON.stringify({ error: "boom" }));
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof PipelineHttpError, "uncoded body must still throw PipelineHttpError");
    assert.ok(!(thrown instanceof PipelineApiError), "uncoded body must NOT be promoted to PipelineApiError");
    console.log("✓ case 2b: uncoded envelope keeps throwing plain PipelineHttpError (no behavior change)");
  }

  // ---- Case 3: pollRender surfaces PipelineApiError on a logical stage=error response ----
  {
    const { pollRender, PipelineApiError } = await import("../src/lib/mcp/pipeline-client");
    const caller = {
      post: async () => { throw new Error("unused in this case"); },
      patch: async () => ({} as never),
      get: async () =>
        ({
          progress: -1,
          videoUrl: null,
          error: "Cannot find module '@remotion/bundler'",
          stage: "error",
        }) as never,
    };
    let thrown: unknown;
    try {
      await pollRender(caller as never, "render-job-1", undefined, { sleep: async () => {} });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof PipelineApiError, "stage=error must throw PipelineApiError");
    const err = thrown as InstanceType<typeof PipelineApiError>;
    assert.equal(err.code, "render_worker_failed");
    assert.equal(err.message, "render failed: Cannot find module '@remotion/bundler'");
    console.log("✓ case 3: pollRender stage=error → PipelineApiError(render_worker_failed)");
  }

  // ---- Case 5: api-error friendlyMessage {message, detail} + envelope carries detail ----
  {
    const { friendlyMessage, apiError } = await import("../src/lib/api-error");
    const secretLeak = "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7";
    const original = new Error(`Prisma P2002: unique constraint failed key=${secretLeak}`);
    const friendly = friendlyMessage(original);
    assert.equal(friendly.message, "เกิดข้อผิดพลาดในฐานข้อมูล กรุณาลองใหม่");
    assert.ok(friendly.detail.length <= 300, "detail must be capped at 300 chars");
    assert.ok(!friendly.detail.includes(secretLeak), "detail must be scrubbed of secrets");
    assert.ok(friendly.detail.includes("<redacted>"), "scrubSecrets must have redacted the key");

    const res = apiError({ route: "test/route", error: original, status: 500 });
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, friendly.message);
    assert.equal(body.detail, friendly.detail);
    console.log("✓ case 5: friendlyMessage returns {message, detail}; apiError() envelope carries detail");
  }

  // ---- Case 1 + Case 4 need a real orchestrator run ----
  const prismaMod = await import("../src/lib/prisma");
  const { prisma } = prismaMod;
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");

  async function makeUser(id: string) {
    return prisma.user.create({
      data: {
        id,
        name: "Pipeline Error Specificity",
        email: `${id}@example.com`,
        plan: "PRO",
        geminiKey: "g",
        pexelsKey: "p",
        minutesUsed: 1,
        minutesLimit: 80,
        usagePeriodStartedAt: new Date(),
      },
    });
  }

  // Case 1: STEP_TELEMETRY_NAME.captions now emits pipeline_step_done with a durationMs.
  {
    const user = await makeUser("pes-user-1");
    const jobId = "pes-job-1";
    const job = await prisma.videoJob.create({
      data: { id: jobId, userId: user.id, status: "processing", inputJson: JSON.stringify({ script: SCRIPT_TEXT, voiceProvider: "gemini" }) },
    });
    const events: Array<{ name: string; step?: string | null; status?: string | null; durationMs?: number | null }> = [];
    const caller = buildHappyCaller(prismaMod, user.id, jobId);

    await runOrchestrator(job.id, user.id, {
      caller: caller as never,
      sleep: async () => {},
      recordTelemetryEvent: async (_userId, input) => {
        events.push(input);
        return null;
      },
    });

    const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(completed.status, "done", "the happy-path job must still complete");
    const captionsDone = events.find((e) => e.name === "pipeline_step_done" && e.step === "captions");
    assert.ok(captionsDone, "captions step must now emit pipeline_step_done (was silently skipped before)");
    assert.equal(typeof captionsDone?.durationMs, "number", "pipeline_step_done must carry a numeric durationMs");
    assert.ok((captionsDone?.durationMs ?? -1) >= 0);
    console.log("✓ case 1: STEP_TELEMETRY_NAME.captions emits pipeline_step_done{durationMs}");
  }

  // Case 4: an unknown (uncoded) Error thrown at the "render" phase stores a specific
  // errorCode + Thai-prefixed errorMessage — never the bare generic fallback.
  {
    const user = await makeUser("pes-user-2");
    const jobId = "pes-job-2";
    const job = await prisma.videoJob.create({
      data: { id: jobId, userId: user.id, status: "processing", inputJson: JSON.stringify({ script: SCRIPT_TEXT, voiceProvider: "gemini" }) },
    });
    const renderFailure = new Error("boom: bundler dependency missing on this host");
    const caller = buildHappyCaller(prismaMod, user.id, jobId, { failRenderWith: renderFailure });

    await runOrchestrator(job.id, user.id, { caller: caller as never, sleep: async () => {} });

    const failed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "render_unknown");
    assert.ok(
      failed.errorMessage?.startsWith("เรนเดอร์ไม่สำเร็จ (render_unknown): "),
      `errorMessage must use the render step's Thai prefix + code, got: ${failed.errorMessage}`,
    );
    assert.ok(failed.errorMessage?.includes("boom: bundler dependency missing on this host"));
    assert.notEqual(
      failed.errorMessage,
      "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
      "must never be the bare generic Thai fallback with no code",
    );
    console.log("✓ case 4: unknown render-step error → errorCode=render_unknown, specific Thai errorMessage");
  }

  await prisma.$disconnect();
  console.log("\n✅ verify-pipeline-error-specificity PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

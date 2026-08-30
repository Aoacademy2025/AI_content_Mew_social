/**
 * TDD for Task 5 (subtitle-shadow-mode-hotfix): specific failure codes end-to-end
 * (route error envelope → PipelineApiError → orchestrator failJob → API `detail`) +
 * `captions` step telemetry. Review round 1 (R31/R30/R32) folded in: customer copy is
 * never re-wrapped, `detail` never reaches the public JSON envelope, and the secret
 * scrubber covers a wider set of key/token shapes.
 *
 *  1. STEP_TELEMETRY_NAME maps "captions" → "captions" (no longer skipped) —
 *     the captions step now emits pipeline_step_done with a numeric durationMs.
 *  2. A route error envelope `{ error: { code, message } }` thrown by decodePipelineResponse
 *     (the function `caller.post` uses under the hood) surfaces as PipelineApiError
 *     { code, message, status }.
 *  2i. The REAL quota envelope shape from src/app/api/videos/render/route.ts's
 *      quotaExceededResponse (`{ error: {code,provider,message,...}, detail }`) round-trips
 *      through the orchestrator's failJob mapping VERBATIM (R31) — never re-wrapped with a
 *      "<prefix> (<code>): ..." stutter — with `code` stored separately as `quota_exceeded`.
 *  2ii. classifyUnknownStepFailure (R31 unit-level): a plain Error whose message already
 *       contains Thai characters — e.g. the orchestrator's own internal captions-phase
 *       throw — is stored VERBATIM with `${phase}_unknown`, never re-wrapped either.
 *  3. pollRender with p.stage === "error" throws PipelineApiError { code: "render_worker_failed" }.
 *  3iii. (== case 4 below) a plain, non-Thai Error without a code at step "render" DOES get
 *        the "<prefix> (<code>): <cause>" wrapping — the prefix form is for genuinely
 *        internal/technical causes only.
 *  4. failJob mapping: an Error without a code at step "render" stores errorCode "render_unknown"
 *     and a specific Thai errorMessage — never the bare generic fallback.
 *  5. api-error friendlyMessage(err) returns { message, detail }; `detail` is scrubbed+capped
 *     but (R30) NEVER reaches the public JSON envelope returned by apiError() — it stays
 *     admin/log-only.
 *  6. scrub-secrets: the R30-widened pattern set (Stripe sk_/rk_/whsec_, OpenAI sk-proj-,
 *     RunPod rpa_, header-style xi-api-key/x-api-key/authorization, /var/www/ paths).
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
 *  save. `failRenderWith`, when set, makes the FIRST /api/videos/render POST throw instead
 *  of succeeding — used by cases 2i/4 to reach the "render" phase with a specific error. */
function buildHappyCaller(
  prismaMod: typeof import("../src/lib/prisma"),
  userId: string,
  jobId: string,
  opts: { failRenderWith?: unknown } = {},
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

  // ---- Case 5: api-error friendlyMessage {message, detail}; detail is admin/log-only (R30) ----
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
    const body = (await res.json()) as { error: string; detail?: string };
    assert.equal(body.error, friendly.message);
    assert.equal(body.detail, undefined, "R30: detail must NEVER reach the public JSON envelope");
    assert.ok(!("detail" in body), "R30: the envelope must not even carry a detail key");
    console.log("✓ case 5: friendlyMessage returns {message, detail}; apiError() envelope carries NO detail (R30)");
  }

  // ---- Case 6: R30 widened scrub-secrets patterns (pure, no DB) ----
  {
    const { scrubSecrets } = await import("../src/lib/scrub-secrets");
    const cases: Array<{ name: string; input: string; mustNotContain: string; mustContain?: string }> = [
      { name: "Stripe live secret key", input: "key=sk_" + "live_51H8x9ZQ1abcdEFGH", mustNotContain: "sk_" + "live_51H8x9ZQ1abcdEFGH" },
      { name: "Stripe test secret key", input: "using sk_" + "test_4eC39HqLyjWDarjtT1zdp7dc", mustNotContain: "sk_" + "test_4eC39HqLyjWDarjtT1zdp7dc" },
      { name: "Stripe restricted key", input: "rk_" + "live_51H8x9ZQ1abcdEFGH", mustNotContain: "rk_" + "live_51H8x9ZQ1abcdEFGH" },
      { name: "Stripe webhook secret", input: "whsec" + "_abcdEFGH12345678", mustNotContain: "whsec" + "_abcdEFGH12345678" },
      { name: "OpenAI project key", input: "sk-proj-abcdEFGH12345678_xyz", mustNotContain: "sk-proj-abcdEFGH12345678_xyz" },
      { name: "RunPod token", input: "rpa_ABCDEFGH12345678IJKLMNOP", mustNotContain: "rpa_ABCDEFGH12345678IJKLMNOP" },
      { name: "xi-api-key header", input: 'xi-api-key: "el_secret_abcdef123456"', mustNotContain: "el_secret_abcdef123456", mustContain: "xi-api-key" },
      { name: "x-api-key header", input: "x-api-key=abcdef1234567890", mustNotContain: "abcdef1234567890", mustContain: "x-api-key" },
      { name: "raw non-Bearer Authorization", input: "Authorization: Basic dXNlcjpwYXNz1234", mustNotContain: "dXNlcjpwYXNz1234", mustContain: "Authorization" },
      { name: "absolute /var/www path", input: "ENOENT: /var/www/ai-content/prisma/dev.db not found", mustNotContain: "/var/www/ai-content/prisma/dev.db" },
    ];
    for (const c of cases) {
      const out = scrubSecrets(c.input);
      assert.ok(!out.includes(c.mustNotContain), `${c.name}: secret must be redacted, got: ${out}`);
      if (c.mustContain) assert.ok(out.includes(c.mustContain), `${c.name}: must keep the header/context name, got: ${out}`);
    }
    console.log("✓ case 6: scrub-secrets covers Stripe/OpenAI/RunPod keys, header-style secrets, and /var/www paths");
  }

  // ---- Case 2ii: classifyUnknownStepFailure — R31 verbatim-vs-prefixed decision (pure) ----
  {
    const { classifyUnknownStepFailure } = await import("../src/lib/mcp/orchestrator");
    // (i) an envelope-authored Thai message (e.g. quota_exceeded) is stored verbatim.
    const quotaMessage = "โควต้านาทีของแผน PRO ใช้ครบแล้ว (80 นาที/เดือน)";
    const quotaResult = classifyUnknownStepFailure({
      phaseName: "render",
      code: "quota_exceeded",
      cause: quotaMessage,
      isEnvelopeCause: true,
    });
    assert.equal(quotaResult.code, "quota_exceeded");
    assert.equal(quotaResult.message, quotaMessage, "an envelope-authored cause must be stored VERBATIM, never re-wrapped");
    assert.ok(
      !quotaResult.message.startsWith("เรนเดอร์ไม่สำเร็จ ("),
      "verbatim customer copy must never stutter with a prepended step prefix + code",
    );

    // (ii) the orchestrator's own internal Thai throw (the literal "unreachable" empty-captions
    // guard at the captions phase) — a plain Error, no envelope — is ALSO stored verbatim
    // because it already contains Thai characters, never re-wrapped into
    // "สร้างซับไม่สำเร็จ (captions_unknown): สร้างซับสำหรับคลิปนี้ไม่สำเร็จ — ..." (the stutter the review caught).
    const captionsThaiCause = "สร้างซับสำหรับคลิปนี้ไม่สำเร็จ — กรุณาลองใหม่อีกครั้ง";
    const captionsResult = classifyUnknownStepFailure({
      phaseName: "captions",
      code: "captions_unknown",
      cause: captionsThaiCause,
      isEnvelopeCause: false,
    });
    assert.equal(captionsResult.code, "captions_unknown");
    assert.equal(captionsResult.message, captionsThaiCause, "a Thai internal cause must be stored VERBATIM, never re-wrapped");
    console.log("✓ case 2ii: classifyUnknownStepFailure stores envelope/Thai causes verbatim (R31)");

    // (iii) a genuinely internal/technical cause (no Thai, no envelope) DOES get wrapped —
    // this is the one case the "<prefix> (<code>): <cause>" form exists for.
    const technicalResult = classifyUnknownStepFailure({
      phaseName: "render",
      code: "render_unknown",
      cause: "Cannot find module '@remotion/bundler'",
      isEnvelopeCause: false,
    });
    assert.equal(technicalResult.message, "เรนเดอร์ไม่สำเร็จ (render_unknown): Cannot find module '@remotion/bundler'");
    console.log("✓ case 2iii: a non-Thai, non-envelope technical cause still gets the step-prefixed form");
  }

  // ---- Case 1 + Case 2i + Case 4 need a real orchestrator run ----
  const prismaMod = await import("../src/lib/prisma");
  const { prisma } = prismaMod;
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { decodePipelineResponse } = await import("../src/lib/mcp/pipeline-client");

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

  // Case 2i: the REAL /api/videos/render quota envelope (src/app/api/videos/render/route.ts's
  // quotaExceededResponse, `{ error: {code,provider,message,...}, detail }`) round-trips through
  // decodePipelineResponse → PipelineApiError → the orchestrator's failJob mapping VERBATIM —
  // never "เรนเดอร์ไม่สำเร็จ (quota_exceeded): โควต้านาทีของแผน PRO…" (the stutter the review caught).
  {
    const user = await makeUser("pes-user-3");
    const jobId = "pes-job-3";
    const job = await prisma.videoJob.create({
      data: { id: jobId, userId: user.id, status: "processing", inputJson: JSON.stringify({ script: SCRIPT_TEXT, voiceProvider: "gemini" }) },
    });
    const quotaMessage = "โควต้านาทีของแผน PRO ใช้ครบแล้ว (80 นาที/เดือน)";
    const quotaEnvelope = JSON.stringify({
      error: {
        code: "quota_exceeded",
        provider: "heroai",
        message: quotaMessage,
        userAction: "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ",
        retryable: false,
      },
      detail: quotaMessage,
    });
    let quotaError: unknown;
    try {
      decodePipelineResponse("POST", "/api/videos/render", 403, quotaEnvelope);
    } catch (e) {
      quotaError = e;
    }
    assert.ok(quotaError, "the real quota envelope must decode to a thrown error");

    const caller = buildHappyCaller(prismaMod, user.id, jobId, { failRenderWith: quotaError });
    await runOrchestrator(job.id, user.id, { caller: caller as never, sleep: async () => {} });

    const failed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "quota_exceeded");
    assert.equal(failed.errorMessage, quotaMessage, "quota_exceeded's own Thai message must be stored VERBATIM");
    console.log("✓ case 2i: the real quota_exceeded envelope stores errorMessage VERBATIM + errorCode=quota_exceeded");
  }

  // Case 4 (== case 3iii): an unknown (uncoded), non-Thai Error thrown at the "render" phase
  // stores a specific errorCode + Thai-prefixed errorMessage — never the bare generic fallback.
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKSPACE_BODY = "พื้นที่ทำงาน HeyGen ที่เชื่อมอยู่ยังไม่พร้อมสร้าง Avatar — ให้ผู้ดูแลบัญชีตรวจสอบการตั้งค่าพื้นที่ทำงาน หรือติดต่อ HeyGen แล้วลองใหม่ หรือปิด Avatar เพื่อสร้างวิดีโอต่อ";
const AVATAR_MISSING_LEGACY_BODY = "ไม่สามารถใช้ Avatar ที่เลือกในบัญชี HeyGen นี้ได้ กรุณาเลือก Avatar ใหม่หรือลองปิด Avatar แล้วสร้างวิดีโออีกครั้ง";

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert.equal(actual, expected, label);
  console.log(`✓ ${label}`);
}

async function main() {
  const databaseDir = mkdtempSync(path.join(tmpdir(), "hero-task2-transport-"));
  const databasePath = path.join(databaseDir, "test.db");
  process.env.DATABASE_URL = `file:${databasePath}`;
  try {
    execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], {
      cwd: process.cwd(), env: process.env, stdio: "pipe",
    });

    const [{ prisma }, { runOrchestrator }, { PipelineHttpError }, heygenGenerateError, heroImageRate, failureView] = await Promise.all([
      import("../src/lib/prisma"),
      import("../src/lib/mcp/orchestrator"),
      import("../src/lib/mcp/pipeline-client"),
      import("../src/lib/heygen-generate-error"),
      import("../src/lib/hero-image-rate-limit"),
      import("../src/app/(dashboard)/video-editor/_v2/failure-view"),
    ]);

    // This is the route's exact provider-response parser. The object below is the
    // only external seam in this verifier: no HeyGen request is ever made.
    const workspaceResponse = heygenGenerateError.heygenGenerateFailureResponse(400, {
      error: { code: "SPACE_ENCRYPTION_DISABLED" },
    });
    const avatarMissingResponse = heygenGenerateError.heygenGenerateFailureResponse(404, {
      error: { message: "avatar look not found" },
    });
    const otherFatalResponse = heygenGenerateError.heygenGenerateFailureResponse(400, {
      error: { message: "avatar request rejected" },
    });
    const sensitiveAvatarResponse = heygenGenerateError.heygenGenerateFailureResponse(404, {
      requestTrace: "outside-provider-secret",
      error: {
        message: "avatar look not found",
        providerTrace: "inside-provider-secret",
      },
    });
    const sensitiveWorkspaceResponse = heygenGenerateError.heygenGenerateFailureResponse(400, {
      requestTrace: "outside-provider-secret",
      error: {
        code: "SPACE_ENCRYPTION_DISABLED",
        providerTrace: "inside-provider-secret",
      },
    });
    const sensitiveGenericResponse = heygenGenerateError.heygenGenerateFailureResponse(400, {
      requestTrace: "outside-provider-secret",
      error: { message: "provider rejected", providerTrace: "inside-provider-secret" },
    });
    assertEqual(avatarMissingResponse.body.error, AVATAR_MISSING_LEGACY_BODY, "HERO-18: legacy route returns owned customer copy");
    assert(!avatarMissingResponse.body.error.includes("avatar look not found"), "HERO-18: legacy route never exposes provider text");
    assertEqual(avatarMissingResponse.body.reason, "HEYGEN_AVATAR_NOT_FOUND", "HERO-18: route keeps an internal durable marker");
    for (const [label, response] of [
      ["avatar", sensitiveAvatarResponse],
      ["workspace", sensitiveWorkspaceResponse],
      ["generic", sensitiveGenericResponse],
    ] as const) {
      const publicEnvelope = JSON.stringify(response.body);
      assert(!publicEnvelope.includes("outside-provider-secret"), `${label}: public envelope omits provider fields outside error`);
      assert(!publicEnvelope.includes("inside-provider-secret"), `${label}: public envelope omits provider fields inside error`);
    }
    assertEqual(sensitiveAvatarResponse.body.reason, "HEYGEN_AVATAR_NOT_FOUND", "HERO-18: sanitized envelope keeps internal avatar marker");
    assertEqual(sensitiveWorkspaceResponse.body.reason, "SPACE_ENCRYPTION_DISABLED", "workspace: sanitized envelope keeps internal workspace marker");
    assertEqual(sensitiveGenericResponse.body.reason, undefined, "generic fatal: sanitized envelope adds no specific marker");

    const user = await prisma.user.create({
      data: { name: "Task 2", email: "task2-transport@example.test", plan: "PRO", geminiKey: "test", pexelsKey: "test" },
    });

    async function persistAvatarFailure(
      response: { status: number; body: unknown },
      expectedKind: string,
      label: string,
    ) {
      const job = await prisma.videoJob.create({
        data: {
          userId: user.id,
          status: "processing",
          inputJson: JSON.stringify({ script: "สวัสดี", voiceProvider: "gemini", avatarMode: "full", avatarId: "avatar-1" }),
        },
      });
      let renderCalls = 0;
      const caller = {
        post: async (requestPath: string) => {
          const key = requestPath.split("?")[0];
          if (key === "/api/heygen/generate-with-bg") {
            throw new PipelineHttpError("POST", key, response.status, response.body);
          }
          if (key === "/api/videos/render") return { jobId: `render-${++renderCalls}` } as never;
          const responses: Record<string, unknown> = {
            "/api/videos/tts-gemini": { voiceUrl: "/api/renders/test.wav", audioDurationMs: 1000, timing: { provider: "gemini", segments: [{ text: "สวัสดี", startMs: 0, durationMs: 1000 }], chars: null } },
            "/api/videos/extract-keywords": { keywords: ["test"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [1] },
            "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
            "/api/videos/generate-config": { config: { durationInFrames: 30, voiceFile: "/api/renders/test.wav", bgVideos: [] } },
            "/api/videos/trim-audio": { audioUrl: "/api/renders/trim.wav" },
          };
          return (responses[key] ?? {}) as never;
        },
        patch: async () => ({} as never),
        get: async (requestPath: string) => requestPath.startsWith("/api/videos/render-progress")
          ? ({ progress: 100, stage: "done", videoUrl: "/api/renders/base.mp4", error: null } as never)
          : ({} as never),
      };
      await runOrchestrator(job.id, user.id, { caller: caller as never, refundOneClip: async () => {}, sleep: async () => {} });
      const persisted = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
      assertEqual(persisted.status, "failed", `${label}: avatar worker persists a terminal job`);
      const kind = failureView.classifyFailure(persisted);
      assertEqual(kind, expectedKind, `${label}: persisted failure reaches the reviewed view`);
      return persisted;
    }

    const workspace = await persistAvatarFailure(workspaceResponse, "heygen-workspace-unavailable", "workspace encryption");
    const workspaceCopy = failureView.failureViewCopy(failureView.classifyFailure(workspace), workspace, false);
    assertEqual(workspace.errorCode, "SPACE_ENCRYPTION_DISABLED", "workspace encryption: route reason is durable error code");
    assertEqual(workspaceCopy.heading, "เชื่อมต่อพื้นที่ทำงาน HeyGen ไม่สำเร็จ", "workspace encryption: heading is exact approved copy");
    assertEqual(workspaceCopy.body, WORKSPACE_BODY, "workspace encryption: body is exact approved copy");

    const avatarMissing = await persistAvatarFailure(avatarMissingResponse, "heygen-avatar-rejected", "HERO-18 avatar missing");
    assertEqual(avatarMissing.errorCode, "HEYGEN_AVATAR_NOT_FOUND", "HERO-18: internal marker remains durable for V2");
    await persistAvatarFailure(otherFatalResponse, "generic", "unrelated fatal HeyGen error");

    await prisma.aiGenerationJob.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "hero-test",
        idempotencyKey: `task2-hourly-${index}`,
      })),
    });
    const rate = await heroImageRate.checkHeroImageRate(user.id, 1);
    assert(!rate.ok && rate.scope === "hour", "local hourly image gate blocks before a new batch");
    if (rate.ok) throw new Error("expected hourly image gate");
    const localGateBody = heroImageRate.heroImageRateLimitResponse(rate, [0]);
    assertEqual(localGateBody.retryAfterSec, rate.retryAfterSec, "local hourly image gate exposes retryAfterSec");

    async function persistStockFailure(body: Record<string, unknown>, label: string) {
      const job = await prisma.videoJob.create({
        data: { userId: user.id, status: "processing", inputJson: JSON.stringify({ script: "สวัสดี", voiceProvider: "gemini" }) },
      });
      let stockCalls = 0;
      const caller = {
        post: async (requestPath: string) => {
          const key = requestPath.split("?")[0];
          if (key === "/api/videos/fetch-stock") {
            stockCalls += 1;
            throw new PipelineHttpError("POST", key, 429, body);
          }
          const responses: Record<string, unknown> = {
            "/api/videos/tts-gemini": { voiceUrl: "/api/renders/test.wav", audioDurationMs: 1000, timing: { provider: "gemini", segments: [{ text: "สวัสดี", startMs: 0, durationMs: 1000 }], chars: null } },
            "/api/videos/extract-keywords": { keywords: ["test"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [1] },
          };
          return (responses[key] ?? {}) as never;
        },
        patch: async () => ({} as never),
        get: async () => ({} as never),
      };
      await runOrchestrator(job.id, user.id, { caller: caller as never, refundOneClip: async () => {}, sleep: async () => {} });
      const persisted = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
      assertEqual(stockCalls, 1, `${label}: local gate does not retry paid image work`);
      assertEqual(persisted.status, "failed", `${label}: stock worker persists terminal error`);
      assertEqual(persisted.errorCode, "RATE_LIMITED", `${label}: route code is durable`);
      assertEqual(persisted.errorMessage, body.error as string, `${label}: route cooldown text is durable`);
      return persisted;
    }

    const localGate = await persistStockFailure(localGateBody, "local hourly image gate");
    const localGateCopy = failureView.failureViewCopy(failureView.classifyFailure(localGate), localGate, false);
    assertEqual(localGateCopy.heading, "สร้างภาพครบขีดจำกัดชั่วคราว", "local hourly image gate: approved heading");
    assertEqual(localGateCopy.body, `รออีกประมาณ ${Math.max(1, Math.ceil(rate.retryAfterSec / 60))} นาที แล้วลองสร้างใหม่ได้`, "local hourly image gate: exact cooldown reaches failure view");

    for (const [label, retryAfterSec, error] of [
      ["zero", 0, "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~0 วินาที"],
      ["negative", -1, "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~-1 วินาที"],
      ["NaN", Number.NaN, "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~NaN วินาที"],
      ["oversized", 86_401, "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~86401 วินาที"],
    ] as const) {
      const persisted = await persistStockFailure({ error, code: "RATE_LIMITED", retryable: true, retryAfterSec }, `cooldown ${label}`);
      const copy = failureView.failureViewCopy(failureView.classifyFailure(persisted), persisted, false);
      assertEqual(copy.body, "กรุณารอสักครู่แล้วลองใหม่", `cooldown ${label}: unsafe retryAfterSec gets unknown wait copy`);
    }

    await prisma.$disconnect();
  } finally {
    rmSync(databaseDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

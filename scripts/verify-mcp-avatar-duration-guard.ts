import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "mcp-avatar-duration-guard-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { avatarFullDurationViolation } = await import("../src/lib/avatar-duration");

  assert.equal(avatarFullDurationViolation({ mode: "full", durationSec: 300 }), null);
  assert.equal(
    avatarFullDurationViolation({ mode: "full", durationSec: 300.1 })?.code,
    "full_avatar_duration_unsupported",
  );
  assert.equal(avatarFullDurationViolation({ mode: "bookend", durationSec: 351 }), null);

  const user = await prisma.user.create({
    data: {
      id: "avatar-duration-user",
      name: "Avatar Duration",
      email: "avatar-duration@example.com",
      plan: "BUSINESS",
      planExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      stripeSubscriptionId: "sub_avatar_duration_test",
      subStatus: "active",
      geminiKey: "g",
      pexelsKey: "p",
    },
  });
  const job = await prisma.videoJob.create({
    data: {
      id: "avatar-duration-job",
      userId: user.id,
      status: "processing",
      inputJson: JSON.stringify({
        script: "เริ่มต้นให้ชัดเจน แล้วลงมือทำทันที นี่คือบททดสอบ MCP",
        voiceProvider: "gemini",
        avatarMode: "bookend-both",
        avatarId: "avatar-1",
        avatarIntroSecs: 3,
        avatarTailSecs: 3,
      }),
    },
  });

  const calls: string[] = [];
  const caller = {
    post: async (path: string) => {
      calls.push(path.split("?")[0]);
      if (path === "/api/videos/tts-gemini") {
        return {
          voiceUrl: "/api/renders/short.wav",
          audioDurationMs: 5_251,
          timing: {
            provider: "gemini",
            segments: [{
              text: "เริ่มต้นให้ชัดเจน แล้วลงมือทำทันที นี่คือบททดสอบ MCP",
              startMs: 0,
              durationMs: 5_251,
            }],
            chars: null,
          },
        } as never;
      }
      throw new Error(`unexpected downstream call: ${path}`);
    },
    patch: async () => ({} as never),
    get: async (path: string) => { throw new Error(`unexpected downstream call: ${path}`); },
  };

  await runOrchestrator(job.id, user.id, { caller: caller as never, sleep: async () => {} });

  const failed = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage ?? "", /สั้นเกินไป.*Intro 3.*Outro 3/);
  assert.deepEqual(
    calls,
    ["/api/videos/tts-gemini"],
    "short bookend-both must stop immediately after exact TTS duration, before LLM, stock, render, or HeyGen",
  );

  const longFullJob = await prisma.videoJob.create({
    data: {
      id: "avatar-full-over-envelope-job",
      userId: user.id,
      status: "processing",
      inputJson: JSON.stringify({
        // Calibrated editor estimate: 3,861 Thai characters / 11 cps = 351s,
        // matching the 350.8s production COMPOSITE_TIMEOUT incident.
        script: "ก".repeat(3_861),
        voiceProvider: "gemini",
        avatarMode: "full",
        avatarId: "avatar-1",
      }),
    },
  });
  const longFullCalls: string[] = [];
  await runOrchestrator(longFullJob.id, user.id, {
    caller: {
      post: async (path: string) => {
        longFullCalls.push(path.split("?")[0]);
        if (path === "/api/videos/tts-gemini") {
          return {
            voiceUrl: "/api/renders/long-full.wav",
            audioDurationMs: 350_800,
            timing: {
              provider: "gemini",
              segments: [{ text: "ก".repeat(3_861), startMs: 0, durationMs: 350_800 }],
              chars: null,
            },
          } as never;
        }
        throw new Error(`unexpected downstream call: ${path}`);
      },
      patch: async () => ({} as never),
      get: async (path: string) => { throw new Error(`unexpected downstream call: ${path}`); },
    } as never,
    sleep: async () => {},
  });
  const rejectedLongFull = await prisma.videoJob.findUniqueOrThrow({ where: { id: longFullJob.id } });
  assert.equal(rejectedLongFull.status, "failed");
  assert.match(rejectedLongFull.errorMessage ?? "", /Full Avatar.*5 นาที.*Bookend/i);
  assert.deepEqual(
    longFullCalls,
    [],
    "a production-shaped 351s full-avatar request must fail before TTS or any provider/render spend",
  );

  const underestimatedFullJob = await prisma.videoJob.create({
    data: {
      id: "avatar-full-exact-backstop-job",
      userId: user.id,
      status: "processing",
      inputJson: JSON.stringify({
        // Estimate is 299.9s and passes admission; exact TTS duration crosses
        // the boundary and must stop before any subsequent provider spend.
        script: "ก".repeat(3_299),
        voiceProvider: "gemini",
        avatarMode: "full",
        avatarId: "avatar-1",
      }),
    },
  });
  const underestimatedCalls: string[] = [];
  await runOrchestrator(underestimatedFullJob.id, user.id, {
    caller: {
      post: async (path: string) => {
        underestimatedCalls.push(path.split("?")[0]);
        if (path === "/api/videos/tts-gemini") {
          return {
            voiceUrl: "/api/renders/full-exact-backstop.wav",
            audioDurationMs: 300_100,
            timing: {
              provider: "gemini",
              segments: [{ text: "ก".repeat(3_299), startMs: 0, durationMs: 300_100 }],
              chars: null,
            },
          } as never;
        }
        throw new Error(`unexpected downstream call: ${path}`);
      },
      patch: async () => ({} as never),
      get: async (path: string) => { throw new Error(`unexpected downstream call: ${path}`); },
    } as never,
    sleep: async () => {},
  });
  const rejectedUnderestimate = await prisma.videoJob.findUniqueOrThrow({ where: { id: underestimatedFullJob.id } });
  assert.equal(rejectedUnderestimate.status, "failed");
  assert.match(rejectedUnderestimate.errorMessage ?? "", /Full Avatar.*5 นาที.*Bookend/i);
  assert.deepEqual(
    underestimatedCalls,
    ["/api/videos/tts-gemini"],
    "exact duration backstop must stop an underestimated full-avatar job before captions, render, or HeyGen",
  );

  await prisma.$disconnect();
  console.log("✅ MCP avatar duration admission guards passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

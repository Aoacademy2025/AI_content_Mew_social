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

  const user = await prisma.user.create({
    data: {
      id: "avatar-duration-user",
      name: "Avatar Duration",
      email: "avatar-duration@example.com",
      plan: "BUSINESS",
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

  await prisma.$disconnect();
  console.log("✅ MCP avatar short-duration guard passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

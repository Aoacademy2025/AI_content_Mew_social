import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function main() {
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "story-film-mcp-editorial-"));
const databasePath = path.join(temporaryDirectory, "test.db");
process.env.DATABASE_URL = `file:${databasePath}`;
process.env.MCP_PUBLIC_ORIGIN = "http://story-film.test";
const port = 34_219;
const mcpUrl = `http://127.0.0.1:${port}/api/story-film/mcp`;

execFileSync(path.resolve("node_modules/.bin/prisma"), ["db", "push", "--skip-generate"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "pipe",
});

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
let nextProcess: ChildProcess | null = null;

const userId = "story-film-editorial-mcp-user";
const projectId = "story-film-editorial-mcp-project";
const musicTrackId = "story-film-editorial-mcp-music";
const bearerToken = `heroai_pat_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(bearerToken).digest("hex");

const approvedEditorial = {
  subtitlesEnabled: true,
  subtitleMode: "sentence" as const,
  subtitleStylePreset: "box-rounded" as const,
  subtitleTextEffect: "fade" as const,
  subtitlePosition: "bottom" as const,
  subtitleFontFamily: "Kanit" as const,
  subtitleFontSize: 60,
  subtitleFontWeight: 600 as const,
  headlineHook: {
    enabled: true,
    headline: "AI ตอบผิด\nยังไม่น่ากลัวที่สุด",
    subheadline: "วันที่มันเห็นด้วยกับเราทุกเรื่อง…น่ากลัวกว่า",
    durationMs: 5_000,
    preset: "clean" as const,
    topPercent: 18,
    fontFamily: "Kanit" as const,
    fontWeight: 600 as const,
    subheadlineFontSize: 42,
  },
  textOverlays: [],
};

function parseMcpPacket(raw: string) {
  if (raw.trim().startsWith("{")) return JSON.parse(raw) as Record<string, unknown>;
  const dataLines = raw.split(/\r?\n/u).filter((line) => line.startsWith("data: "));
  if (dataLines.length === 0) throw new Error("MCP response did not contain JSON or SSE data");
  return JSON.parse(dataLines.at(-1)!.slice(6)) as Record<string, unknown>;
}

async function callMcp(name: string, args: Record<string, unknown>) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomBytes(4).toString("hex"),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const packet = parseMcpPacket(await response.text()) as {
    error?: unknown;
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  assert.equal(response.status, 200, `MCP ${name} HTTP status`);
  assert.equal(packet.error, undefined, `MCP ${name} JSON-RPC error`);
  const payload = packet.result?.content?.find((block) => block.type === "text")?.text;
  assert.ok(payload, `MCP ${name} text result`);
  return JSON.parse(payload) as Record<string, unknown>;
}

async function waitForMcpServer(logs: () => string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (nextProcess?.exitCode != null) {
      throw new Error(`Next server exited before MCP became ready\n${logs()}`);
    }
    try {
      const response = await fetch(mcpUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401 || response.status === 405) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for local MCP server\n${logs()}`);
}

try {
  await prisma.user.create({
    data: {
      id: userId,
      name: "Mew Story Film MCP Test",
      email: "duckyhero@gmail.com",
      role: "ADMIN",
      plan: "PRO",
      planExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    },
  });
  await prisma.mcpToken.create({
    data: {
      id: "story-film-editorial-mcp-token",
      userId,
      tokenHash,
      name: "Editorial transport verification",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    },
  });
  await prisma.music.create({
    data: {
      id: musicTrackId,
      title: "Classical Ambient Cinematic",
      filename: "classical-ambient-cinematic.mp3",
      duration: 151.798,
    },
  });
  await prisma.storyFilmProject.create({
    data: {
      id: projectId,
      userId,
      title: "วันที่ ChatGPT เห็นด้วยกับเราทุกเรื่อง",
      idempotencyKey: "verify:story-film:mcp-editorial",
      presentationMode: "faceless",
      sourcePackage: "content/2026-08-28-allan-brooks-chatgpt-loop",
      narrativeSource: "สิ่งที่น่ากลัวที่สุดของ AI อาจไม่ใช่วันที่มันตอบเราผิดครับ แต่เป็นวันที่มันเห็นด้วยกับเราทุกเรื่อง",
      narrationMasterUrl: "/api/renders/story-film-narration-test.mp3",
      narrationDurationMs: 151_798,
      narrationProvider: "elevenlabs",
      narrationVoiceId: "test-eleven-v3-voice",
      musicSource: "system",
      musicTrackId,
      musicUrl: "/api/music/classical-ambient-cinematic.mp3",
      finalRenderUrl: "/api/renders/story-film-final-approved-r58.mp4",
      status: "active",
      stage: "final_render",
      revision: 58,
      generationEpoch: 30,
      awaitingApproval: true,
      stageDataJson: JSON.stringify({
        gate: "final_render",
        renderSetup: false,
        waitingForGeneration: false,
        editorial: {
          subtitlesEnabled: false,
          subtitleMode: "sentence",
          subtitleStylePreset: "stroke",
          subtitleTextEffect: "pop",
          subtitlePosition: "bottom",
          subtitleFontFamily: "Kanit",
          headlineHook: {
            enabled: false,
            headline: "",
            durationMs: 5_000,
            preset: "viral",
            topPercent: 20,
            fontFamily: "Kanit",
          },
          textOverlays: [],
        },
      }),
    },
  });

  let serverLogs = "";
  nextProcess = spawn(path.resolve("node_modules/.bin/next"), ["dev", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: `file:${databasePath}`,
      MCP_PUBLIC_ORIGIN: "http://story-film.test",
      NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rememberLog = (chunk: Buffer) => {
    serverLogs = `${serverLogs}${chunk.toString()}`.slice(-8_000);
  };
  nextProcess.stdout?.on("data", rememberLog);
  nextProcess.stderr?.on("data", rememberLog);
  await waitForMcpServer(() => serverLogs);

  const before = await callMcp("hero_story_film_read", { projectId });
  const beforeProject = before.project as Record<string, unknown>;
  assert.equal(beforeProject.stage, "final_render");
  assert.equal(beforeProject.revision, 58);
  assert.equal(beforeProject.awaitingApproval, true);

  const decision = await callMcp("hero_story_film_decide", {
    projectId,
    expectedStage: beforeProject.stage,
    expectedRevision: beforeProject.revision,
    decision: "approve",
    instruction: "สร้าง Final Preview ใหม่โดยเปลี่ยนเฉพาะ Headline, Subheadline และ Subtitle ห้าม regenerate ภาพหรือวิดีโอทุกฉาก",
    target: {
      musicSource: "system",
      musicTrackId,
      editorial: approvedEditorial,
    },
    idempotencyKey: "mewshort:allan-brooks:editorial-preview:r59",
  });
  const decidedProject = (decision.project as Record<string, unknown>);
  assert.equal(decidedProject.stage, "final_render");
  assert.equal(decidedProject.revision, 59);
  assert.equal(decidedProject.generationEpoch, 31);
  assert.equal(decidedProject.status, "waiting_generation");
  assert.equal(decidedProject.awaitingApproval, false);

  const after = await callMcp("hero_story_film_read", { projectId });
  const afterProject = after.project as Record<string, unknown>;
  assert.equal(afterProject.revision, 59);
  assert.equal(afterProject.nextAction, "wait_for_final_render");

  const [finalJobs, visualJobs, decisionRow] = await Promise.all([
    prisma.storyFilmGenerationJob.findMany({ where: { projectId, kind: "final_render" } }),
    prisma.storyFilmGenerationJob.count({
      where: { projectId, kind: { in: ["look_image", "keyframe_image", "scene_video"] } },
    }),
    prisma.storyFilmDecision.findUniqueOrThrow({ where: { projectId_revision: { projectId, revision: 58 } } }),
  ]);
  assert.equal(finalJobs.length, 1);
  assert.equal(visualJobs, 0, "editorial-only MCP decision must not enqueue Grok visual work");
  const jobPayload = JSON.parse(finalJobs[0].payloadJson) as { editorial?: typeof approvedEditorial };
  assert.deepEqual(jobPayload.editorial, approvedEditorial);
  assert.match(decisionRow.instruction ?? "", /ห้าม regenerate ภาพหรือวิดีโอ/u);

  await prisma.$transaction([
    prisma.storyFilmGenerationJob.update({
      where: { id: finalJobs[0].id },
      data: {
        status: "needs_attention",
        attemptCount: 2,
        technicalFailureCount: 2,
        providerJobId: `hero-render:${finalJobs[0].id}`,
        submittedAt: new Date(),
        finishedAt: new Date(),
        errorCode: "final_render_failure",
        errorMessage: "Remotion runtime failed",
      },
    }),
    prisma.storyFilmProject.update({
      where: { id: projectId },
      data: { status: "needs_attention" },
    }),
  ]);
  const attention = await callMcp("hero_story_film_read", { projectId });
  const attentionProject = attention.project as Record<string, unknown>;
  assert.equal(attentionProject.nextAction, "resolve_attention");
  const retry = await callMcp("hero_story_film_decide", {
    projectId,
    expectedStage: attentionProject.stage,
    expectedRevision: attentionProject.revision,
    decision: "retry",
    instruction: "Retry the same approved Final Preview after fixing the worker runtime.",
    idempotencyKey: "mewshort:allan-brooks:retry:r59",
  });
  const retryProject = retry.project as Record<string, unknown>;
  const [retriedJob, retryDecision] = await Promise.all([
    prisma.storyFilmGenerationJob.findUniqueOrThrow({ where: { id: finalJobs[0].id } }),
    prisma.storyFilmDecision.findUniqueOrThrow({
      where: { projectId_revision: { projectId, revision: 59 } },
    }),
  ]);
  assert.equal(retryProject.revision, 60);
  assert.equal(retryProject.generationEpoch, 31);
  assert.equal(retryProject.status, "waiting_generation");
  assert.equal(retriedJob.status, "queued");
  assert.equal(retriedJob.technicalFailureCount, 0);
  assert.equal(retryDecision.kind, "retry");

  console.log(JSON.stringify({
    ok: true,
    transport: "internal_story_film_mcp",
    readBeforeDecision: {
      stage: beforeProject.stage,
      revision: beforeProject.revision,
    },
    result: {
      stage: afterProject.stage,
      revision: retryProject.revision,
      generationEpoch: retryProject.generationEpoch,
      nextAction: retryProject.nextAction,
    },
    editorial: jobPayload.editorial,
    queuedJobs: {
      finalRender: finalJobs.length,
      grokVisual: visualJobs,
    },
  }, null, 2));
} finally {
  if (nextProcess && nextProcess.exitCode == null) {
    nextProcess.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      nextProcess?.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  await prisma.$disconnect();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

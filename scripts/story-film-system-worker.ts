// Long-lived Hero-owned adapter worker for provider-neutral Story Film jobs.
// Grok subscription jobs stay on Mew's Mac mini; this process currently drains
// Hero text, voice and final-render lanes and never owns creator approvals.
import "dotenv/config";
import { hostname } from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import {
  completeStoryFilmGenerationJob,
  failStoryFilmGenerationJob,
  heartbeatStoryFilmGenerationJob,
  leaseStoryFilmGenerationJobs,
  markStoryFilmGenerationSubmitted,
  type LeasedStoryFilmJob,
} from "../src/lib/story-film-generation-queue.server";
import {
  persistStoryFilmStoryboardScenes,
  planStoryFilmStoryboardJob,
} from "../src/lib/story-film-storyboard.server";
import { hydrateServerGeminiKeyEnv } from "../src/lib/server-keys";
import {
  advanceHeroVoiceGeneration,
  heroVoiceResultFromJob,
  startHeroVoiceGeneration,
} from "../src/lib/hero-voice-generation.server";
import { isValidOmniVoiceId } from "../src/lib/omnivoice";
import { renderStoryFilmFinal } from "../src/lib/story-film-render.server";

const POLL_MS = Math.max(1_000, Number(process.env.STORY_FILM_SYSTEM_POLL_MS) || 4_000);
const HEARTBEAT_MS = 30_000;
const WORKER_ID = `hero-story-film-system:${hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`;
const rendersDir = path.join(process.cwd(), "public", "renders");
let running = true;

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

function artifactPath(job: LeasedStoryFilmJob) {
  return path.join(rendersDir, `story-film-storyboard-${job.id}.json`);
}

async function persistStoryboard(job: LeasedStoryFilmJob) {
  const finalPath = artifactPath(job);
  try {
    const existing = await fs.readFile(finalPath);
    JSON.parse(existing.toString("utf8"));
    if (!job.resumeProviderJobId) {
      await markStoryFilmGenerationSubmitted({
        jobId: job.id,
        workerId: WORKER_ID,
        leaseToken: job.leaseToken,
        providerJobId: `hero-text:recovered:${job.id}:${Date.now()}`,
      });
    }
    return { finalPath, sizeBytes: existing.byteLength };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (job.resumeProviderJobId) {
    throw new Error("storyboard submission was interrupted before a durable result was written");
  }
  await markStoryFilmGenerationSubmitted({
    jobId: job.id,
    workerId: WORKER_ID,
    leaseToken: job.leaseToken,
    providerJobId: `hero-text:${job.id}:${Date.now()}`,
  });
  const storyboard = await planStoryFilmStoryboardJob(job.id);
  await persistStoryFilmStoryboardScenes(storyboard);
  const encoded = Buffer.from(`${JSON.stringify(storyboard, null, 2)}\n`, "utf8");
  if (encoded.byteLength > 2 * 1024 * 1024) throw new Error("storyboard artifact exceeds 2 MB");
  await fs.mkdir(rendersDir, { recursive: true });
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, encoded, { flag: "wx" });
  await fs.rename(temporaryPath, finalPath);
  return { finalPath, sizeBytes: encoded.byteLength };
}

function payloadText(job: LeasedStoryFilmJob, key: string, max: number) {
  const value = job.payload[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`invalid payload.${key}`);
  return value.trim();
}

async function persistNarration(job: LeasedStoryFilmJob) {
  const project = await prisma.storyFilmProject.findUnique({
    where: { id: job.projectId },
    include: { user: { select: { id: true, plan: true } } },
  });
  if (!project || project.stage !== "narration" || project.generationEpoch !== job.generationEpoch) {
    throw new Error("narration job is stale");
  }
  const text = payloadText(job, "text", 12_000);
  const voiceId = payloadText(job, "voiceId", 160);
  if (!isValidOmniVoiceId(voiceId)) throw new Error("invalid Hero Voice id");
  const rawSpeed = Number(job.payload.speed);
  const speed = Number.isFinite(rawSpeed) ? Math.min(3, Math.max(0.3, rawSpeed)) : 1;
  let voiceJob = job.resumeProviderJobId
    ? await prisma.aiGenerationJob.findFirst({ where: { id: job.resumeProviderJobId, userId: project.user.id } })
    : null;
  if (!voiceJob) {
    const started = await startHeroVoiceGeneration({
      userId: project.user.id,
      plan: project.user.plan,
      text,
      voiceId,
      speed,
      studio: true,
      idempotencyKey: `story-film-voice:${project.id}:${job.generationEpoch}`,
    });
    voiceJob = started.job;
    await markStoryFilmGenerationSubmitted({
      jobId: job.id,
      workerId: WORKER_ID,
      leaseToken: job.leaseToken,
      providerJobId: voiceJob.id,
    });
  }
  while (!["completed", "failed", "canceled"].includes(voiceJob.status)) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    voiceJob = await advanceHeroVoiceGeneration(project.user.id, voiceJob.id);
  }
  if (voiceJob.status !== "completed") {
    throw new Error(voiceJob.errorMessage || `Hero Voice ended as ${voiceJob.status}`);
  }
  const result = heroVoiceResultFromJob(voiceJob);
  if (!result) throw new Error("Hero Voice completed without a durable result");
  const match = /^\/api\/renders\/([A-Za-z0-9._-]+)$/.exec(result.voiceUrl);
  if (!match) throw new Error("Hero Voice returned an unsafe result URL");
  const finalPath = path.join(rendersDir, match[1]);
  const stats = await fs.stat(finalPath);
  return {
    storageUrl: result.voiceUrl,
    mimeType: "audio/wav",
    sizeBytes: stats.size,
    durationMs: result.audioDurationMs,
    metadata: { adapter: "hero_voice", aiGenerationJobId: voiceJob.id, voiceId },
  };
}

async function persistFinalRender(job: LeasedStoryFilmJob) {
  if (!job.resumeProviderJobId) {
    await markStoryFilmGenerationSubmitted({
      jobId: job.id,
      workerId: WORKER_ID,
      leaseToken: job.leaseToken,
      providerJobId: `hero-render:${job.id}`,
    });
  }
  return renderStoryFilmFinal(job.id);
}

async function processJob(job: LeasedStoryFilmJob) {
  let leaseHealthy = true;
  const heartbeat = setInterval(() => {
    void heartbeatStoryFilmGenerationJob({
      jobId: job.id,
      workerId: WORKER_ID,
      leaseToken: job.leaseToken,
    }).catch((error) => {
      leaseHealthy = false;
      console.error(`[story-film-system] ${job.id} heartbeat failed:`, error);
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const artifact = job.kind === "storyboard_plan"
      ? await persistStoryboard(job).then((stored) => ({
          storageUrl: `/api/renders/${path.basename(stored.finalPath)}`,
          mimeType: "application/json",
          sizeBytes: stored.sizeBytes,
          metadata: { planner: "hero_text", storyboardVersion: "hero-story-film-storyboard-v1" },
        }))
      : job.kind === "narration_voice"
        ? await persistNarration(job)
        : job.kind === "final_render"
          ? await persistFinalRender(job)
        : null;
    if (!artifact) throw new Error(`unsupported Hero system job kind: ${job.kind}`);
    if (!leaseHealthy) throw new Error("Story Film system lease heartbeat was lost");
    await completeStoryFilmGenerationJob({
      jobId: job.id,
      workerId: WORKER_ID,
      leaseToken: job.leaseToken,
      artifact,
    });
    console.log(`[story-film-system] ${job.id} ${job.kind} ready for review`);
  } catch (error) {
    console.error(`[story-film-system] ${job.id} failed:`, error);
    await failStoryFilmGenerationJob({
      jobId: job.id,
      workerId: WORKER_ID,
      leaseToken: job.leaseToken,
      errorCode: `${job.kind}_failure`,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch((reportError) => console.error(`[story-film-system] ${job.id} failure report rejected:`, reportError));
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  if (await hydrateServerGeminiKeyEnv()) console.log("[story-film-system] loaded server Gemini key from DB");
  console.log(`[story-film-system] started as ${WORKER_ID}`);
  const active = new Set<Promise<void>>();
  while (running) {
    const jobs = await leaseStoryFilmGenerationJobs({
      workerId: WORKER_ID,
      providerBackends: ["hero_text", "hero_voice", "hero_render"],
      maxJobs: 2,
    }).catch((error) => {
      console.error("[story-film-system] lease failed:", error);
      return [];
    });
    for (const job of jobs) {
      const task = processJob(job);
      active.add(task);
      void task.finally(() => active.delete(task));
    }
    if (active.size >= 2) await Promise.race(active).catch(() => {});
    else if (jobs.length === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  await Promise.allSettled(active);
  await prisma.$disconnect();
  console.log("[story-film-system] stopped");
}

void main().catch(async (error) => {
  console.error("[story-film-system] fatal:", error);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});

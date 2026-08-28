// Long-lived Hero-owned adapter worker for provider-neutral Story Film jobs.
// Grok subscription jobs stay on Mew's Mac mini; this process currently drains
// Hero text, voice and final-render lanes and never owns creator approvals.
import "dotenv/config";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
import { decryptKey } from "../src/lib/key-crypto";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";
import { synthesizeElevenLabsV3 } from "../src/lib/elevenlabs-v3.server";
import {
  storyFilmCaptionTrackFromTtsTiming,
  type StoryFilmCaptionTrack,
} from "../src/lib/story-film-editorial";
import type { TtsTiming } from "../src/lib/tts-timing";
import { alignStoryFilmPresenterCaptions } from "../src/lib/story-film-caption-alignment.server";

const POLL_MS = Math.max(1_000, Number(process.env.STORY_FILM_SYSTEM_POLL_MS) || 4_000);
const HEARTBEAT_MS = 30_000;
const WORKER_ID = `hero-story-film-system:${hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`;
const rendersDir = path.join(process.cwd(), "public", "renders");
let running = true;
const execFileAsync = promisify(execFile);

class NonRetryableStoryFilmProviderError extends Error {}

function compactCaptionTrack(track: StoryFilmCaptionTrack | null) {
  if (!track) return undefined;
  // Artifact metadata is intentionally capped. Sentence captions remain exact;
  // only the optional word-density modes fall back when an unusually long Thai
  // word timeline would make metadata too large.
  return JSON.stringify(track).length <= 75_000 ? track : { ...track, words: [] };
}

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

function localRenderPath(rawUrl: string) {
  const match = /^\/api\/renders\/([A-Za-z0-9._-]+)$/u.exec(rawUrl);
  if (!match || match[1] !== path.basename(match[1])) throw new Error("caption alignment requires a local Narration Master");
  return path.join(rendersDir, match[1]);
}

async function persistCaptionAlignment(job: LeasedStoryFilmJob) {
  const finalPath = path.join(rendersDir, `story-film-caption-track-${job.id}.json`);
  try {
    const existing = await fs.readFile(finalPath);
    const parsed = JSON.parse(existing.toString("utf8")) as { track?: StoryFilmCaptionTrack | null; reason?: string | null };
    if (!job.resumeProviderJobId) {
      await markStoryFilmGenerationSubmitted({
        jobId: job.id,
        workerId: WORKER_ID,
        leaseToken: job.leaseToken,
        providerJobId: `gemini-alignment:recovered:${job.id}`,
      });
    }
    return {
      storageUrl: `/api/renders/${path.basename(finalPath)}`,
      mimeType: "application/vnd.hero.caption-track+json",
      sizeBytes: existing.byteLength,
      durationMs: Number(job.payload.narrationDurationMs) || undefined,
      metadata: {
        adapter: "gemini_forced_alignment",
        captionTimingSource: parsed.track ? "forced_alignment" : "storyboard_fallback",
        reason: parsed.reason ?? null,
        recovered: true,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (job.resumeProviderJobId) {
    throw new NonRetryableStoryFilmProviderError(
      "Gemini alignment was already submitted but no durable caption track exists; refusing to spend twice",
    );
  }
  const project = await prisma.storyFilmProject.findUnique({ where: { id: job.projectId } });
  if (!project) throw new Error("caption alignment project is missing");
  const apiKey = process.env.GEMINI_SERVER_KEY?.trim();
  const narrationMasterUrl = payloadText(job, "narrationMasterUrl", 2_000);
  const script = payloadText(job, "script", 12_000);
  const durationMs = Number(job.payload.narrationDurationMs);
  if (!(durationMs > 0) || durationMs > 180_000) throw new Error("invalid caption alignment duration");
  await markStoryFilmGenerationSubmitted({
    jobId: job.id,
    workerId: WORKER_ID,
    leaseToken: job.leaseToken,
    providerJobId: `gemini-alignment:${job.id}`,
  });
  let aligned: Awaited<ReturnType<typeof alignStoryFilmPresenterCaptions>>;
  if (!apiKey) {
    aligned = { track: null, reason: "server_gemini_key_missing" };
  } else {
    try {
      aligned = await alignStoryFilmPresenterCaptions({
        videoPath: localRenderPath(narrationMasterUrl),
        script,
        durationMs,
        apiKey,
      });
    } catch (error) {
      // Alignment improves editorial timing but must never block the film.
      // Persist the explicit fallback so Studio and render metadata stay honest.
      aligned = {
        track: null,
        reason: `provider_failure:${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      };
    }
  }
  const encoded = Buffer.from(`${JSON.stringify(aligned)}\n`, "utf8");
  if (encoded.byteLength > 2 * 1024 * 1024) throw new Error("caption track exceeds 2 MB");
  await fs.mkdir(rendersDir, { recursive: true });
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, encoded, { flag: "wx" });
  await fs.rename(temporaryPath, finalPath);
  return {
    storageUrl: `/api/renders/${path.basename(finalPath)}`,
    mimeType: "application/vnd.hero.caption-track+json",
    sizeBytes: encoded.byteLength,
    durationMs,
    metadata: {
      adapter: "gemini_forced_alignment",
      captionTimingSource: aligned.track ? "forced_alignment" : "storyboard_fallback",
      reason: aligned.reason,
      captionCount: aligned.track?.captions.length ?? 0,
    },
  };
}

function payloadText(job: LeasedStoryFilmJob, key: string, max: number) {
  const value = job.payload[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`invalid payload.${key}`);
  return value.trim();
}

async function persistHeroVoiceNarration(job: LeasedStoryFilmJob) {
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
  const captionTrack = compactCaptionTrack(storyFilmCaptionTrackFromTtsTiming(
    result.timing,
    result.audioDurationMs,
    "hero_voice_timing",
  ));
  return {
    storageUrl: result.voiceUrl,
    mimeType: "audio/wav",
    sizeBytes: stats.size,
    durationMs: result.audioDurationMs,
    metadata: {
      adapter: "hero_voice",
      aiGenerationJobId: voiceJob.id,
      voiceId,
      ...(captionTrack ? { captionTrack } : {}),
    },
  };
}

async function probeAudioDurationMs(filePath: string) {
  const ffprobe = getFfmpegPath().replace(/ffmpeg(\.exe)?$/, (value) => value.replace("ffmpeg", "ffprobe"));
  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath,
  ], { timeout: 10_000, encoding: "utf8" });
  const seconds = Number.parseFloat(stdout.trim());
  if (!(seconds > 0)) throw new Error("ElevenLabs narration duration unavailable");
  return Math.round(seconds * 1_000);
}

async function existingElevenLabsArtifact(filePath: string) {
  try {
    const stats = await fs.stat(filePath);
    const durationMs = await probeAudioDurationMs(filePath);
    return { stats, durationMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function persistElevenLabsNarration(job: LeasedStoryFilmJob) {
  const project = await prisma.storyFilmProject.findUnique({
    where: { id: job.projectId },
    include: { user: { select: { id: true, elevenlabsKey: true } } },
  });
  if (!project || project.stage !== "narration" || project.generationEpoch !== job.generationEpoch) {
    throw new Error("narration job is stale");
  }
  const text = payloadText(job, "text", 5_000);
  const voiceId = payloadText(job, "voiceId", 160);
  const rawSpeed = Number(job.payload.speed);
  const speed = Number.isFinite(rawSpeed) ? Math.min(1.2, Math.max(0.7, rawSpeed)) : 1;
  if (!project.user.elevenlabsKey) throw new Error("ElevenLabs API key is not configured");

  const filename = `story-film-narration-${job.id}.mp3`;
  const finalPath = path.join(rendersDir, filename);
  const recovered = await existingElevenLabsArtifact(finalPath);
  if (recovered) {
    if (!job.resumeProviderJobId) {
      await markStoryFilmGenerationSubmitted({
        jobId: job.id,
        workerId: WORKER_ID,
        leaseToken: job.leaseToken,
        providerJobId: `elevenlabs-v3:recovered:${job.id}`,
      });
    }
    return {
      storageUrl: `/api/renders/${filename}`,
      mimeType: "audio/mpeg",
      sizeBytes: recovered.stats.size,
      durationMs: recovered.durationMs,
      metadata: { adapter: "elevenlabs", modelId: "eleven_v3", voiceId, recovered: true },
    };
  }
  if (job.resumeProviderJobId) {
    throw new NonRetryableStoryFilmProviderError(
      "ElevenLabs request was already submitted but its durable audio is missing; refusing to spend quota twice",
    );
  }

  await markStoryFilmGenerationSubmitted({
    jobId: job.id,
    workerId: WORKER_ID,
    leaseToken: job.leaseToken,
    providerJobId: `elevenlabs-v3:${job.id}`,
  });

  let result;
  try {
    result = await synthesizeElevenLabsV3({
      apiKey: decryptKey(project.user.elevenlabsKey),
      voiceId,
      text,
      languageCode: "th",
      speed,
      label: `story-film:${project.id}`,
    });
  } catch (error) {
    throw new NonRetryableStoryFilmProviderError(
      `ElevenLabs response was uncertain after submission: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!result.ok) {
    throw new NonRetryableStoryFilmProviderError(
      `ElevenLabs v3 failed (${result.status}): ${result.errBody.slice(0, 200)}`,
    );
  }

  await fs.mkdir(rendersDir, { recursive: true });
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, result.mp3, { flag: "wx" });
  await fs.rename(temporaryPath, finalPath);
  const stats = await fs.stat(finalPath);
  const durationMs = await probeAudioDurationMs(finalPath);
  const alignment = result.alignment;
  const timing: TtsTiming | null = alignment && alignment.characters.length > 0
    ? {
        provider: "elevenlabs",
        segments: [{
          text: alignment.characters.join(""),
          startMs: 0,
          durationMs,
        }],
        chars: {
          characters: alignment.characters,
          startSec: alignment.character_start_times_seconds,
          endSec: alignment.character_end_times_seconds,
        },
      }
    : null;
  const captionTrack = compactCaptionTrack(storyFilmCaptionTrackFromTtsTiming(
    timing,
    durationMs,
    "elevenlabs_alignment",
  ));
  return {
    storageUrl: `/api/renders/${filename}`,
    mimeType: "audio/mpeg",
    sizeBytes: stats.size,
    durationMs,
    metadata: {
      adapter: "elevenlabs",
      modelId: "eleven_v3",
      voiceId,
      speed,
      ...(captionTrack ? { captionTrack } : {}),
    },
  };
}

async function persistNarration(job: LeasedStoryFilmJob) {
  return job.providerBackend === "elevenlabs"
    ? persistElevenLabsNarration(job)
    : persistHeroVoiceNarration(job);
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
      : job.kind === "caption_alignment"
        ? await persistCaptionAlignment(job)
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
      retryable: !(error instanceof NonRetryableStoryFilmProviderError),
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
      providerBackends: ["hero_text", "hero_alignment", "hero_voice", "elevenlabs", "hero_render"],
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

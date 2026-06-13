import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { refundClipUsage } from "@/lib/usage-limits";
import { captionsFromTtsTiming } from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { setJobStep, finishJob, failJob } from "@/lib/mcp/video-job";
import { pipelineCaller, pollRender, type PipelineCaller } from "@/lib/mcp/pipeline-client";
import {
  DEFAULT_STOCK_SOURCE, RENDER_FPS, RENDER_JPEG_QUALITY, maxCardCharsFor,
  buildKeywordsPayload, buildStockPayload, buildConfigPayload, buildBurnConfig, type OrchCaption,
} from "@/lib/mcp/orchestrator-steps";

export interface OrchestratorDeps {
  caller?: PipelineCaller;
  refundOneClip?: (userId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

interface CreateInput { script: string; title?: string; voiceProvider?: "gemini" | "elevenlabs"; voiceId?: string }

export async function runOrchestrator(jobId: string, userId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const caller = deps.caller ?? pipelineCaller(userId);
  const refund = deps.refundOneClip ?? refundClipUsage;
  const sleep = deps.sleep;
  try {
    const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    const input = JSON.parse(job.inputJson) as CreateInput;
    const user = (await prisma.user.findUnique({ where: { id: userId } })) as User;
    const provider = input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");

    // 1. TTS
    await setJobStep(jobId, "tts", 10);
    const tts = provider === "elevenlabs"
      ? await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts", { text: input.script, voiceId: input.voiceId ?? user.elevenlabsVoiceId ?? undefined, languageCode: "th" })
      : await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts-gemini", { text: input.script, voiceName: user.geminiVoiceName ?? "Aoede" });
    const audioDurationMs = tts.audioDurationMs ?? 0;

    // 2. Captions (in-process, reuse the pure editor helper)
    await setJobStep(jobId, "captions", 25);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor());
    if (!capRes || capRes.captions.length === 0) throw new Error("ไม่มี subtitle timing จาก TTS — ลองใหม่อีกครั้ง");
    const captions = capRes.captions as OrchCaption[];
    const durMs = capRes.audioDurationMs || audioDurationMs;

    // 3. Keywords
    await setJobStep(jobId, "keywords", 40);
    const kw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][] }>(
      "/api/videos/extract-keywords", buildKeywordsPayload(captions.map((c) => c.text), input.script, durMs),
    );

    // 4. Stock
    await setJobStep(jobId, "stock", 55);
    const totalDur = (kw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(durMs / 1000);
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock", buildStockPayload(kw.keywords ?? [], totalDur, DEFAULT_STOCK_SOURCE, captions, kw.visualDirection, kw.keywordAlternatives),
    );

    // 5. Config
    await setJobStep(jobId, "config", 65);
    const sceneClipCounts = captions.length === (kw.keywords ?? []).length ? captions.map(() => 1) : (kw.sceneClipCounts ?? []);
    const cfgRes = await caller.post<{ config: Record<string, unknown> }>(
      "/api/videos/generate-config",
      buildConfigPayload(captions, stock.results ?? [], tts.voiceUrl, durMs, captions.map((c) => c.text), kw.keywordsPerScene ?? 5, sceneClipCounts, kw.sceneDurations ?? []),
    );

    // 6. Base render (no burned subs) → poll
    await setJobStep(jobId, "render", 75);
    const r1 = await caller.post<{ jobId: string }>("/api/videos/render", {
      shortVideoConfig: { ...cfgRes.config, keywordPopups: [] }, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
    });
    const baseUrl = await pollRender(caller, r1.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep });

    // 7. Create Video row (PROCESSING)
    const created = await caller.post<{ id: string }>("/api/videos", {
      videoUrl: baseUrl, audioUrl: tts.voiceUrl, thumbnail: null, script: input.script.trim() || null,
      avatarModel: "none", voiceModel: provider === "elevenlabs" ? (input.voiceId ?? "elevenlabs") : (user.geminiVoiceName ?? "gemini"),
      sceneCount: captions.length, renderConfig: cfgRes.config, status: "PROCESSING",
    });

    // 8. Burn subtitles (2nd render) → refund 1 clip so 1 video = 1 clip
    await setJobStep(jobId, "burn", 88);
    const r2 = await caller.post<{ jobId: string }>("/api/videos/render", { subtitleOverlayConfig: buildBurnConfig(baseUrl, captions, durMs, RENDER_FPS) });
    const burnedUrl = await pollRender(caller, r2.jobId, (pct) => { void setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep });
    await refund(userId).catch(() => {});

    // 9. Update Video row → COMPLETED (the gallery route is PATCH — see /api/videos/[id])
    await caller.patch(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

    await finishJob(jobId, { videoUrl: burnedUrl, videoId: created.id });
  } catch (e) {
    await failJob(jobId, e instanceof Error ? e.message : "internal error");
  }
}

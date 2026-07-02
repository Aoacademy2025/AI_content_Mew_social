import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { refundClipUsage } from "@/lib/usage-limits";
import { captionsFromTtsTiming } from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { setJobStep, finishJob, failJob } from "@/lib/mcp/video-job";
import { pipelineCaller, pollRender, type PipelineCaller } from "@/lib/mcp/pipeline-client";
import {
  DEFAULT_STOCK_SOURCE, RENDER_FPS, RENDER_JPEG_QUALITY, maxCardCharsFor,
  buildKeywordsPayload, buildStockPayload, buildConfigPayload, buildBurnConfig, type OrchCaption,
  cardsByWordCount, POSITION_TOP_PERCENT,
} from "@/lib/mcp/orchestrator-steps";
import { runAvatarComposite } from "@/lib/mcp/avatar-steps";
import { resolveBgm, moodMenu } from "@/lib/mcp/bgm-resolve";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { buildBrollWindows } from "@/lib/broll-windows";
import type { ScriptCard, TtsTiming } from "@/lib/tts-timing";

export interface OrchestratorDeps {
  caller?: PipelineCaller;
  refundOneClip?: (userId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

interface CreateInput {
  script: string; title?: string; voiceProvider?: "gemini" | "elevenlabs"; voiceId?: string;
  avatarMode?: "full" | "bookend" | "bookend-both"; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number;
  avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number;
  bgmFile?: string; bgmVolume?: number;
  subtitleMode?: "sentence" | "1" | "2" | "3" | "4";
  subtitlePosition?: "top" | "middle" | "bottom";
  /** Per-job Gemini voice override (Editor v2) — falls back to user.geminiVoiceName. */
  geminiVoiceName?: string;
  /**
   * Editor v2 background render (ADR 0001): stop after the base render (+ avatar
   * composite if any) WITHOUT burning subtitles; persist captions/config in
   * outputJson v2 so the web editor resumes at the subtitle phase and burns there.
   * MCP clients never send this — the full path below is byte-identical without it.
   */
  previewMode?: boolean;
}

export async function runOrchestrator(jobId: string, userId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const caller = deps.caller ?? pipelineCaller(userId);
  const refund = deps.refundOneClip ?? refundClipUsage;
  const sleep = deps.sleep;

  // P3: server-side stage telemetry — emitted from the worker so stage done/fail is
  // recorded even when no browser is attached (the web editor emits client-side and
  // loses events on tab-close). Maps worker phase → canonical insights step name.
  // Fire-and-forget + fail-open: telemetry must NEVER break the pipeline.
  const pipelineRunId = `mcp_${jobId}`;
  const STEP_TELEMETRY_NAME: Record<string, string> = {
    tts: "tts", keywords: "keywords", stock: "fetchStock",
    config: "config", render: "render", avatar: "avatar", burn: "burnSubtitles",
  };
  const jobStartedAt = Date.now();
  let phaseName = "startup";
  let phaseStartedAt = jobStartedAt;
  const timings: Array<[string, number]> = [];
  function emitStage(phase: string, status: "started" | "done" | "error", durationMs?: number, extra?: Record<string, unknown>) {
    const step = STEP_TELEMETRY_NAME[phase];
    if (!step) return; // skip startup/captions and other non-pipeline phases
    void recordTelemetryEvent(userId, {
      name: status === "started" ? "pipeline_step_started" : status === "done" ? "pipeline_step_done" : "pipeline_step_error",
      category: status === "error" ? "error" : "pipeline",
      source: "server",
      step,
      status,
      durationMs: durationMs != null && durationMs >= 0 ? Math.round(durationMs) : null,
      properties: { pipelineRunId, jobId, via: "mcp", ...extra },
    }).catch(() => {});
  }
  // step() logs the phase that just ended (worker log, for audits) + emits its `done`
  // telemetry, then advances and emits the new phase's `started`. Render/burn progress
  // callbacks keep calling setJobStep directly so they don't spam this.
  async function step(name: string, progress: number) {
    const now = Date.now();
    const ended = now - phaseStartedAt;
    timings.push([phaseName, ended]);
    console.log(`[mcp-worker] job ${jobId} step=${phaseName} ${(ended / 1000).toFixed(1)}s`);
    emitStage(phaseName, "done", ended);
    phaseName = name;
    phaseStartedAt = now;
    emitStage(name, "started");
    await setJobStep(jobId, name, progress);
  }

  try {
    const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.userId !== userId) { await failJob(jobId, "forbidden: job/user mismatch"); return; } // defense-in-depth (IDOR guard)
    const input = JSON.parse(job.inputJson) as CreateInput;
    const user = (await prisma.user.findUnique({ where: { id: userId } })) as User;
    const provider = input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");

    // Resolve BGM (path | track title | mood word like "ชิล"/"chill"/"ดราม่า") → a
    // real /music path. In chat the client usually sends a title or mood, not a path,
    // so without this the renderer gets <Audio src="Groove"> and crashes. Unresolvable
    // → fail fast with the mood menu; music-list fetch failure → drop bgm rather than
    // block the whole video over decorative music.
    if (input.bgmFile) {
      const rawBgm = input.bgmFile; // narrowed string — keep for the catch (input.bgmFile gets reassigned below)
      try {
        const lib = await caller.get<{ tracks?: { title: string; filename: string }[]; userTracks?: { title: string; filename: string }[] }>("/api/music");
        const bgmTracks = [
          ...(lib.tracks ?? []).map((t) => ({ title: t.title, bgmFile: `/music/${t.filename}` })),
          ...(lib.userTracks ?? []).map((t) => ({ title: t.title, bgmFile: `/api/music/${t.filename}` })),
        ];
        const res = resolveBgm(rawBgm, bgmTracks);
        if (res.kind === "resolved") input.bgmFile = res.bgmFile;
        else if (res.kind === "none") input.bgmFile = undefined;
        else { await failJob(jobId, `เพลงประกอบ "${rawBgm}" ไม่พบในระบบ — เลือกแนวเพลง: ${moodMenu()}`); return; }
      } catch {
        if (!rawBgm.startsWith("/")) input.bgmFile = undefined; // can't resolve a name without the list → drop, don't fail the video
      }
    }

    // 1. TTS
    await step("tts", 10);
    const tts = provider === "elevenlabs"
      ? await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts", { text: input.script, voiceId: input.voiceId ?? user.elevenlabsVoiceId ?? undefined, languageCode: "th" })
      : await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts-gemini", { text: input.script, voiceName: input.geminiVoiceName ?? user.geminiVoiceName ?? "Aoede" });
    const audioDurationMs = tts.audioDurationMs ?? 0;

    // 2. Captions (in-process, reuse the pure editor helper)
    await step("captions", 25);
    // Sentence-mode PARITY with the web editor: the editor first calls /api/videos/split-script
    // (an LLM that cuts on natural breath points — keeps a number and its unit together, never
    // splits mid-phrase) and feeds those cards into captionsFromTtsTiming. Without it the MCP
    // path fell back to the greedy char-cap splitter, so cards broke mid-phrase and the renderer's
    // word-break wrapped them awkwardly ("ตัดคำ/เว้นบรรทัดเพี้ยน"). Text-only over the exact TTS
    // text (timing stays 100% TTS-derived), server-validated verbatim; ANY failure → viralCards
    // null → byte-identical to the old deterministic cards (fail-open). Only sentence mode uses
    // these cards — word modes re-split capRes.words below, so skip the extra call there.
    const wantsSentenceCards = !input.subtitleMode || input.subtitleMode === "sentence";
    const timingForCards = tts.timing as TtsTiming | null;
    const fullTextForCards = (timingForCards?.segments ?? []).map((s) => s.text).join("");
    let viralCards: ScriptCard[] | null = null;
    if (wantsSentenceCards && fullTextForCards.length >= 120) {
      try {
        const sc = await caller.post<{ cards?: ScriptCard[] }>("/api/videos/split-script", {
          text: fullTextForCards,
          maxCardChars: maxCardCharsFor(),
        });
        viralCards = Array.isArray(sc.cards) ? sc.cards : null;
      } catch { /* fail-open → deterministic sentence cards */ }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor(), viralCards);
    if (!capRes || capRes.captions.length === 0) throw new Error("ไม่มี subtitle timing จาก TTS — ลองใหม่อีกครั้ง");
    const baseCaptions = capRes.captions as OrchCaption[];
    const captions = (input.subtitleMode && input.subtitleMode !== "sentence")
      ? cardsByWordCount(capRes.words, parseInt(input.subtitleMode), capRes.fullText)
      : baseCaptions;
    const durMs = capRes.audioDurationMs || audioDurationMs;

    // B-roll cadence PARITY with the web editor: group captions into ~4s windows so the
    // background holds one clip per window instead of cutting on every caption (the strobing
    // "พื้นหลังไม่เนียน / แล้วตัด"). Gated on the SAME flag as web so both surfaces stay in
    // lockstep. In window mode generate-config places one clip per window (ignoring
    // sceneClipCounts); subtitle timing is untouched.
    const brollWindowMode = process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE === "1";
    const brollWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
    const brollWindows = brollWindowMode
      ? buildBrollWindows(captions.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), brollWindowSec)
      : [];

    // 3. Keywords
    await step("keywords", 40);
    const kw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][]; relevanceSpec?: unknown }>(
      "/api/videos/extract-keywords", buildKeywordsPayload(captions.map((c) => c.text), input.script, durMs),
    );

    // 4. Stock
    await step("stock", 55);
    const totalDur = (kw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(durMs / 1000);
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock", buildStockPayload(kw.keywords ?? [], totalDur, DEFAULT_STOCK_SOURCE, captions, kw.visualDirection, kw.keywordAlternatives, kw.relevanceSpec),
    );

    // 5. Config
    await step("config", 65);
    // Window mode → empty sceneClipCounts so generate-config takes the window branch (one clip
    // per window) instead of per-caption cycling; brollWindows below carries the spans (mirrors
    // web page.tsx runConfig). Otherwise keep the legacy 1-clip-per-caption path.
    const sceneClipCounts = brollWindows.length > 0
      ? []
      : (captions.length === (kw.keywords ?? []).length ? captions.map(() => 1) : (kw.sceneClipCounts ?? []));
    const cfgRes = await caller.post<{ config: Record<string, unknown> }>(
      "/api/videos/generate-config",
      buildConfigPayload(
        captions, stock.results ?? [], tts.voiceUrl, durMs, captions.map((c) => c.text),
        kw.keywordsPerScene ?? 5, sceneClipCounts, kw.sceneDurations ?? [],
        brollWindows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
      ),
    );

    // 6. Base render (no burned subs) → poll
    await step("render", 75);
    const baseConfig = { ...cfgRes.config, keywordPopups: [] as unknown[], ...(input.bgmFile ? { bgmFile: input.bgmFile, bgmVolume: input.bgmVolume ?? 0.12 } : {}) };
    const r1 = await caller.post<{ jobId: string }>("/api/videos/render", {
      shortVideoConfig: baseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
    });
    const baseUrl = await pollRender(caller, r1.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep });
    // Base render reserved 1 clip; the burn render will reserve another. Refund the base's
    // reservation NOW so a finished video nets exactly 1 clip, and a burn-stage failure (the
    // burn route refunds its own clip) nets 0 — never over-charges for an undelivered video.
    // PREVIEW MODE: no burn follows in this job, so the base reservation must STAND as the
    // single charge (same as the web editor's preview render today) — skip the refund.
    if (!input.previewMode) await refund(userId).catch(() => {});

    // 6b. Avatar (optional) — generate + composite onto the base render.
    let finalBase = baseUrl;
    let avatarModel = "none";
    let avatarVideoUrl: string | null = null;
    if (input.avatarMode) {
      // Defense-in-depth: the route only ever persists avatarMode together with a
      // resolved avatarId, but the worker reads inputJson directly — fail cleanly on a
      // malformed job rather than generating with avatarModel=undefined.
      if (!input.avatarId) throw new Error("avatar job missing avatarId");
      await step("avatar", 80);
      const av = await runAvatarComposite(caller, {
        baseUrl, ttsAudioUrl: tts.voiceUrl, avatarMode: input.avatarMode, avatarId: input.avatarId,
        introSecs: input.avatarIntroSecs ?? 5, tailSecs: input.avatarTailSecs ?? 5, sleep,
        layout: { scale: input.avatarScale ?? 1, offsetX: input.avatarOffsetX ?? 0, offsetY: input.avatarOffsetY ?? 0 },
        onStep: (label) => { void setJobStep(jobId, label, 84).catch(() => {}); },
      });
      finalBase = av.compositeUrl;
      avatarModel = input.avatarId;
      avatarVideoUrl = av.avatarUrl;
    }

    // PREVIEW MODE (Editor v2): stop here — no burn, no gallery Video row (the web burn
    // step creates it, exactly like today's web flow; also avoids PROCESSING ghost rows).
    // outputJson v2 carries everything the editor's subtitle phase needs.
    if (input.previewMode) {
      const previewDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, previewDuration]);
      emitStage(phaseName, "done", previewDuration);
      const totalPreviewS = (Date.now() - jobStartedAt) / 1000;
      console.log(`[mcp-worker] job ${jobId} PREVIEW TIMINGS total=${totalPreviewS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);
      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: finalBase,
        preview: {
          captions,
          config: baseConfig,
          voiceUrl: tts.voiceUrl,
          audioDurationMs: durMs,
          avatarModel,
          avatarVideoUrl,
        },
      });
      return;
    }

    // 7. Create Video row (PROCESSING)
    const created = await caller.post<{ id: string }>("/api/videos", {
      videoUrl: finalBase, audioUrl: tts.voiceUrl, thumbnail: null, script: input.script.trim() || null,
      avatarModel, avatarVideoUrl, voiceModel: provider === "elevenlabs" ? (input.voiceId ?? "elevenlabs") : (user.geminiVoiceName ?? "gemini"),
      sceneCount: captions.length, renderConfig: baseConfig, status: "PROCESSING",
    });

    // 8. Burn subtitles onto the (possibly avatar-composited) base.
    await step("burn", 88);
    const subTop = input.subtitlePosition ? POSITION_TOP_PERCENT[input.subtitlePosition] : undefined;
    const r2 = await caller.post<{ jobId: string }>("/api/videos/render", { subtitleOverlayConfig: buildBurnConfig(finalBase, captions, durMs, RENDER_FPS, subTop) });
    const burnedUrl = await pollRender(caller, r2.jobId, (pct) => { void setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep });

    // 9. Update Video row → COMPLETED (the gallery route is PATCH — see /api/videos/[id])
    await caller.patch(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

    // flush final phase + emit one-line breakdown for audits
    const finalDuration = Date.now() - phaseStartedAt;
    timings.push([phaseName, finalDuration]);
    emitStage(phaseName, "done", finalDuration); // final phase (burn) done
    const totalS = (Date.now() - jobStartedAt) / 1000;
    console.log(`[mcp-worker] job ${jobId} TIMINGS total=${totalS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);

    await finishJob(jobId, { videoUrl: burnedUrl, videoId: created.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    emitStage(phaseName, "error", Date.now() - phaseStartedAt, { message });
    await failJob(jobId, message);
  }
}

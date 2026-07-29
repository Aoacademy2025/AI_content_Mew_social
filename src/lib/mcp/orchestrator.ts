import type { User } from "@prisma/client";
import { isOmniVoiceUserAllowed } from "@/lib/omnivoice-policy";
import { prisma } from "@/lib/prisma";
import { refundVideoJobBaseReservation } from "@/lib/render/reservation-settlement";
import { captionsFromTtsTiming } from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import {
  setJobStep,
  finishJob,
  finishJobWithTransition,
  failJob,
  clearProviderCheckpoint,
  parseVideoJobOutput,
  parkHeroVoiceProviderJob,
  parkProviderJob,
  saveProviderCheckpoint,
  VIDEO_JOB_CANCELED_ERROR,
} from "@/lib/mcp/video-job";
import { validateWindowEdits, mergeWindowEdits, type WindowEdit } from "@/lib/broll-rerender";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { pipelineCaller, pollRender, type PipelineCaller } from "@/lib/mcp/pipeline-client";
import {
  DEFAULT_STOCK_SOURCE, RENDER_FPS, RENDER_JPEG_QUALITY, maxCardCharsFor,
  buildKeywordsPayload, buildStockPayload, buildConfigPayload, buildBurnConfig, type OrchCaption,
  cardsByWordCount, POSITION_TOP_PERCENT, buildDegradedTimingTelemetry,
} from "@/lib/mcp/orchestrator-steps";
import {
  compositeAvatarVideo,
  generateAvatarVideo,
  pollAvatarOnce,
  prepareAvatarAudio,
} from "@/lib/mcp/avatar-steps";
import {
  parseAvatarProviderCheckpoint,
  providerPollDelayMs,
  type AvatarProviderCheckpointV1,
} from "@/lib/mcp/avatar-provider-checkpoint";
import {
  advanceAvatarProvider,
  type AvatarProviderAdvanceResult,
} from "@/lib/mcp/avatar-provider-resume";
import { resolveBgm, moodMenu } from "@/lib/mcp/bgm-resolve";
import {
  recordTelemetryEvent as recordServerTelemetryEvent,
  type TelemetryInput,
} from "@/lib/telemetry";
import {
  buildBrollWindows,
  buildFixedCountBrollWindows,
  type BrollWindow,
} from "@/lib/broll-windows";
import { planCutaway } from "@/lib/cutaway-plan";
import { normalizeTrustedLogoRenderInput } from "@/lib/logo-export.server";
import { buildDegradedTtsTiming } from "@/lib/tts-timing";
import type { ScriptCard, TtsTiming } from "@/lib/tts-timing";
import type { StockProvider } from "@/lib/key-preflight";
import { audioDurationLimitViolation } from "@/lib/plan-limits";
import { resolveJobTtsProvider } from "@/lib/tts-providers";
import { expandThaiSpeechAbbreviations } from "@/lib/hero-voice-speech";
import { polishScriptForTts } from "@/lib/tts-script-polish";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import {
  advanceHeroVoiceGeneration,
  cancelHeroVoiceGeneration,
  HeroVoiceGenerationError,
  heroVoiceProviderDeadlineFromJob,
  heroVoiceResultFromJob,
  startHeroVoiceGeneration,
  type HeroVoiceGenerationResult,
} from "@/lib/hero-voice-generation.server";
import {
  HERO_VOICE_PROVIDER_CHECKPOINT_VERSION,
  parseHeroVoiceProviderCheckpoint,
  type HeroVoiceProviderCheckpointV1,
} from "@/lib/mcp/hero-voice-provider-checkpoint";

class AvatarProviderFailureError extends Error {
  constructor(
    public readonly failure: Extract<AvatarProviderAdvanceResult, { kind: "failed" }>,
    public readonly reservationRefundReason?: string,
  ) {
    super(failure.message);
    this.name = "AvatarProviderFailureError";
  }
}

class AvatarReservationSettlementError extends Error {
  constructor(public readonly reservationRefundReason: string) {
    super("คืนโควตาของ base render ยังไม่สำเร็จ — ระบบบันทึกไว้เพื่อลองคืนอัตโนมัติ");
    this.name = "AvatarReservationSettlementError";
  }
}

class HeroVoiceProviderFailureError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HeroVoiceProviderFailureError";
  }
}

export interface OrchestratorDeps {
  caller?: PipelineCaller;
  refundOneClip?: (userId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  recordTelemetryEvent?: (
    userId: string | null,
    input: TelemetryInput,
  ) => Promise<unknown>;
}

interface CreateInput {
  script: string; title?: string; voiceProvider?: "gemini" | "elevenlabs" | "omnivoice"; voiceId?: string;
  /**
   * Set by the worker after the one-time silent pre-TTS polish + abbreviation
   * expansion ran and the result was persisted back into inputJson. Guarantees
   * a requeued/resumed job replays with the exact text the first run spoke.
   */
  scriptPolished?: boolean;
  /** OmniVoice voice_id — defaults to voice_01 only for legacy saved jobs. */
  omniVoiceId?: string;
  /** Backend pinned by the accepting server; never selected by a browser. */
  voiceBackend?: "runpod" | "hostinger";
  avatarMode?: "full" | "bookend" | "bookend-both"; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number;
  avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number;
  bgmFile?: string; bgmVolume?: number;
  subtitleMode?: "sentence" | "1" | "2" | "3" | "4";
  subtitlePosition?: "top" | "middle" | "bottom";
  /** Per-job Gemini voice override (Editor v2) — falls back to user.geminiVoiceName. */
  geminiVoiceName?: string;
  /**
   * B-roll source override (Editor v2): "both" (stock, default) | "kie-image" | "auto-mix".
   * Validated + admin-gated at the web route; MCP never sends it → DEFAULT_STOCK_SOURCE.
   */
  stockSource?: string;
  /** จำนวนคลิปบีโรลกำหนดเอง (Editor v2 ขั้นสูง) — absent = auto */
  targetClipCount?: number;
  /** Visual preference hints for B-roll keyword/search/ranking (Editor v2 Advanced) */
  brollRegionPreference?: string;
  brollVisualStyle?: string;
  /** โมเดลภาพ AI (Beta, admin-gated at the web route) */
  kieModel?: string;
  /** Hero AI Image is a separate RunPod-only product seam, not a KIE model. */
  imageEngine?: "runpod";
  imageModel?: "z-image-turbo";
  /** แหล่งภาพ Auto Mix (Beta, admin-gated at the web route) */
  autoMixProviders?: string[];
  /** Providers whose keys passed submit-time preflight (unknown remains fail-open). */
  stockProviders?: StockProvider[];
  /** Editor v2 mix-preset weights (D5.1) — validated at the web route; fetch-stock
   *  honors them only under MANAGED_KIE and force-zeros ai for unauthorized users. */
  autoMixWeights?: { video: number; photo: number; ai: number };
  /**
   * Editor v2 "ใช้คลิปที่ถ่ายเอง" (cutaway, launch-coupled): clip แนวตั้งของผู้ใช้
   * → transcribe เสียงในคลิป → b-roll windows → base reel → composite mode:cutaway.
   * previewMode เสมอ (ยิงจากเว็บเท่านั้น; MCP ไม่ส่ง). Route gates on CLIP_CUTAWAY flag.
   */
  mode?: "script" | "upload" | "broll-rerender" | "export";
  clipUrl?: string;
  /**
   * Editor v2 free per-window b-roll re-render (Phase 2, previewMode-only): reuse the source
   * job's TTS/avatar, swap only the named b-roll windows, re-render the base WITHOUT charging
   * minutes again (render route's server-trusted `rerenderOf` skip). Never sent by MCP.
   */
  sourceJobId?: string;
  windowEdits?: WindowEdit[];
  /**
   * Editor v2 durable final export: burn the user-edited subtitle overlay and save the
   * finished video to Gallery from the worker, not from a mounted browser component.
   */
  subtitleOverlayConfig?: Record<string, unknown>;
  exportScript?: string;
  exportSceneCount?: number;
  /**
   * Editor v2 background render (ADR 0001): stop after the base render (+ avatar
   * composite if any) WITHOUT burning subtitles; persist captions/config in
   * outputJson v2 so the web editor resumes at the subtitle phase and burns there.
   * MCP clients never send this — the full path below is byte-identical without it.
   */
  previewMode?: boolean;
}

type SourceVideoJob = {
  id: string;
  userId: string;
  inputJson: string;
  outputJson: string | null;
};

function parseCreateInput(inputJson: string): CreateInput | null {
  try {
    const value = JSON.parse(inputJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as CreateInput
      : null;
  } catch {
    return null;
  }
}

/** Canonical Gallery voice identity: the exact per-job voice wins over user defaults. */
function galleryVoiceModelForInput(
  input: CreateInput,
  user: User,
  provider = resolveJobTtsProvider(input.voiceProvider, user.ttsProvider),
): string {
  if (provider === "elevenlabs") {
    return input.voiceId ?? user.elevenlabsVoiceId ?? "elevenlabs";
  }
  if (provider === "omnivoice") return input.omniVoiceId ?? "voice_01";
  return input.geminiVoiceName ?? user.geminiVoiceName ?? "gemini";
}

/**
 * New previews persist voiceModel directly. For previews created before that field existed,
 * recover it from the server-owned source input. Old b-roll re-renders may form a short chain,
 * so follow only same-owner source jobs with a strict depth/cycle guard.
 */
async function resolveExportGalleryVoiceModel(
  initialSource: SourceVideoJob,
  userId: string,
  user: User,
): Promise<string> {
  let source: SourceVideoJob | null = initialSource;
  const seen = new Set<string>();

  for (let depth = 0; source && depth < 8 && !seen.has(source.id); depth++) {
    seen.add(source.id);
    const previewVoiceModel = parseVideoJobOutput(source.outputJson)?.preview?.voiceModel;
    if (typeof previewVoiceModel === "string" && previewVoiceModel.trim()) {
      return previewVoiceModel;
    }

    const sourceInput = parseCreateInput(source.inputJson);
    if (!sourceInput) return "unknown";
    if (sourceInput.mode === "upload") return "original-audio";
    if (sourceInput.mode !== "broll-rerender" || !sourceInput.sourceJobId) {
      return galleryVoiceModelForInput(sourceInput, user);
    }

    source = await prisma.videoJob.findFirst({
      where: { id: sourceInput.sourceJobId, userId },
      select: { id: true, userId: true, inputJson: true, outputJson: true },
    });
  }

  return "unknown";
}

export type LogoExportDurationBucket =
  | "under-30s"
  | "30-60s"
  | "1-3m"
  | "over-3m"
  | "unknown";

function logoExportDurationBucket(durationMs: unknown): LogoExportDurationBucket {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }
  if (durationMs < 30_000) return "under-30s";
  if (durationMs < 60_000) return "30-60s";
  if (durationMs < 180_000) return "1-3m";
  return "over-3m";
}

/** Allowlist-only server builder: trusted render identity never crosses into telemetry. */
export function buildLogoExportCompletedTelemetryProperties(
  subtitleOverlayConfig: unknown,
  previewDurationMs: unknown,
): { position: string; durationBucket: LogoExportDurationBucket } | null {
  if (
    !subtitleOverlayConfig
    || typeof subtitleOverlayConfig !== "object"
    || Array.isArray(subtitleOverlayConfig)
  ) {
    return null;
  }
  const trustedLogo = normalizeTrustedLogoRenderInput(
    (subtitleOverlayConfig as Record<string, unknown>).logoOverlay,
  );
  if (!trustedLogo) return null;
  return {
    position: trustedLogo.position,
    durationBucket: logoExportDurationBucket(previewDurationMs),
  };
}

function brollWindowCaptions(windows: BrollWindow[]): OrchCaption[] {
  return windows.map((w, i) => ({
    text: w.text,
    startMs: w.startMs,
    endMs: w.endMs,
    tag: i === 0 ? "hook" : "body",
  }));
}

function durationFromTtsTiming(timing: unknown): number {
  if (!timing || typeof timing !== "object" || !Array.isArray((timing as { segments?: unknown }).segments)) return 0;
  const segments = (timing as { segments: Array<{ startMs?: unknown; durationMs?: unknown }> }).segments;
  return Math.round(segments.reduce((latest, segment) => {
    const startMs = typeof segment?.startMs === "number" && Number.isFinite(segment.startMs) ? segment.startMs : 0;
    const durationMs = typeof segment?.durationMs === "number" && Number.isFinite(segment.durationMs) ? segment.durationMs : 0;
    return Math.max(latest, startMs + durationMs);
  }, 0));
}

function alignBrollWindowsToKeywords(
  windows: BrollWindow[],
  units: OrchCaption[],
  keywords: string[],
  alternatives?: string[][],
): { windows: BrollWindow[]; units: OrchCaption[]; keywords: string[]; alternatives?: string[][] } {
  if (windows.length === 0 || keywords.length === windows.length) {
    return { windows, units, keywords, alternatives };
  }

  const alignedKeywords = windows.map((window, index) =>
    keywords[index]
      ?? (keywords.length > 0 ? keywords[index % keywords.length] : undefined)
      ?? units[index]?.text
      ?? window.text
      ?? "general lifestyle",
  );
  const alignedAlternatives = alternatives
    ? windows.map((_, index) =>
        alternatives[index]
          ?? (alternatives.length > 0 ? alternatives[index % alternatives.length] : undefined)
          ?? [alignedKeywords[index]],
      )
    : undefined;
  return {
    windows,
    units,
    keywords: alignedKeywords,
    alternatives: alignedAlternatives,
  };
}

export async function runOrchestrator(jobId: string, userId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const caller = deps.caller ?? pipelineCaller(userId);
  const sleep = deps.sleep;
  const recordTelemetryEvent = deps.recordTelemetryEvent ?? recordServerTelemetryEvent;
  let baseReservationSettledThisRun = false;

  const refundBaseReservation = async (reason: string): Promise<boolean> => {
    if (baseReservationSettledThisRun) return true;
    // Tests and older embedded callers can provide the legacy seam. Production always
    // settles the exact RenderJob reservation so minutes/credits/clips are bucket-correct.
    if (deps.refundOneClip) {
      await deps.refundOneClip(userId);
      baseReservationSettledThisRun = true;
      return true;
    }

    let result;
    try {
      result = await refundVideoJobBaseReservation({
        videoJobId: jobId,
        userId,
        reason,
      });
    } catch (error) {
      emitTelemetry({
        name: "avatar_base_reservation_settlement",
        category: "error",
        source: "server",
        step: "avatar",
        status: "error",
        properties: { pipelineRunId, jobId, reason },
      });
      throw error;
    }
    emitTelemetry({
      name: "avatar_base_reservation_settlement",
      category: result.kind === "not_found" || result.kind === "ambiguous" ? "error" : "pipeline",
      source: "server",
      step: "avatar",
      status: result.kind,
      value: result.kind === "refunded" ? result.amount : null,
      properties: {
        pipelineRunId,
        jobId,
        reason,
        ...(result.kind === "refunded" ? { funding: result.funding } : {}),
      },
    });
    if (result.kind === "not_found" || result.kind === "ambiguous") {
      console.error(
        `[mcp-worker] job ${jobId} could not settle base reservation: ${result.kind} reason=${reason}`,
      );
    } else {
      baseReservationSettledThisRun = true;
    }
    return baseReservationSettledThisRun;
  };

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
  function emitTelemetry(input: TelemetryInput) {
    void Promise.resolve()
      .then(() => recordTelemetryEvent(userId, input))
      .catch(() => {});
  }
  function emitBrollStockInventory(requestedWindowCount: number, results: unknown[]) {
    const assetKeys = results.map((result, index) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return `item:${index}`;
      const asset = result as Record<string, unknown>;
      return String(
        asset.pexelsId ?? asset.id ?? asset.localUrl ?? asset.videoUrl ?? asset.imageUrl ?? `item:${index}`,
      );
    });
    emitTelemetry({
      name: "broll_stock_inventory",
      category: "pipeline",
      source: "server",
      step: "fetchStock",
      status: "done",
      properties: {
        pipelineRunId,
        jobId,
        via: "mcp",
        requestedWindowCount,
        availableAssetCount: results.length,
        distinctAssetCount: new Set(assetKeys).size,
      },
    });
  }
  function emitStage(phase: string, status: "started" | "done" | "error", durationMs?: number, extra?: Record<string, unknown>) {
    const step = STEP_TELEMETRY_NAME[phase];
    if (!step) return; // skip startup/captions and other non-pipeline phases
    emitTelemetry({
      name: status === "started" ? "pipeline_step_started" : status === "done" ? "pipeline_step_done" : "pipeline_step_error",
      category: status === "error" ? "error" : "pipeline",
      source: "server",
      step,
      status,
      durationMs: durationMs != null && durationMs >= 0 ? Math.round(durationMs) : null,
      properties: { pipelineRunId, jobId, via: "mcp", ...extra },
    });
  }
  // step() logs the phase that just ended (worker log, for audits) + emits its `done`
  // telemetry, then advances and emits the new phase's `started`. Render/burn progress
  // callbacks keep calling setJobStep directly so they don't spam this.
  async function step(name: string, progress: number) {
    // Cooperative cancel (incident 07-03: kie runaway had no stop lever): the cancel
    // route marks processing jobs `canceled`; we honor it at every step boundary —
    // the current step finishes, nothing further starts, no failJob overwrite.
    const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
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
  // Cancel mid-RENDER (QA 07-03 Flow 4.2): the render step is the only one whose cost is
  // already committed — /api/videos/render reserves minutes/credits at request time — and
  // it's the longest, so step-boundary checks alone let a canceled job render to completion
  // with the charge standing (never refunded; finishJob even flipped the job back to done).
  // Checked every poll tick: on cancel, kill the in-flight render via its cancel route —
  // the render route's own cancelled path refunds the reservation bucket-aware
  // (refundReservedClip) — then throw so the poll aborts and the job stops cleanly.
  const cancelInFlightRender = (renderJobId: string) => async () => {
    const cur = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (cur?.status !== "canceled") return;
    await caller.post(`/api/videos/render-cancel?jobId=${encodeURIComponent(renderJobId)}`, {}).catch(() => {});
    throw new Error(VIDEO_JOB_CANCELED_ERROR);
  };

  try {
    const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.userId !== userId) { await failJob(jobId, "forbidden: job/user mismatch"); return; } // defense-in-depth (IDOR guard)
    const input = JSON.parse(job.inputJson) as CreateInput;
    const user = (await prisma.user.findUnique({ where: { id: userId } })) as User;
    // One-time silent pre-TTS pass, shared by EVERY provider (Gemini/ElevenLabs/
    // Hero Voice): Gemini polish (fail-open) + deterministic abbreviation
    // expansion (จนท. → เจ้าหน้าที่, …) as the backstop when polish is skipped.
    // The result is persisted into inputJson so a requeued/resumed job replays
    // with the exact text the first run spoke — captions can never drift.
    if (!input.scriptPolished && typeof input.script === "string" && input.script.trim()) {
      const polished = await polishScriptForTts(
        { id: user.id, geminiKey: user.geminiKey, plan: user.plan },
        input.script,
        20_000,
      );
      input.script = expandThaiSpeechAbbreviations(polished.text);
      input.scriptPolished = true;
      await prisma.videoJob.update({ where: { id: jobId }, data: { inputJson: JSON.stringify(input) } });
    }
    const requestedProvider = resolveJobTtsProvider(input.voiceProvider, user.ttsProvider);
    if (requestedProvider === "omnivoice" && !isOmniVoiceUserAllowed(user)) {
      throw new Error("Hero Voice ยังไม่เปิดใช้งานสำหรับบัญชีนี้ กรุณาติดต่อทีมงานก่อนลองสร้างด้วย Hero Voice อีกครั้ง");
    }
    const provider = requestedProvider;
    let resumedHeroVoiceTts: HeroVoiceGenerationResult | null = null;
    let ttsStepAlreadyEntered = false;

    const heroVoiceCheckpointFor = (voiceJob: {
      id: string;
      createdAt: Date;
      kind: string;
      inputJson: string | null;
    }): HeroVoiceProviderCheckpointV1 => {
      const providerDeadlineAt = heroVoiceProviderDeadlineFromJob(voiceJob);
      if (!providerDeadlineAt) {
        throw new HeroVoiceProviderFailureError(
          "Hero Voice job ไม่มี provider deadline ที่บันทึกไว้",
          "OMNIVOICE_DEADLINE_MISSING",
        );
      }
      return {
        version: HERO_VOICE_PROVIDER_CHECKPOINT_VERSION,
        provider: "omnivoice",
        aiGenerationJobId: voiceJob.id,
        providerStartedAt: voiceJob.createdAt.toISOString(),
        providerDeadlineAt,
      };
    };

    const settleHeroVoiceJob = async (
      voiceJob: Awaited<ReturnType<typeof advanceHeroVoiceGeneration>>,
    ): Promise<HeroVoiceGenerationResult | null> => {
      if (voiceJob.status === "failed" || voiceJob.status === "canceled") {
        throw new HeroVoiceProviderFailureError(
          voiceJob.errorMessage ?? "Hero Voice สร้างเสียงไม่สำเร็จ",
          voiceJob.errorCode ?? "OMNIVOICE_PROVIDER_FAILED",
        );
      }
      if (voiceJob.status === "completed") {
        const result = heroVoiceResultFromJob(voiceJob);
        if (!result) {
          throw new HeroVoiceProviderFailureError(
            "Hero Voice สร้างเสียงเสร็จแต่ข้อมูลผลลัพธ์ไม่ครบ",
            "OMNIVOICE_RESULT_MISSING",
          );
        }
        return result;
      }

      const checkpoint = heroVoiceCheckpointFor(voiceJob);
      const nextPollAt = new Date(Date.now() + 5_000);
      const parked = await parkHeroVoiceProviderJob(jobId, checkpoint, nextPollAt);
      if (parked.count === 1) return null;
      const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
      if (current?.status === "canceled") {
        await cancelHeroVoiceGeneration(userId, voiceJob.id).catch(() => {});
        throw new Error(VIDEO_JOB_CANCELED_ERROR);
      }
      throw new Error("video_job_not_processing");
    };

    const persistProviderCheckpoint = async (checkpoint: AvatarProviderCheckpointV1): Promise<boolean> => {
      const saved = await saveProviderCheckpoint(jobId, checkpoint);
      return saved.count === 1;
    };

    const advanceProvider = (
      checkpoint: AvatarProviderCheckpointV1,
      allowGenerate = false,
    ) => advanceAvatarProvider(checkpoint, {
      now: () => new Date(),
      allowGenerate,
      generate: (avatarId, audioUrl) => generateAvatarVideo(caller, avatarId, audioUrl),
      poll: (providerVideoId) => pollAvatarOnce(caller, providerVideoId),
      composite: async (value) => {
        const introVideoUrl = value.avatar.introVideoUrl;
        if (!introVideoUrl) throw new Error("avatar checkpoint missing intro video URL");
        if (value.avatar.mode === "bookend-both" && !value.avatar.tailVideoUrl) {
          throw new Error("avatar checkpoint missing tail video URL");
        }
        return compositeAvatarVideo(caller, {
          baseUrl: value.baseUrl,
          avatarMode: value.avatar.mode,
          introSecs: value.avatar.introSecs,
          tailSecs: value.avatar.tailSecs,
          introVideoUrl,
          tailVideoUrl: value.avatar.tailVideoUrl,
          layout: value.avatar.layout,
        });
      },
      persist: persistProviderCheckpoint,
    });

    const finishPreparedAvatarJob = async (
      checkpoint: AvatarProviderCheckpointV1,
      compositeUrl: string,
    ): Promise<void> => {
      const avatarVideoUrl = checkpoint.avatar.introVideoUrl;
      if (!avatarVideoUrl) throw new Error("avatar checkpoint missing intro video URL");
      const captions: OrchCaption[] = checkpoint.captions.map((caption, index) => ({
        ...caption,
        tag: caption.tag ?? (index === 0 ? "hook" : "body"),
      }));

      if (input.previewMode) {
        const previewDuration = Date.now() - phaseStartedAt;
        timings.push([phaseName, previewDuration]);
        emitStage(phaseName, "done", previewDuration);
        const totalPreviewS = (Date.now() - jobStartedAt) / 1000;
        console.log(`[mcp-worker] job ${jobId} PREVIEW TIMINGS total=${totalPreviewS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);
        await finishJob(jobId, {
          version: 2,
          mode: "preview",
          videoUrl: compositeUrl,
          preview: {
            captions,
            config: checkpoint.baseConfig,
            voiceUrl: checkpoint.voiceUrl,
            voiceModel: galleryVoiceModelForInput(input, user, provider),
            audioDurationMs: checkpoint.audioDurationMs,
            avatarModel: checkpoint.avatar.id,
            avatarVideoUrl,
            avatarMode: checkpoint.avatar.mode,
            avatarIntroSecs: checkpoint.avatar.introSecs,
            avatarTailSecs: checkpoint.avatar.tailSecs,
            compositeBaseUrl: checkpoint.baseUrl,
            tailAvatarUrl: checkpoint.avatar.tailVideoUrl ?? null,
            words: checkpoint.words,
            fullText: checkpoint.fullText,
          },
        });
        return;
      }

      const created = await caller.post<{ id: string }>("/api/videos", {
        videoUrl: compositeUrl,
        audioUrl: checkpoint.voiceUrl,
        thumbnail: null,
        script: input.script.trim() || null,
        avatarModel: checkpoint.avatar.id,
        avatarVideoUrl,
        voiceModel: galleryVoiceModelForInput(input, user, provider),
        sceneCount: captions.length,
        renderConfig: checkpoint.baseConfig,
        status: "PROCESSING",
      });

      await step("burn", 88);
      const subTop = input.subtitlePosition ? POSITION_TOP_PERCENT[input.subtitlePosition] : undefined;
      const render = await caller.post<{ jobId: string }>("/api/videos/render", {
        subtitleOverlayConfig: buildBurnConfig(compositeUrl, captions, checkpoint.audioDurationMs, RENDER_FPS, subTop),
        parentJobId: jobId,
      });
      const burnedUrl = await pollRender(
        caller,
        render.jobId,
        (pct) => { void setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}); },
        { sleep, checkCanceled: cancelInFlightRender(render.jobId) },
      );
      await caller.patch(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

      const finalDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, finalDuration]);
      emitStage(phaseName, "done", finalDuration);
      const totalS = (Date.now() - jobStartedAt) / 1000;
      console.log(`[mcp-worker] job ${jobId} TIMINGS total=${totalS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);
      await finishJob(jobId, { videoUrl: burnedUrl, videoId: created.id });
    };

    const settleProviderAdvance = async (result: AvatarProviderAdvanceResult): Promise<void> => {
      if (result.kind === "failed") {
        if (result.message === "provider checkpoint guard rejected") {
          const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
          if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
        }
        let reservationRefundReason: string | undefined;
        if (result.outcome === "definitive") {
          const reason = `avatar-provider-${result.code ?? "rejected"}`;
          const settled = await refundBaseReservation(reason).catch((error) => {
            console.error(`[mcp-worker] job ${jobId} failed to refund base reservation`, error);
            return false;
          });
          if (!settled) reservationRefundReason = reason;
        }
        throw new AvatarProviderFailureError(result, reservationRefundReason);
      }
      if (result.kind === "ready") {
        await finishPreparedAvatarJob(result.checkpoint, result.compositeUrl);
        return;
      }

      const nowMs = Date.now();
      const delayMs = providerPollDelayMs(Date.parse(result.checkpoint.providerStartedAt), nowMs, result.retryAfterSec);
      const parked = await parkProviderJob(jobId, result.checkpoint, new Date(nowMs + delayMs));
      if (parked.count === 1) return;
      const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
      if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
      throw new Error("video_job_not_processing");
    };

    const rawProviderCheckpoint = job.providerCheckpointJson;
    const heroVoiceCheckpoint = parseHeroVoiceProviderCheckpoint(rawProviderCheckpoint);
    if (heroVoiceCheckpoint) {
      if (provider !== "omnivoice") {
        throw new HeroVoiceProviderFailureError(
          "งานนี้ถูกบันทึกให้ใช้ Hero Voice แต่ provider ของงานเปลี่ยนไป",
          "OMNIVOICE_PROVIDER_PIN_MISMATCH",
        );
      }
      await step("tts", 10);
      ttsStepAlreadyEntered = true;
      const voiceJob = await advanceHeroVoiceGeneration(userId, heroVoiceCheckpoint.aiGenerationJobId);
      resumedHeroVoiceTts = await settleHeroVoiceJob(voiceJob);
      if (!resumedHeroVoiceTts) return;
      const cleared = await clearProviderCheckpoint(jobId, rawProviderCheckpoint!);
      if (cleared.count !== 1) {
        const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
        if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
        throw new HeroVoiceProviderFailureError(
          "Hero Voice checkpoint เปลี่ยนก่อนบันทึกผลลัพธ์",
          "OMNIVOICE_CHECKPOINT_CONFLICT",
        );
      }
    }
    const providerCheckpoint = parseAvatarProviderCheckpoint(rawProviderCheckpoint);
    if (rawProviderCheckpoint && !providerCheckpoint && !heroVoiceCheckpoint) {
      throw new Error("invalid avatar provider checkpoint - manual recovery required");
    }
    if (providerCheckpoint) {
      await step(providerCheckpoint.phase === "composite" ? "composite" : "avatar", providerCheckpoint.phase === "composite" ? 86 : 84);
      await settleProviderAdvance(await advanceProvider(providerCheckpoint));
      return;
    }

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

    // ── EDITOR V2 FREE PER-WINDOW B-ROLL RE-RENDER (Phase 2, previewMode-only) ──
    // Reuse the SOURCE preview's captions/TTS/avatar; swap only the edited b-roll windows;
    // re-render the base for FREE (render route's server-trusted `rerenderOf` skip — never a
    // client flag). Subtitle timing is untouched: captions/voiceUrl/words/audioDurationMs are
    // copied through verbatim. MCP never sends this mode.
    if (input.mode === "broll-rerender") {
      if (!input.sourceJobId) { await failJob(jobId, "broll-rerender job missing sourceJobId"); return; }
      const src = await prisma.videoJob.findUnique({ where: { id: input.sourceJobId } });
      if (!src || src.userId !== userId) { await failJob(jobId, "ไม่พบวิดีโอต้นฉบับ หรือไม่มีสิทธิ์เข้าถึง"); return; } // IDOR guard
      const parsed = parseVideoJobOutput(src.outputJson);
      const preview = parsed?.preview;
      const srcBgVideos = (preview?.config as Record<string, unknown> | undefined)?.bgVideos;
      if (!preview || !Array.isArray(srcBgVideos)) { await failJob(jobId, "วิดีโอต้นฉบับไม่มีข้อมูล b-roll ที่แก้ไขได้"); return; }

      // Re-validate the edits server-side (defense-in-depth; the jobs route already validated).
      const editsRes = validateWindowEdits(input.windowEdits);
      if ("error" in editsRes) { await failJob(jobId, editsRes.error); return; }
      const mergeRes = mergeWindowEdits(srcBgVideos, editsRes);
      if ("error" in mergeRes) { await failJob(jobId, mergeRes.error); return; }

      // New base config: source preview config with merged b-roll, no keyword popups (base render).
      const rrBaseConfig = { ...(preview.config as Record<string, unknown>), bgVideos: mergeRes.bgVideos, keywordPopups: [] as unknown[] };

      await step("render", 40);
      const rr = await caller.post<{ jobId: string }>("/api/videos/render", {
        shortVideoConfig: rrBaseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
        rerenderOf: { sourceJobId: input.sourceJobId },
        parentJobId: jobId,
      });
      const rrNewBase = await pollRender(caller, rr.jobId, (pct) => { void setJobStep(jobId, "render", 40 + Math.round(pct * 0.3)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(rr.jobId) });

      // Avatar re-composite (HeyGen only) — EXACTLY like AvatarAdjustOverlay.apply(): a free
      // chromakey re-composite of the SAME stored avatar assets onto the NEW base (no HeyGen call).
      let rrFinalUrl = rrNewBase;
      let rrCompositeBaseUrl: string | null = preview.compositeBaseUrl ?? null;
      const rrHasAvatar = !!(preview.avatarModel && preview.avatarModel !== "none" && preview.avatarVideoUrl);
      if (rrHasAvatar) {
        const heygenModes = new Set(["full", "bookend", "bookend-both"]);
        const rrAvatarTiming = preview.avatarMode;
        // chromakey re-composite is only valid for HeyGen avatars (full/bookend/bookend-both) —
        // the exact set AvatarAdjustOverlay operates on (its gate also requires compositeBaseUrl +
        // avatarMode). An upload-cutaway preview (avatarModel="upload-cutaway", no avatarMode) is a
        // DIFFERENT composite (cutaway w/ personRanges); chromakey-ing it would corrupt the video,
        // so fail cleanly rather than emit garbage. (Per-window edit for uploaded clips = future.)
        if (!rrAvatarTiming || !heygenModes.has(rrAvatarTiming)) {
          await failJob(jobId, "การแก้ b-roll รายช่วงยังไม่รองรับวิดีโอที่อัปโหลดคลิปเอง");
          return;
        }
        if (rrAvatarTiming === "bookend-both" && !preview.tailAvatarUrl) {
          await failJob(jobId, "ข้อมูลอวตารท้ายคลิปไม่ครบ — ปรับ b-roll ไม่ได้"); return;
        }
        await step("avatar", 80);
        const rrLayout = resolveAvatarLayout({}, await getAvatarPreset(userId, preview.avatarModel!));
        const rrComp = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
          avatarVideoUrl: preview.avatarVideoUrl,
          ...(preview.tailAvatarUrl ? { tailAvatarVideoUrl: preview.tailAvatarUrl } : {}),
          bgVideoUrl: rrNewBase,
          mode: "chromakey",
          avatarTiming: rrAvatarTiming,
          avatarBookendSecs: preview.avatarIntroSecs ?? 5,
          avatarTailSecs: preview.avatarTailSecs ?? 5,
          avatarLayout: rrLayout,
        }, { retries: 0 });
        rrFinalUrl = rrComp.videoUrl;
        rrCompositeBaseUrl = rrNewBase; // new pre-composite base
      }

      // flush final phase + one-line log
      const rrDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, rrDuration]);
      emitStage(phaseName, "done", rrDuration);
      console.log(`[mcp-worker] job ${jobId} BROLL-RERENDER total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s edits=${editsRes.length} avatar=${rrHasAvatar}`);

      // Preview payload = SOURCE preview copied verbatim (captions/voiceUrl/words/audioDurationMs
      // /avatar* unchanged — subtitle invariant) with config + videoUrl + compositeBaseUrl updated.
      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: rrFinalUrl,
        preview: {
          ...preview,
          config: rrBaseConfig,
          compositeBaseUrl: rrCompositeBaseUrl,
        },
      });
      return;
    }

    // ── EDITOR V2 DURABLE EXPORT ───────────────────────────────────────────────
    // Final subtitle burn + Gallery save must be server-owned. If the user switches to
    // another project, closes the tab, or refreshes, this job keeps running and the
    // project can later resume from activeExportJobId.
    if (input.mode === "export") {
      if (!input.sourceJobId) { await failJob(jobId, "export job missing sourceJobId"); return; }
      if (!input.subtitleOverlayConfig || typeof input.subtitleOverlayConfig !== "object") {
        await failJob(jobId, "export job missing subtitle overlay config");
        return;
      }
      const src = await prisma.videoJob.findUnique({ where: { id: input.sourceJobId } });
      if (!src || src.userId !== userId) { await failJob(jobId, "ไม่พบวิดีโอต้นฉบับ หรือไม่มีสิทธิ์เข้าถึง"); return; }
      if (src.status !== "done") { await failJob(jobId, "วิดีโอต้นฉบับยังไม่พร้อมสำหรับส่งออก"); return; }
      const parsed = parseVideoJobOutput(src.outputJson);
      const preview = parsed?.preview;
      if (!preview) { await failJob(jobId, "วิดีโอต้นฉบับไม่มีข้อมูลสำหรับส่งออก"); return; }
      const voiceModel = await resolveExportGalleryVoiceModel(src, userId, user);

      await step("burn", 20);
      const burn = await caller.post<{ jobId: string }>("/api/videos/render", {
        subtitleOverlayConfig: input.subtitleOverlayConfig,
        parentJobId: jobId,
      });
      const burnedUrl = await pollRender(
        caller,
        burn.jobId,
        (pct) => { void setJobStep(jobId, "burn", 20 + Math.round(pct * 0.7)).catch(() => {}); },
        { sleep, checkCanceled: cancelInFlightRender(burn.jobId) },
      );

      await step("save", 92);
      const saved = await caller.post<{ videoId?: string; id?: string }>("/api/videos", {
        videoUrl: burnedUrl,
        ...(job.projectId ? { projectId: job.projectId } : {}),
        audioUrl: preview.voiceUrl ?? null,
        avatarModel: preview.avatarModel ?? "none",
        avatarVideoUrl: preview.avatarVideoUrl ?? null,
        voiceModel,
        thumbnail: null,
        script: input.exportScript?.trim() || preview.fullText || null,
        sceneCount: input.exportSceneCount ?? preview.captions?.length ?? 1,
        renderConfig: preview.config,
        status: "COMPLETED",
      });
      const videoId = saved.videoId ?? saved.id;

      const exportDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, exportDuration]);
      emitStage(phaseName, "done", exportDuration);
      console.log(`[mcp-worker] job ${jobId} EXPORT total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s source=${input.sourceJobId}`);

      const completion = await finishJobWithTransition(jobId, {
        version: 2,
        mode: "export",
        sourceJobId: input.sourceJobId,
        videoUrl: burnedUrl,
        ...(videoId ? { videoId } : {}),
      });
      const logoCompletionProperties = buildLogoExportCompletedTelemetryProperties(
        input.subtitleOverlayConfig,
        preview.audioDurationMs,
      );
      if (
        completion.transitioned
        && completion.job.status === "done"
        && logoCompletionProperties
      ) {
        emitTelemetry({
          name: "logo_overlay_export_completed",
          category: "product",
          source: "server",
          status: "done",
          properties: logoCompletionProperties,
        });
      }
      return;
    }

    // ── EDITOR V2 UPLOAD → CUTAWAY (P6.5, previewMode-only) ───────────────────
    // ข้ามเสียง/อวตาร/เพลงตามดีไซน์: ถอดซับจากเสียงในคลิป → b-roll windows →
    // base reel → composite mode:"cutaway" (เสียงมาจากคลิปเสมอ) → จบที่ preview.
    if (input.mode === "upload") {
      if (!input.clipUrl) { await failJob(jobId, "upload job missing clipUrl"); return; }

      await step("captions", 20);
      const tx = await caller.post<{ captions?: OrchCaption[]; audioDurationMs?: number }>(
        "/api/videos/transcribe", { audioUrl: input.clipUrl, script: "" },
      );
      const upCaps = (tx.captions ?? []).filter((c) => typeof c?.text === "string" && c.text.trim());
      if (!upCaps.length) throw new Error("ถอดซับจากคลิปไม่สำเร็จ — เช็คว่าคลิปมีเสียงพูดชัดเจน");
      const upDurMs = (tx.audioDurationMs && tx.audioDurationMs > 0)
        ? Math.round(tx.audioDurationMs)
        : Math.max(...upCaps.map((c) => c.endMs));

      const upWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
      const upManualBrollCount = input.targetClipCount && input.targetClipCount > 0
        ? Math.min(60, Math.floor(input.targetClipCount))
        : 0;
      const upWindows = upManualBrollCount > 0
        ? buildFixedCountBrollWindows(
            upCaps.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            upManualBrollCount,
            upDurMs,
          )
        : buildBrollWindows(
            upCaps.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            upWindowSec,
            upDurMs,
          );
      const upBrollUnits = upWindows.length > 0 ? brollWindowCaptions(upWindows) : upCaps;

      await step("keywords", 40);
      const upKw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][]; relevanceSpec?: unknown }>(
        "/api/videos/extract-keywords",
        {
          ...buildKeywordsPayload(upBrollUnits.map((c) => c.text), upCaps.map((c) => c.text).join("\n"), upDurMs, {
          brollRegionPreference: input.brollRegionPreference,
          brollVisualStyle: input.brollVisualStyle,
          }),
          ...(input.targetClipCount && input.targetClipCount > 0 ? { targetClipCount: input.targetClipCount } : {}),
        },
      );

      await step("stock", 55);
      const upAiGen = input.stockSource === "kie-image" || input.stockSource === "auto-mix";
      const upAligned = alignBrollWindowsToKeywords(upWindows, upBrollUnits, upKw.keywords ?? [], upKw.keywordAlternatives);
      const upTotalDur = upAligned.windows.length > 0
        ? Math.round(upDurMs / 1000)
        : (upKw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(upDurMs / 1000);
      const upStock = await caller.post<{ results: unknown[] }>(
        "/api/videos/fetch-stock",
        {
          ...buildStockPayload(upAligned.keywords, upTotalDur, input.stockSource ?? DEFAULT_STOCK_SOURCE, upAligned.units, upKw.visualDirection, upAligned.alternatives, upKw.relevanceSpec, {
            brollRegionPreference: input.brollRegionPreference,
            brollVisualStyle: input.brollVisualStyle,
          }, upAligned.windows.length > 0, upAligned.windows),
          ...(input.kieModel ? { kieModel: input.kieModel } : {}),
          ...(input.imageEngine ? { imageEngine: input.imageEngine } : {}),
          ...(input.imageModel ? { imageModel: input.imageModel } : {}),
          videoJobId: jobId,
          ...(input.autoMixProviders?.length ? { autoMixProviders: input.autoMixProviders } : {}),
          ...(input.autoMixWeights ? { autoMixWeights: input.autoMixWeights } : {}),
          ...(input.stockProviders?.length ? { stockProviders: input.stockProviders } : {}),
        },
        upAiGen ? { retries: 0 } : undefined,
      );
      emitBrollStockInventory(upAligned.windows.length, upStock.results ?? []);

      await step("config", 65);
      const upScc = upAligned.windows.length > 0 ? [] : (upCaps.length === (upKw.keywords ?? []).length ? upCaps.map(() => 1) : (upKw.sceneClipCounts ?? []));
      const upCfg = await caller.post<{ config: Record<string, unknown> }>(
        "/api/videos/generate-config",
        buildConfigPayload(
          upCaps, upStock.results ?? [], input.clipUrl, upDurMs, upCaps.map((c) => c.text),
          upKw.keywordsPerScene ?? 5, upScc, upKw.sceneDurations ?? [],
          upAligned.windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
        ),
      );

      await step("render", 75);
      const upBaseConfig = { ...upCfg.config, keywordPopups: [] as unknown[] };
      const upR = await caller.post<{ jobId: string }>("/api/videos/render", {
        shortVideoConfig: upBaseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
        parentJobId: jobId,
      });
      const upReelUrl = await pollRender(caller, upR.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.12)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(upR.jobId) });
      // preview: การจองที่ base render คือค่าใช้จ่ายเดียว (เหมือน script preview) — ไม่ refund

      await step("composite", 90);
      const plan = planCutaway(upWindows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })));
      const personRanges = plan.person.map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));
      // hook = คลิปที่อัปต้องเป็นเฟรมแรกเสมอ. transcribe เว้นช่วง [0, คำแรก) ไว้ (เงียบ/หายใจ/อินโทร)
      // ทำให้ base reel (b-roll) โผล่ก่อนหน้าคนพูด — คลุม person range แรกให้เริ่มที่ 0 (บั๊ก kapokja 07-04).
      // person เป็น overlay บน b-roll base (composite mode:cutaway) → ทุกจังหวะที่ไม่มี person range = b-roll โผล่.
      if (personRanges.length > 0) personRanges[0] = { ...personRanges[0], start: 0 };
      const comp = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
        mode: "cutaway",
        avatarVideoUrl: input.clipUrl,
        bgVideoUrl: upReelUrl,
        personRanges,
      }, { retries: 0 });

      const upFinalDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, upFinalDuration]);
      emitStage(phaseName, "done", upFinalDuration);
      console.log(`[mcp-worker] job ${jobId} UPLOAD-CUTAWAY total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s scenes=${upCaps.length} windows=${upWindows.length}`);

      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: comp.videoUrl,
        preview: {
          captions: upCaps,
          config: upBaseConfig,
          voiceUrl: input.clipUrl,
          voiceModel: "original-audio",
          audioDurationMs: upDurMs,
          avatarModel: "upload-cutaway",
          avatarVideoUrl: input.clipUrl,
        },
      });
      return;
    }

    // 1. TTS
    if (!ttsStepAlreadyEntered) await step("tts", 10);
    let tts: { voiceUrl: string; audioDurationMs?: number; timing?: unknown };
    if (provider === "elevenlabs") {
      tts = await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>(
        "/api/videos/tts",
        { text: input.script, voiceId: input.voiceId ?? user.elevenlabsVoiceId ?? undefined, languageCode: "th" },
      );
    } else if (provider === "omnivoice") {
      if (resumedHeroVoiceTts) {
        tts = resumedHeroVoiceTts;
      } else {
        let started;
        try {
          started = await startHeroVoiceGeneration({
            userId,
            plan: user.plan,
            text: input.script,
            voiceId: input.omniVoiceId ?? "voice_01",
            speed: 1,
            studio: false,
            idempotencyKey: `video-job-${jobId}`,
            backend: input.voiceBackend,
          });
        } catch (error) {
          if (error instanceof HeroVoiceGenerationError) {
            throw new HeroVoiceProviderFailureError(error.message, error.code);
          }
          throw error;
        }
        const result = await settleHeroVoiceJob(started.job);
        if (!result) return;
        tts = result;
      }
    } else {
      tts = await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>(
        "/api/videos/tts-gemini",
        { text: input.script, voiceName: input.geminiVoiceName ?? user.geminiVoiceName ?? "Aoede" },
      );
    }
    let audioDurationMs = typeof tts.audioDurationMs === "number" && tts.audioDurationMs > 0
      ? Math.round(tts.audioDurationMs)
      : durationFromTtsTiming(tts.timing);
    if (audioDurationMs <= 0) {
      const measured = await caller.post<{ durationMs?: number }>(
        "/api/videos/audio-duration",
        { audioUrl: tts.voiceUrl },
      );
      audioDurationMs = typeof measured.durationMs === "number" && measured.durationMs > 0
        ? Math.round(measured.durationMs)
        : 0;
    }
    if (audioDurationMs <= 0) {
      throw new Error("ตรวจสอบความยาวเสียงไม่ได้ — กรุณาลองสร้างใหม่");
    }

    // Exact duration is known now. Stop before captions, keyword LLM, stock downloads,
    // rendering, or HeyGen can spend more time/quota; /api/videos/render keeps its own
    // authoritative backstop for direct callers.
    const durationViolation = audioDurationLimitViolation(audioDurationMs, user.plan);
    if (durationViolation) {
      throw new Error(`${durationViolation.message} — ${durationViolation.userAction}`);
    }

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
    let capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor(), viralCards);
    if (!capRes || capRes.captions.length === 0) {
      // TTS produced AUDIO but no usable instrumented timing — Gemini's segmented
      // pass fell open to a single uninstrumented call (returns no `timing`), or a
      // rare timing/text mismatch. The web editor recovers here via its transcribe
      // fallback, but this headless path has none, so pre-fix it turned a completed
      // audio render into a hard failure ("ไม่มี subtitle timing") that a plain
      // retry rarely cleared (prod: longer scripts = more segments = higher fail-open
      // odds; 2/4 affected users never recovered by retrying). Derive a single-segment
      // clock from the EXACT audio duration over the exact spoken text — still 100%
      // TTS-derived, same char clock, no transcribe, no arithmetic change; only loss
      // vs the segmented path is per-chunk re-anchoring + silence snap.
      const degraded = buildDegradedTtsTiming(provider, input.script, audioDurationMs);
      if (degraded) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capRes = captionsFromTtsTiming(degraded as any, audioDurationMs, maxCardCharsFor(), null);
        if (capRes && capRes.captions.length > 0) {
          const scriptCharCount = input.script.trim().length;
          console.warn(`[mcp-worker] job ${jobId}: TTS timing absent — recovered with single-segment clock over ${scriptCharCount} chars / ${audioDurationMs}ms`);
          // Durable marker (fire-and-forget, never fails the job) so degraded videos
          // are identifiable and a systemic timing regression spikes this event.
          emitTelemetry(buildDegradedTimingTelemetry({ pipelineRunId, jobId, provider, scriptCharCount, audioDurationMs }));
        }
      }
    }
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
    const brollWindowMode = isInternalAiBetaEnabledFor(user, process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE === "1");
    const brollWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
    const manualBrollCount = input.targetClipCount && input.targetClipCount > 0
      ? Math.min(60, Math.floor(input.targetClipCount))
      : 0;
    const brollWindows = brollWindowMode || manualBrollCount > 0
      ? manualBrollCount > 0
        ? buildFixedCountBrollWindows(
            captions.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            manualBrollCount,
            durMs,
          )
        : buildBrollWindows(
            captions.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            brollWindowSec,
            durMs,
          )
      : [];
    const brollUnits = brollWindows.length > 0 ? brollWindowCaptions(brollWindows) : captions;

    // 3. Keywords
    await step("keywords", 40);
    const kw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][]; relevanceSpec?: unknown }>(
      "/api/videos/extract-keywords",
      {
        ...buildKeywordsPayload(brollUnits.map((c) => c.text), input.script, durMs, {
          brollRegionPreference: input.brollRegionPreference,
          brollVisualStyle: input.brollVisualStyle,
        }),
        // v2 ขั้นสูง: จำนวนคลิปกำหนดเอง (extract-keywords รองรับ field นี้จาก web เดิมอยู่แล้ว)
        ...(input.targetClipCount && input.targetClipCount > 0 ? { targetClipCount: input.targetClipCount } : {}),
      },
    );

    // 4. Stock
    await step("stock", 55);
    const aligned = alignBrollWindowsToKeywords(brollWindows, brollUnits, kw.keywords ?? [], kw.keywordAlternatives);
    const totalDur = aligned.windows.length > 0
      ? Math.round(durMs / 1000)
      : (kw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(durMs / 1000);
    // AI-gen sources (kie-image / auto-mix) SPEND kie credits per image — a transport
    // retry re-generates the entire batch (incident 07-03: 20+ images × 2). retries: 0.
    const aiGenSource = input.stockSource === "kie-image" || input.stockSource === "auto-mix";
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock",
      {
        ...buildStockPayload(aligned.keywords, totalDur, input.stockSource ?? DEFAULT_STOCK_SOURCE, aligned.units, kw.visualDirection, aligned.alternatives, kw.relevanceSpec, {
          brollRegionPreference: input.brollRegionPreference,
          brollVisualStyle: input.brollVisualStyle,
        }, aligned.windows.length > 0, aligned.windows),
        // v2 ขั้นสูง (Beta): โมเดลภาพ AI + แหล่ง Auto Mix — fetch-stock มี server default ให้ทั้งคู่
        ...(input.kieModel ? { kieModel: input.kieModel } : {}),
        ...(input.imageEngine ? { imageEngine: input.imageEngine } : {}),
        ...(input.imageModel ? { imageModel: input.imageModel } : {}),
        videoJobId: jobId,
        ...(input.autoMixProviders?.length ? { autoMixProviders: input.autoMixProviders } : {}),
        ...(input.autoMixWeights ? { autoMixWeights: input.autoMixWeights } : {}),
        ...(input.stockProviders?.length ? { stockProviders: input.stockProviders } : {}),
      },
      aiGenSource ? { retries: 0 } : undefined,
    );
    emitBrollStockInventory(aligned.windows.length, stock.results ?? []);

    // 5. Config
    await step("config", 65);
    // Window mode → empty sceneClipCounts so generate-config takes the window branch (one clip
    // per window) instead of per-caption cycling; brollWindows below carries the spans (mirrors
    // web page.tsx runConfig). Otherwise keep the legacy 1-clip-per-caption path.
    const sceneClipCounts = aligned.windows.length > 0
      ? []
      : (captions.length === (kw.keywords ?? []).length ? captions.map(() => 1) : (kw.sceneClipCounts ?? []));
    const cfgRes = await caller.post<{ config: Record<string, unknown> }>(
      "/api/videos/generate-config",
      buildConfigPayload(
        captions, stock.results ?? [], tts.voiceUrl, durMs, captions.map((c) => c.text),
        kw.keywordsPerScene ?? 5, sceneClipCounts, kw.sceneDurations ?? [],
        aligned.windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
      ),
    );

    // 6. Base render (no burned subs) → poll
    await step("render", 75);
    const baseConfig = { ...cfgRes.config, keywordPopups: [] as unknown[], ...(input.bgmFile ? { bgmFile: input.bgmFile, bgmVolume: input.bgmVolume ?? 0.12 } : {}) };
    const r1 = await caller.post<{ jobId: string }>("/api/videos/render", {
      shortVideoConfig: baseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
      parentJobId: jobId,
    });
    const baseUrl = await pollRender(caller, r1.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(r1.jobId) });
    // Base render reserved 1 clip. Refund it NOW *only when an avatar composite follows* —
    // because only then does finalBase become a NEW url (the composite) that the burn step
    // does NOT recognize as already-paid, so the burn re-reserves a clip. Refunding the base
    // then nets exactly 1 (base +1, refund −1, burn +1), and an avatar/burn failure nets 0
    // (the burn route refunds its own clip) — never over-charging an undelivered video.
    //
    // NON-AVATAR: finalBase stays == baseUrl, so the burn's isBurnAlreadyPaid() matches the
    // base's ChargedClip (render/route.ts) and the burn SKIPS its reservation (it is free).
    // Refunding the base here would then net 0 — a full quota bypass for every delivered
    // clips-mode video. So do NOT refund: the base's single ChargedClip is the only charge.
    // (MON-2: docs/audits/2026-07-07-system-optimization-audit.md.)
    //
    // PREVIEW MODE: no burn follows in this job, so the base reservation must STAND as the
    // single charge (same as the web editor's preview render today) — skip the refund.
    if (!input.previewMode && input.avatarMode) {
      const reason = "avatar-composite-replacement";
      const settled = await refundBaseReservation(reason).catch((error) => {
        console.error(`[mcp-worker] job ${jobId} failed to refund base reservation`, error);
        return false;
      });
      if (!settled) throw new AvatarReservationSettlementError(reason);
    }

    // 6b. Avatar (optional) — generate + composite onto the base render.
    let finalBase = baseUrl;
    let avatarModel = "none";
    let avatarVideoUrl: string | null = null;
    let tailAvatarUrl: string | null = null;
    if (input.avatarMode) {
      // Defense-in-depth: the route only ever persists avatarMode together with a
      // resolved avatarId, but the worker reads inputJson directly — fail cleanly on a
      // malformed job rather than generating with avatarModel=undefined.
      if (!input.avatarId) throw new Error("avatar job missing avatarId");
      await step("avatar", 80);
      const introSecs = input.avatarIntroSecs ?? 5;
      const tailSecs = input.avatarTailSecs ?? 5;
      const preparedAudio = await prepareAvatarAudio(caller, {
        ttsAudioUrl: tts.voiceUrl,
        avatarMode: input.avatarMode,
        introSecs,
        tailSecs,
      });
      const startedAt = new Date();
      const checkpoint: AvatarProviderCheckpointV1 = {
        version: 1,
        provider: "heygen",
        phase: "intro_generate",
        providerStartedAt: startedAt.toISOString(),
        providerDeadlineAt: new Date(startedAt.getTime() + 2 * 60 * 60_000).toISOString(),
        baseUrl,
        voiceUrl: tts.voiceUrl,
        audioDurationMs: durMs,
        captions,
        words: capRes.words,
        fullText: capRes.fullText,
        baseConfig,
        avatar: {
          mode: input.avatarMode,
          id: input.avatarId,
          introSecs,
          tailSecs,
          layout: {
            scale: Number.isFinite(input.avatarScale) ? Number(input.avatarScale) : 1,
            offsetX: Number.isFinite(input.avatarOffsetX) ? Number(input.avatarOffsetX) : 0,
            offsetY: Number.isFinite(input.avatarOffsetY) ? Number(input.avatarOffsetY) : 0,
          },
          introAudioUrl: preparedAudio.introAudioUrl,
          tailAudioUrl: preparedAudio.tailAudioUrl,
        },
      };
      if (!await persistProviderCheckpoint(checkpoint)) throw new Error(VIDEO_JOB_CANCELED_ERROR);
      await settleProviderAdvance(await advanceProvider(checkpoint, true));
      return;
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
          voiceModel: galleryVoiceModelForInput(input, user, provider),
          audioDurationMs: durMs,
          avatarModel,
          avatarVideoUrl,
          // ข้อมูล re-composite (จอแต่งซับปรับตำแหน่งอวตารได้โดยไม่เรียก HeyGen ใหม่)
          avatarMode: input.avatarMode ?? null,
          avatarIntroSecs: input.avatarIntroSecs ?? 5,
          avatarTailSecs: input.avatarTailSecs ?? 5,
          compositeBaseUrl: input.avatarMode ? baseUrl : null,
          tailAvatarUrl,
          // word timeline สำหรับ "ความยาวการ์ด 1/2/3/4 คำ" ในจอแต่งซับ (regroup ฝั่ง
          // editor ด้วย timing เป๊ะ ไม่ต้อง interpolate) — MCP path (non-preview) ไม่แตะ
          words: capRes.words,
          fullText: capRes.fullText,
        },
      });
      return;
    }

    // 7. Create Video row (PROCESSING)
    const created = await caller.post<{ id: string }>("/api/videos", {
      videoUrl: finalBase, audioUrl: tts.voiceUrl, thumbnail: null, script: input.script.trim() || null,
      avatarModel, avatarVideoUrl, voiceModel: galleryVoiceModelForInput(input, user, provider),
      sceneCount: captions.length, renderConfig: baseConfig, status: "PROCESSING",
    });

    // 8. Burn subtitles onto the (possibly avatar-composited) base.
    await step("burn", 88);
    const subTop = input.subtitlePosition ? POSITION_TOP_PERCENT[input.subtitlePosition] : undefined;
    const r2 = await caller.post<{ jobId: string }>("/api/videos/render", {
      subtitleOverlayConfig: buildBurnConfig(finalBase, captions, durMs, RENDER_FPS, subTop),
      parentJobId: jobId,
    });
    const burnedUrl = await pollRender(caller, r2.jobId, (pct) => { void setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(r2.jobId) });

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
    if (message === VIDEO_JOB_CANCELED_ERROR) {
      console.log(`[mcp-worker] job ${jobId} canceled by user at step=${phaseName} — stopping cleanly`);
      return; // status is already 'canceled'; don't overwrite with failed
    }
    emitStage(phaseName, "error", Date.now() - phaseStartedAt, { message });
    await failJob(jobId, e instanceof AvatarProviderFailureError
      ? {
          message: e.failure.message,
          code: e.failure.code,
          provider: e.failure.provider,
          reservationRefundReason: e.reservationRefundReason,
        }
      : e instanceof HeroVoiceProviderFailureError
        ? {
            message: e.message,
            code: e.code,
            provider: "omnivoice",
          }
      : e instanceof AvatarReservationSettlementError
        ? {
            message: e.message,
            code: "reservation_refund_pending",
            provider: "system",
            reservationRefundReason: e.reservationRefundReason,
          }
      : message);
  }
}

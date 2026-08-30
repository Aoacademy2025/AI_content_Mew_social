import type { User } from "@prisma/client";
import { isOmniVoiceUserAllowed } from "@/lib/omnivoice-policy";
import type { SubtitleSpeechCoverage } from "@/lib/subtitle-speech-coverage";
import { prisma } from "@/lib/prisma";
import { refundSettledVideoImageBatch } from "@/lib/video-image-batch-settlement";
import {
  refundVideoJobBaseReservation,
  refundVideoJobTerminalRenderReservations,
} from "@/lib/render/reservation-settlement";
import {
  captionsFromSpokenScript,
  captionsFromTtsTiming,
} from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { estimateClipSecV2 } from "@/app/(dashboard)/video-editor/_v2/estimate";
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
import type { EditorExportSnapshot } from "@/lib/editor-export-snapshot";
import {
  firstPassVisualRejectionReasonForWindow,
  validateWindowEdits,
  mergeWindowEdits,
  type WindowEdit,
} from "@/lib/broll-rerender";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import {
  pipelineCaller,
  pipelineFailureDetails,
  pollRender,
  type PipelineCaller,
} from "@/lib/mcp/pipeline-client";
import { heroImageProviderRetryDirective } from "@/lib/mcp/hero-image-pipeline-retry";
import {
  DEFAULT_STOCK_SOURCE, RENDER_FPS, RENDER_JPEG_QUALITY, maxCardCharsFor,
  buildKeywordsPayload, buildStockPayload, buildConfigPayload, buildBurnConfig, type OrchCaption,
  cardsByWordCount, POSITION_TOP_PERCENT,
} from "@/lib/mcp/orchestrator-steps";
import {
  attemptAvatarComposite,
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
  buildNarrativeAlignedBrollWindows,
  type BrollWindow,
} from "@/lib/broll-windows";
import {
  buildCutawayBackgroundTimeline,
  cutawayPieceLimit,
  effectiveManualCutawayPieceCount,
  manualCutawayWindowCount,
  planCutaway,
  planCutawayRecomposite,
  reconstructCutawayPersonRanges,
  type CutawayBrollSegment,
} from "@/lib/cutaway-plan";
import { normalizeTrustedLogoRenderInput } from "@/lib/logo-export.server";
import type { ScriptCard, TtsTiming } from "@/lib/tts-timing";
import type { StockProvider } from "@/lib/key-preflight";
import { audioDurationLimitViolation } from "@/lib/plan-limits";
import { avatarBookendDurationViolation, avatarFullDurationViolation } from "@/lib/avatar-duration";
import { minutesFromSeconds } from "@/lib/minute-limits";
import { reconcileVideoJobFunding } from "@/lib/mcp/video-job-funding";
import { resolveJobTtsProvider } from "@/lib/tts-providers";
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
import { shouldEmitPipelineStepStarted } from "@/lib/pipeline-telemetry";
import {
  compileNarrationPlan,
  parseNarrationPlan,
  type NarrationPlanV1,
} from "@/lib/narration-plan";
import {
  alignTranscriptWordsToSourceDetailed,
  buildCanonicalCaptionsFromAlignedWords,
  repairCaptionTiming,
  resolveUploadTranscriptWords,
  subtitleQualityShouldFailJob,
  validateSubtitleQuality,
  type SubtitleTimingSource,
} from "@/lib/mcp/subtitle-quality";
import { getVideoJobBillingReceipt } from "@/lib/mcp/billing-receipt";
import { ensureUploadContentPreflight } from "@/lib/upload-content-preflight.server";
import { sceneContentPolicyFromPreference, type SceneContentPolicy } from "@/lib/scene-content-policy";
import { pinProjectVisualContextToVideoJob } from "@/lib/project-look.server";
import {
  ContentPreflightError,
  contentPreflightFailureDetails,
  narrativeVisualWindowsForPreflight,
} from "@/lib/content-preflight.server";
import { ensureVideoJobContentPreflight } from "@/lib/video-job-content-preflight.server";
import {
  recordFirstPassVisualExport,
  recordFirstPassVisualRejection,
  type FirstPassVisualRejectionReason,
} from "@/lib/first-pass-visual-acceptance.server";
import { brollExportCompletionProperties } from "@/lib/broll-growth-funnel";
import {
  commitAppliedSceneRerollAssetsInTransaction,
  prepareAppliedSceneRerollAssets,
} from "@/lib/scene-reroll-apply.server";

class AvatarProviderFailureError extends Error {
  constructor(
    public readonly failure: Extract<AvatarProviderAdvanceResult, { kind: "failed" }>,
    public readonly reservationRefundReason?: string,
  ) {
    super(failure.message);
    this.name = "AvatarProviderFailureError";
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

class SubtitleAlignmentFailureError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly provider?: string,
  ) {
    super(message);
    this.name = "SubtitleAlignmentFailureError";
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
  narrationPlan?: NarrationPlanV1;
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
  sceneContentPolicy?: SceneContentPolicy;
  narrativeSourceKind?: "ai-script" | "creator-script";
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
  /** Ceiling on paid AutoMix AI images = the exact count the client's Render Receipt
   *  disclosed. Validated at the web route; fetch-stock clamps its plan to it so the
   *  charge can never exceed the approved quote. */
  maxAiImages?: number;
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
  editSnapshot?: EditorExportSnapshot;
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

/** Replace only caption text/times in a trusted Editor v2 burn config. Per-card
 * style and every non-subtitle layer remain unchanged. */
function retimeSubtitleOverlayConfig(
  subtitleOverlayConfig: Record<string, unknown>,
  captions: OrchCaption[],
  fps = RENDER_FPS,
): Record<string, unknown> | null {
  const candidates = subtitleOverlayConfig.keywordPopups;
  if (!Array.isArray(candidates)) return null;
  // An empty track means the creator deliberately hid subtitles.
  if (candidates.length === 0) return { ...subtitleOverlayConfig };
  if (candidates.length !== captions.length) return null;

  const configuredDuration = Number(subtitleOverlayConfig.durationInFrames);
  const captionDuration = Math.max(
    fps,
    ...captions.map((caption) => Math.ceil((caption.endMs / 1_000) * fps)),
  );
  const durationInFrames = Number.isFinite(configuredDuration) && configuredDuration >= captionDuration
    ? Math.round(configuredDuration)
    : captionDuration;
  let frameCursor = 0;
  const keywordPopups: Record<string, unknown>[] = [];
  for (let index = 0; index < captions.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const caption = captions[index];
    const rawStart = Math.round((caption.startMs / 1_000) * fps);
    const rawEnd = Math.round((caption.endMs / 1_000) * fps);
    const start = Math.min(Math.max(frameCursor, rawStart), durationInFrames - 1);
    const end = Math.min(Math.max(rawEnd, start + 1), durationInFrames);
    frameCursor = end;
    keywordPopups.push({
      ...(candidate as Record<string, unknown>),
      text: caption.text,
      start,
      end,
      tag: caption.tag ?? (index === 0 ? "hook" : "body"),
    });
  }
  return { ...subtitleOverlayConfig, durationInFrames, keywordPopups };
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

/**
 * Evidence for the one acoustic alignment attempt a TTS-voice render is allowed to make
 * (ADR 0056). It records the rung of the timing ladder that was reached and the clock that
 * was NOT rendered, so subtitle accuracy can be measured later without another render.
 */
type SubtitleVerification = {
  status: "aligned" | "failed" | "skipped" | "timeout";
  /** Alignment failure code when status === "failed", or "card_count_mismatch" info. */
  code?: string;
  method?: "exact" | "fuzzy";
  similarityPermille?: number;
  durationMs: number;
  /** Provider-clock cards — the timing that renders unless the alignment above succeeded. */
  ttsCaptions: Array<{ startMs: number; endMs: number }>;
  maxAbsStartDeltaMs?: number;
  medianAbsStartDeltaMs?: number;
};

/** The verification plus the captions it produced; only the evidence half is persisted. */
type SubtitleAlignmentAttempt = SubtitleVerification & {
  capRes?: NonNullable<ReturnType<typeof captionsFromTtsTiming>>;
  speechCoverage?: SubtitleSpeechCoverage;
};

function subtitleVerificationEvidence(attempt: SubtitleAlignmentAttempt): SubtitleVerification {
  return {
    status: attempt.status,
    durationMs: attempt.durationMs,
    ttsCaptions: attempt.ttsCaptions,
    ...(attempt.code ? { code: attempt.code } : {}),
    ...(attempt.method ? { method: attempt.method } : {}),
    ...(attempt.similarityPermille !== undefined ? { similarityPermille: attempt.similarityPermille } : {}),
    ...(attempt.medianAbsStartDeltaMs !== undefined ? { medianAbsStartDeltaMs: attempt.medianAbsStartDeltaMs } : {}),
    ...(attempt.maxAbsStartDeltaMs !== undefined ? { maxAbsStartDeltaMs: attempt.maxAbsStartDeltaMs } : {}),
  };
}

const SUBTITLE_VERIFY_BUDGET_DEFAULT_MS = 180_000;
const SUBTITLE_VERIFY_TIMED_OUT = Symbol("subtitle_verify_timed_out");

/** Wall-clock budget for the one alignment call. Read at call time, never cached, so the
 *  knob answers to the current environment. */
function subtitleVerifyBudgetMs(): number {
  const configured = Number(process.env.SUBTITLE_VERIFY_BUDGET_MS ?? SUBTITLE_VERIFY_BUDGET_DEFAULT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : SUBTITLE_VERIFY_BUDGET_DEFAULT_MS;
}

/** How far the acoustic clock moved each card off the provider clock (same card count only). */
function startDeltaStats(
  captions: Array<{ startMs: number }>,
  ttsCaptions: Array<{ startMs: number }>,
): { medianAbsStartDeltaMs: number; maxAbsStartDeltaMs: number } | null {
  if (captions.length === 0 || captions.length !== ttsCaptions.length) return null;
  const deltas = captions
    .map((caption, index) => Math.abs(Math.round(caption.startMs - ttsCaptions[index].startMs)))
    .sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  return {
    medianAbsStartDeltaMs: deltas.length % 2 === 0
      ? Math.round((deltas[middle - 1] + deltas[middle]) / 2)
      : deltas[middle],
    maxAbsStartDeltaMs: deltas[deltas.length - 1],
  };
}

/**
 * ONE bounded acoustic alignment of the known narration against its own generated audio.
 *
 * Never throws, never retries, never causes provider spend. When it succeeds the caller
 * renders from this word timing (`forced_alignment`); on any other outcome the caller keeps
 * the provider's deterministic clock and this result is persisted as the reason why.
 */
async function alignNarrationOnce(args: {
  caller: PipelineCaller;
  audioUrl: string;
  narrationText: string;
  maxCardChars: number;
  budgetMs: number;
  audioDurationMs: number;
  ttsCaptions: Array<{ startMs: number; endMs: number }>;
}): Promise<SubtitleAlignmentAttempt> {
  const startedAt = Date.now();
  const ttsCaptions = args.ttsCaptions;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = args.caller.post<{
      words?: Array<{ word: string; startMs: number; endMs: number }>;
      audioDurationMs?: number;
      speechCoverage?: SubtitleSpeechCoverage;
    }>("/api/videos/transcribe", {
      audioUrl: args.audioUrl,
      scriptPrompt: args.narrationText.slice(0, 800),
      script: args.narrationText,
    }, { retries: 0 });
    // The caller exposes no cancellation seam: an over-budget request is abandoned, not
    // aborted, so its eventual rejection must be swallowed here or it crashes the worker.
    request.catch(() => {});
    const response = await Promise.race([
      request,
      new Promise<typeof SUBTITLE_VERIFY_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(SUBTITLE_VERIFY_TIMED_OUT), args.budgetMs);
      }),
    ]);
    if (response === SUBTITLE_VERIFY_TIMED_OUT) {
      console.warn(
        `[mcp-worker] subtitle alignment exceeded ${args.budgetMs}ms — abandoned, rendering on the provider clock`,
      );
      return { status: "timeout", durationMs: Date.now() - startedAt, ttsCaptions };
    }
    const alignment = alignTranscriptWordsToSourceDetailed(args.narrationText, response.words ?? []);
    if (alignment.status !== "aligned") {
      return { status: "failed", code: alignment.code, durationMs: Date.now() - startedAt, ttsCaptions };
    }
    // Reuse only proven word timestamps; every visible character still comes from the
    // canonical narration so ASR normalisation can never rewrite what the viewer reads.
    const captions = buildCanonicalCaptionsFromAlignedWords(args.narrationText, alignment.words, args.maxCardChars);
    if (!captions || captions.length === 0) {
      return {
        status: "failed",
        code: "canonical_caption_projection_failed",
        durationMs: Date.now() - startedAt,
        ttsCaptions,
      };
    }
    return {
      status: "aligned",
      method: alignment.method,
      similarityPermille: Math.round(alignment.similarity * 1_000),
      durationMs: Date.now() - startedAt,
      ttsCaptions,
      ...(startDeltaStats(captions, ttsCaptions) ?? { code: "card_count_mismatch" }),
      capRes: {
        captions,
        words: alignment.words,
        audioDurationMs: Number(response.audioDurationMs) > 0
          ? Math.round(Number(response.audioDurationMs))
          : args.audioDurationMs,
        fullText: args.narrationText,
      },
      speechCoverage: response.speechCoverage,
    };
  } catch (error) {
    return {
      status: "failed",
      code: pipelineFailureDetails(error)?.code ?? "transcribe_request_failed",
      durationMs: Date.now() - startedAt,
      ttsCaptions,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runOrchestrator(jobId: string, userId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const caller = deps.caller ?? pipelineCaller(userId, jobId);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
      category: result.kind === "not_found" || result.kind === "ambiguous" || result.kind === "in_flight"
        ? "error"
        : "pipeline",
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
    if (result.kind === "not_found" || result.kind === "ambiguous" || result.kind === "in_flight") {
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

  const renderReservationStages = new Set(["render", "avatar", "composite_queue", "composite", "burn"]);
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

  /**
   * Retry only the refunded Hero image batch. Keeping this loop at the stock
   * seam preserves the already-created TTS, captions and keyword plan; replaying
   * the whole VideoJob would repeat external voice work. A fresh provider-attempt
   * namespace prevents a failed/refunded AiGenerationJob from poisoning retry.
   */
  async function fetchStockWithHeroProviderRetry<T>(
    body: Record<string, unknown>,
    heroProviderMode: boolean,
    aiGenerationMode: boolean,
  ): Promise<T> {
    let completedRetries = 0;
    while (true) {
      try {
        return await caller.post<T>(
          "/api/videos/fetch-stock",
          {
            ...body,
            ...(heroProviderMode ? { heroProviderAttempt: completedRetries } : {}),
          },
          aiGenerationMode ? { retries: 0 } : undefined,
        );
      } catch (error) {
        const retry = heroProviderMode
          ? heroImageProviderRetryDirective(error, completedRetries)
          : null;
        if (!retry) throw error;

        emitTelemetry({
          name: "hero_ai_image_provider_retry_scheduled",
          category: "performance",
          source: "server",
          step: "fetchStock.heroAiImage",
          status: "waiting_provider",
          properties: {
            pipelineRunId,
            jobId,
            via: "mcp",
            provider: "runpod",
            code: retry.code,
            nextAttempt: retry.nextAttempt,
            retryAfterMs: retry.delayMs,
          },
        });
        await sleep(retry.delayMs);
        const current = await prisma.videoJob.findUnique({
          where: { id: jobId },
          select: { status: true },
        });
        if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
        if (current?.status !== "processing") throw new Error("video_job_not_processing");
        completedRetries = retry.nextAttempt;
      }
    }
  }
  // step() logs the phase that just ended (worker log, for audits) + emits its `done`
  // telemetry, then advances and emits the new phase's `started`. Render/burn progress
  // callbacks keep calling setJobStep directly so they don't spam this.
  async function step(name: string, progress: number) {
    // Cooperative cancel (incident 07-03: kie runaway had no stop lever): the cancel
    // route marks processing jobs `canceled`; we honor it at every step boundary —
    // the current step finishes, nothing further starts, no failJob overwrite.
    const current = await prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { status: true, currentStep: true },
    });
    if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
    const now = Date.now();
    const ended = now - phaseStartedAt;
    timings.push([phaseName, ended]);
    console.log(`[mcp-worker] job ${jobId} step=${phaseName} ${(ended / 1000).toFixed(1)}s`);
    emitStage(phaseName, "done", ended);
    phaseName = name;
    phaseStartedAt = now;
    if (shouldEmitPipelineStepStarted(current?.currentStep, name)) {
      emitStage(name, "started");
    }
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
    const persistedNarrationPlan = typeof input.script === "string"
      ? parseNarrationPlan(input.narrationPlan, input.script)
      : null;
    const narrationPlan = persistedNarrationPlan ?? (
      typeof input.script === "string" && input.script.trim()
        ? compileNarrationPlan(input.script)
        : null
    );
    if (narrationPlan && !persistedNarrationPlan) {
      input.narrationPlan = narrationPlan;
      const persisted = await prisma.videoJob.updateMany({
        where: { id: jobId, userId, status: "processing" },
        data: { inputJson: JSON.stringify(input) },
      });
      if (persisted.count !== 1) {
        const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
        if (current?.status === "canceled") throw new Error(VIDEO_JOB_CANCELED_ERROR);
        throw new Error("video_job_not_processing");
      }
    }
    const narrationText = narrationPlan?.speechText ?? (typeof input.script === "string" ? input.script.trim() : "");
    const estimatedFullAvatarViolation = avatarFullDurationViolation({
      mode: input.avatarMode,
      durationSec: estimateClipSecV2(narrationText),
    });
    if (estimatedFullAvatarViolation) {
      throw new Error(`${estimatedFullAvatarViolation.message} — ${estimatedFullAvatarViolation.userAction}`);
    }
    const user = (await prisma.user.findUnique({ where: { id: userId } })) as User;
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
        return attemptAvatarComposite(caller, {
          videoJobId: jobId,
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
      const subtitleQa = validateSubtitleQuality({
        script: checkpoint.fullText,
        captions,
        audioDurationMs: checkpoint.audioDurationMs,
        timingSource: checkpoint.subtitleTimingSource ?? "tts_segment_timing",
        speechCoverage: checkpoint.speechCoverage,
      });
      // The alignment already ran before the provider wait; the resume path only re-reports
      // it (ADR 0056) and replays the evidence the checkpoint carries.
      const subtitleVerification = checkpoint.subtitleVerification;
      if (subtitleQa.status !== "passed") {
        emitTelemetry({
          name: "subtitle_quality_report",
          category: subtitleQa.status === "failed" ? "error" : "pipeline",
          source: "server",
          step: "captions",
          status: subtitleQa.code,
          properties: {
            pipelineRunId,
            jobId,
            via: "mcp",
            provider,
            timingSource: subtitleQa.timingSource,
            resumedFrom: "avatar_checkpoint",
          },
        });
        if (subtitleQualityShouldFailJob(subtitleQa)) {
          throw new Error(`ไม่มีข้อความซับสำหรับคลิปนี้ (${subtitleQa.code}) — กรุณาตรวจสคริปต์แล้วลองใหม่`);
        }
      }

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
          subtitleQa,
          subtitleEvidence: {
            captions,
            words: checkpoint.words,
            fullText: checkpoint.fullText,
            audioDurationMs: checkpoint.audioDurationMs,
            timingSource: checkpoint.subtitleTimingSource ?? "tts_segment_timing",
            speechCoverage: checkpoint.speechCoverage,
            ...(subtitleVerification ? { verification: subtitleVerification } : {}),
          },
          preview: {
            captions,
            config: checkpoint.baseConfig,
            voiceUrl: checkpoint.voiceUrl,
            voiceModel: galleryVoiceModelForInput(input, user, provider),
            audioDurationMs: checkpoint.audioDurationMs,
            speechCoverage: checkpoint.speechCoverage,
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

      const billingReceipt = process.env.RENDER_VIA_QUEUE === "1"
        ? await getVideoJobBillingReceipt({ videoJobId: jobId, userId })
        : null;
      if (billingReceipt && billingReceipt.status !== "settled") {
        throw new Error(`ตรวจสอบการคิดนาที/เครดิตไม่ผ่าน (${billingReceipt.code}) — ระบบหยุดก่อนส่งมอบงาน`);
      }
      await caller.patch(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

      const finalDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, finalDuration]);
      emitStage(phaseName, "done", finalDuration);
      const totalS = (Date.now() - jobStartedAt) / 1000;
      console.log(`[mcp-worker] job ${jobId} TIMINGS total=${totalS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);
      await finishJob(jobId, {
        videoUrl: burnedUrl,
        videoId: created.id,
        subtitleQa,
        subtitleEvidence: {
          captions,
          words: checkpoint.words,
          fullText: checkpoint.fullText,
          audioDurationMs: checkpoint.audioDurationMs,
          timingSource: checkpoint.subtitleTimingSource ?? "tts_segment_timing",
          speechCoverage: checkpoint.speechCoverage,
          ...(subtitleVerification ? { verification: subtitleVerification } : {}),
        },
        ...(billingReceipt ? { billingReceipt } : {}),
      });
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
      const rrBaseConfig: Record<string, unknown> = {
        ...(preview.config as Record<string, unknown>),
        bgVideos: mergeRes.bgVideos,
        keywordPopups: [] as unknown[],
      };

      await step("render", 40);
      const rr = await caller.post<{ jobId: string }>("/api/videos/render", {
        shortVideoConfig: rrBaseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
        rerenderOf: { sourceJobId: input.sourceJobId },
        parentJobId: jobId,
      });
      const rrNewBase = await pollRender(caller, rr.jobId, (pct) => { void setJobStep(jobId, "render", 40 + Math.round(pct * 0.3)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(rr.jobId) });

      // Re-composite with the SAME stored avatar/uploaded clip assets (no HeyGen call).
      let rrFinalUrl = rrNewBase;
      let rrCompositeBaseUrl: string | null = preview.compositeBaseUrl ?? null;
      let rrCutawayPersonRanges = preview.cutawayPersonRanges;
      const rrHasAvatar = !!(preview.avatarModel && preview.avatarModel !== "none" && preview.avatarVideoUrl);
      if (rrHasAvatar) {
        const heygenModes = new Set(["full", "bookend", "bookend-both"]);
        const rrAvatarTiming = preview.avatarMode;
        const rrIsCutaway = preview.avatarModel === "upload-cutaway";

        if (rrIsCutaway) {
          // Uploaded clip is a full-frame speaker layer, not chromakey footage. Visibility edits
          // control personRanges: B-roll OFF reveals the original uploaded clip; B-roll ON removes
          // that overlay for the exact fixed window.
          //
          // The baseline is NEVER guessed from the merged segments: new previews persist
          // `cutawayPersonRanges`, legacy ones replay the creation formula (same captions, same
          // window cadence / targetClipCount) so "swap one clip" can't reshuffle person ↔ B-roll
          // across the whole video.
          let rrBasePersonRanges: { start: number; end: number }[];
          if (Array.isArray(preview.cutawayPersonRanges)) {
            rrBasePersonRanges = preview.cutawayPersonRanges;
          } else {
            const rrSourceInput = parseCreateInput(src.inputJson);
            rrBasePersonRanges = reconstructCutawayPersonRanges({
              captions: preview.captions,
              audioDurationMs: preview.audioDurationMs,
              windowSec: Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4,
              targetClipCount: rrSourceInput?.targetClipCount,
            });
            if (rrBasePersonRanges.length === 0) {
              // No captions to replay => the original layout is unknowable. Fail closed instead
              // of shipping a video whose person/B-roll spans are a guess.
              await failJob(jobId, "ข้อมูลช่วงคนพูดของวิดีโอต้นฉบับไม่ครบ — ปรับ B-roll ไม่ได้");
              return;
            }
          }

          const rrDecision = planCutawayRecomposite(
            mergeRes.bgVideos,
            rrBasePersonRanges,
            srcBgVideos as CutawayBrollSegment[],
          );
          rrCutawayPersonRanges = rrDecision.personRanges;
          if (rrDecision.skipComposite) {
            // Every window shows B-roll => there is no speaker overlay left. Compositing would
            // hand ffmpeg an empty `enable=` expression, which draws the uploaded clip over the
            // WHOLE video (the exact opposite of the edit). The base render already carries the
            // clip's own audio (config.voiceFile = the uploaded clip), so it IS the final video.
            rrFinalUrl = rrNewBase;
            rrCompositeBaseUrl = null;
          } else {
            await step("composite", 80);
            const rrComp = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
              avatarVideoUrl: preview.avatarVideoUrl,
              bgVideoUrl: rrNewBase,
              mode: "cutaway",
              personRanges: rrCutawayPersonRanges,
              cutawayAudioFromBackground: typeof rrBaseConfig.bgmFile === "string"
                && rrBaseConfig.bgmFile.length > 0,
            }, { retries: 0 });
            rrFinalUrl = rrComp.videoUrl;
            rrCompositeBaseUrl = null;
          }
        } else {
          // AI Avatar: free chromakey re-composite, identical to AvatarAdjustOverlay.apply().
          if (!rrAvatarTiming || !heygenModes.has(rrAvatarTiming)) {
            await failJob(jobId, "ข้อมูลโหมด Avatar ไม่ครบ — ปรับ B-roll ไม่ได้");
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
          rrCompositeBaseUrl = rrNewBase;
        }
      }

      // flush final phase + one-line log
      const rrDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, rrDuration]);
      emitStage(phaseName, "done", rrDuration);
      console.log(`[mcp-worker] job ${jobId} BROLL-RERENDER total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s edits=${editsRes.length} avatar=${rrHasAvatar}`);

      // Preview payload = SOURCE preview copied verbatim (captions/voiceUrl/words/audioDurationMs
      // /avatar* unchanged — subtitle invariant) with config + videoUrl + compositeBaseUrl updated.
      const preparedSceneRerollPromotions = await prepareAppliedSceneRerollAssets({
        userId,
        sourceVideoJobId: src.id,
        edits: editsRes,
      });
      const rrCompletion = await finishJobWithTransition(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: rrFinalUrl,
        // This derivative changes only visual windows. Keep the source's proven
        // subtitle release decision and acoustic evidence so Export does not
        // misclassify an upload preview as legacy and attempt to realign it.
        ...(parsed.subtitleQa ? { subtitleQa: parsed.subtitleQa } : {}),
        ...(parsed.subtitleEvidence ? { subtitleEvidence: parsed.subtitleEvidence } : {}),
        preview: {
          ...preview,
          config: rrBaseConfig,
          compositeBaseUrl: rrCompositeBaseUrl,
          ...(rrCutawayPersonRanges ? { cutawayPersonRanges: rrCutawayPersonRanges } : {}),
        },
      }, {
        onTransition: ({ tx, job: completedJob }) =>
          commitAppliedSceneRerollAssetsInTransaction(tx, {
            appliedVideoJobId: completedJob.id,
            promotions: preparedSceneRerollPromotions,
          }),
      });
      if (
        rrCompletion.transitioned
        && rrCompletion.job.status === "done"
        && src.projectId
        && src.projectVisualContextJson
      ) {
        await Promise.all(editsRes.map(async (edit) => {
          const reason: FirstPassVisualRejectionReason | null =
            firstPassVisualRejectionReasonForWindow(srcBgVideos[edit.index], edit);
          if (!reason) return;
          await recordFirstPassVisualRejection(userId, {
            actor: user,
            projectId: src.projectId!,
            videoJobId: src.id,
            sceneIndex: edit.index,
            reason,
            projectVisualContextJson: src.projectVisualContextJson,
          });
        })).catch((error) => {
          console.error("[mcp-worker] first-pass visual rejection telemetry failed:", error);
        });
      }
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
      const sourceSubtitleQa = parsed?.subtitleQa;
      const sourceInput = parseCreateInput(src.inputJson);
      const overlayPopups = Array.isArray(input.subtitleOverlayConfig.keywordPopups)
        ? input.subtitleOverlayConfig.keywordPopups
        : [];
      const subtitlesVisible = overlayPopups.length > 0;
      let finalCaptions: OrchCaption[];
      if (!subtitlesVisible) {
        finalCaptions = preview.captions.map((caption, index) => ({
          ...caption,
          tag: caption.tag === "hook" || caption.tag === "cta" ? caption.tag : (index === 0 ? "hook" : "body"),
        }));
      } else if (input.editSnapshot?.captions?.length) {
        finalCaptions = input.editSnapshot.captions.map((caption, index) => ({
          ...caption,
          tag: caption.tag === "hook" || caption.tag === "cta" ? caption.tag : (index === 0 ? "hook" : "body"),
        }));
      } else {
        finalCaptions = overlayPopups.flatMap((candidate, index) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
          const popup = candidate as Record<string, unknown>;
          const text = typeof popup.text === "string" ? popup.text.trim() : "";
          const startFrame = Number(popup.start);
          const endFrame = Number(popup.end);
          if (!text || !Number.isFinite(startFrame) || !Number.isFinite(endFrame)) return [];
          return [{
            text,
            startMs: Math.round((startFrame / RENDER_FPS) * 1_000),
            endMs: Math.round((endFrame / RENDER_FPS) * 1_000),
            tag: index === 0 ? "hook" as const : "body" as const,
          }];
        });
      }
      const canonicalScript = sourceInput?.mode === "upload" || sourceSubtitleQa?.timingSource === "upload_transcription"
        ? finalCaptions.map((caption) => caption.text).join("")
        : preview.fullText?.trim() || sourceInput?.script?.trim() || "";
      const exportTimingSource: SubtitleTimingSource = sourceSubtitleQa?.timingSource
        ?? (sourceInput?.mode === "upload" ? "upload_transcription" : "tts_segment_timing");
      const exportWords = preview.words ?? [];
      const exportAudioDurationMs = preview.audioDurationMs;
      let exportSpeechCoverage = preview.speechCoverage ?? sourceSubtitleQa?.speechCoverage;
      if (!exportSpeechCoverage && exportTimingSource === "upload_transcription") {
        const spokenEndMs = finalCaptions.reduce((max, caption) => Math.max(max, caption.endMs), 0);
        if (spokenEndMs > 0) {
          // Backward compatibility for previews created before silence-analysis
          // evidence was persisted. Upload captions themselves are acoustic;
          // word-level regrouping remains optional.
          exportSpeechCoverage = { source: "upload_transcription", spokenEndMs };
        }
      }
      let exportOverlayConfig = input.subtitleOverlayConfig;
      // ADR 0056: Export never re-aligns and never refuses a creator's edit. Timing is
      // repaired deterministically (blank cards dropped, cards clamped inside the audio);
      // everything else is reported with the job.
      const repairedExport = repairCaptionTiming(finalCaptions, exportAudioDurationMs ?? 0);
      finalCaptions = repairedExport.captions;
      if (repairedExport.dropped > 0 && subtitlesVisible) {
        // A dropped blank card must not be burned either. Removing exactly the empty popups
        // (never by index) keeps every remaining card's own style, and the projection below
        // still refuses to touch a track whose card count no longer matches.
        const visiblePopups = overlayPopups.filter((candidate) =>
          !!candidate
          && typeof candidate === "object"
          && !Array.isArray(candidate)
          && typeof (candidate as { text?: unknown }).text === "string"
          && (candidate as { text: string }).text.trim().length > 0);
        if (visiblePopups.length === finalCaptions.length) {
          exportOverlayConfig = { ...exportOverlayConfig, keywordPopups: visiblePopups };
        }
      }
      if (repairedExport.repaired) {
        exportOverlayConfig = retimeSubtitleOverlayConfig(exportOverlayConfig, finalCaptions)
          ?? exportOverlayConfig;
      }
      const exportSubtitleQa = validateSubtitleQuality({
        script: canonicalScript,
        captions: finalCaptions,
        audioDurationMs: exportAudioDurationMs,
        timingSource: exportTimingSource,
        speechCoverage: exportSpeechCoverage,
      });
      if (exportSubtitleQa.status !== "passed") {
        emitTelemetry({
          name: "subtitle_quality_report",
          category: exportSubtitleQa.status === "failed" ? "error" : "pipeline",
          source: "server",
          step: "burn",
          status: exportSubtitleQa.code,
          properties: {
            pipelineRunId,
            jobId,
            via: "mcp",
            mode: "export",
            timingSource: exportTimingSource,
            repaired: repairedExport.repaired,
            dropped: repairedExport.dropped,
          },
        });
        // Only "nothing to show" stops an export.
        if (subtitleQualityShouldFailJob(exportSubtitleQa)) {
          throw new SubtitleAlignmentFailureError(
            "ไม่มีข้อความซับให้ส่งออก — เปิดชั้นซับหรือเพิ่มข้อความอย่างน้อย 1 กล่องก่อนส่งออก",
            exportSubtitleQa.code,
            sourceInput?.voiceProvider,
          );
        }
      }
      const voiceModel = await resolveExportGalleryVoiceModel(src, userId, user);

      await step("burn", 20);
      const durableBurn = await prisma.renderJob.findFirst({
        where: {
          parentJobId: jobId,
          userId,
          type: "BURN",
          status: { in: ["QUEUED", "RUNNING", "DONE"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, videoUrl: true },
      });
      let burnedUrl: string;
      if (durableBurn?.status === "DONE" && durableBurn.videoUrl) {
        burnedUrl = durableBurn.videoUrl;
      } else {
        const burnJobId = durableBurn?.id ?? (await caller.post<{ jobId: string }>("/api/videos/render", {
          subtitleOverlayConfig: exportOverlayConfig,
          parentJobId: jobId,
        })).jobId;
        burnedUrl = await pollRender(
          caller,
          burnJobId,
          (pct) => { void setJobStep(jobId, "burn", 20 + Math.round(pct * 0.7)).catch(() => {}); },
          { sleep, checkCanceled: cancelInFlightRender(burnJobId) },
        );
      }

      await step("save", 92);
      let videoId = job.videoId ?? undefined;
      if (!videoId) {
        const saved = await caller.post<{ videoId?: string; id?: string }>("/api/videos", {
          parentJobId: jobId,
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
        videoId = saved.videoId ?? saved.id;
      }

      const exportDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, exportDuration]);
      emitStage(phaseName, "done", exportDuration);
      console.log(`[mcp-worker] job ${jobId} EXPORT total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s source=${input.sourceJobId}`);

      const completion = await finishJobWithTransition(jobId, {
        version: 2,
        mode: "export",
        sourceJobId: input.sourceJobId,
        videoUrl: burnedUrl,
        subtitleQa: exportSubtitleQa,
        subtitleEvidence: {
          captions: finalCaptions,
          words: exportWords,
          fullText: canonicalScript,
          audioDurationMs: exportAudioDurationMs,
          timingSource: exportTimingSource,
          speechCoverage: exportSpeechCoverage,
        },
        ...(videoId ? { videoId } : {}),
        ...(input.editSnapshot ? { editSnapshot: input.editSnapshot } : {}),
      });
      if (
        completion.transitioned
        && completion.job.status === "done"
        && src.projectId
        && src.contentPreflightId
        && src.projectVisualContextJson
      ) {
        const initialAiWindowCount = await prisma.projectVisualBeat.count({
          where: {
            userId,
            projectId: src.projectId,
            preflightId: src.contentPreflightId,
            existingImageJobId: { not: null },
          },
        });
        await recordFirstPassVisualExport(userId, {
          actor: user,
          projectId: src.projectId,
          videoJobId: src.id,
          projectVisualContextJson: src.projectVisualContextJson,
          initialAiWindowCount,
        }).catch((error) => {
          console.error("[mcp-worker] first-pass visual export telemetry failed:", error);
        });
      }
      const logoCompletionProperties = buildLogoExportCompletedTelemetryProperties(
        exportOverlayConfig,
        exportAudioDurationMs,
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
      const brollCompletionProperties = brollExportCompletionProperties(src);
      if (
        completion.transitioned
        && completion.job.status === "done"
        && brollCompletionProperties
      ) {
        emitTelemetry({
          name: "editor_broll_export_completed",
          category: "product",
          source: "server",
          status: "done",
          properties: brollCompletionProperties,
        });
      }
      return;
    }

    // ── EDITOR V2 UPLOAD → CUTAWAY (P6.5, previewMode-only) ───────────────────
    // ข้ามเสียงพากย์/อวตาร: ถอดซับจากเสียงในคลิป → b-roll windows →
    // base reel (เสียงคลิป + เพลงที่เลือก) → composite mode:"cutaway" → จบที่ preview.
    if (input.mode === "upload") {
      if (!input.clipUrl) { await failJob(jobId, "upload job missing clipUrl"); return; }

      await step("captions", 20);
      const tx = await caller.post<{
        captions?: OrchCaption[];
        words?: Array<{ word: string; startMs: number; endMs: number }>;
        fullText?: string;
        audioDurationMs?: number;
        speechCoverage?: SubtitleSpeechCoverage;
      }>(
        "/api/videos/transcribe", { audioUrl: input.clipUrl, script: "" },
      );
      const upCaps = (tx.captions ?? []).filter((c) => typeof c?.text === "string" && c.text.trim());
      if (!upCaps.length) throw new Error("ถอดซับจากคลิปไม่สำเร็จ — เช็คว่าคลิปมีเสียงพูดชัดเจน");
      const upFullText = tx.fullText?.trim() || upCaps.map((caption) => caption.text).join(" ");
      const uploadWords = resolveUploadTranscriptWords(upFullText, tx.words ?? []);
      const upWords = uploadWords.words;
      if (!uploadWords.regroupingAvailable) {
        console.warn(
          `[orchestrator] upload word regrouping disabled job=${jobId} reason=${uploadWords.failureCode}`,
        );
      }
      const upDurMs = (tx.audioDurationMs && tx.audioDurationMs > 0)
        ? Math.round(tx.audioDurationMs)
        : Math.max(...upCaps.map((c) => c.endMs));
      const uploadSubtitleQa = validateSubtitleQuality({
        script: upCaps.map((caption) => caption.text).join(""),
        captions: upCaps,
        audioDurationMs: upDurMs,
        timingSource: "upload_transcription",
        speechCoverage: tx.speechCoverage,
      });
      if (subtitleQualityShouldFailJob(uploadSubtitleQa)) {
        throw new Error(`ซับจากคลิปไม่ผ่านการตรวจคุณภาพ (${uploadSubtitleQa.status === "failed" ? uploadSubtitleQa.code : "unknown"}) — กรุณาลองใหม่`);
      }
      await reconcileVideoJobFunding(jobId, userId, minutesFromSeconds(upDurMs / 1_000));

      const upWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
      const upManualWindowCount = manualCutawayWindowCount(input.targetClipCount, upDurMs);
      const upVisibleTargetCount = effectiveManualCutawayPieceCount(input.targetClipCount, upDurMs);
      const upWindows = cutawayPieceLimit(upDurMs) === 0
        ? buildFixedCountBrollWindows(
            upCaps.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            1,
            upDurMs,
            120,
          )
        : upManualWindowCount > 0
        ? buildFixedCountBrollWindows(
            upCaps.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            upManualWindowCount,
            upDurMs,
            120,
          )
        : buildBrollWindows(
            upCaps.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
            upWindowSec,
            upDurMs,
          );
      // Plan the final composite before any provider request. The uploaded presenter
      // covers every `person` range, so media generated for those ranges can never be
      // seen and must not consume image credits.
      const upCutawayPlan = planCutaway(upWindows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })));
      const visibleBrollRanges = new Set(
        upCutawayPlan.broll.map((range) => `${range.startMs}:${range.endMs}`),
      );
      const upVisibleWindows = upWindows.filter((window) =>
        visibleBrollRanges.has(`${window.startMs}:${window.endMs}`),
      );
      const upBrollUnits = brollWindowCaptions(upVisibleWindows);

      if (upVisibleWindows.length > 0) {
        const uploadPreflight = await ensureUploadContentPreflight({
          actor: {
            id: user.id,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
          },
          projectId: job.projectId,
          transcriptText: upCaps.map((caption) => caption.text).join("\n"),
          windows: upVisibleWindows.map((window) => ({
            text: window.text,
            startMs: window.startMs,
            endMs: window.endMs,
          })),
          sceneContentPolicy: input.sceneContentPolicy
            ?? sceneContentPolicyFromPreference(input.brollRegionPreference),
          brandVisualAccepted: Boolean(job.projectVisualContextJson),
        });
        if (uploadPreflight.kind === "resolved") {
          await pinProjectVisualContextToVideoJob({
            userId: user.id,
            projectId: job.projectId!,
            videoJobId: jobId,
            preflightId: uploadPreflight.preflight.id,
          });
          emitTelemetry({
            name: "brand_visual_preflight_resolved",
            category: "performance",
            source: "server",
            step: "editor.step2",
            status: uploadPreflight.preflight.cached ? "cached" : "analyzed",
            properties: {
              projectId: job.projectId,
              preflightId: uploadPreflight.preflight.id,
              sourceKind: "upload-transcript",
              visualFormatId: uploadPreflight.preflight.suggestedVisualFormatId,
              beatCount: uploadPreflight.preflight.visualBeats.length,
              via: "upload-worker",
            },
          });
        }
      }

      await step("keywords", 40);
      const upKw = upBrollUnits.length > 0
        ? await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][]; relevanceSpec?: unknown }>(
            "/api/videos/extract-keywords",
            {
              ...buildKeywordsPayload(upBrollUnits.map((c) => c.text), upCaps.map((c) => c.text).join("\n"), upDurMs, {
                brollRegionPreference: input.brollRegionPreference,
                brollVisualStyle: input.brollVisualStyle,
              }),
              ...(upVisibleTargetCount > 0 ? { targetClipCount: upVisibleTargetCount } : {}),
            },
          )
        : {
            keywords: [] as string[],
            keywordsPerScene: 1,
            sceneClipCounts: [] as number[],
            sceneDurations: [] as number[],
            visualDirection: "",
            keywordAlternatives: [] as string[][],
            relevanceSpec: undefined as unknown,
          };

      await step("stock", 55);
      const upAiGen = input.stockSource === "kie-image" || input.stockSource === "auto-mix";
      const upAligned = alignBrollWindowsToKeywords(upVisibleWindows, upBrollUnits, upKw.keywords ?? [], upKw.keywordAlternatives);
      const upTotalDur = upAligned.windows.length > 0
        ? Math.round(upDurMs / 1000)
        : (upKw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(upDurMs / 1000);
      const upStock = upAligned.windows.length > 0
        ? await fetchStockWithHeroProviderRetry<{ results: unknown[] }>(
            {
              ...buildStockPayload(upAligned.keywords, upTotalDur, input.stockSource ?? DEFAULT_STOCK_SOURCE, upAligned.units, upKw.visualDirection, upAligned.alternatives, upKw.relevanceSpec, {
                brollRegionPreference: input.brollRegionPreference,
                brollVisualStyle: input.brollVisualStyle,
              }, true, upAligned.windows, {
                fullScript: upCaps.map((caption) => caption.text).join("\n"),
              }),
              ...(input.kieModel ? { kieModel: input.kieModel } : {}),
              ...(input.imageEngine ? { imageEngine: input.imageEngine } : {}),
              ...(input.imageModel ? { imageModel: input.imageModel } : {}),
              videoJobId: jobId,
              ...(input.autoMixProviders?.length ? { autoMixProviders: input.autoMixProviders } : {}),
              ...(input.autoMixWeights ? { autoMixWeights: input.autoMixWeights } : {}),
              ...(typeof input.maxAiImages === "number" ? { maxAiImages: input.maxAiImages } : {}),
              ...(input.stockProviders?.length ? { stockProviders: input.stockProviders } : {}),
            },
            input.stockSource === "kie-image" && input.imageEngine === "runpod",
            upAiGen,
          )
        : {
            // With fewer than two windows the presenter covers the whole clip. Reuse
            // that clip as the hidden render background without calling stock/AI.
            results: [{
              videoUrl: input.clipUrl,
              keyword: "uploaded presenter clip",
              duration: Math.max(1, upDurMs / 1000),
              sourceIndex: 0,
            }] as unknown[],
          };
      emitBrollStockInventory(upAligned.windows.length, upStock.results ?? []);

      await step("config", 65);
      const upScc = upAligned.windows.length > 0 ? [] : (upCaps.length === (upKw.keywords ?? []).length ? upCaps.map(() => 1) : (upKw.sceneClipCounts ?? []));
      const upBackgroundTimeline = buildCutawayBackgroundTimeline({
        windows: upWindows.map((window) => ({ startMs: window.startMs, endMs: window.endMs })),
        brollRanges: upCutawayPlan.broll,
        brollAssets: (upStock.results ?? []) as Record<string, unknown>[],
        presenterAsset: {
          videoUrl: input.clipUrl,
          keyword: "uploaded presenter clip",
          duration: Math.max(1, upDurMs / 1_000),
          timelineAligned: true,
        },
      });
      const upCfg = await caller.post<{ config: Record<string, unknown> }>(
        "/api/videos/generate-config",
        buildConfigPayload(
          upCaps, upBackgroundTimeline.assets, input.clipUrl, upDurMs, upCaps.map((c) => c.text),
          upKw.keywordsPerScene ?? 5, upScc, upKw.sceneDurations ?? [],
          upBackgroundTimeline.windows,
        ),
      );

      await step("render", 75);
      const upBaseConfig = {
        ...upCfg.config,
        keywordPopups: [] as unknown[],
        ...(input.bgmFile ? { bgmFile: input.bgmFile, bgmVolume: input.bgmVolume ?? 0.12 } : {}),
      };
      const upR = await caller.post<{ jobId: string }>("/api/videos/render", {
        shortVideoConfig: upBaseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
        parentJobId: jobId,
      });
      const upReelUrl = await pollRender(caller, upR.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.12)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(upR.jobId) });
      // preview: การจองที่ base render คือค่าใช้จ่ายเดียว (เหมือน script preview) — ไม่ refund

      await step("composite", 90);
      const personRanges = upCutawayPlan.person.map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));
      // hook = คลิปที่อัปต้องเป็นเฟรมแรกเสมอ. transcribe เว้นช่วง [0, คำแรก) ไว้ (เงียบ/หายใจ/อินโทร)
      // ทำให้ base reel (b-roll) โผล่ก่อนหน้าคนพูด — คลุม person range แรกให้เริ่มที่ 0 (บั๊ก kapokja 07-04).
      // person เป็น overlay บน b-roll base (composite mode:cutaway) → ทุกจังหวะที่ไม่มี person range = b-roll โผล่.
      if (personRanges.length > 0) personRanges[0] = { ...personRanges[0], start: 0 };
      // ไม่มี window เลย (transcript เพี้ยน) = ไม่มี b-roll ให้ตัดสลับ → คลิปครองทั้งไทม์ไลน์.
      // ต้องระบุช่วงให้ชัด: /api/heygen/composite ปฏิเสธ personRanges ว่างแล้ว (fail-closed)
      // แทน fail-open เดิมที่วางคลิปทับทั้งคลิปเงียบ ๆ.
      else if (upDurMs > 0) personRanges.push({ start: 0, end: upDurMs / 1000 });
      const comp = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
        mode: "cutaway",
        avatarVideoUrl: input.clipUrl,
        bgVideoUrl: upReelUrl,
        personRanges,
        cutawayAudioFromBackground: Boolean(input.bgmFile),
      }, { retries: 0 });

      const upFinalDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, upFinalDuration]);
      emitStage(phaseName, "done", upFinalDuration);
      console.log(`[mcp-worker] job ${jobId} UPLOAD-CUTAWAY total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s scenes=${upCaps.length} windows=${upWindows.length} visibleBroll=${upVisibleWindows.length}`);

      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: comp.videoUrl,
        subtitleQa: uploadSubtitleQa,
        preview: {
          captions: upCaps,
          config: upBaseConfig,
          voiceUrl: input.clipUrl,
          voiceModel: "original-audio",
          audioDurationMs: upDurMs,
          speechCoverage: tx.speechCoverage,
          avatarModel: "upload-cutaway",
          avatarVideoUrl: input.clipUrl,
          cutawayPersonRanges: personRanges,
          words: upWords,
          fullText: upFullText,
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
        { text: narrationText, voiceId: input.voiceId ?? user.elevenlabsVoiceId ?? undefined, languageCode: "th" },
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
            text: narrationText,
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
        { text: narrationText, voiceName: input.geminiVoiceName ?? user.geminiVoiceName ?? "Aoede" },
      );
    }
    const prepareGeneratedTts = async (
      candidate: { voiceUrl: string; audioDurationMs?: number; timing?: unknown },
    ): Promise<number> => {
      let candidateDurationMs = typeof candidate.audioDurationMs === "number" && candidate.audioDurationMs > 0
        ? Math.round(candidate.audioDurationMs)
        : durationFromTtsTiming(candidate.timing);
      if (candidateDurationMs <= 0) {
        const measured = await caller.post<{ durationMs?: number }>(
          "/api/videos/audio-duration",
          { audioUrl: candidate.voiceUrl },
        );
        candidateDurationMs = typeof measured.durationMs === "number" && measured.durationMs > 0
          ? Math.round(measured.durationMs)
          : 0;
      }
      if (candidateDurationMs <= 0) {
        throw new Error("ตรวจสอบความยาวเสียงไม่ได้ — กรุณาลองสร้างใหม่");
      }

      await reconcileVideoJobFunding(jobId, userId, minutesFromSeconds(candidateDurationMs / 1_000));

      // Exact duration is known now. Stop before captions, keyword LLM, stock downloads,
      // rendering, or HeyGen can spend more time/quota; /api/videos/render keeps its own
      // authoritative backstop for direct callers.
      const durationViolation = audioDurationLimitViolation(candidateDurationMs, user.plan);
      if (durationViolation) {
        throw new Error(`${durationViolation.message} — ${durationViolation.userAction}`);
      }

      // The calibrated script estimate rejects known-unsupported requests before
      // TTS. This exact post-TTS backstop catches estimator undershoot before any
      // caption, stock, render, or HeyGen spend begins.
      const fullAvatarDurationViolation = avatarFullDurationViolation({
        mode: input.avatarMode,
        durationSec: candidateDurationMs / 1_000,
      });
      if (fullAvatarDurationViolation) {
        throw new Error(`${fullAvatarDurationViolation.message} — ${fullAvatarDurationViolation.userAction}`);
      }

      // Web parity + provider-spend guard: a split intro/outro must leave a real
      // middle interval. Stop immediately after exact TTS duration, before keyword
      // LLM, stock downloads, base render, or either HeyGen generation.
      const avatarDurationViolation = avatarBookendDurationViolation({
        mode: input.avatarMode,
        audioDurationMs: candidateDurationMs,
        introSec: input.avatarIntroSecs ?? 5,
        tailSec: input.avatarTailSecs ?? 5,
      });
      if (avatarDurationViolation) throw new Error(avatarDurationViolation.message);
      return candidateDurationMs;
    };
    const audioDurationMs = await prepareGeneratedTts(tts);

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
    let subtitleTimingSource: SubtitleTimingSource = provider === "elevenlabs"
      ? "provider_alignment"
      : "tts_segment_timing";
    let subtitleSpeechCoverage: SubtitleSpeechCoverage | undefined;
    const timingForCards = tts.timing as TtsTiming | null;
    const fullTextForCards = (timingForCards?.segments ?? []).map((segment) => segment.text).join("");
    let viralCards: ScriptCard[] | null = null;
    if (wantsSentenceCards && fullTextForCards.length >= 120) {
      try {
        const split = await caller.post<{ cards?: ScriptCard[] }>("/api/videos/split-script", {
          text: fullTextForCards,
          maxCardChars: maxCardCharsFor(),
        });
        viralCards = Array.isArray(split.cards) ? split.cards : null;
      } catch { /* fail-open → deterministic sentence cards */ }
    }

    // ── Timing ladder (ADR 0056) ──────────────────────────────────────────────
    // 1. The provider clock always renders unless something better is proven. It is exact
    //    by arithmetic for ElevenLabs and deterministic for Gemini/Hero AI Voice.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor(), viralCards);
    if (!capRes || capRes.captions.length === 0) {
      // The provider returned no usable timing (the tts-gemini single-call fallback):
      // spread the exact narration over the measured duration instead of refusing the clip.
      capRes = captionsFromSpokenScript(narrationText, audioDurationMs, maxCardCharsFor());
      subtitleTimingSource = "avatar_script_clock";
    }
    if (!capRes || capRes.captions.length === 0) {
      throw new SubtitleAlignmentFailureError(
        "ไม่มีข้อความซับสำหรับคลิปนี้ (empty_captions) — กรุณาตรวจสคริปต์แล้วลองใหม่",
        "empty_captions",
        provider,
      );
    }
    const ttsCaptions = capRes.captions.map((caption) => ({ startMs: caption.startMs, endMs: caption.endMs }));

    // 2. ONE bounded acoustic alignment (Gemini / Hero AI Voice — ElevenLabs already ships
    //    real word timing). Success promotes it to the render clock; anything else keeps the
    //    provider clock and is recorded. It never retries, never regenerates the narration.
    let verification: SubtitleAlignmentAttempt = { status: "skipped", durationMs: 0, ttsCaptions };
    if (provider !== "elevenlabs") {
      verification = await alignNarrationOnce({
        caller,
        audioUrl: tts.voiceUrl,
        narrationText,
        maxCardChars: maxCardCharsFor(),
        budgetMs: subtitleVerifyBudgetMs(),
        audioDurationMs,
        ttsCaptions,
      });
      emitTelemetry({
        name: "subtitle_verification_done",
        category: "pipeline",
        source: "server",
        step: "captions",
        status: verification.status,
        value: verification.durationMs,
        properties: {
          pipelineRunId,
          jobId,
          via: "mcp",
          provider,
          durationMs: verification.durationMs,
          ...(verification.method ? { method: verification.method } : {}),
          ...(verification.similarityPermille !== undefined ? { similarityPermille: verification.similarityPermille } : {}),
          ...(verification.medianAbsStartDeltaMs !== undefined ? { medianAbsStartDeltaMs: verification.medianAbsStartDeltaMs } : {}),
          ...(verification.maxAbsStartDeltaMs !== undefined ? { maxAbsStartDeltaMs: verification.maxAbsStartDeltaMs } : {}),
          ...(verification.code ? { code: verification.code } : {}),
        },
      });
      if (verification.status === "aligned" && verification.capRes) {
        capRes = verification.capRes;
        subtitleTimingSource = "forced_alignment";
        subtitleSpeechCoverage = verification.speechCoverage;
      }
    }
    const subtitleVerification = subtitleVerificationEvidence(verification);

    const baseCaptions = capRes.captions as OrchCaption[];
    const wordModeCaptions = (input.subtitleMode && input.subtitleMode !== "sentence")
      ? cardsByWordCount(capRes.words, parseInt(input.subtitleMode), capRes.fullText)
      : baseCaptions;
    const durMs = capRes.audioDurationMs || audioDurationMs;
    // 3. Deterministic timing repair: blank cards dropped, cards clamped inside the audio,
    //    monotonic, never shorter than the render floor.
    const repairedTiming = repairCaptionTiming(wordModeCaptions, durMs);
    const captions = repairedTiming.captions;
    const subtitleQa = validateSubtitleQuality({
      script: capRes.fullText,
      captions,
      audioDurationMs: durMs,
      timingSource: subtitleTimingSource,
      speechCoverage: subtitleSpeechCoverage,
    });
    if (subtitleQa.status !== "passed") {
      emitTelemetry({
        name: "subtitle_quality_report",
        category: subtitleQa.status === "failed" ? "error" : "pipeline",
        source: "server",
        step: "captions",
        status: subtitleQa.code,
        properties: {
          pipelineRunId,
          jobId,
          via: "mcp",
          provider,
          timingSource: subtitleTimingSource,
          repaired: repairedTiming.repaired,
          dropped: repairedTiming.dropped,
          verification: verification.status,
        },
      });
      // Only "nothing to show" stops a render (ADR 0056); every other finding is a report.
      if (subtitleQualityShouldFailJob(subtitleQa)) {
        throw new SubtitleAlignmentFailureError(
          `ไม่มีข้อความซับสำหรับคลิปนี้ (${subtitleQa.code}) — กรุณาตรวจสคริปต์แล้วลองใหม่`,
          subtitleQa.code,
          provider,
        );
      }
    }

    // B-roll cadence PARITY with the web editor: group captions into ~4s windows so the
    // background holds one clip per window instead of cutting on every caption (the strobing
    // "พื้นหลังไม่เนียน / แล้วตัด"). Gated on the SAME flag as web so both surfaces stay in
    // lockstep. In window mode generate-config places one clip per window (ignoring
    // sceneClipCounts); subtitle timing is untouched.
    let effectiveContentPreflightId = job.contentPreflightId;
    const needsAiVisualPlan = input.stockSource === "kie-image" || input.stockSource === "auto-mix";
    let awaitingContentPreflight = false;
    if (job.projectVisualContextJson) {
      try {
        const parsed = JSON.parse(job.projectVisualContextJson) as { state?: string };
        awaitingContentPreflight = parsed.state === "awaiting-content-preflight";
      } catch {
        awaitingContentPreflight = false;
      }
    }
    if (
      (needsAiVisualPlan || awaitingContentPreflight)
      && !effectiveContentPreflightId
      && job.projectId
      && job.projectVisualContextJson
    ) {
      try {
        const visualPlan = await ensureVideoJobContentPreflight({
          actor: {
            id: user.id,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
          },
          projectId: job.projectId,
          videoJobId: jobId,
          narrativeSource: {
            kind: input.narrativeSourceKind ?? "creator-script",
            text: input.script,
            ...(input.targetClipCount ? { windowCount: input.targetClipCount } : {}),
            sceneContentPolicy: input.sceneContentPolicy
              ?? sceneContentPolicyFromPreference(input.brollRegionPreference),
          },
          brandVisualAccepted: true,
        });
        if (visualPlan.kind === "resolved") {
          effectiveContentPreflightId = visualPlan.preflight.id;
          emitTelemetry({
            name: "brand_visual_preflight_resolved",
            category: "performance",
            source: "server",
            step: "editor.step2",
            status: visualPlan.preflight.cached ? "cached" : "analyzed",
            properties: {
              projectId: job.projectId,
              preflightId: visualPlan.preflight.id,
              sourceKind: input.narrativeSourceKind ?? "creator-script",
              visualFormatId: visualPlan.preflight.suggestedVisualFormatId,
              treatmentPresetId: visualPlan.preflight.suggestedTreatment.presetId,
              beatCount: visualPlan.preflight.visualBeats.length,
              via: "script-worker",
            },
          });
        }
      } catch (error) {
        if (needsAiVisualPlan) throw error;
        emitTelemetry({
          name: "first_clip_preflight_fail_open",
          category: "pipeline",
          source: "server",
          step: "editor.step2",
          status: "fail_open",
          properties: {
            projectId: job.projectId,
            message: error instanceof Error ? error.message : "content_preflight_failed",
          },
        });
      }
    }
    const brollWindowMode = isInternalAiBetaEnabledFor(user, process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE === "1");
    const brollWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
    const pinnedBrandVisualWindows = effectiveContentPreflightId && job.projectVisualContextJson && job.projectId
      ? await narrativeVisualWindowsForPreflight({
          userId,
          projectId: job.projectId,
          preflightId: effectiveContentPreflightId,
        })
      : [];
    const pinnedBrandVisualWindowCount = pinnedBrandVisualWindows.length;
    const manualBrollCount = input.targetClipCount && input.targetClipCount > 0
      ? Math.min(60, Math.floor(input.targetClipCount))
      : Math.min(60, pinnedBrandVisualWindowCount);
    const timedCaptionInput = captions.map((caption) => ({
      startMs: caption.startMs,
      endMs: caption.endMs,
      text: caption.text,
    }));
    const narrativeAlignedWindows = pinnedBrandVisualWindowCount > 0
      ? buildNarrativeAlignedBrollWindows({
          captions: timedCaptionInput,
          words: capRes.words,
          spokenText: capRes.fullText,
          narrativeWindows: pinnedBrandVisualWindows.map((window) => window.text),
          audioEndMs: durMs,
        })
      : null;
    if (pinnedBrandVisualWindowCount > 0 && !narrativeAlignedWindows) {
      throw new ContentPreflightError(
        "NARRATIVE_MISMATCH",
        "ข้อมูลฉากไม่ตรงกับเนื้อหาที่เสียงพูดจริง — กรุณาเตรียมแนวภาพใหม่",
      );
    }
    const brollWindows = narrativeAlignedWindows
      ?? (brollWindowMode || manualBrollCount > 0
        ? manualBrollCount > 0
        ? buildFixedCountBrollWindows(
            timedCaptionInput,
            manualBrollCount,
            durMs,
          )
        : buildBrollWindows(
            timedCaptionInput,
            brollWindowSec,
            durMs,
          )
        : []);
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
    const stock = await fetchStockWithHeroProviderRetry<{ results: unknown[] }>(
      {
        ...buildStockPayload(aligned.keywords, totalDur, input.stockSource ?? DEFAULT_STOCK_SOURCE, aligned.units, kw.visualDirection, aligned.alternatives, kw.relevanceSpec, {
          brollRegionPreference: input.brollRegionPreference,
          brollVisualStyle: input.brollVisualStyle,
        }, aligned.windows.length > 0, aligned.windows, {
          fullScript: input.script,
        }),
        // v2 ขั้นสูง (Beta): โมเดลภาพ AI + แหล่ง Auto Mix — fetch-stock มี server default ให้ทั้งคู่
        ...(input.kieModel ? { kieModel: input.kieModel } : {}),
        ...(input.imageEngine ? { imageEngine: input.imageEngine } : {}),
        ...(input.imageModel ? { imageModel: input.imageModel } : {}),
        videoJobId: jobId,
        ...(input.autoMixProviders?.length ? { autoMixProviders: input.autoMixProviders } : {}),
        ...(input.autoMixWeights ? { autoMixWeights: input.autoMixWeights } : {}),
        ...(typeof input.maxAiImages === "number" ? { maxAiImages: input.maxAiImages } : {}),
        ...(input.stockProviders?.length ? { stockProviders: input.stockProviders } : {}),
      },
      input.stockSource === "kie-image" && input.imageEngine === "runpod",
      aiGenSource,
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
    // The base render owns the delivered video's single reservation for every success path,
    // including avatar composites. /api/heygen/composite publishes a paid marker for the
    // derived composite URL, allowing the later burn to stay free without moving the actual
    // minute/credit reservation. Refunding here would leave a successful avatar video with a
    // net-zero charge: base +1, refund -1, composite marker +0, burn +0.
    //
    // Terminal avatar/provider/burn failures are still settled by the failure paths below,
    // which refund this retained base reservation exactly once.

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
        subtitleTimingSource,
        speechCoverage: subtitleSpeechCoverage,
        // Carried so the resume path delivers the same evidence without re-aligning.
        subtitleVerification,
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
        subtitleQa,
        subtitleEvidence: {
          captions,
          words: capRes.words,
          fullText: capRes.fullText,
          audioDurationMs: durMs,
          timingSource: subtitleTimingSource,
          speechCoverage: subtitleSpeechCoverage,
          verification: subtitleVerification,
        },
        preview: {
          captions,
          config: baseConfig,
          voiceUrl: tts.voiceUrl,
          voiceModel: galleryVoiceModelForInput(input, user, provider),
          audioDurationMs: durMs,
          speechCoverage: subtitleSpeechCoverage,
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

    const billingReceipt = process.env.RENDER_VIA_QUEUE === "1"
      ? await getVideoJobBillingReceipt({ videoJobId: jobId, userId })
      : null;
    if (billingReceipt && billingReceipt.status !== "settled") {
      throw new Error(`ตรวจสอบการคิดนาที/เครดิตไม่ผ่าน (${billingReceipt.code}) — ระบบหยุดก่อนส่งมอบงาน`);
    }

    // 9. Update Video row → COMPLETED (the gallery route is PATCH — see /api/videos/[id])
    await caller.patch(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

    // flush final phase + emit one-line breakdown for audits
    const finalDuration = Date.now() - phaseStartedAt;
    timings.push([phaseName, finalDuration]);
    emitStage(phaseName, "done", finalDuration); // final phase (burn) done
    const totalS = (Date.now() - jobStartedAt) / 1000;
    console.log(`[mcp-worker] job ${jobId} TIMINGS total=${totalS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);

    await finishJob(jobId, {
      videoUrl: burnedUrl,
      videoId: created.id,
      subtitleQa,
      subtitleEvidence: {
        captions,
        words: capRes.words,
        fullText: capRes.fullText,
        audioDurationMs: durMs,
        timingSource: subtitleTimingSource,
        speechCoverage: subtitleSpeechCoverage,
        verification: subtitleVerification,
      },
      ...(billingReceipt ? { billingReceipt } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    const pipelineFailure = pipelineFailureDetails(e);
    const contentPreflightFailure = contentPreflightFailureDetails(e);
    if (message === VIDEO_JOB_CANCELED_ERROR) {
      console.log(`[mcp-worker] job ${jobId} canceled by user at step=${phaseName} — stopping cleanly`);
      const reason = `video_${phaseName || "unknown"}_canceled`;
      let settlementPending = false;
      try {
        await refundSettledVideoImageBatch({ userId, videoJobId: jobId, reason });
      } catch (settlementError) {
        settlementPending = true;
        console.error(`[mcp-worker] canceled job ${jobId} failed to refund image batch`, settlementError);
      }
      try {
        const result = await refundVideoJobTerminalRenderReservations({
          videoJobId: jobId,
          userId,
          reason,
        });
        if (result.kind === "in_flight") settlementPending = true;
      } catch (settlementError) {
        settlementPending = true;
        console.error(`[mcp-worker] canceled job ${jobId} failed to refund render reservations`, settlementError);
      }
      await prisma.videoJob.updateMany({
        where: { id: jobId, userId, status: "canceled" },
        data: settlementPending
          ? {
              reservationRefundPending: true,
              reservationRefundReason: reason,
              reservationRefundAttempts: { increment: 1 },
            }
          : {
              reservationRefundPending: false,
              reservationRefundReason: null,
              reservationRefundAttempts: { increment: 1 },
            },
      });
      return; // status is already 'canceled'; don't overwrite with failed
    }
    const settlementReason = `video_${phaseName || "unknown"}_failed`;
    let financialSettlementPending = false;
    try {
      await refundSettledVideoImageBatch({
        userId,
        videoJobId: jobId,
        reason: settlementReason,
      });
    } catch (settlementError) {
      financialSettlementPending = true;
      console.error(`[mcp-worker] job ${jobId} failed to refund settled image batch`, settlementError);
    }
    if (renderReservationStages.has(phaseName)) {
      const result = await refundVideoJobTerminalRenderReservations({
        videoJobId: jobId,
        userId,
        reason: settlementReason,
      }).catch((settlementError) => {
        console.error(`[mcp-worker] job ${jobId} failed to refund render reservations`, settlementError);
        return null;
      });
      if (!result || result.kind === "in_flight") financialSettlementPending = true;
    }
    const reservationRefundReason = financialSettlementPending
      ? settlementReason
      : e instanceof AvatarProviderFailureError
        ? e.reservationRefundReason
        : undefined;
    emitStage(phaseName, "error", Date.now() - phaseStartedAt, { message });
    await failJob(jobId, e instanceof AvatarProviderFailureError
      ? {
          message: e.failure.message,
          code: e.failure.code,
          provider: e.failure.provider,
          ...(reservationRefundReason ? { reservationRefundReason } : {}),
        }
      : e instanceof HeroVoiceProviderFailureError
        ? {
            message: e.message,
            code: e.code,
            provider: "omnivoice",
            ...(financialSettlementPending ? { reservationRefundReason: settlementReason } : {}),
          }
      : e instanceof SubtitleAlignmentFailureError
        ? {
            message: e.message,
            code: `subtitle_alignment_${e.code}`,
            ...(e.provider ? { provider: e.provider } : {}),
            ...(financialSettlementPending ? { reservationRefundReason: settlementReason } : {}),
          }
      : contentPreflightFailure
        ? {
            ...contentPreflightFailure,
            ...(financialSettlementPending ? { reservationRefundReason: settlementReason } : {}),
          }
      : financialSettlementPending
        ? { message, reservationRefundReason: settlementReason }
      : pipelineFailure
        ? pipelineFailure
        : message);
  }
}

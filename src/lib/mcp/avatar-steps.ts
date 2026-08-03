import { missingKeyError, missingAvatarError } from "@/lib/mcp/onboarding";
import { PipelineHttpError, type PipelineCaller } from "@/lib/mcp/pipeline-client";
import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";
import { classifyHttpStatus, isProviderErrorCode, toUserMessage, type ProviderErrorCode } from "@/lib/provider-errors";
import type {
  AvatarCompositeAttemptResult,
  AvatarCompositeFailureCode,
  AvatarProviderGenerateResult,
} from "@/lib/mcp/avatar-provider-resume";

export type AvatarMode = "none" | "full" | "bookend" | "bookend-both";
// HeyGen framing (how HeyGen frames the avatar in ITS render) — sent to generate-with-bg only.
// Single source of truth lives in avatar-gen-framing.ts — re-exported here so callers of this
// module don't need a second import.
export const HEYGEN_FRAMING = HEYGEN_GEN_FRAMING;
// Composite layer default (how the avatar overlays the bg frame). scale 1 = fill frame.
export const DEFAULT_AVATAR_LAYER = { scale: 1, offsetX: 0, offsetY: 0 } as const;

function clampLayer(scale: unknown, ox: unknown, oy: unknown) {
  const s = Number(scale), x = Number(ox), y = Number(oy);
  return {
    scale: Number.isFinite(s) ? Math.min(2.5, Math.max(0.1, s)) : 1,
    offsetX: Number.isFinite(x) ? Math.min(2, Math.max(-2, x)) : 0,
    offsetY: Number.isFinite(y) ? Math.min(2, Math.max(-2, y)) : 0,
  };
}

export function clampSecs(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

type AvatarArgs = { avatarMode?: string; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number; avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number };
type AvatarUser = { heygenKey: string | null; heygenAvatarId: string | null };
type ErrPayload = { error: string; message: string };

export type AvatarResolution =
  | { kind: "none" }
  | { kind: "error"; payload: ErrPayload }
  | { kind: "ok"; avatarMode: "full" | "bookend" | "bookend-both"; avatarId: string; introSecs: number; tailSecs: number; scale: number; offsetX: number; offsetY: number };

export function resolveAvatarRequest(args: AvatarArgs, user: AvatarUser): AvatarResolution {
  const mode = args.avatarMode ?? "none";
  if (mode === "none") return { kind: "none" };
  if (mode !== "full" && mode !== "bookend" && mode !== "bookend-both")
    return { kind: "error", payload: { error: "bad_request", message: `avatarMode ไม่ถูกต้อง: ${mode}` } };
  if (!user.heygenKey) return { kind: "error", payload: missingKeyError("heygen") };
  const avatarId = args.avatarId ?? user.heygenAvatarId ?? "";
  if (!avatarId) return { kind: "error", payload: missingAvatarError() };
  const { scale, offsetX, offsetY } = clampLayer(args.avatarScale ?? 1, args.avatarOffsetX ?? 0, args.avatarOffsetY ?? 0);
  return { kind: "ok", avatarMode: mode, avatarId, introSecs: clampSecs(args.avatarIntroSecs, 5), tailSecs: clampSecs(args.avatarTailSecs, 5), scale, offsetX, offsetY };
}

// ---------------------------------------------------------------------------
// I/O functions — call existing web endpoints via PipelineCaller
// ---------------------------------------------------------------------------

export type AvatarPollOnce = {
  status: string;
  videoUrl: string | null;
  errorMsg: string | null;
  errorCode?: ProviderErrorCode;
  retryAfterSec?: number;
};

type AvatarPollEndpointPayload = AvatarPollOnce & {
  error?: { code?: string };
};

function normalizePollErrorCode(code: string | undefined): ProviderErrorCode | undefined {
  if (code === "insufficient_credit") return "quota";
  if (code === "invalid_key") return "invalid_key";
  if (code === "not_found" || code === "provider_failed") return "fatal";
  return isProviderErrorCode(code) ? code : undefined;
}

export async function pollAvatarOnce(
  caller: PipelineCaller,
  heygenVideoId: string,
): Promise<AvatarPollOnce> {
  const result = await caller.post<AvatarPollEndpointPayload>("/api/videos/poll-avatar", { videoId: heygenVideoId });
  const errorCode = normalizePollErrorCode(result.error?.code ?? result.errorCode);
  return {
    status: result.status,
    videoUrl: result.videoUrl,
    errorMsg: result.errorMsg,
    ...(errorCode ? { errorCode } : {}),
    ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
  };
}

export async function pollAvatar(
  caller: PipelineCaller,
  heygenVideoId: string,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const interval = opts.intervalMs ?? 5000;
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await pollAvatarOnce(caller, heygenVideoId);
    if (p.status === "completed" && p.videoUrl) return p.videoUrl;
    if (p.status === "failed") throw new Error(`avatar generation failed: ${p.errorMsg ?? "unknown"}`);
    await sleep(interval);
  }
  throw new Error("avatar generation timed out");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function generateAvatarVideo(caller: PipelineCaller, avatarId: string, audioUrl: string): Promise<AvatarProviderGenerateResult> {
  try {
    const g = await caller.post<{ videoId: string }>("/api/heygen/generate-with-bg", {
      audioUrl, avatarId, greenScreen: true,
      scale: HEYGEN_FRAMING.scale, offsetX: HEYGEN_FRAMING.offsetX, offsetY: HEYGEN_FRAMING.offsetY,
    }, { retries: 0 });
    return g.videoId
      ? { kind: "accepted", providerVideoId: g.videoId }
      : { kind: "unknown", message: "HeyGen generate returned no video ID" };
  } catch (error) {
    if (!(error instanceof PipelineHttpError)) return { kind: "unknown" };
    const body = record(error.body);
    const rawCode = body?.code;
    const code = isProviderErrorCode(rawCode)
      ? rawCode
      : classifyHttpStatus(error.status);
    // A transport/5xx response cannot prove whether the paid generate was accepted.
    if (code === "transient" || error.status >= 500) return { kind: "unknown" };
    const message = typeof body?.userAction === "string"
      ? body.userAction
      : typeof body?.error === "string"
        ? body.error
        : toUserMessage(code);
    return { kind: "rejected", code, message };
  }
}

function acceptedVideoId(result: AvatarProviderGenerateResult): string {
  if (result.kind === "accepted") return result.providerVideoId;
  if (result.kind === "rejected") throw new Error(result.message);
  throw new Error("avatar generate has unknown provider outcome - manual recovery required");
}

export interface AvatarComposeOpts {
  baseUrl: string;       // base render (has full TTS audio) = composite bg
  ttsAudioUrl: string;   // full TTS audio (source for trimming / full mode)
  avatarMode: "full" | "bookend" | "bookend-both";
  avatarId: string;
  introSecs: number;
  tailSecs: number;
  layout?: { scale: number; offsetX: number; offsetY: number };
  sleep?: (ms: number) => Promise<void>;
  onStep?: (label: string) => void;
}

export async function prepareAvatarAudio(
  caller: PipelineCaller,
  opts: Pick<AvatarComposeOpts, "ttsAudioUrl" | "avatarMode" | "introSecs" | "tailSecs">,
): Promise<{ introAudioUrl: string; tailAudioUrl?: string }> {
  let introAudioUrl = opts.ttsAudioUrl;
  let tailAudioUrl: string | undefined;
  if (opts.avatarMode === "bookend" || opts.avatarMode === "bookend-both") {
    introAudioUrl = (await caller.post<{ audioUrl: string }>("/api/videos/trim-audio", {
      audioUrl: opts.ttsAudioUrl,
      durationSecs: opts.introSecs,
    })).audioUrl;
  }
  if (opts.avatarMode === "bookend-both") {
    tailAudioUrl = (await caller.post<{ audioUrl: string }>("/api/videos/trim-audio", {
      audioUrl: opts.ttsAudioUrl,
      tailSecs: opts.tailSecs,
    })).audioUrl;
  }
  return { introAudioUrl, tailAudioUrl };
}

export interface AvatarCompositeInput {
  videoJobId?: string;
  baseUrl: string;
  avatarMode: "full" | "bookend" | "bookend-both";
  introSecs: number;
  tailSecs: number;
  introVideoUrl: string;
  tailVideoUrl?: string;
  layout?: { scale: number; offsetX: number; offsetY: number };
}

const COMPOSITE_FAILURE_CODES = new Set<AvatarCompositeFailureCode>([
  "COMPOSITE_TIMEOUT",
  "COMPOSITE_STALLED",
  "COMPOSITE_TRANSIENT",
  "COMPOSITE_FAILED",
  "COMPOSITE_RETRY_EXHAUSTED",
]);

function compositeFailureCode(value: unknown): AvatarCompositeFailureCode | null {
  return typeof value === "string" && COMPOSITE_FAILURE_CODES.has(value as AvatarCompositeFailureCode)
    ? value as AvatarCompositeFailureCode
    : null;
}

export async function attemptAvatarComposite(
  caller: PipelineCaller,
  input: AvatarCompositeInput,
): Promise<AvatarCompositeAttemptResult> {
  try {
    const result = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
      videoJobId: input.videoJobId,
      avatarVideoUrl: input.introVideoUrl,
      tailAvatarVideoUrl: input.tailVideoUrl,
      bgVideoUrl: input.baseUrl,
      mode: "chromakey",
      avatarTiming: input.avatarMode,
      avatarBookendSecs: input.introSecs,
      avatarTailSecs: input.tailSecs,
      avatarLayout: input.layout ?? DEFAULT_AVATAR_LAYER,
    }, { retries: 0 });
    if (typeof result.videoUrl !== "string" || result.videoUrl.length === 0) {
      return {
        kind: "failed",
        code: "COMPOSITE_FAILED",
        message: "composite returned no video URL",
        retryable: false,
      };
    }
    return { kind: "completed", videoUrl: result.videoUrl };
  } catch (error) {
    if (!(error instanceof PipelineHttpError)) {
      return {
        kind: "failed",
        code: "COMPOSITE_TRANSIENT",
        message: error instanceof Error ? error.message : "composite transport failed",
        retryable: true,
      };
    }
    const body = record(error.body);
    const typedCode = compositeFailureCode(body?.code);
    const code = typedCode && typedCode !== "COMPOSITE_RETRY_EXHAUSTED"
      ? typedCode
      : error.status >= 500
        ? "COMPOSITE_TRANSIENT"
        : "COMPOSITE_FAILED";
    const message = typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : error.message;
    return {
      kind: "failed",
      code,
      message,
      retryable: code === "COMPOSITE_TRANSIENT" && body?.retryable !== false,
    };
  }
}

export async function compositeAvatarVideo(
  caller: PipelineCaller,
  input: AvatarCompositeInput,
): Promise<string> {
  const result = await attemptAvatarComposite(caller, input);
  if (result.kind === "failed") throw new Error(result.message);
  return result.videoUrl;
}

export async function runAvatarComposite(
  caller: PipelineCaller,
  o: AvatarComposeOpts,
): Promise<{ compositeUrl: string; avatarUrl: string; tailAvatarUrl?: string }> {
  // 1. prepare audio for the avatar segment(s)
  const prepared = await prepareAvatarAudio(caller, o);

  // 2+3. generate + poll (intro, then tail for bookend-both)
  o.onStep?.("avatar");
  const introUrl = await pollAvatar(caller, acceptedVideoId(await generateAvatarVideo(caller, o.avatarId, prepared.introAudioUrl)), { sleep: o.sleep });
  let tailAvatarUrl: string | undefined;
  if (o.avatarMode === "bookend-both" && prepared.tailAudioUrl) {
    tailAvatarUrl = await pollAvatar(caller, acceptedVideoId(await generateAvatarVideo(caller, o.avatarId, prepared.tailAudioUrl)), { sleep: o.sleep });
  }

  // 4. composite onto the base render (bg carries the full TTS audio)
  o.onStep?.("composite");
  const compositeUrl = await compositeAvatarVideo(caller, {
    baseUrl: o.baseUrl,
    avatarMode: o.avatarMode,
    introSecs: o.introSecs,
    tailSecs: o.tailSecs,
    introVideoUrl: introUrl,
    tailVideoUrl: tailAvatarUrl,
    layout: o.layout,
  });
  return { compositeUrl, avatarUrl: introUrl, tailAvatarUrl };
}

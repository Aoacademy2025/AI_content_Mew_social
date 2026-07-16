import { missingKeyError, missingAvatarError } from "@/lib/mcp/onboarding";
import type { PipelineCaller } from "@/lib/mcp/pipeline-client";
import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";

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
  retryAfterSec?: number;
};

export async function pollAvatarOnce(
  caller: PipelineCaller,
  heygenVideoId: string,
): Promise<AvatarPollOnce> {
  return caller.post<AvatarPollOnce>("/api/videos/poll-avatar", { videoId: heygenVideoId });
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

export async function generateAvatarVideo(caller: PipelineCaller, avatarId: string, audioUrl: string): Promise<string> {
  const g = await caller.post<{ videoId: string }>("/api/heygen/generate-with-bg", {
    audioUrl, avatarId, greenScreen: true,
    scale: HEYGEN_FRAMING.scale, offsetX: HEYGEN_FRAMING.offsetX, offsetY: HEYGEN_FRAMING.offsetY,
  });
  return g.videoId;
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
  baseUrl: string;
  avatarMode: "full" | "bookend" | "bookend-both";
  introSecs: number;
  tailSecs: number;
  introVideoUrl: string;
  tailVideoUrl?: string;
  layout?: { scale: number; offsetX: number; offsetY: number };
}

export async function compositeAvatarVideo(
  caller: PipelineCaller,
  input: AvatarCompositeInput,
): Promise<string> {
  const result = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
    avatarVideoUrl: input.introVideoUrl,
    tailAvatarVideoUrl: input.tailVideoUrl,
    bgVideoUrl: input.baseUrl,
    mode: "chromakey",
    avatarTiming: input.avatarMode,
    avatarBookendSecs: input.introSecs,
    avatarTailSecs: input.tailSecs,
    avatarLayout: input.layout ?? DEFAULT_AVATAR_LAYER,
  });
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
  const introUrl = await pollAvatar(caller, await generateAvatarVideo(caller, o.avatarId, prepared.introAudioUrl), { sleep: o.sleep });
  let tailAvatarUrl: string | undefined;
  if (o.avatarMode === "bookend-both" && prepared.tailAudioUrl) {
    tailAvatarUrl = await pollAvatar(caller, await generateAvatarVideo(caller, o.avatarId, prepared.tailAudioUrl), { sleep: o.sleep });
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

import { missingKeyError, missingAvatarError } from "@/lib/mcp/onboarding";
import type { PipelineCaller } from "@/lib/mcp/pipeline-client";

export type AvatarMode = "none" | "full" | "bookend" | "bookend-both";
export const AVATAR_LAYOUT = { scale: 2.02, offsetX: 0, offsetY: 0.13 } as const;

export function clampSecs(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

type AvatarArgs = { avatarMode?: string; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number };
type AvatarUser = { heygenKey: string | null; heygenAvatarId: string | null };
type ErrPayload = { error: string; message: string };

export type AvatarResolution =
  | { kind: "none" }
  | { kind: "error"; payload: ErrPayload }
  | { kind: "ok"; avatarMode: "full" | "bookend" | "bookend-both"; avatarId: string; introSecs: number; tailSecs: number };

export function resolveAvatarRequest(args: AvatarArgs, user: AvatarUser): AvatarResolution {
  const mode = args.avatarMode ?? "none";
  if (mode === "none") return { kind: "none" };
  if (mode !== "full" && mode !== "bookend" && mode !== "bookend-both")
    return { kind: "error", payload: { error: "bad_request", message: `avatarMode ไม่ถูกต้อง: ${mode}` } };
  if (!user.heygenKey) return { kind: "error", payload: missingKeyError("heygen") };
  const avatarId = args.avatarId ?? user.heygenAvatarId ?? "";
  if (!avatarId) return { kind: "error", payload: missingAvatarError() };
  return { kind: "ok", avatarMode: mode, avatarId, introSecs: clampSecs(args.avatarIntroSecs, 5), tailSecs: clampSecs(args.avatarTailSecs, 5) };
}

// ---------------------------------------------------------------------------
// I/O functions — call existing web endpoints via PipelineCaller
// ---------------------------------------------------------------------------

type PollAvatarResp = { status: string; videoUrl: string | null; errorMsg: string | null };

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
    const p = await caller.post<PollAvatarResp>("/api/videos/poll-avatar", { videoId: heygenVideoId });
    if (p.status === "completed" && p.videoUrl) return p.videoUrl;
    if (p.status === "failed") throw new Error(`avatar generation failed: ${p.errorMsg ?? "unknown"}`);
    await sleep(interval);
  }
  throw new Error("avatar generation timed out");
}

async function generateAvatar(caller: PipelineCaller, avatarId: string, audioUrl: string): Promise<string> {
  const g = await caller.post<{ videoId: string }>("/api/heygen/generate-with-bg", {
    audioUrl, avatarId, greenScreen: true,
    scale: AVATAR_LAYOUT.scale, offsetX: AVATAR_LAYOUT.offsetX, offsetY: AVATAR_LAYOUT.offsetY,
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
  sleep?: (ms: number) => Promise<void>;
  onStep?: (label: string) => void;
}

export async function runAvatarComposite(
  caller: PipelineCaller,
  o: AvatarComposeOpts,
): Promise<{ compositeUrl: string; avatarUrl: string; tailAvatarUrl?: string }> {
  // 1. prepare audio for the avatar segment(s)
  let introAudio = o.ttsAudioUrl;
  let tailAudio: string | undefined;
  if (o.avatarMode === "bookend" || o.avatarMode === "bookend-both") {
    introAudio = (await caller.post<{ audioUrl: string }>("/api/videos/trim-audio", { audioUrl: o.ttsAudioUrl, durationSecs: o.introSecs })).audioUrl;
  }
  if (o.avatarMode === "bookend-both") {
    tailAudio = (await caller.post<{ audioUrl: string }>("/api/videos/trim-audio", { audioUrl: o.ttsAudioUrl, tailSecs: o.tailSecs })).audioUrl;
  }

  // 2+3. generate + poll (intro, then tail for bookend-both)
  o.onStep?.("avatar");
  const introUrl = await pollAvatar(caller, await generateAvatar(caller, o.avatarId, introAudio), { sleep: o.sleep });
  let tailAvatarUrl: string | undefined;
  if (o.avatarMode === "bookend-both" && tailAudio) {
    tailAvatarUrl = await pollAvatar(caller, await generateAvatar(caller, o.avatarId, tailAudio), { sleep: o.sleep });
  }

  // 4. composite onto the base render (bg carries the full TTS audio)
  o.onStep?.("composite");
  const c = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
    avatarVideoUrl: introUrl,
    tailAvatarVideoUrl: tailAvatarUrl,
    bgVideoUrl: o.baseUrl,
    mode: "chromakey",
    avatarTiming: o.avatarMode,
    avatarBookendSecs: o.introSecs,
    avatarTailSecs: o.tailSecs,
    avatarLayout: AVATAR_LAYOUT,
  });
  return { compositeUrl: c.videoUrl, avatarUrl: introUrl, tailAvatarUrl };
}

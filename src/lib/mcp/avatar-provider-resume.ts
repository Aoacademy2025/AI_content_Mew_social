import {
  avatarCheckpointRouting,
  type AvatarProviderCheckpointV1,
} from "@/lib/mcp/avatar-provider-checkpoint";
import type { HeyGenAvatarApiVersion, HeyGenAvatarEngine } from "@/lib/heygen-avatar-engine";
import type { ProviderErrorCode } from "@/lib/provider-errors";

export interface AvatarProviderPollResult {
  status: string;
  videoUrl: string | null;
  errorMsg: string | null;
  errorCode?: ProviderErrorCode;
  retryAfterSec?: number;
}

export type AvatarProviderGenerateResult =
  | { kind: "accepted"; providerVideoId: string }
  | { kind: "rejected"; code: ProviderErrorCode; message: string; reason?: string }
  | { kind: "unknown"; message?: string };

export type AvatarProviderUploadResult =
  | { kind: "accepted"; audioAssetId: string }
  | { kind: "rejected"; code: ProviderErrorCode; message: string; reason?: string };

export type AvatarCompositeFailureCode =
  | "COMPOSITE_TIMEOUT"
  | "COMPOSITE_STALLED"
  | "COMPOSITE_TRANSIENT"
  | "COMPOSITE_FAILED"
  | "COMPOSITE_RETRY_EXHAUSTED";

export type AvatarCompositeAttemptResult =
  | { kind: "completed"; videoUrl: string }
  | {
      kind: "failed";
      code: Exclude<AvatarCompositeFailureCode, "COMPOSITE_RETRY_EXHAUSTED">;
      message: string;
      retryable: boolean;
    };

export interface AvatarProviderAdvanceDeps {
  now: () => Date;
  upload?: (
    avatarId: string,
    audioUrl: string,
    routing: { engine: HeyGenAvatarEngine; apiVersion: HeyGenAvatarApiVersion },
  ) => Promise<AvatarProviderUploadResult>;
  generate: (
    avatarId: string,
    audioUrl: string,
    routing: { engine: HeyGenAvatarEngine; apiVersion: HeyGenAvatarApiVersion; idempotencyKey?: string },
  ) => Promise<AvatarProviderGenerateResult>;
  poll: (providerVideoId: string, apiVersion: HeyGenAvatarApiVersion) => Promise<AvatarProviderPollResult>;
  composite: (checkpoint: AvatarProviderCheckpointV1) => Promise<AvatarCompositeAttemptResult>;
  /** Guarded persistence: false means cancellation/another terminal transition won. */
  persist?: (checkpoint: AvatarProviderCheckpointV1) => Promise<boolean>;
  /** Only the fresh orchestrator call that already persisted generate intent may set this. */
  allowGenerate?: boolean;
}

export type AvatarProviderAdvanceResult =
  | { kind: "waiting"; checkpoint: AvatarProviderCheckpointV1; retryAfterSec?: number }
  | { kind: "ready"; checkpoint: AvatarProviderCheckpointV1; compositeUrl: string }
  | {
      kind: "failed";
      message: string;
      code?: ProviderErrorCode | AvatarCompositeFailureCode;
      reason?: string;
      provider?: "heygen" | "composite";
      outcome?: "definitive" | "unknown";
    };

const GUARD_REJECTED = "provider checkpoint guard rejected";
const UNKNOWN_GENERATE_OUTCOME = "avatar generate has unknown provider outcome - manual recovery required";
const MAX_COMPOSITE_ATTEMPTS = 2;

function withAvatar(
  checkpoint: AvatarProviderCheckpointV1,
  avatar: Partial<AvatarProviderCheckpointV1["avatar"]>,
  phase: AvatarProviderCheckpointV1["phase"],
): AvatarProviderCheckpointV1 {
  return { ...checkpoint, phase, avatar: { ...checkpoint.avatar, ...avatar } };
}

async function persist(
  checkpoint: AvatarProviderCheckpointV1,
  deps: AvatarProviderAdvanceDeps,
): Promise<boolean> {
  return deps.persist ? deps.persist(checkpoint) : true;
}

async function generatePhase(
  checkpoint: AvatarProviderCheckpointV1,
  which: "intro" | "tail",
  deps: AvatarProviderAdvanceDeps,
): Promise<AvatarProviderAdvanceResult> {
  const audioUrl = which === "intro" ? checkpoint.avatar.introAudioUrl : checkpoint.avatar.tailAudioUrl;
  if (!audioUrl) return { kind: "failed", message: `avatar checkpoint missing ${which} audio` };

  const routing = avatarCheckpointRouting(checkpoint);
  let createInput = audioUrl;
  if (routing.apiVersion === "v3") {
    try {
      const storedAssetId = which === "intro"
        ? checkpoint.avatar.introAudioAssetId
        : checkpoint.avatar.tailAudioAssetId;
      if (storedAssetId) {
        createInput = storedAssetId;
      } else {
        if (!deps.upload) {
          return {
            kind: "failed",
            message: "avatar audio upload is unavailable",
            code: "fatal",
            provider: "heygen",
            outcome: "definitive",
          };
        }
        let uploaded: AvatarProviderUploadResult;
        try {
          uploaded = await deps.upload(checkpoint.avatar.id, audioUrl, routing);
        } catch {
          return {
            kind: "failed",
            message: "เตรียมเสียงสำหรับ Avatar ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
            code: "transient",
            provider: "heygen",
            outcome: "definitive",
          };
        }
        if (uploaded.kind === "rejected") {
          return {
            kind: "failed",
            message: uploaded.message,
            code: uploaded.code,
            ...(uploaded.reason ? { reason: uploaded.reason } : {}),
            provider: "heygen",
            outcome: "definitive",
          };
        }
        const assetCheckpoint = withAvatar(
          checkpoint,
          which === "intro"
            ? { introAudioAssetId: uploaded.audioAssetId }
            : { tailAudioAssetId: uploaded.audioAssetId },
          checkpoint.phase,
        );
        if (!await persist(assetCheckpoint, deps)) return { kind: "failed", message: GUARD_REJECTED };
        checkpoint = assetCheckpoint;
        createInput = uploaded.audioAssetId;
      }
    } catch {
      return {
        kind: "failed",
        message: "เตรียมเสียงสำหรับ Avatar ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
        code: "transient",
        provider: "heygen",
        outcome: "definitive",
      };
    }
  }
  const idempotencyKey = which === "intro"
    ? checkpoint.avatar.introIdempotencyKey
    : checkpoint.avatar.tailIdempotencyKey;
  let generated: AvatarProviderGenerateResult;
  try {
    generated = await deps.generate(checkpoint.avatar.id, createInput, { ...routing, idempotencyKey });
  } catch {
    // The external request may have spent credits even when its response was lost. Never retry.
    return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME, provider: "heygen", outcome: "unknown" };
  }
  if (generated.kind === "rejected") {
    return {
      kind: "failed",
      message: generated.message,
      code: generated.code,
      ...(generated.reason ? { reason: generated.reason } : {}),
      provider: "heygen",
      outcome: "definitive",
    };
  }
  if (generated.kind === "unknown") {
    return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME, provider: "heygen", outcome: "unknown" };
  }
  const providerVideoId = generated.providerVideoId;
  if (!providerVideoId) {
    return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME, provider: "heygen", outcome: "unknown" };
  }

  const waiting = which === "intro"
    ? withAvatar(checkpoint, { introVideoId: providerVideoId }, "intro_wait")
    : withAvatar(checkpoint, { tailVideoId: providerVideoId }, "tail_wait");
  if (!await persist(waiting, deps)) return { kind: "failed", message: GUARD_REJECTED };
  return { kind: "waiting", checkpoint: waiting };
}

async function composite(
  checkpoint: AvatarProviderCheckpointV1,
  deps: AvatarProviderAdvanceDeps,
): Promise<AvatarProviderAdvanceResult> {
  const attempt = (checkpoint.compositeAttempts ?? 0) + 1;
  const readyToComposite = {
    ...checkpoint,
    phase: "composite" as const,
    compositeAttempts: attempt,
  };
  if (!await persist(readyToComposite, deps)) return { kind: "failed", message: GUARD_REJECTED };
  let result: AvatarCompositeAttemptResult;
  try {
    result = await deps.composite(readyToComposite);
  } catch {
    result = {
      kind: "failed",
      code: "COMPOSITE_TRANSIENT",
      message: "composite worker temporarily unavailable",
      retryable: true,
    };
  }
  if (result.kind === "completed") {
    return { kind: "ready", checkpoint: readyToComposite, compositeUrl: result.videoUrl };
  }
  if (result.retryable && attempt < MAX_COMPOSITE_ATTEMPTS) {
    return { kind: "waiting", checkpoint: readyToComposite, retryAfterSec: 60 };
  }
  return {
    kind: "failed",
    message: result.retryable
      ? `ประกอบวิดีโอไม่สำเร็จหลังลอง ${attempt} ครั้ง: ${result.message}`
      : result.message,
    code: result.retryable ? "COMPOSITE_RETRY_EXHAUSTED" : result.code,
    provider: "composite",
    outcome: "definitive",
  };
}

async function pollPhase(
  checkpoint: AvatarProviderCheckpointV1,
  which: "intro" | "tail",
  deps: AvatarProviderAdvanceDeps,
): Promise<AvatarProviderAdvanceResult> {
  const providerVideoId = which === "intro" ? checkpoint.avatar.introVideoId : checkpoint.avatar.tailVideoId;
  if (!providerVideoId) return { kind: "failed", message: `avatar checkpoint missing ${which} provider ID` };

  let polled: AvatarProviderPollResult;
  try {
    polled = await deps.poll(providerVideoId, avatarCheckpointRouting(checkpoint).apiVersion);
  } catch {
    return { kind: "waiting", checkpoint };
  }
  if (polled.status === "failed") {
    return {
      kind: "failed",
      message: `avatar generation failed: ${polled.errorMsg ?? "unknown"}`,
      code: polled.errorCode ?? "fatal",
      provider: "heygen",
      outcome: "definitive",
    };
  }
  if (polled.status !== "completed" || !polled.videoUrl) {
    return {
      kind: "waiting",
      checkpoint,
      ...(polled.retryAfterSec ? { retryAfterSec: polled.retryAfterSec } : {}),
    };
  }

  if (which === "intro") {
    const introReady = withAvatar(checkpoint, { introVideoUrl: polled.videoUrl }, checkpoint.phase);
    if (checkpoint.avatar.mode === "bookend-both") {
      if (introReady.avatar.tailVideoUrl) return composite(introReady, deps);
      if (introReady.avatar.tailVideoId) {
        return pollPhase({ ...introReady, phase: "tail_wait" }, "tail", deps);
      }

      const tailGenerate = { ...introReady, phase: "tail_generate" as const };
      if (!await persist(tailGenerate, deps)) return { kind: "failed", message: GUARD_REJECTED };
      return generatePhase(tailGenerate, "tail", deps);
    }
    return composite(introReady, deps);
  }

  const tailReady = withAvatar(checkpoint, { tailVideoUrl: polled.videoUrl }, checkpoint.phase);
  return composite(tailReady, deps);
}

export async function advanceAvatarProvider(
  checkpoint: AvatarProviderCheckpointV1,
  deps: AvatarProviderAdvanceDeps,
): Promise<AvatarProviderAdvanceResult> {
  // The provider deadline bounds HeyGen generation/polling only. Once provider media is
  // persisted, composite is local work with its own executor timeout/retry policy.
  if (checkpoint.phase !== "composite"
    && deps.now().getTime() > Date.parse(checkpoint.providerDeadlineAt)) {
    return {
      kind: "failed",
      message: "avatar provider deadline exceeded",
      code: "transient",
      provider: "heygen",
      outcome: "definitive",
    };
  }

  switch (checkpoint.phase) {
    case "intro_generate":
      if (checkpoint.avatar.introVideoId) {
        return pollPhase({ ...checkpoint, phase: "intro_wait" }, "intro", deps);
      }
      if (!deps.allowGenerate) return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME, provider: "heygen", outcome: "unknown" };
      return generatePhase(checkpoint, "intro", deps);
    case "intro_wait":
      return pollPhase(checkpoint, "intro", deps);
    case "tail_generate":
      if (checkpoint.avatar.tailVideoId) {
        return pollPhase({ ...checkpoint, phase: "tail_wait" }, "tail", deps);
      }
      if (!deps.allowGenerate) return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME, provider: "heygen", outcome: "unknown" };
      return generatePhase(checkpoint, "tail", deps);
    case "tail_wait":
      return pollPhase(checkpoint, "tail", deps);
    case "composite":
      return composite(checkpoint, deps);
  }
}

import type { AvatarProviderCheckpointV1 } from "@/lib/mcp/avatar-provider-checkpoint";

export interface AvatarProviderPollResult {
  status: string;
  videoUrl: string | null;
  errorMsg: string | null;
  retryAfterSec?: number;
}

export interface AvatarProviderAdvanceDeps {
  now: () => Date;
  generate: (avatarId: string, audioUrl: string) => Promise<string>;
  poll: (providerVideoId: string) => Promise<AvatarProviderPollResult>;
  composite: (checkpoint: AvatarProviderCheckpointV1) => Promise<string>;
  /** Guarded persistence: false means cancellation/another terminal transition won. */
  persist?: (checkpoint: AvatarProviderCheckpointV1) => Promise<boolean>;
  /** Only the fresh orchestrator call that already persisted generate intent may set this. */
  allowGenerate?: boolean;
}

export type AvatarProviderAdvanceResult =
  | { kind: "waiting"; checkpoint: AvatarProviderCheckpointV1; retryAfterSec?: number }
  | { kind: "ready"; checkpoint: AvatarProviderCheckpointV1; compositeUrl: string }
  | { kind: "failed"; message: string };

const GUARD_REJECTED = "provider checkpoint guard rejected";
const UNKNOWN_GENERATE_OUTCOME = "avatar generate has unknown provider outcome - manual recovery required";

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

  let providerVideoId: string;
  try {
    providerVideoId = await deps.generate(checkpoint.avatar.id, audioUrl);
  } catch {
    // The external request may have spent credits even when its response was lost. Never retry.
    return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME };
  }
  if (!providerVideoId) return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME };

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
  const readyToComposite = { ...checkpoint, phase: "composite" as const };
  if (!await persist(readyToComposite, deps)) return { kind: "failed", message: GUARD_REJECTED };
  try {
    const compositeUrl = await deps.composite(readyToComposite);
    return { kind: "ready", checkpoint: readyToComposite, compositeUrl };
  } catch {
    // Composite is internally retryable and does not spend HeyGen generation credits.
    return { kind: "waiting", checkpoint: readyToComposite };
  }
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
    polled = await deps.poll(providerVideoId);
  } catch {
    return { kind: "waiting", checkpoint };
  }
  if (polled.status === "failed") {
    return { kind: "failed", message: `avatar generation failed: ${polled.errorMsg ?? "unknown"}` };
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
  if (deps.now().getTime() > Date.parse(checkpoint.providerDeadlineAt)) {
    return { kind: "failed", message: "avatar provider deadline exceeded" };
  }

  switch (checkpoint.phase) {
    case "intro_generate":
      if (checkpoint.avatar.introVideoId) {
        return pollPhase({ ...checkpoint, phase: "intro_wait" }, "intro", deps);
      }
      if (!deps.allowGenerate) return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME };
      return generatePhase(checkpoint, "intro", deps);
    case "intro_wait":
      return pollPhase(checkpoint, "intro", deps);
    case "tail_generate":
      if (checkpoint.avatar.tailVideoId) {
        return pollPhase({ ...checkpoint, phase: "tail_wait" }, "tail", deps);
      }
      if (!deps.allowGenerate) return { kind: "failed", message: UNKNOWN_GENERATE_OUTCOME };
      return generatePhase(checkpoint, "tail", deps);
    case "tail_wait":
      return pollPhase(checkpoint, "tail", deps);
    case "composite":
      return composite(checkpoint, deps);
  }
}

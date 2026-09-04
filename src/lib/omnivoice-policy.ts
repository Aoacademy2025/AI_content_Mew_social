import { userInOmniVoiceAllowlist } from "@/lib/omnivoice-core";
import { isHeroAiBetaUser, isInternalAiTester } from "@/lib/internal-ai-access";

export type HeroVoiceCloneCanaryActor = {
  id: string;
  email?: string | null;
  role?: string | null;
  suspended?: boolean | null;
};

/**
 * Clone-capable HTTP surfaces and durable Hero Voice callers. Mixed routes must
 * apply the canary policy before touching a clone job while preserving their
 * existing image/stock behavior. A stock-only durable caller is inventoried as
 * such because the durable boundary itself rejects clone opt-in. The focused
 * verifier compares this list with the route tree so a new sink cannot silently
 * bypass classification.
 */
export const HERO_VOICE_CLONE_CANARY_ROUTE_INVENTORY = [
  { method: "GET", route: "/api/ai-studio/catalog", scope: "whole-route" },
  { method: "POST", route: "/api/ai-studio/voices", scope: "whole-route" },
  { method: "POST", route: "/api/ai-studio/voice-clone-canary/runs/[runId]/slots/[slotId]/submit", scope: "whole-route" },
  { method: "GET", route: "/api/ai-studio/voice-clone-canary/runs/[runId]", scope: "whole-route" },
  { method: "GET", route: "/api/ai-studio/voice-clone-canary/runs/[runId]/audio/[token]", scope: "whole-route" },
  { method: "PUT", route: "/api/ai-studio/voice-clone-canary/runs/[runId]/scores/[pairId]", scope: "whole-route" },
  { method: "POST", route: "/api/ai-studio/voice-clone-canary/runs/[runId]/lock", scope: "whole-route" },
  { method: "POST", route: "/api/ai-studio/voice-clone-canary/runs/[runId]/reveal", scope: "whole-route" },
  { method: "POST", route: "/api/ai-studio/voice-clone-canary/runs/[runId]/close", scope: "whole-route" },
  { method: "GET", route: "/api/ai-studio/jobs", scope: "whole-route" },
  { method: "GET", route: "/api/ai-studio/jobs/[id]", scope: "clone-job-only" },
  { method: "GET", route: "/api/ai-studio/voice-audio/[jobId]", scope: "whole-route" },
  { method: "GET", route: "/api/omnivoice/user-voices", scope: "whole-route" },
  { method: "POST", route: "/api/omnivoice/user-voices", scope: "whole-route" },
  { method: "GET", route: "/api/omnivoice/user-voices/[id]", scope: "whole-route" },
  { method: "DELETE", route: "/api/omnivoice/user-voices/[id]", scope: "whole-route" },
  { method: "DELETE", route: "/api/videos/jobs/[id]", scope: "durable-stock-caller" },
] as const;

/**
 * Access policy shared by Next.js routes and standalone background workers.
 * This module intentionally contains no worker credential or network client.
 */
export function isOmniVoiceServerEnabled(): boolean {
  return process.env.OMNIVOICE_ENABLED === "1";
}

/** Separate, fail-closed rollout switch for biometric-ish clone references. */
export function isHeroVoiceCloningEnabled(): boolean {
  return process.env.HERO_VOICE_CLONING_ENABLED === "1";
}

export function isOmniVoiceUserAllowed(user: { id: string; email?: string | null; role?: string | null }): boolean {
  if (!isOmniVoiceServerEnabled()) return false;
  if (!isHeroAiBetaUser(user)) return false;
  return userInOmniVoiceAllowlist(user.id, process.env.OMNIVOICE_ALLOWED_USER_IDS);
}

/**
 * The sole Hero Voice Clone canary authorization policy.
 *
 * The clone switch, internal-AI cohort, and existing OmniVoice user-ID
 * allowlist are independent requirements. ADMIN by itself is deliberately not
 * sufficient. Missing/deleted actors and suspended rows fail closed.
 */
export function isHeroVoiceCloneCanaryUser(
  actor: HeroVoiceCloneCanaryActor | null | undefined,
): boolean {
  if (!actor?.id || actor.suspended) return false;
  return isHeroVoiceCloningEnabled()
    && isInternalAiTester(actor)
    && isOmniVoiceUserAllowed(actor);
}

export type HeroVoiceCloneCanaryAccessDecision =
  | { allowed: true; status: 200 }
  | { allowed: false; status: 401 | 404 };

/** Exact unauthenticated/denied/allowed response matrix for HTTP surfaces. */
export function heroVoiceCloneCanaryAccessDecision(
  actor: HeroVoiceCloneCanaryActor | null | undefined,
): HeroVoiceCloneCanaryAccessDecision {
  if (!actor) return { allowed: false, status: 401 };
  if (!isHeroVoiceCloneCanaryUser(actor)) return { allowed: false, status: 404 };
  return { allowed: true, status: 200 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAiStudioCloneState(inputJson: string | null | undefined, voiceId: string): boolean {
  if (!inputJson) return false;
  try {
    const state: unknown = JSON.parse(inputJson);
    return isRecord(state)
      && state.version === 1
      && state.mode === "clone"
      && state.cloneCanarySurface === "ai-studio"
      && state.voiceId === voiceId;
  } catch {
    return false;
  }
}

/** True only for a fully consistent durable AI Studio clone job. */
export function isHeroVoiceCloneGenerationJob(job: {
  kind?: string | null;
  model?: string | null;
  providerModel?: string | null;
  productSurface?: string | null;
  inputJson?: string | null;
}): boolean {
  return job.kind === "voice"
    && job.providerModel === "omnivoice-clone"
    && job.model?.startsWith("user_") === true
    && job.productSurface === "ai_studio"
    && hasAiStudioCloneState(job.inputJson, job.model);
}

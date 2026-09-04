import { auth } from "@clerk/nextjs/server";

import {
  authenticateHeroVoiceCanaryAuthState,
  HeroVoiceCanaryAuthError,
} from "@/lib/hero-voice-canary-auth.server";
import {
  DeferredGitHubCommitmentAuthority,
  GitHubGitCommitmentAuthority,
  LocalBareGitCommitmentAuthority,
  type GitCommitmentAuthority,
} from "@/lib/hero-voice-canary-review.server";

export class HeroVoiceCanaryHttpError extends Error {
  constructor(readonly status: 401 | 404) {
    super(status === 401 ? "Unauthorized" : "Not found");
    this.name = "HeroVoiceCanaryHttpError";
  }
}

export async function authenticateHeroVoiceCanaryHttpRequest() {
  const authState = await auth();
  try { return await authenticateHeroVoiceCanaryAuthState(authState); }
  catch (error) {
    if (error instanceof HeroVoiceCanaryAuthError && error.status === 401) throw new HeroVoiceCanaryHttpError(401);
    throw new HeroVoiceCanaryHttpError(404);
  }
}

export function parseHeroVoiceCanaryIfMatch(request: Request): number {
  const value = request.headers.get("if-match") ?? "";
  const match = /^"([1-9][0-9]*)"$/u.exec(value);
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision)) throw new Error("canary_revision_required");
  return revision;
}

export function heroVoiceCanaryGitAuthority(): GitCommitmentAuthority {
  const localBareRepository = process.env.HERO_VOICE_CANARY_LOCAL_BARE_GIT;
  if (localBareRepository) return new LocalBareGitCommitmentAuthority(localBareRepository);
  return process.env.HERO_VOICE_CANARY_GITHUB_AUTHORITY_ENABLED === "1"
    && process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256
    ? new GitHubGitCommitmentAuthority()
    : new DeferredGitHubCommitmentAuthority();
}

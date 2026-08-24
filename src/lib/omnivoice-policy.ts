import { userInOmniVoiceAllowlist } from "@/lib/omnivoice-core";
import { isHeroAiBetaUser } from "@/lib/internal-ai-access";

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

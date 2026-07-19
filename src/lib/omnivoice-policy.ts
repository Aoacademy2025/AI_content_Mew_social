import { userInOmniVoiceAllowlist } from "@/lib/omnivoice-core";

/**
 * Access policy shared by Next.js routes and standalone background workers.
 * This module intentionally contains no worker credential or network client.
 */
export function isOmniVoiceServerEnabled(): boolean {
  return process.env.OMNIVOICE_ENABLED === "1";
}

export function isOmniVoiceUserAllowed(userId: string): boolean {
  if (!isOmniVoiceServerEnabled()) return false;
  return userInOmniVoiceAllowlist(userId, process.env.OMNIVOICE_ALLOWED_USER_IDS);
}

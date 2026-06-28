import { prisma } from "@/lib/prisma";

// Server-owned (platform) API keys for internal automation — distinct from a
// user's BYOK key on the User model. Stored in SiteConfig via the admin settings
// page (key "server_gemini_key"), with an env fallback so it also works in a
// headless cron before the DB row exists. Returns "" when unset (callers no-op).
export async function getServerGeminiKey(): Promise<string> {
  try {
    const row = await prisma.siteConfig.findUnique({ where: { key: "server_gemini_key" } });
    return (row?.value ?? process.env.LOANWORD_MINER_GEMINI_KEY ?? "").trim();
  } catch {
    return (process.env.LOANWORD_MINER_GEMINI_KEY ?? "").trim();
  }
}

/**
 * Hydrate the SiteConfig `server_gemini_key` (set via /admin) into the env vars the
 * SYNC managed resolver reads — so the platform Gemini key can be managed from the
 * admin UI (no SSH, no secret in chat) and the same key powers both the managed
 * TTS/transcribe path (`GEMINI_SERVER_KEY`) and the loanword cron
 * (`LOANWORD_MINER_GEMINI_KEY`). Call once at boot (instrumentation).
 *
 * Env WINS (parity with ensureStripeConfig): if `GEMINI_SERVER_KEY` is already set
 * in the real env, this is a no-op. Returns true iff it hydrated from DB.
 */
export async function hydrateServerGeminiKeyEnv(): Promise<boolean> {
  if (process.env.GEMINI_SERVER_KEY) return false; // explicit env override respected
  try {
    const row = await prisma.siteConfig.findUnique({ where: { key: "server_gemini_key" } });
    const val = row?.value?.trim();
    if (!val) return false;
    process.env.GEMINI_SERVER_KEY = val;
    if (!process.env.LOANWORD_MINER_GEMINI_KEY) process.env.LOANWORD_MINER_GEMINI_KEY = val;
    return true;
  } catch {
    return false;
  }
}

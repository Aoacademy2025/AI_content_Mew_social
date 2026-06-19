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

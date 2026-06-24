export class KeyRequiredError extends Error {
  constructor(public provider = "gemini") { super("KEY_REQUIRED:" + provider); }
}

export function resolveGeminiKey(user: { geminiKey: string | null; plan: string }): { key: string; mode: "managed" | "byok" } {
  if (user.geminiKey && user.geminiKey.trim()) {
    // Keys are stored base64-encoded; decode to the raw API key for callers.
    const decoded = Buffer.from(user.geminiKey.trim(), "base64").toString("utf-8");
    return { key: decoded, mode: "byok" };
  }
  const managed = process.env.MANAGED_GEMINI === "1";
  const serverKey = process.env.GEMINI_SERVER_KEY ?? "";
  if (managed && serverKey) return { key: serverKey, mode: "managed" };
  throw new KeyRequiredError("gemini");
}

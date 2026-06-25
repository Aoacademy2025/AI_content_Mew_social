export class KeyRequiredError extends Error {
  constructor(public provider = "gemini") { super("KEY_REQUIRED:" + provider); }
}

export function resolveGeminiKey(user: { geminiKey: string | null; plan: string }): { key: string; mode: "managed" | "byok" } {
  const managed = process.env.MANAGED_GEMINI === "1";
  const serverKey = process.env.GEMINI_SERVER_KEY ?? "";
  // Managed-first: when managed mode is on and a server key is configured, always
  // use it and IGNORE any stored user key (Gemini BYOK is removed in managed mode).
  if (managed && serverKey) return { key: serverKey, mode: "managed" };
  // Flag off (or managed but server key missing) → legacy BYOK, byte-identical to before.
  if (user.geminiKey && user.geminiKey.trim()) {
    const decoded = Buffer.from(user.geminiKey.trim(), "base64").toString("utf-8");
    return { key: decoded, mode: "byok" };
  }
  throw new KeyRequiredError("gemini");
}

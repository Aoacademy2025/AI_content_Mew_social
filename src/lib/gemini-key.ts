export class KeyRequiredError extends Error {
  constructor(public provider = "gemini") { super("KEY_REQUIRED:" + provider); }
}

export function resolveGeminiKey(user: { geminiKey: string | null; plan: string }): { key: string; mode: "managed" | "byok" } {
  if (user.geminiKey && user.geminiKey.trim()) return { key: user.geminiKey.trim(), mode: "byok" };
  const managed = process.env.MANAGED_GEMINI === "1";
  const serverKey = process.env.GEMINI_SERVER_KEY ?? "";
  if (managed && serverKey) return { key: serverKey, mode: "managed" };
  throw new KeyRequiredError("gemini");
}

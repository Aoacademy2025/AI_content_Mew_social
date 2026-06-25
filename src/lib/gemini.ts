import { GoogleGenAI } from "@google/genai";
import { getGeminiErrorInfo, type GeminiErrorKind } from "./gemini-errors";
import { providerError, type ProviderErrorCode } from "./provider-errors";

const GEMINI_MODEL = "gemini-2.5-flash";
// PR-5 budget: text generation must never hang a route for minutes.
const GEMINI_TEXT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3; // 1 call + 2 retries on retryable failures

function codeFromGeminiInfo(kind: GeminiErrorKind, status: number, retryable: boolean): ProviderErrorCode {
  if (kind === "invalid_key") return "invalid_key";
  // Account problems (non-retryable) BEFORE the 429 check: gemini-errors
  // reports kind "billing" with status 429 when the upstream status was 429,
  // and that must stay `quota` (retryable:false), not become `rate_limit`.
  if (kind === "billing" || kind === "permission" || kind === "api_disabled") return "quota";
  if (kind === "quota" || status === 429) return "rate_limit";
  if (status === 402 || status === 403) return "quota";
  if (retryable || status >= 500 || kind === "timeout" || kind === "high_demand") return "transient";
  return "fatal";
}

export async function geminiGenerateText(
  apiKey: string,
  prompt: string,
  maxOutputTokens = 4096,
  temperature = 0,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: GEMINI_TEXT_TIMEOUT_MS } });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          maxOutputTokens,
          temperature,
          thinkingConfig: { thinkingBudget: 0 },  // disable thinking — JSON output must not be prefixed with thought text
          abortSignal: AbortSignal.timeout(GEMINI_TEXT_TIMEOUT_MS),
        },
      });
      return response.text ?? "";
    } catch (e) {
      const info = getGeminiErrorInfo(e, { managed: process.env.MANAGED_GEMINI === "1" });
      if (info.retryable && attempt < MAX_ATTEMPTS) {
        const delayMs = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`[gemini] ${info.kind} (attempt ${attempt}/${MAX_ATTEMPTS}) — retry in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw providerError(
        codeFromGeminiInfo(info.kind, info.status, info.retryable),
        "gemini",
        info.technicalMessage || (e instanceof Error ? e.message : String(e)),
        { status: info.status, userAction: info.userMessage },
      );
    }
  }
  // Unreachable — the loop always returns or throws — TS needs a tail.
  throw providerError("transient", "gemini", "gemini retries exhausted");
}

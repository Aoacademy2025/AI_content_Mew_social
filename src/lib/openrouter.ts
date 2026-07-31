// openrouter.ts — OpenAI-compatible chat-completions client, used ONLY by the
// Hero Script LLM path (behind `HERO_SCRIPT_PROVIDER=openrouter`, resolved in
// src/lib/hero-script.server.ts). Nothing else in the app talks to OpenRouter:
// the 11 legacy Gemini call sites keep calling src/lib/gemini.ts unchanged.
//
// Discipline mirrors geminiGenerateText (src/lib/gemini.ts) on purpose — the two
// are interchangeable behind one seam, so they must fail the same way:
//   • 120s per-attempt timeout,
//   • up to 3 attempts, retrying ONLY 429 / 5xx / network+timeout, with jittered
//     exponential backoff (fetchWithBudget's policy — Retry-After honored on 429),
//   • every other 4xx is final,
//   • temperature 0 and max_tokens mapped from the caller's maxOutputTokens,
//   • returns the assistant text (never null — "" when the model said nothing,
//     which the caller's JSON validator then treats as a parse failure).
//
// Cost bearer: OpenRouter runs on the SERVER's key for every user (there is no
// OpenRouter BYOK), which is why resolveLlmTriad meters every call when this
// provider is active — see hero-script.server.ts.
//
// There is deliberately NO cross-provider fallback to Gemini (ADR 0004's
// principle: engines are separate product choices, not primary/backup). A dead
// model or an empty credit balance is reported honestly instead.

import { fetchWithBudget } from "./fetch-budget";
import { providerError, isProviderError, type ProviderError } from "./provider-errors";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Per-attempt timeout — same budget as GEMINI_TEXT_TIMEOUT_MS. */
export const OPENROUTER_TIMEOUT_MS = 120_000;
/** 1 call + 2 retries, same as gemini.ts's MAX_ATTEMPTS. */
export const OPENROUTER_MAX_ATTEMPTS = 3;
/** Total budget across attempts + backoff (3 × 120s + ~3s of backoff). */
const OPENROUTER_WALL_CLOCK_MS = 380_000;
/** Retryable statuses: the server SAID it failed and a retry can plausibly win. */
const OPENROUTER_RETRY_ON = [429, 500, 502, 503, 504];

/** Model defaults (env-overridable — see heroScriptModel in hero-script.server.ts). */
export const OPENROUTER_MODEL_FAST_DEFAULT = "openai/gpt-5.6-luna";
export const OPENROUTER_MODEL_PRO_DEFAULT = "openai/gpt-5.6-terra";

/** OpenRouter's recommended identity headers (they attribute traffic + unlock
 *  the app's listing; harmless if the dashboard entry doesn't exist yet). */
export const OPENROUTER_REFERER = "https://studio.heroaiengine.com";
export const OPENROUTER_TITLE = "HERO AI Creator Studio";

// ── Error classes ──────────────────────────────────────────────────────────
//
// OpenRouter multiplexes many upstreams, so its statuses carry more meanings
// than Gemini's. These five classes are what the Hero Script layer must be able
// to tell apart:
//
//   model_unavailable — the configured model id is gone/unroutable (404, or a
//     400 whose body says "not a valid model" / "no endpoints found"). Mapped to
//     an upstream status of 404 so hero-script.server.ts's existing
//     isModelUnavailableError() predicate — and therefore the existing
//     MODEL_UNAVAILABLE 503 path — keeps working unchanged.
//   provider_credit — the TEAM's OpenRouter balance/rate allowance is spent
//     (402 = out of credits, 429 = rate/credit throttle). User-facing message is
//     the Thai "temporarily unavailable (provider credit)" line; the user has
//     nothing to fix, so this must never look like a key problem.
//   provider_auth  — the server key is missing/invalid/forbidden (401/403). A
//     server misconfiguration: the user has no OpenRouter key of their own, so
//     they are told "temporarily unavailable", and the operator gets the log.
//   transient      — 5xx / network / timeout.
//   fatal          — any other 4xx (malformed request, etc.).
export type OpenRouterErrorClass =
  | "model_unavailable"
  | "provider_credit"
  | "provider_auth"
  | "transient"
  | "fatal";

/** Thai, user-facing: the team's OpenRouter credit/allowance is exhausted. */
export const OPENROUTER_CREDIT_MESSAGE = "ระบบ AI ไม่พร้อมใช้งานชั่วคราว (เครดิตผู้ให้บริการ)";
/** Thai, user-facing: anything else the user cannot act on. */
export const OPENROUTER_UNAVAILABLE_MESSAGE =
  "ระบบ AI ไม่พร้อมใช้งานชั่วคราว โปรดลองใหม่อีกครั้งหรือแจ้งทีมงาน";

export interface OpenRouterError extends ProviderError {
  openRouterClass: OpenRouterErrorClass;
}

/** Redact anything key-shaped before a provider message reaches a log or an
 *  admin notification (api-error.ts scrubs too, but these errors also travel
 *  through console.error paths that bypass it). */
export function scrubOpenRouterSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi, "$1<redacted>");
}

/** Which failure class is this HTTP status + response body?
 *
 *  `status` is undefined for network/timeout failures. `body` is the (already
 *  truncated) upstream response text — OpenRouter reports a bad model id as a
 *  400/404 whose MESSAGE is the only precise signal, so both are consulted. */
export function classifyOpenRouterFailure(
  status: number | undefined,
  body: string | undefined = ""
): OpenRouterErrorClass {
  const text = (body ?? "").toLowerCase();

  // The model id itself is gone/unroutable. 404 is OpenRouter's "no endpoints
  // found for <model>"; the phrase check catches the 400 variants.
  if (status === 404) return "model_unavailable";
  if (
    /no endpoints found|not a valid model|model not found|no allowed providers|unknown model|invalid model/.test(
      text
    )
  ) {
    return "model_unavailable";
  }

  // The team's balance/allowance — never the user's problem.
  if (status === 402 || status === 429) return "provider_credit";
  if (status === 401 || status === 403) return "provider_auth";

  if (status === undefined || status === 408 || status >= 500) return "transient";
  return "fatal";
}

function codeForClass(cls: OpenRouterErrorClass): ProviderError["code"] {
  switch (cls) {
    // provider_credit / provider_auth are "the service is down for you right
    // now" from the user's side → `transient` renders as a 503 through
    // toErrorResponse, and NOT as invalid_key (which would pop the
    // fix-your-own-key modal for a key the user does not own).
    case "provider_credit":
    case "provider_auth":
    case "transient":
      return "transient";
    case "model_unavailable":
    case "fatal":
      return "fatal";
  }
}

function userActionForClass(cls: OpenRouterErrorClass): string {
  return cls === "provider_credit" ? OPENROUTER_CREDIT_MESSAGE : OPENROUTER_UNAVAILABLE_MESSAGE;
}

/** Build the ProviderError for a classified OpenRouter failure.
 *
 *  model_unavailable is pinned to upstream status 404 even when OpenRouter
 *  answered 400: that status is the signal hero-script.server.ts's
 *  isModelUnavailableError() reads, and this class means exactly what a Gemini
 *  404 means — "this model id is not usable". */
export function openRouterError(
  cls: OpenRouterErrorClass,
  technicalMessage: string,
  status?: number
): OpenRouterError {
  const err = providerError(codeForClass(cls), "openrouter", scrubOpenRouterSecrets(technicalMessage), {
    status: cls === "model_unavailable" ? 404 : status,
    userAction: userActionForClass(cls),
  }) as OpenRouterError;
  err.openRouterClass = cls;
  return err;
}

export function isOpenRouterError(error: unknown): error is OpenRouterError {
  return isProviderError(error) && typeof (error as OpenRouterError).openRouterClass === "string";
}

export function isOpenRouterErrorOfClass(error: unknown, cls: OpenRouterErrorClass): boolean {
  return isOpenRouterError(error) && error.openRouterClass === cls;
}

/** "The team's OpenRouter credit/allowance is exhausted" — the class the Hero
 *  Script routes turn into a 503 with OPENROUTER_CREDIT_MESSAGE. */
export function isOpenRouterCreditError(error: unknown): boolean {
  return isOpenRouterErrorOfClass(error, "provider_credit");
}

/** "The server's OpenRouter credential is missing/rejected" — also a 503, and a
 *  loud server log, because only an operator can fix it. */
export function isOpenRouterAuthError(error: unknown): boolean {
  return isOpenRouterErrorOfClass(error, "provider_auth");
}

// ── Response shape ─────────────────────────────────────────────────────────

/** Pull the assistant text out of a chat-completions payload. Tolerates the
 *  two content shapes seen in the wild (plain string, or an array of typed
 *  parts) and returns "" for anything else — an empty string is what the
 *  caller's JSON validator treats as "unusable answer, retry once". */
export function extractOpenRouterContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

export interface OpenRouterTextOptions {
  /** Full OpenRouter model slug, e.g. "openai/gpt-5.6-luna". */
  model: string;
  /** Mapped to `max_tokens`. Same meaning as Gemini's maxOutputTokens. */
  maxOutputTokens?: number;
  /** Default 0 — deterministic JSON, same as the Gemini path. */
  temperature?: number;
  /** Defaults to OPENROUTER_API_KEY. Present for tests; never a user key. */
  apiKey?: string;
}

/**
 * One chat-completions round trip. Returns the assistant text.
 *
 * Throws an OpenRouterError (a ProviderError) on failure — classified so the
 * Hero Script layer can answer 503 MODEL_UNAVAILABLE / 503 PROVIDER_CREDIT
 * instead of a generic 500. Never falls back to another provider.
 */
export async function openRouterGenerateText(
  prompt: string,
  options: OpenRouterTextOptions
): Promise<string> {
  const { model, maxOutputTokens = 4096, temperature = 0 } = options;
  const apiKey = (options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    // Server misconfiguration, not a user problem — same class as a rejected
    // server credential so the user sees "temporarily unavailable", not "fix
    // your API key" (they have none to fix).
    throw openRouterError("provider_auth", "OPENROUTER_API_KEY is not configured");
  }

  const res = await fetchWithBudget(
    OPENROUTER_CHAT_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter's recommended attribution headers.
        "HTTP-Referer": OPENROUTER_REFERER,
        "X-Title": OPENROUTER_TITLE,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        max_tokens: maxOutputTokens,
      }),
    },
    {
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      retries: OPENROUTER_MAX_ATTEMPTS - 1,
      retryOn: OPENROUTER_RETRY_ON,
      wallClockMs: OPENROUTER_WALL_CLOCK_MS,
      provider: "openrouter",
      // Non-ok responses come back instead of throwing so the body can be read
      // and classified precisely (402 vs 404 vs 400-bad-model).
      returnHttpErrors: true,
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const excerpt = body.slice(0, 300);
    throw openRouterError(
      classifyOpenRouterFailure(res.status, excerpt),
      `openrouter returned HTTP ${res.status} for model=${model}: ${excerpt}`,
      res.status
    );
  }

  const payload = await res.json().catch(() => null);

  // A 200 can still carry an error envelope (OpenRouter surfaces some upstream
  // failures that way) — classify it exactly like a non-ok status.
  const envelope = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (envelope) {
    const message = typeof envelope.message === "string" ? envelope.message : JSON.stringify(envelope);
    const code = typeof envelope.code === "number" ? envelope.code : undefined;
    throw openRouterError(
      classifyOpenRouterFailure(code, message),
      `openrouter error envelope for model=${model}: ${message.slice(0, 300)}`,
      code
    );
  }

  return extractOpenRouterContent(payload);
}

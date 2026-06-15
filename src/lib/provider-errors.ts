/**
 * Shared provider-error taxonomy — design doc §8 (2026-06-10).
 *
 * Every external-provider failure (HeyGen / ElevenLabs / Gemini / Pexels /
 * Pixabay / stock CDNs) is normalized into one of five codes so API routes
 * return a consistent JSON shape and the UI can map each code to the right
 * action (fix key / show plan-limit / wait / silent retry / generic error).
 *
 * Framework-free on purpose: scripts/verify-*.ts run this directly via
 * `npx tsx` (the repo's test pattern).
 */

export type ProviderErrorCode = "invalid_key" | "quota" | "rate_limit" | "transient" | "fatal";

export interface ProviderError extends Error {
  /** Taxonomy bucket (design doc §8). */
  code: ProviderErrorCode;
  /** Which provider failed: "heygen" | "elevenlabs" | "gemini" | "pexels" | "pixabay" | "stock-cdn" | … */
  provider: string;
  /** Technical message for logs/admin notifications (NOT for end users). */
  message: string;
  /** Thai, user-facing — what the user should do. */
  userAction?: string;
  /** Whether an automatic retry can plausibly succeed. */
  retryable: boolean;
  /** Upstream HTTP status, when there was one. */
  status?: number;
}

class ProviderErrorImpl extends Error implements ProviderError {
  code: ProviderErrorCode;
  provider: string;
  userAction?: string;
  retryable: boolean;
  status?: number;

  constructor(
    code: ProviderErrorCode,
    provider: string,
    message: string,
    opts?: { status?: number; userAction?: string },
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.retryable = code === "rate_limit" || code === "transient";
    this.userAction = opts?.userAction ?? toUserMessage(code);
    this.status = opts?.status;
  }
}

export function providerError(
  code: ProviderErrorCode,
  provider: string,
  message: string,
  opts?: { status?: number; userAction?: string },
): ProviderError {
  return new ProviderErrorImpl(code, provider, message, opts);
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof Error && e.name === "ProviderError" && "code" in e && "provider" in e && "retryable" in e;
}

export function isRetryable(e: unknown): boolean {
  return isProviderError(e) && e.retryable;
}

export function toUserMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "invalid_key":
      return "API Key ใช้ไม่ได้ — กรุณาตรวจสอบ key ใน Settings";
    case "quota":
      return "เครดิต/โควต้าของผู้ให้บริการหมด — กรุณาตรวจสอบแพ็กเกจของบัญชีที่ใช้ key";
    case "rate_limit":
      return "ผู้ให้บริการขอให้รอสักครู่ (rate limit) — กรุณาลองใหม่ในอีก 1-2 นาที";
    case "transient":
      return "ระบบปลายทางขัดข้องชั่วคราว — กรุณาลองใหม่อีกครั้ง";
    case "fatal":
      return "เกิดข้อผิดพลาดที่ไม่คาดคิด — กรุณาลองใหม่ หรือติดต่อทีมงาน";
  }
}

/** Map an UPSTREAM provider HTTP status to a taxonomy code. */
export function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401) return "invalid_key";
  if (status === 402 || status === 403) return "quota";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  return "fatal";
}

/** HTTP status OUR routes return for each code (§8): 401 / 402 / 429 / 503 / 500. */
export function httpStatusForCode(code: ProviderErrorCode): number {
  switch (code) {
    case "invalid_key":
      return 401;
    case "quota":
      return 402;
    case "rate_limit":
      return 429;
    case "transient":
      return 503;
    case "fatal":
      return 500;
  }
}

export interface ProviderErrorBody {
  /** Legacy field every existing client toast reads — Thai user message. */
  error: string;
  code: ProviderErrorCode;
  provider: string;
  message: string;
  userAction: string;
  /**
   * Taxonomy retryable flag — OMITTED on invalid_key. The existing clients'
   * handleMissingKey (video-creator/page.tsx, video-editor/page.tsx) treats
   * `retryable === false` as "not a key problem" and returns BEFORE checking
   * missingKey, which would permanently suppress the fix-your-key modal.
   */
  retryable?: boolean;
  /** Set on invalid_key so the existing fix-your-key modal opens (same field routes already use). */
  missingKey?: string;
}

/** Build the JSON body + HTTP status for an API route response. */
export function toErrorResponse(err: ProviderError): { body: ProviderErrorBody; status: number } {
  const userAction = err.userAction ?? toUserMessage(err.code);
  return {
    body: {
      error: userAction,
      code: err.code,
      provider: err.provider,
      message: err.message,
      userAction,
      // invalid_key: missingKey opens the key modal; legacy `retryable` is
      // omitted because retryable===false would suppress that modal (see above).
      ...(err.code === "invalid_key" ? { missingKey: err.provider } : { retryable: err.retryable }),
    },
    status: httpStatusForCode(err.code),
  };
}

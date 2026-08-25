/**
 * One reader for the TWO shapes our routes use for `quota_exceeded`.
 *
 * `/api/videos/render` answers with the design-doc §8 envelope:
 *     { error: { code: "quota_exceeded", message, userAction, canBuyCredits? }, detail }
 * `/api/videos/jobs` answers with the flat legacy envelope:
 *     { error: "quota_exceeded", message, remainingMinutes?, canBuyCredits? }
 *
 * Editor v2 used to compare `d.error === "quota_exceeded"` — a string compare that can
 * never match the envelope shape — and then fed `d.error` (an object) straight to
 * `toast.error`, so an out-of-minutes creator saw "[object Object]" and no way forward.
 * Both shapes now land here, so a caller reads one code and one set of fields no matter
 * which route answered.
 *
 * Framework-free on purpose: scripts/verify-quota-error-shape.ts runs it via `npx tsx`,
 * and both API routes import it server-side for the shared upgrade wording.
 */

import { customerApiErrorMessage } from "./customer-api-error";

export const QUOTA_EXCEEDED_CODE = "quota_exceeded";

export interface QuotaExceededInfo {
  code: typeof QUOTA_EXCEEDED_CODE;
  /** Customer-facing Thai sentence describing what ran out. Null when the route sent none. */
  message: string | null;
  /** Customer-facing Thai sentence describing what to do next. Null when the route sent none. */
  userAction: string | null;
  /** Credits overflow is live AND the wallet is the remaining way to render. */
  canBuyCredits: boolean;
  remainingMinutes: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The error code of an API response, whichever envelope it used. Returns null when the
 * body carries no code at all — never an object, so a `=== "some_code"` compare on the
 * result can no longer silently fail against the envelope shape.
 */
export function apiErrorCode(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  if (typeof record.error === "string") return str(record.error);
  const nested = asRecord(record.error);
  if (nested) return str(nested.code);
  return null;
}

/**
 * A string message for any API error body — used where the UI needs one line of text.
 * Guarantees a string, so an envelope-shaped `error` can never reach a toast as
 * "[object Object]".
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  if (!record) return fallback;
  const nested = asRecord(record.error);
  const candidates = [
    nested?.message,
    record.message,
    typeof record.error === "string" ? record.error : undefined,
    record.detail,
  ];
  for (const candidate of candidates) {
    const text = str(candidate);
    if (text) return text;
  }
  return fallback;
}

/**
 * Returns the parsed quota facts when (and only when) the body is a quota_exceeded
 * refusal, in either envelope. Anything else — a different code, a non-JSON body, a
 * network null — returns null so callers fall through to their normal error handling.
 */
export function parseQuotaExceeded(body: unknown): QuotaExceededInfo | null {
  if (apiErrorCode(body) !== QUOTA_EXCEEDED_CODE) return null;
  const record = asRecord(body);
  if (!record) return null;
  const nested = asRecord(record.error);
  const remainingRaw = nested?.remainingMinutes ?? record.remainingMinutes;
  return {
    code: QUOTA_EXCEEDED_CODE,
    message: str(nested?.message) ?? str(record.message) ?? str(record.detail),
    userAction: str(nested?.userAction) ?? str(record.userAction),
    canBuyCredits: nested?.canBuyCredits === true || record.canBuyCredits === true,
    remainingMinutes: typeof remainingRaw === "number" && Number.isFinite(remainingRaw)
      ? remainingRaw
      : null,
  };
}

/**
 * The customer-visible sentence for a quota refusal: what ran out, then what to do.
 * Every part is filtered through the shared customer-copy gate, so provider payloads or
 * English diagnostics that ever leaked into `message` are dropped rather than shown.
 */
export function quotaExceededText(info: QuotaExceededInfo, fallback: string): string {
  const parts: string[] = [];
  for (const part of [info.message, info.userAction]) {
    if (!part) continue;
    const safe = customerApiErrorMessage({ message: part }, "");
    if (safe && !parts.includes(safe)) parts.push(safe);
  }
  return parts.length > 0 ? parts.join(" — ") : fallback;
}

/**
 * Shared next-step wording, so `/api/videos/render` and `/api/videos/jobs` cannot drift
 * into telling the same out-of-quota creator two different things.
 */
export function quotaUpgradeUserAction(canBuyCredits: boolean): string {
  return canBuyCredits
    ? "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ"
    : "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ";
}

/** Where the upgrade CTA points, with the funnel source attached. */
export const QUOTA_PRICING_HREF = "/pricing?source=quota_hit";
/** Where the "เติมเครดิต" CTA points — only offered when `canBuyCredits`. */
export const QUOTA_BUY_CREDITS_HREF = "/settings?tab=billing";

import { customerApiErrorMessage } from "@/lib/customer-api-error";

/**
 * Per-window B-roll search & stock-swap policy (Phase 2 "เปลี่ยนสต็อก" tab).
 *
 * The window search runs the creator's keyword qualified by their Step-2
 * preferences. When that qualified query genuinely finds nothing we widen back
 * to the plain keyword once — a degrade rule on two FREE stock APIs, the same
 * one the render pipeline's fallback queries use.
 *
 * The distinction this module exists to keep: an EMPTY result and a FAILED
 * provider look identical once `Promise.allSettled` has swallowed the rejection.
 * Widening after a real zero helps the creator; widening after an outage or a
 * revoked/rate-limited key just doubles the failing calls and hides the real
 * cause. So the caller reports `allProvidersFailed` and the second search is
 * skipped in that case.
 */
export type WindowSearchOutcome<T> = {
  candidates: T[];
  /** True only when every provider that was actually asked threw/rejected or was throttled.
   *  A provider with no key was never asked, so it can neither fail nor succeed. */
  allProvidersFailed: boolean;
};

export async function searchWindowCandidatesWithDegrade<T>(input: {
  styledQuery: string;
  plainKeyword: string;
  search: (query: string) => Promise<WindowSearchOutcome<T>>;
  /** Called just before the one widening search, for logging. */
  onDegrade?: (styledQuery: string) => void;
}): Promise<T[]> {
  const first = await input.search(input.styledQuery);
  const genuineZeroResult = first.candidates.length === 0 && !first.allProvidersFailed;
  if (!genuineZeroResult || input.styledQuery === input.plainKeyword) return first.candidates;
  input.onDegrade?.(input.styledQuery);
  const widened = await input.search(input.plainKeyword);
  return widened.candidates;
}

/**
 * Hostname allowlist for client-supplied stock `videoUrl` in `/api/videos/broll-window/select`.
 * The URL round-trips through the browser (came from `/search`'s response), so it must be
 * re-validated server-side before fetching (SSRF-via-client-echo protection).
 * Suffixes are the actual CDN hosts Pexels/Pixabay video files resolve to
 * (e.g. videos.pexels.com, cdn.pixabay.com) plus vimeocdn.com (some Pixabay hits proxy there).
 */
export const ALLOWED_STOCK_HOST_SUFFIXES = ["pexels.com", "pixabay.com", "vimeocdn.com"] as const;

export function isAllowedStockUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_STOCK_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Shared Thai copy for `/api/videos/broll-window/search` fail-closed responses and client fallbacks. */
export const BROLL_WINDOW_SEARCH_ERROR_MESSAGES = {
  missing_key:
    "คลังสต็อกของระบบยังไม่เปิดใช้งาน — ใส่ Pexels หรือ Pixabay key ของคุณเองใน Settings → API Keys เพื่อค้นหาสต็อก",
  account_suspended: "บัญชีนี้ไม่สามารถใช้งานคลังสต็อกของระบบได้ในขณะนี้",
  managed_stock_rate_limited:
    "ค้นหาสต็อกของระบบครบโควต้าชั่วคราวแล้ว กรุณารอสักครู่แล้วลองใหม่ หรือใส่ Pexels/Pixabay key ของคุณเองใน Settings → API Keys",
  managed_stock_budget_exceeded:
    "คลังสต็อกของระบบครบโควต้าประจำเดือนแล้ว กรุณาใส่ Pexels หรือ Pixabay key ของคุณเองใน Settings → API Keys เพื่อค้นหาต่อ",
} as const;

const API_KEYS_LINK_ERROR_CODES = new Set<string>([
  "missing_key",
  "managed_stock_rate_limited",
  "managed_stock_budget_exceeded",
]);

function readErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const code = (payload as Record<string, unknown>).error;
  return typeof code === "string" ? code : null;
}

export function brollWindowSearchErrorNeedsApiKeys(payload: unknown): boolean {
  const code = readErrorCode(payload);
  return code !== null && API_KEYS_LINK_ERROR_CODES.has(code);
}

export function brollWindowSearchErrorMessage(status: number, payload: unknown): string {
  const code = readErrorCode(payload);
  const codeFallback =
    code === "missing_key"
      ? BROLL_WINDOW_SEARCH_ERROR_MESSAGES.missing_key
      : code === "managed_stock_budget_exceeded"
        ? BROLL_WINDOW_SEARCH_ERROR_MESSAGES.managed_stock_budget_exceeded
        : code === "managed_stock_rate_limited"
          ? BROLL_WINDOW_SEARCH_ERROR_MESSAGES.managed_stock_rate_limited
          : code === "account_suspended"
            ? BROLL_WINDOW_SEARCH_ERROR_MESSAGES.account_suspended
            : status === 429
              ? BROLL_WINDOW_SEARCH_ERROR_MESSAGES.managed_stock_rate_limited
              : "ค้นหาคลิปสต็อกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
  return customerApiErrorMessage(payload, codeFallback);
}

export function brollWindowSelectErrorMessage(status: number, payload: unknown): string {
  const fallback =
    status === 429
      ? "เปลี่ยนคลิปมากเกินไปในชั่วโมงนี้ กรุณาลองใหม่ภายหลัง"
      : "เปลี่ยนคลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
  return customerApiErrorMessage(payload, fallback);
}

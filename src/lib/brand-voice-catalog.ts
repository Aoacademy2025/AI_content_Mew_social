/**
 * HERO-32 — turn a failed voice-catalog fetch into something the creator can act on.
 *
 * `/api/elevenlabs/voices` and `/api/omnivoice/voices` already answer with specific
 * bodies (no key → 400 with a Settings hint, plan → 403, invalid key → 422 with an
 * `action` path, Hero Voice unavailable → 503, not in the cohort → 404). The brand
 * setup picker used to flatten all of them into one dead-end sentence plus a retry
 * button that could never succeed. This module keeps that mapping pure so the
 * picker stays a thin view and the cases are testable without a browser.
 */
export type VoiceCatalogProvider = "elevenlabs" | "omnivoice";

export type VoiceCatalogFailure = {
  /** Plain-language reason, shown verbatim. */
  message: string;
  /** Same-origin path the creator can follow to fix it, when one exists. */
  action: { href: string; label: string } | null;
  /** True when trying again could plausibly work (network blip, upstream 5xx, session). */
  retryable: boolean;
  /**
   * True when this provider is not usable for this account at all right now (no key,
   * plan does not include it, not in the cohort). The picker may switch a brand with
   * no saved voice on this provider to `gemini`; a saved voice is never overwritten.
   */
  providerUnavailable: boolean;
};

type ResponseBody = { error?: unknown; code?: unknown; action?: unknown } | null | undefined;

const PROVIDER_LABEL: Record<VoiceCatalogProvider, string> = {
  elevenlabs: "ElevenLabs",
  omnivoice: "Hero AI Voice",
};

function bodyString(body: ResponseBody, key: "error" | "action"): string | null {
  const value = body && typeof body === "object" ? body[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safePath(candidate: string | null): string | null {
  return candidate && candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : null;
}

export function describeVoiceCatalogFailure(input: {
  provider: VoiceCatalogProvider;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  body?: ResponseBody;
}): VoiceCatalogFailure {
  const label = PROVIDER_LABEL[input.provider];
  const serverMessage = bodyString(input.body, "error");
  const serverAction = safePath(bodyString(input.body, "action"));

  switch (input.status) {
    case 400:
      return {
        message: `ยังไม่ได้ใส่ API key ของ ${label} — ใช้ "เสียง AI" ไปก่อนได้ หรือเพิ่ม key ในตั้งค่า`,
        action: { href: serverAction ?? "/settings?tab=api-keys", label: "ไปตั้งค่า API key" },
        retryable: false,
        providerUnavailable: true,
      };
    case 403:
      return {
        message: `${label} ใช้ได้ในแผน PRO / BUSINESS — แบรนด์นี้ใช้ "เสียง AI" แทนได้เลย`,
        action: { href: "/pricing?source=brand_voice", label: "ดูแพ็กเกจ" },
        retryable: false,
        providerUnavailable: true,
      };
    case 404:
      return {
        message: `${label} ยังไม่เปิดให้บัญชีนี้ — ใช้ "เสียง AI" แทนได้เลย`,
        action: null,
        retryable: false,
        providerUnavailable: true,
      };
    case 422:
      return {
        message: serverMessage ?? `API key ของ ${label} ไม่ถูกต้อง กรุณาตรวจสอบในตั้งค่า`,
        action: { href: serverAction ?? "/settings?tab=api-keys", label: "ตรวจสอบ API key" },
        retryable: false,
        providerUnavailable: false,
      };
    case 401:
      return {
        message: "เซสชันหมดอายุ — รีเฟรชหน้าแล้วลองใหม่",
        action: null,
        retryable: true,
        providerUnavailable: false,
      };
    case null:
      return {
        message: `เชื่อมต่อไม่ได้ — รายชื่อเสียง ${label} จะโหลดใหม่เมื่อกดลองอีกครั้ง เสียงที่บันทึกไว้ยังคงเดิม`,
        action: null,
        retryable: true,
        providerUnavailable: false,
      };
    default:
      return {
        message: serverMessage ?? `${label} ยังไม่พร้อมใช้งานชั่วคราว — เสียงที่บันทึกไว้ยังคงเดิม`,
        action: null,
        retryable: true,
        providerUnavailable: false,
      };
  }
}

/**
 * Whether the picker may silently move this brand to Gemini after a failure:
 * only when the provider is unusable for the account AND nothing is saved for it.
 * A brand that already carries an ElevenLabs/Hero voice id keeps it — the creator
 * chose it, and the render path still honours their key at job time.
 */
export function shouldFallBackToGemini(failure: VoiceCatalogFailure, savedVoiceId: string | null): boolean {
  return failure.providerUnavailable && !savedVoiceId;
}

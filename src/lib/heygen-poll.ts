// Pure mapper: HeyGen v1 video_status.get HTTP response → /api/videos/poll-avatar payload.
// No I/O here so scripts/verify-heygen-poll-map.ts can prove the contract:
//   - invalid key (HTTP 401 หรือ HeyGen code 400112), 404, 402, 4xx อื่นๆ → terminal "failed"
//   - 429 → "pending" + retryAfterSec (client หน่วงตาม Retry-After)
//   - network timeout (httpStatus 0) / 5xx / 200 ที่ parse ไม่ได้ → "pending" (poll ต่อ)
// This closes the "kapokja hole": the old route returned 200 {status:"unknown"} for
// HeyGen 401/404 and the client kept polling a dead video for 30 minutes.

export type AvatarPollError = {
  code: "invalid_key" | "not_found" | "insufficient_credit" | "provider_failed";
  provider: "heygen";
  message: string;
  userAction: string;
  retryable: false;
};

export type AvatarPollPayload = {
  status: string; // "completed" | "processing" | "pending" | "waiting" | "failed" | ...
  videoUrl: string | null;
  thumbnailUrl: string | null;
  errorMsg: string | null;
  error?: AvatarPollError;
  retryAfterSec?: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function heygenErrorText(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === "string") return err;
  const rec = asRecord(err);
  if (rec) {
    const parts = [rec.code, rec.message, rec.detail].filter((p) => p != null).map(String);
    if (parts.length > 0) return parts.join(": ");
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

function pendingPayload(retryAfterSec?: number): AvatarPollPayload {
  return { status: "pending", videoUrl: null, thumbnailUrl: null, errorMsg: null, ...(retryAfterSec ? { retryAfterSec } : {}) };
}

function terminalPayload(error: AvatarPollError): AvatarPollPayload {
  return {
    status: "failed",
    videoUrl: null,
    thumbnailUrl: null,
    errorMsg: `${error.message} — ${error.userAction}`,
    error,
  };
}

export function mapHeygenPollResponse(input: {
  /** HTTP status of the HeyGen response; 0 = fetch threw (network error / timeout) */
  httpStatus: number;
  /** Parsed JSON body, or null when the body was not JSON */
  body: unknown;
  retryAfterHeader?: string | null;
}): AvatarPollPayload {
  const { httpStatus, body, retryAfterHeader } = input;
  const rec = asRecord(body);
  const bodyCode = typeof rec?.code === "number" ? rec.code : null;
  const data = asRecord(rec?.data);

  // Invalid API key — HTTP 401 หรือ HeyGen application code 400112 (มาได้แม้ HTTP 200)
  if (httpStatus === 401 || bodyCode === 400112) {
    return terminalPayload({
      code: "invalid_key",
      provider: "heygen",
      message: "HeyGen API key ไม่ถูกต้องหรือหมดอายุ",
      userAction: "แก้ HeyGen API key ใน Settings",
      retryable: false,
    });
  }

  if (httpStatus === 404) {
    return terminalPayload({
      code: "not_found",
      provider: "heygen",
      message: "ไม่พบวิดีโอนี้ใน HeyGen (อาจถูกลบ หรือสร้างไม่สำเร็จ)",
      userAction: "กดสร้าง Avatar ใหม่อีกครั้ง",
      retryable: false,
    });
  }

  if (httpStatus === 402) {
    return terminalPayload({
      code: "insufficient_credit",
      provider: "heygen",
      message: "เครดิต HeyGen ไม่เพียงพอ",
      userAction: "เติมเครดิตในบัญชี HeyGen แล้วลองใหม่",
      retryable: false,
    });
  }

  // Rate limited — poll ต่อได้ แต่ให้ client หน่วงตาม Retry-After
  if (httpStatus === 429) {
    const parsed = Number(retryAfterHeader);
    const retryAfterSec = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 30;
    return pendingPayload(retryAfterSec);
  }

  // 4xx อื่นๆ = client error ถาวร — poll ต่อก็ไม่มีวันหาย ต้อง fail ทันที
  if (httpStatus >= 400 && httpStatus < 500) {
    const detail = (typeof rec?.message === "string" && rec.message) || heygenErrorText(data?.error) || `HTTP ${httpStatus}`;
    return terminalPayload({
      code: "provider_failed",
      provider: "heygen",
      message: `HeyGen ปฏิเสธคำขอ (${detail})`,
      userAction: "ตรวจสอบ HeyGen API key/เครดิต แล้วลองสร้างใหม่",
      retryable: false,
    });
  }

  // Network error/timeout (0) หรือ HeyGen 5xx — ชั่วคราว poll ต่อ
  if (httpStatus === 0 || httpStatus >= 500) return pendingPayload();

  // 2xx — อ่าน envelope ของ HeyGen { code, data: { status, video_url, thumbnail_url, error } }
  const status = typeof data?.status === "string" ? data.status : null;
  if (!status) return pendingPayload(); // 200 แต่ body ไม่ใช่รูปแบบที่รู้จัก (เช่น proxy คั่น) — ชั่วคราว

  if (status === "failed") {
    const detail = heygenErrorText(data?.error);
    return {
      status: "failed",
      videoUrl: null,
      thumbnailUrl: typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null,
      errorMsg: detail ?? "HeyGen แจ้งว่าสร้างวิดีโอไม่สำเร็จ",
      error: {
        code: "provider_failed",
        provider: "heygen",
        message: detail ? `HeyGen สร้างวิดีโอไม่สำเร็จ: ${detail}` : "HeyGen สร้างวิดีโอไม่สำเร็จ",
        userAction: "ตรวจสอบ Avatar ID และเครดิตใน HeyGen แล้วลองใหม่",
        retryable: false,
      },
    };
  }

  return {
    status,
    videoUrl: typeof data?.video_url === "string" ? data.video_url : null,
    thumbnailUrl: typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null,
    errorMsg: null,
  };
}

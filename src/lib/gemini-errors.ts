export type GeminiErrorKind =
  | "invalid_key"
  | "api_disabled"
  | "quota"
  | "billing"
  | "high_demand"
  | "permission"
  | "timeout"
  | "unknown";

export type GeminiErrorInfo = {
  kind: GeminiErrorKind;
  status: number;
  retryable: boolean;
  userMessage: string;
  technicalMessage: string;
};

function tryParseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function flattenErrorMessage(input: unknown): string {
  if (!input) return "";
  if (input instanceof Error) return input.message || input.toString();
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function statusFromParsed(parsed: unknown, fallback = 500): number {
  const record = parsed as { error?: { code?: unknown }; code?: unknown; status?: unknown } | null;
  const direct = Number(record?.error?.code ?? record?.code ?? record?.status);
  return Number.isFinite(direct) && direct > 0 ? direct : fallback;
}

/** Platform-framed message shown to managed users when a failure is a
 *  user-key-fault kind (invalid_key / billing / permission / api_disabled).
 *  In managed mode those are platform problems, not the user's key. */
const MANAGED_PLATFORM_MSG =
  "ระบบ AI ขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือแจ้งทีมงานหากยังเป็นอยู่";

/** Kinds where the user-message is replaced when managed=true.
 *  Transient kinds (quota / high_demand / timeout) remain as-is — they are
 *  genuine platform/capacity conditions regardless of key ownership. */
const KEY_FAULT_KINDS: ReadonlySet<GeminiErrorKind> = new Set([
  "invalid_key",
  "billing",
  "permission",
  "api_disabled",
]);

export function getGeminiErrorInfo(
  error: unknown,
  opts?: { managed?: boolean },
  fallbackStatus?: number,
): GeminiErrorInfo;
/** @deprecated Use getGeminiErrorInfo(error, opts?, fallbackStatus?) instead */
export function getGeminiErrorInfo(error: unknown, fallbackStatus?: number): GeminiErrorInfo;
export function getGeminiErrorInfo(
  error: unknown,
  optsOrFallback?: { managed?: boolean } | number,
  fallbackStatus = 500,
): GeminiErrorInfo {
  // Handle legacy positional call: getGeminiErrorInfo(err, 404)
  const managed =
    typeof optsOrFallback === "object" ? (optsOrFallback?.managed ?? false) : false;
  const resolvedFallback =
    typeof optsOrFallback === "number" ? optsOrFallback : fallbackStatus;

  const raw = flattenErrorMessage(error);
  const parsed = tryParseJsonObject(raw);
  const status = statusFromParsed(parsed, resolvedFallback);
  const haystack = `${raw} ${flattenErrorMessage(parsed)}`.toLowerCase();

  if (status === 401 || /api_key_invalid|invalid api key|key not valid|invalid key/.test(haystack)) {
    return {
      kind: "invalid_key",
      status: 401,
      retryable: false,
      userMessage: managed
        ? MANAGED_PLATFORM_MSG
        : "Gemini API Key ไม่ถูกต้อง กรุณาสร้าง key ใหม่แล้วบันทึกใน Settings",
      technicalMessage: raw,
    };
  }

  if (/service_disabled|has not been used|generative language api.*disabled|api has not been used/.test(haystack)) {
    return {
      kind: "api_disabled",
      status: 403,
      retryable: false,
      userMessage: managed
        ? MANAGED_PLATFORM_MSG
        : "ยังไม่ได้เปิด Gemini API ใน Google Cloud กรุณากด Enable แล้วลองใหม่",
      technicalMessage: raw,
    };
  }

  if (/billing|payment|paid plan|paid tier|enable billing|billing account/.test(haystack)) {
    return {
      kind: "billing",
      status: status === 429 ? 429 : 403,
      retryable: false,
      userMessage: managed
        ? MANAGED_PLATFORM_MSG
        : "Gemini key นี้ยังไม่ได้ผูกบัตร Google หรือยังเปิดการชำระเงินไม่สมบูรณ์",
      technicalMessage: raw,
    };
  }

  if (status === 429 || /resource_exhausted|quota|rate.?limit|free_tier|freetier|requests per day|retry in/.test(haystack)) {
    return {
      kind: "quota",
      status: 429,
      retryable: true,
      userMessage: "Gemini โควต้าฟรีเต็มแล้ว กรุณารอรอบรีเซ็ต หรือผูกบัตร Google เพื่อเพิ่มโควต้า",
      technicalMessage: raw,
    };
  }

  if (status === 503 || /unavailable|high demand|overloaded|temporarily unavailable/.test(haystack)) {
    return {
      kind: "high_demand",
      status: 503,
      retryable: true,
      userMessage: "Gemini ฝั่ง Google ใช้งานหนาแน่นชั่วคราว กรุณารอ 1-2 นาทีแล้วลองใหม่",
      technicalMessage: raw,
    };
  }

  if (/timeout|etimedout|headers_timeout|body_timeout|aborterror/.test(haystack)) {
    return {
      kind: "timeout",
      status: 504,
      retryable: true,
      userMessage: "Gemini ใช้เวลาตอบนานเกินไป กรุณาลองใหม่อีกครั้ง",
      technicalMessage: raw,
    };
  }

  if (status === 403 || /permission_denied|permission denied|forbidden/.test(haystack)) {
    return {
      kind: "permission",
      status: 403,
      retryable: false,
      userMessage: managed
        ? MANAGED_PLATFORM_MSG
        : "Gemini key นี้ยังไม่มีสิทธิ์ใช้งาน กรุณาตรวจสอบ project หรือสร้าง key ใหม่",
      technicalMessage: raw,
    };
  }

  return {
    kind: "unknown",
    status,
    retryable: status >= 500,
    userMessage: "Gemini ทำงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    technicalMessage: raw,
  };
}

export { KEY_FAULT_KINDS };

// Google 429 bodies carry RetryInfo, e.g. {"retryDelay":"18s"} — honoring it
// matters once a clip is many sequential TTS calls (free-tier RPM windows are
// longer than naive exponential backoff). Capped so one bad hint can't stall
// the whole request.
export function parseRetryDelayMs(errBody: string, capMs = 30_000): number | null {
  const m = errBody.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!m) return null;
  const ms = Math.round(parseFloat(m[1]) * 1000);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, capMs);
}

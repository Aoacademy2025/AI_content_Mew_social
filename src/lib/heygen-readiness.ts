export type HeygenReadiness =
  | { kind: "ready"; remainingQuota: number }
  | { kind: "blocked"; code: "invalid_key" | "quota"; message: string }
  | { kind: "unknown"; message: string };

export type HeygenProviderAction = "open_heygen" | "switch_faceless";

export type HeygenBlockedResponse =
  | {
      status: 400;
      body: {
        error: "invalid_key";
        code: "invalid_key";
        provider: "heygen";
        missingKey: "heygen";
        message: string;
      };
    }
  | {
      status: 402;
      body: {
        error: "provider_quota";
        code: "quota";
        provider: "heygen";
        message: string;
        actions: HeygenProviderAction[];
      };
    };

export function toHeygenBlockedResponse(
  readiness: Extract<HeygenReadiness, { kind: "blocked" }>,
): HeygenBlockedResponse {
  if (readiness.code === "invalid_key") {
    return {
      status: 400,
      body: {
        error: "invalid_key",
        code: "invalid_key",
        provider: "heygen",
        missingKey: "heygen",
        message: readiness.message,
      },
    };
  }
  return {
    status: 402,
    body: {
      error: "provider_quota",
      code: "quota",
      provider: "heygen",
      message: readiness.message,
      actions: ["open_heygen", "switch_faceless"],
    },
  };
}

export interface HeygenQuotaPort {
  getRemainingQuota(input: {
    apiKey: string;
    timeoutMs: number;
  }): Promise<{ status: number; body: unknown }>;
}

const DEFAULT_TIMEOUT_MS = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quotaFrom(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const data = isRecord(body.data) ? body.data : null;
  const raw = data?.remaining_quota ?? body.remaining_quota;
  const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

export const heygenHttpQuotaPort: HeygenQuotaPort = {
  async getRemainingQuota({ apiKey, timeoutMs }) {
    const response = await fetch("https://api.heygen.com/v2/user/remaining_quota", {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  },
};

export async function checkHeygenReadiness(
  input: { apiKey: string; timeoutMs?: number },
  port: HeygenQuotaPort = heygenHttpQuotaPort,
): Promise<HeygenReadiness> {
  try {
    const result = await port.getRemainingQuota({
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.status === 401) {
      return {
        kind: "blocked",
        code: "invalid_key",
        message: "HeyGen API key ใช้ไม่ได้ — กรุณาตรวจสอบ key ใน Settings",
      };
    }
    if (result.status === 402 || result.status === 403) {
      return {
        kind: "blocked",
        code: "quota",
        message: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
      };
    }
    if (result.status < 200 || result.status >= 300) {
      return { kind: "unknown", message: `ตรวจสอบเครดิต HeyGen ไม่สำเร็จ (${result.status})` };
    }

    const remainingQuota = quotaFrom(result.body);
    if (remainingQuota === null) {
      return { kind: "unknown", message: "HeyGen ไม่ได้ส่งยอดเครดิตที่อ่านได้กลับมา" };
    }
    if (remainingQuota <= 0) {
      return {
        kind: "blocked",
        code: "quota",
        message: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
      };
    }
    return { kind: "ready", remainingQuota };
  } catch {
    return { kind: "unknown", message: "ยังตรวจสอบเครดิต HeyGen ไม่ได้" };
  }
}

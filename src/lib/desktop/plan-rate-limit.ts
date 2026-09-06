// Per-user 10 req/min burst cap for /api/desktop/plan-versions and plan-split.
// Same result shape as reserveAiTextCall ({ allowed, remaining, message }).

const WINDOW_MS = 60_000;
const LIMIT = 10;
const hits = new Map<string, number[]>();

export type DesktopPlanRateResult = {
  allowed: boolean;
  remaining: number;
  message?: string;
};

export function tryConsumeDesktopPlanRate(
  userId: string,
  now: number = Date.now(),
): DesktopPlanRateResult {
  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(userId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= LIMIT) {
    hits.set(userId, recent);
    return {
      allowed: false,
      remaining: 0,
      message: "วางแผนเวอร์ชันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
    };
  }
  recent.push(now);
  hits.set(userId, recent);
  return { allowed: true, remaining: LIMIT - recent.length };
}

/** Test-only: clear the in-process rate window. */
export function __resetDesktopPlanRateForTest(): void {
  hits.clear();
}

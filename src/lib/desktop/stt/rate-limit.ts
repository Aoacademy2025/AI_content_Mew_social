// Per-user 6 req/min burst cap for /api/desktop/transcribe.
// Same result shape as reserveAiTextCall in src/lib/ai-text-limits.ts
// ({ allowed, remaining, message }). That module is a monthly ceiling
// (no per-minute window); this is the in-process sliding window used
// elsewhere in this tree for req/min caps (single-box, same as Kie).

const WINDOW_MS = 60_000;
const LIMIT = 6;
const hits = new Map<string, number[]>();

export type DesktopTranscribeRateResult = {
  allowed: boolean;
  remaining: number;
  message?: string;
};

export function tryConsumeDesktopTranscribeRate(
  userId: string,
  now: number = Date.now(),
): DesktopTranscribeRateResult {
  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(userId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= LIMIT) {
    hits.set(userId, recent);
    return {
      allowed: false,
      remaining: 0,
      message: "ถอดเสียงถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
    };
  }
  recent.push(now);
  hits.set(userId, recent);
  return { allowed: true, remaining: LIMIT - recent.length };
}

/** Test-only: clear the in-process rate window. */
export function __resetDesktopTranscribeRateForTest(): void {
  hits.clear();
}

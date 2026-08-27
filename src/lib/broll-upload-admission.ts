const HOUR_MS = 60 * 60 * 1_000;

/** Matches the product's maximum number of user-selected B-roll targets. */
export const BROLL_UPLOADS_PER_HOUR = 60;

type AdmissionLease = {
  commit(): void;
  release(): void;
};

export type BrollUploadAdmissionResult =
  | { ok: true; lease: AdmissionLease }
  | { ok: false; reason: "rate_limited" | "busy"; retryAfterSec: number };

export class BrollUploadAdmission {
  // Production currently runs one Next process. Keep the same in-process rolling
  // window as the route's legacy guard; the class boundary makes a durable backend
  // replaceable later without coupling upload validation or ffmpeg work to it.
  private readonly hits = new Map<string, number[]>();
  private readonly inFlight = new Map<string, symbol>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  tryAcquire(userId: string): BrollUploadAdmissionResult {
    const now = this.now();
    if (this.inFlight.has(userId)) {
      return { ok: false, reason: "busy", retryAfterSec: 5 };
    }
    const recent = (this.hits.get(userId) ?? []).filter((hit) => hit > now - HOUR_MS);
    this.hits.set(userId, recent);
    if (recent.length >= BROLL_UPLOADS_PER_HOUR) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterSec: Math.max(1, Math.ceil(((recent[0] ?? now) + HOUR_MS - now) / 1_000)),
      };
    }

    const token = Symbol(userId);
    let committed = false;
    let released = false;
    this.inFlight.set(userId, token);
    return {
      ok: true,
      lease: {
        commit: () => {
          if (committed || released) return;
          const committedAt = this.now();
          const cutoff = committedAt - HOUR_MS;
          const committedHits = (this.hits.get(userId) ?? []).filter((hit) => hit > cutoff);
          committedHits.push(committedAt);
          this.hits.set(userId, committedHits);
          committed = true;
        },
        release: () => {
          if (released) return;
          if (this.inFlight.get(userId) === token) this.inFlight.delete(userId);
          released = true;
        },
      },
    };
  }
}

export const brollUploadAdmission = new BrollUploadAdmission();

export function brollUploadAdmissionMessage(
  result: Extract<BrollUploadAdmissionResult, { ok: false }>,
): string {
  if (result.reason === "busy") {
    return "กำลังประมวลผลไฟล์อัปโหลดก่อนหน้า กรุณารอประมาณ 5 วินาทีแล้วลองใหม่";
  }
  const waitMinutes = Math.max(1, Math.ceil(result.retryAfterSec / 60));
  return `อัปโหลดครบ ${BROLL_UPLOADS_PER_HOUR} ครั้งในชั่วโมงนี้แล้ว ลองใหม่ได้ในอีกประมาณ ${waitMinutes} นาที`;
}

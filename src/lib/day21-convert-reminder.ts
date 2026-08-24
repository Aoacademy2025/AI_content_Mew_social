export const DAY21_CONVERT_ELAPSED_DAYS = 21;
export const DAY21_CONVERT_TITLE = "สิทธิ์แคมเปญครบ 21 วัน — สมัครรายเดือนต่อได้เลย";
export const DAY21_CONVERT_BODY =
  "สมัครรายเดือนตอนนี้เพื่อใช้ต่อไม่สะดุด · รายปี Founding ยังมีที่นั่งถ้าต้องการล็อคราคา";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Calendar days between two instants in Asia/Bangkok (prod cron is 09:00 ICT). */
export function bangkokCalendarDaysBetween(from: Date, to: Date): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const start = Date.parse(`${fmt.format(from)}T00:00:00+07:00`);
  const end = Date.parse(`${fmt.format(to)}T00:00:00+07:00`);
  return Math.round((end - start) / DAY_MS);
}

export type Day21ConvertDecision =
  | { send: true }
  | { send: false; reason: "internal" | "recurring_payer" | "no_start" | "expired" | "not_day_21" };

export function decideDay21ConvertReminder(input: {
  isInternal: boolean;
  isRecurringPayer: boolean;
  entitlementStartedAt: Date | null;
  entitlementExpiresAt: Date | null;
  now: Date;
}): Day21ConvertDecision {
  if (input.isInternal) return { send: false, reason: "internal" };
  if (input.isRecurringPayer) return { send: false, reason: "recurring_payer" };
  if (!input.entitlementStartedAt) return { send: false, reason: "no_start" };
  if (input.entitlementExpiresAt && input.entitlementExpiresAt.getTime() <= input.now.getTime()) {
    return { send: false, reason: "expired" };
  }
  if (bangkokCalendarDaysBetween(input.entitlementStartedAt, input.now) !== DAY21_CONVERT_ELAPSED_DAYS) {
    return { send: false, reason: "not_day_21" };
  }
  return { send: true };
}

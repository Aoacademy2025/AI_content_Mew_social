/**
 * Asia/Bangkok calendar days — the one day boundary every admin "today", daily series and
 * date label is measured against.
 *
 * The VPS runs with `TZ` unset, so `Etc/UTC`. Anything that reached for the server clock
 * (`new Date().setHours(0,0,0,0)`, `toISOString().slice(0,10)`) therefore started its day at
 * 07:00 Bangkok, not 00:00: on 2026-09-12 at 04:34 Bangkok the /admin "สมัครใช้งานวันนี้" card
 * showed 9 signups that had all happened the previous Bangkok day, and the real Bangkok-today
 * figure was 0 (audit A4, rows #8 / #9). Business days here are Bangkok days; the server's
 * timezone is an implementation detail and must never define one.
 *
 * Asia/Bangkok is UTC+7 all year (no DST), so a fixed offset is exact — the same assumption
 * `src/lib/managed-stock.ts` already makes for its monthly budget periods.
 */

/** Asia/Bangkok is UTC+7 all year. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** `YYYY-MM-DD` of the Asia/Bangkok calendar day containing `date`. */
export function bangkokDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * The instant Bangkok midnight began for the Bangkok day containing `date` — the `gte` bound
 * for any "today" query.
 */
export function startOfBangkokDay(date: Date): Date {
  const shifted = date.getTime() + BANGKOK_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS);
}

/**
 * The `gte` bound for a window of exactly `days` Bangkok calendar days ending with the Bangkok
 * day containing `date` — `bangkokWindowStart(now, 7)` is a true 7-day week (today plus the six
 * days before it), not the eight calendar days a `now − 7d` then floor-to-midnight produces.
 */
export function bangkokWindowStart(date: Date, days: number): Date {
  const wholeDays = Math.max(1, Math.floor(days));
  return new Date(startOfBangkokDay(date).getTime() - (wholeDays - 1) * DAY_MS);
}

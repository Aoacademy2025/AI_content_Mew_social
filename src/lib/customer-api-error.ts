/**
 * Accept only customer-ready API copy at browser boundaries. Provider payloads
 * and diagnostic strings stay available in server logs but never become toast
 * or notice text by accident.
 */

const THAI_TEXT = /[ก-๙]/;
const DIAGNOSTIC_TEXT = /MOVIO_|INSUFFICIENT_CREDIT|provider_failed|manual recovery|stack trace|Prisma|ECONN|HTTP \d{3}|\bat .+\(.+:\d+:\d+\)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function customerApiErrorMessage(value: unknown, fallback: string): string {
  const record = asRecord(value);
  const candidates = record
    ? [record.userAction, record.message, record.error]
    : [value];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const text = candidate.trim();
    if (!text || text.length > 500) continue;
    if (!THAI_TEXT.test(text) || DIAGNOSTIC_TEXT.test(text)) continue;
    return text;
  }
  return fallback;
}

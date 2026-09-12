/**
 * Job Failure Class — the ONE taxonomy every admin surface uses for a failed video job
 * (CONTEXT.md § Operations & Admin):
 *
 *   system — ฝั่งเรา: our code, or our managed key hitting a ceiling
 *   byok   — ฝั่งลูกค้า: the customer's own provider key or credit
 *   quota  — ฝั่งลูกค้า: the customer's plan cap; a pricing signal, not a bug
 *   noise  — superseded or cancelled work; never counted as a failure
 *
 * Admin copy groups byok + quota as "ฝั่งลูกค้า" and system as "ฝั่งเรา". Every consumer
 * (/admin trends, /admin/insights) imports from here — there is no second copy.
 */

export type JobFailureClass = "system" | "byok" | "quota" | "noise";

// OUR own plan caps (minute/clip quota) — an EXPECTED business rule (PRO 15-min cap thrown as 409),
// not a bug and not a customer-key fault. Must NOT inflate "ระบบเรา" (system) OR "คีย์ลูกค้า" (byok);
// it is a pricing/upgrade signal. Classified BEFORE byok so a plan cap never reads as a BYOK error.
export function quotaReasonFromText(text: string): string | null {
  if (/QUOTA_MINUTES|เกินโควต้านาที|เกินนาที/i.test(text)) return "ชนเพดานแผน: โควต้านาที";
  if (/QUOTA_CLIPS|QUOTA_[A-Z]+|เกินโควต้าคลิป|clip quota/i.test(text)) return "ชนเพดานแผน: โควต้าคลิป";
  return null;
}

// P2 กฎ #4: แยก error ฝั่ง "คีย์ลูกค้า" (BYOK) ออกจาก "ระบบเรา" — 429/503/RESOURCE_EXHAUSTED/rate-limit/
// billing/คีย์ผิด = ปัญหาของลูกค้า ไม่ใช่บั๊กระบบ. NOTE: bare "quota" was removed — our plan caps
// (QUOTA_MINUTES/QUOTA_CLIPS) now belong to quotaReasonFromText, not to BYOK.
export function byokReasonFromText(text: string): string | null {
  if (/\b429\b|\b503\b|RESOURCE_EXHAUSTED|too many requests|rate limit/i.test(text)) return "คีย์ลูกค้า: เกินโควต้า/rate limit";
  if (/ผูกบัตร|billing/i.test(text)) return "คีย์ลูกค้า: ยังไม่ผูกบัตร/billing";
  if (/api[\s_-]?key|API_KEY_INVALID|invalid key|api key not valid|unauthorized|permission denied/i.test(text)) return "คีย์ลูกค้า: คีย์ผิด/ไม่มีสิทธิ์";
  return null;
}

// Classify a VideoJob failure. Order: noise → quota (our plan cap) → managed-key rate-limit → byok →
// system. `managed` = MANAGED_GEMINI: when on, a 429/RESOURCE_EXHAUSTED/rate-limit is OUR managed key
// hitting a ceiling (a capacity/infra signal = system), NOT a customer key. Pure + testable.
export function classifyJobError(message: string | null, managed: boolean): JobFailureClass {
  const text = message ?? "";
  if (/__SUPERSEDED__|superseded|AbortError|aborted|cancelled|canceled/i.test(text)) return "noise";
  if (quotaReasonFromText(text)) return "quota";
  if (managed && /\b429\b|\b503\b|RESOURCE_EXHAUSTED|too many requests|rate limit/i.test(text)) return "system";
  if (byokReasonFromText(text)) return "byok";
  return "system";
}

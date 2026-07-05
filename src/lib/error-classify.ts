// OUR own plan caps (minute/clip quota) are expected business rules, not
// customer-key or platform failures. Keep this outside Next route files so
// route modules export only HTTP handlers and route config.
export function quotaReasonFromText(text: string): string | null {
  if (/QUOTA_MINUTES|เกินโควต้านาที|เกินนาที/i.test(text)) return "ชนเพดานแผน: โควต้านาที";
  if (/QUOTA_CLIPS|QUOTA_[A-Z]+|เกินโควต้าคลิป|clip quota/i.test(text)) return "ชนเพดานแผน: โควต้าคลิป";
  return null;
}

// P2 กฎ #4: แยก error ฝั่ง "คีย์ลูกค้า" (BYOK) ออกจาก "ระบบเรา".
// Bare "quota" is intentionally excluded because our plan caps belong to
// quotaReasonFromText, not BYOK.
export function byokReasonFromText(text: string): string | null {
  if (/\b429\b|\b503\b|RESOURCE_EXHAUSTED|too many requests|rate limit/i.test(text)) return "คีย์ลูกค้า: เกินโควต้า/rate limit";
  if (/ผูกบัตร|billing/i.test(text)) return "คีย์ลูกค้า: ยังไม่ผูกบัตร/billing";
  if (/api[\s_-]?key|API_KEY_INVALID|invalid key|api key not valid|unauthorized|permission denied/i.test(text)) return "คีย์ลูกค้า: คีย์ผิด/ไม่มีสิทธิ์";
  return null;
}

// Classify a VideoJob failure. Order: noise -> quota (our plan cap) ->
// managed-key rate-limit -> byok -> system.
export function classifyJobError(message: string | null, managed: boolean): "system" | "byok" | "quota" | "noise" {
  const text = message ?? "";
  if (/__SUPERSEDED__|superseded|AbortError|aborted|cancelled|canceled/i.test(text)) return "noise";
  if (quotaReasonFromText(text)) return "quota";
  if (managed && /\b429\b|\b503\b|RESOURCE_EXHAUSTED|too many requests|rate limit/i.test(text)) return "system";
  if (byokReasonFromText(text)) return "byok";
  return "system";
}

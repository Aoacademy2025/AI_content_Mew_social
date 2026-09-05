import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { sanitizeSentryText } from "@/lib/sentry-config";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const SENTRY_ISSUE_BASE_URL = "https://mew-social-k0.sentry.io/issues";

type UnknownRecord = Record<string, unknown>;

export type SentryLineAlert = {
  eventId: string;
  groupId: string | null;
  text: string;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readTags(value: unknown): Record<string, string> {
  const tags: Record<string, string> = {};
  const record = asRecord(value);
  if (record) {
    for (const [key, item] of Object.entries(record)) {
      const normalized = firstString(item);
      if (normalized) tags[key] = normalized;
    }
    return tags;
  }

  if (!Array.isArray(value)) return tags;
  for (const item of value) {
    if (Array.isArray(item)) {
      const key = firstString(item[0]);
      const tagValue = firstString(item[1]);
      if (key && tagValue) tags[key] = tagValue;
      continue;
    }
    const tag = asRecord(item);
    const key = firstString(tag?.key);
    const tagValue = firstString(tag?.value);
    if (key && tagValue) tags[key] = tagValue;
  }
  return tags;
}

function findEvent(payload: UnknownRecord): UnknownRecord {
  const directEvent = asRecord(payload.event);
  if (directEvent) return directEvent;

  const dataEvent = asRecord(asRecord(payload.data)?.event);
  return dataEvent ?? payload;
}

function sanitizeLineText(value: string, maxLength: number): string {
  return sanitizeSentryText(value)
    .replace(
      /\b(authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|private[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[Filtered]",
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[id]",
    )
    .replace(/\b(?:c[a-z0-9]{20,}|[a-z0-9_-]{32,})\b/gi, "[id]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeLevel(value: unknown): string {
  const level = firstString(value)?.toUpperCase();
  return ["FATAL", "ERROR", "WARNING", "INFO"].includes(level ?? "")
    ? level!
    : "ERROR";
}

function normalizeErrorType(value: unknown): string {
  const type = firstString(value);
  return type && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(type)
    ? type
    : "ApplicationError";
}

export function verifySentryServiceHookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret?.trim() || !signatureHeader?.trim()) return false;
  const signature = signatureHeader.trim().replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}

export function timingSafeTextEqual(
  actual: string | null,
  expected: string | undefined,
): boolean {
  if (!actual || !expected?.trim()) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected.trim());
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function buildSentryLineAlert(payload: unknown): SentryLineAlert | null {
  const root = asRecord(payload);
  if (!root) return null;
  const event = findEvent(root);
  const tags = readTags(event.tags ?? root.tags);
  const environment = firstString(
    event.environment,
    root.environment,
    tags.environment,
  );
  if (environment?.toLowerCase() !== "production") return null;

  const metadata = asRecord(event.metadata);
  const eventId =
    firstString(event.event_id, event.eventID, event.id, root.event_id) ??
    "unknown";
  const rawGroupId = firstString(
    event.group_id,
    event.groupID,
    event.groupId,
    root.group_id,
  );
  const groupId = rawGroupId && /^\d+$/.test(rawGroupId) ? rawGroupId : null;
  const exception = asRecord(
    Array.isArray(asRecord(event.exception)?.values)
      ? (asRecord(event.exception)?.values as unknown[])[0]
      : null,
  );
  const errorType = normalizeErrorType(
    firstString(metadata?.type, exception?.type),
  );
  const culprit = sanitizeLineText(
    firstString(event.culprit, event.transaction) ?? "ไม่ระบุ",
    180,
  );
  const issueUrl = groupId
    ? `${SENTRY_ISSUE_BASE_URL}/${groupId}/`
    : `${SENTRY_ISSUE_BASE_URL}/`;

  return {
    eventId,
    groupId,
    text: [
      "🚨 HERO Studio · Sentry",
      "พบ error ใหม่หรือกลับมาเกิดซ้ำ",
      `ระดับ: ${normalizeLevel(event.level ?? root.level)}`,
      `ประเภท: ${errorType}`,
      `จุดเกิด: ${culprit}`,
      `ดูใน Sentry: ${issueUrl}`,
      "Action: ให้ agent audit ก่อนสร้างหรืออัปเดต Linear",
    ].join("\n"),
  };
}

export function buildLineRetryKey(
  hookGuid: string,
  eventId: string,
): string {
  const bytes = createHash("sha256")
    .update(`${hookGuid}:${eventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sendLinePush(
  input: {
    accessToken: string;
    targetId: string;
    text: string;
    retryKey: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const response = await fetchImpl(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": input.retryKey,
    },
    body: JSON.stringify({
      to: input.targetId,
      messages: [{ type: "text", text: input.text }],
      notificationDisabled: false,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  return response.ok;
}

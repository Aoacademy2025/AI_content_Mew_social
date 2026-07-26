import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";

export type VideoJobOperation = "preview" | "export" | "broll-rerender";

type JsonObject = Record<string, unknown>;

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

export function videoJobOperationKind(body: JsonObject): VideoJobOperation {
  if (body.mode === "export") return "export";
  if (body.mode === "broll-rerender") return "broll-rerender";
  return "preview";
}

export function canonicalVideoJobRequest(
  operation: VideoJobOperation,
  rawBody: JsonObject,
): string {
  const body = { ...rawBody };
  delete body.idempotencyKey;
  return JSON.stringify(canonicalizeJson({
    version: 1,
    operation,
    body,
  }));
}

export async function fingerprintVideoJobRequest(
  operation: VideoJobOperation,
  body: JsonObject,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalVideoJobRequest(operation, body));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const LEGACY_KEY_NAMESPACE = "legacy-v1:";

/**
 * แถวเดิมที่ terminal แล้วยัง replay ได้ภายใน window นี้ — ครอบ "กดซ้ำเร็ว ๆ ของ attempt เดิม"
 * (ดับเบิลคลิก / โพสต์ซ้ำเพราะ response หาย) โดยไม่ขังแท็บเก่าไว้กับงานที่พังถาวร
 */
export const LEGACY_VIDEO_JOB_REPLAY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Compatibility for tabs loaded before idempotencyKey became mandatory.
 * A stable fingerprint-derived key prevents duplicate paid jobs even when retries race.
 * `attempt` ≥ 2 opens a NEW slot for the SAME body once the previous attempt reached a terminal
 * state — without it a stale tab replays its own failed job forever (there is no client-side
 * attempt key to rotate). Attempt 1 keeps the historic shape so rows written before this change
 * keep matching.
 */
export function legacyVideoJobIdempotencyKey(
  fingerprint: string,
  attempt = 1,
): string {
  return attempt > 1
    ? `${LEGACY_KEY_NAMESPACE}${fingerprint}:r${attempt}`
    : `${LEGACY_KEY_NAMESPACE}${fingerprint}`;
}

/**
 * Prefix ที่ครอบทุก attempt ของ fingerprint เดียว (fingerprint = hex ยาวคงที่ ตัวถัดไปจึงเป็น
 * ":" หรือจบสตริงเสมอ → prefix ของ fingerprint หนึ่งไม่มีทางกินของอีกอันหนึ่ง)
 */
export function legacyVideoJobKeyPrefix(fingerprint: string): string {
  return `${LEGACY_KEY_NAMESPACE}${fingerprint}`;
}

/** `legacy-v1:<fp>` → 1 · `legacy-v1:<fp>:r<N>` → N · คีย์อื่น (รวมคีย์ที่ client ส่งเอง) → null */
export function legacyVideoJobAttemptNumber(
  key: string | null | undefined,
  fingerprint: string,
): number | null {
  if (!key) return null;
  const base = legacyVideoJobKeyPrefix(fingerprint);
  if (key === base) return 1;
  if (!key.startsWith(`${base}:r`)) return null;
  const attempt = Number(key.slice(base.length + 2));
  return Number.isInteger(attempt) && attempt >= 2 ? attempt : null;
}

export type LegacyVideoJobAttemptRow = {
  idempotencyKey: string | null;
  status: string;
  createdAt: Date | string | null;
};

/** งานที่ยังวิ่งอยู่ replay ได้เสมอ · งานที่จบแล้ว replay ได้เฉพาะใน window */
export function isLegacyVideoJobReplayable(
  row: Pick<LegacyVideoJobAttemptRow, "status" | "createdAt">,
  now: number = Date.now(),
): boolean {
  if ((VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(row.status)) return true;
  const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
  // createdAt อ่านไม่ได้ = ตัดสินไม่ได้ว่า "เพิ่งกด" → ถือว่าเป็น attempt ที่จบแล้ว (เปิดใบใหม่)
  // ปลอดภัยกับเงิน เพราะเคสนี้ต้องผ่านเงื่อนไข status terminal มาก่อนอยู่แล้ว
  if (!Number.isFinite(createdAt)) return false;
  return now - createdAt <= LEGACY_VIDEO_JOB_REPLAY_WINDOW_MS;
}

/**
 * เลือกคีย์ของ legacy client จากแถวที่มีจริงของ user คนนั้น (คีย์ทุกใบของ fingerprint นี้):
 * - ใบล่าสุดยัง in-flight หรือเพิ่งสร้าง → คีย์เดิม (กดซ้ำ/สองแท็บยิงพร้อมกัน = งานเดียว)
 * - ใบล่าสุด terminal และพ้น window → `:r<N+1>` (สั่งใหม่ด้วย config เดิมได้เสมอ)
 * เป็นฟังก์ชัน pure — deterministic ต่อ input เดียวกัน จึงไม่แตกคีย์ตอน race
 */
export function resolveLegacyVideoJobAttemptKey(
  fingerprint: string,
  rows: readonly LegacyVideoJobAttemptRow[],
  now: number = Date.now(),
): string {
  let latestAttempt = 0;
  let latestRow: LegacyVideoJobAttemptRow | null = null;
  for (const row of rows) {
    const attempt = legacyVideoJobAttemptNumber(row.idempotencyKey, fingerprint);
    if (attempt === null || attempt < latestAttempt) continue;
    latestAttempt = attempt;
    latestRow = row;
  }
  if (!latestRow) return legacyVideoJobIdempotencyKey(fingerprint);
  return legacyVideoJobIdempotencyKey(
    fingerprint,
    isLegacyVideoJobReplayable(latestRow, now) ? latestAttempt : latestAttempt + 1,
  );
}

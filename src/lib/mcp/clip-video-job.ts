import { prisma } from "@/lib/prisma";
import { failJob, withVideoJobSqliteRetry } from "@/lib/mcp/video-job";
import {
  MAX_PRESENTER_IMPORT_BYTES,
  MEDIA_IMPORT_NOT_FOUND,
  createUrlImport,
  failMediaImport,
  findOwnedMediaImport,
} from "@/lib/media-import/imports";
import { admissionRefusal } from "@/lib/mcp/media-import-copy";
import { isReservedMcpChainIdempotencyKey } from "@/lib/mcp/chain-key";
import { toPublicVideoJobStatus } from "@/lib/mcp/video-job-status";
import { durationCapSecFor } from "@/lib/plan-limits";

/**
 * T14 (plan docs/plans/2026-10-03-mcp-edit-before-export.md, ADR 0065; G2, G5, G22, G28, A10):
 * `create_video_job({clipUrl | clipUploadId, cutawayLayout})` — a video made from a presenter
 * clip the customer already has (e.g. rendered in HeyGen), cut away to B-roll.
 *
 * Flow: the route validates the clip fields (parseClipJobArgs), starts or looks up the presenter
 * MediaImport (startClipImport), and creates the job parked in `waiting_import` with only the
 * import's id. A parked job holds no worker slot — the worker never claims that status — and
 * nothing is reserved. settleClipImportJob then moves it on, exactly once:
 *   - import ready  → `queued` with `input.clipUrl` = the import's OWN stored output (allowlisted,
 *                     never the agent's link — G28); the worker runs the existing upload/cutaway
 *                     path, and the existing render-time funding path reserves from there;
 *   - import failed → the job fails with the import's code; failJob refunds anything reserved,
 *                     so the net charge is zero (G5);
 *   - still running → stays parked (the lane's watchdog always ends an import).
 * Triggers: right after create (an already-ready upload starts at once), the worker's 60 s
 * watchdog sweep, and get_video_status (settle on read). Neither the worker loop nor the import
 * lane knows about this module.
 *
 * This module stays light (no orchestrator, no route code): the watchdog imports it.
 */

export type CutawayLayout = "auto" | "fillYourself";
export type ClipSource = { kind: "url"; url: string } | { kind: "upload"; id: string };
export type ClipRequest = { source: ClipSource; cutawayLayout: CutawayLayout };

/** G14 envelope. `importError` rides only on `import_failed`. */
export type ClipJobFailure = { error: string; code: string; message: string; next: string; importError?: string };

type ClipArgs = {
  script?: string;
  clipUrl?: string;
  clipUploadId?: string;
  cutawayLayout?: CutawayLayout;
  avatarMode?: string;
};

/** Same bound as replace_broll_window's url (edit-tools MAX_MEDIA_URL_CHARS). */
const MAX_CLIP_URL_CHARS = 2_048;

function failure(code: string, message: string, next: string): ClipJobFailure {
  return { error: code, code, message, next };
}

const NEXT_CLIP_SOURCE = "ส่ง clipUrl (ลิงก์ https สาธารณะของคลิป) หรือ clipUploadId (จาก create_upload_url ชนิด presenter หลัง PUT ไฟล์เสร็จ) อย่างใดอย่างหนึ่ง";

const BOTH_SOURCES = failure("invalid_input", "ส่งได้ทีละแหล่งเท่านั้น: clipUrl หรือ clipUploadId อย่างใดอย่างหนึ่ง", NEXT_CLIP_SOURCE);
const NO_CONTENT = failure(
  "invalid_input",
  "ต้องมี script หรือคลิปพิธีกร (clipUrl / clipUploadId) อย่างน้อยหนึ่งอย่าง",
  "ส่ง script ที่จะให้พากย์ หรือส่งคลิปพิธีกรด้วย clipUrl / clipUploadId (ไม่ต้องมี script)",
);
const LAYOUT_WITHOUT_CLIP = failure(
  "invalid_input",
  "cutawayLayout ใช้ได้เฉพาะเมื่อส่งคลิปพิธีกร (clipUrl / clipUploadId)",
  "ตัด cutawayLayout ออก หรือส่งคลิปพิธีกรมาด้วย",
);
const AVATAR_WITH_CLIP = failure(
  "invalid_input",
  "คลิปพิธีกรใช้คู่กับ avatarMode ไม่ได้ — คลิปที่ส่งมาคือพิธีกรอยู่แล้ว",
  "ตัด avatarMode / avatarId ออก แล้วเรียก create_video_job อีกครั้ง",
);
const BAD_CLIP_URL = failure(
  "invalid_input",
  "clipUrl ไม่ใช่ลิงก์ที่ใช้ได้ (ต้องเป็นลิงก์ https เต็ม ยาวไม่เกิน 2048 ตัวอักษร และไม่มีชื่อผู้ใช้/รหัสผ่านในลิงก์)",
  "ส่งลิงก์ https สาธารณะของไฟล์คลิป หรืออัปโหลดด้วย create_upload_url(kind: \"presenter\") แล้วส่ง clipUploadId แทน",
);
const CLIP_URL_NOT_HTTPS = failure(
  "url_not_https",
  "clipUrl ต้องเป็นลิงก์ https เท่านั้น",
  "ส่งลิงก์ https:// ของไฟล์คลิป หรืออัปโหลดด้วย create_upload_url(kind: \"presenter\") แล้วส่ง clipUploadId แทน",
);
/** G27: one reply for missing, someone else's, wrong-kind and not-yet-PUT ids. */
const CLIP_UPLOAD_NOT_FOUND: ClipJobFailure = {
  ...MEDIA_IMPORT_NOT_FOUND,
  next: "ใช้ uploadId จาก create_upload_url(kind: \"presenter\") ของบัญชีนี้ หลัง PUT ไฟล์เสร็จแล้ว หรือส่ง clipUrl แทน",
};

/** Any of the T14 fields present — the route's beta gate keys on this. */
export function clipFieldsRequested(args: ClipArgs): boolean {
  return args.clipUrl !== undefined || args.clipUploadId !== undefined || args.cutawayLayout !== undefined;
}

/**
 * Server-side validation of the clip fields (the schema stays flat, G13). `clip: null` = a plain
 * script job, unchanged. A plain call still needs its script — only a clip may stand in for it.
 */
export function parseClipJobArgs(args: ClipArgs): { ok: true; clip: ClipRequest | null } | { ok: false; failure: ClipJobFailure } {
  const hasUrl = args.clipUrl !== undefined;
  const hasUpload = args.clipUploadId !== undefined;
  if (hasUrl && hasUpload) return { ok: false, failure: BOTH_SOURCES };
  if (!hasUrl && !hasUpload) {
    if (args.cutawayLayout !== undefined) return { ok: false, failure: LAYOUT_WITHOUT_CLIP };
    if (args.script === undefined) return { ok: false, failure: NO_CONTENT };
    return { ok: true, clip: null };
  }
  if (args.avatarMode !== undefined && args.avatarMode !== "none") return { ok: false, failure: AVATAR_WITH_CLIP };
  const cutawayLayout: CutawayLayout = args.cutawayLayout === "fillYourself" ? "fillYourself" : "auto";
  if (hasUpload) return { ok: true, clip: { source: { kind: "upload", id: String(args.clipUploadId) }, cutawayLayout } };

  const raw = String(args.clipUrl).trim();
  if (!raw || raw.length > MAX_CLIP_URL_CHARS) return { ok: false, failure: BAD_CLIP_URL };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, failure: BAD_CLIP_URL };
  }
  if (parsed.protocol !== "https:") return { ok: false, failure: CLIP_URL_NOT_HTTPS };
  if (parsed.username || parsed.password) return { ok: false, failure: BAD_CLIP_URL };
  // T10's guarded fetch re-validates every hop and the resolved address (G23) in the lane.
  return { ok: true, clip: { source: { kind: "url", url: parsed.href }, cutawayLayout } };
}

/**
 * T14-A2 (PR-B fix round 1): a retried clip create with an idempotencyKey already used answers
 * `duplicate` with the existing job BEFORE any import starts — so a retry never queues a second
 * import, never meets `too_many_active_imports` / `too_many_jobs`, and never fails or cancels
 * anything. A server-reserved key (`mcp-chain:` …) is refused the same way. null = a fresh key.
 */
export async function duplicateClipJobReply(
  userId: string,
  idempotencyKey: string,
): Promise<(ClipJobFailure & { jobId?: string; status?: string }) | null> {
  const next = "เช็คงานเดิมด้วย get_video_status — ถ้าต้องการสร้างงานใหม่ ให้ใช้ idempotencyKey ใหม่";
  if (isReservedMcpChainIdempotencyKey(idempotencyKey)) {
    return failure("duplicate", "idempotencyKey นี้ถูกใช้แล้ว", "ใช้ idempotencyKey อื่นที่ไม่ขึ้นต้นด้วย mcp-chain:, mcp-export: หรือ mcp-rerender:");
  }
  const row = await prisma.videoJob.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: { id: true, status: true },
  });
  if (!row) return null;
  return { ...failure("duplicate", "idempotencyKey นี้ถูกใช้แล้ว — งานเดิมยังอยู่", next), jobId: row.id, status: toPublicVideoJobStatus(row.status) };
}

export type StartedClipImport = { importId: string; createdHere: boolean };

/**
 * Queue the presenter import for a url (G25 caps, refused with the shared admission copy), or
 * find the caller's own presenter upload (G27). An upload that already failed is refused here
 * with its code, before any job exists.
 */
export async function startClipImport(
  userId: string,
  source: ClipSource,
  now: Date = new Date(),
): Promise<{ ok: true; started: StartedClipImport } | { ok: false; failure: ClipJobFailure }> {
  if (source.kind === "url") {
    const created = await createUrlImport(userId, source.url, now, "presenter");
    if (!created.ok) return { ok: false, failure: admissionRefusal(created.code, "create_video_job", created.retryAfterSeconds) };
    return { ok: true, started: { importId: created.importId, createdHere: true } };
  }
  const owned = await findOwnedMediaImport(userId, source.id, ["presenter"]);
  if (!owned.ok) return { ok: false, failure: CLIP_UPLOAD_NOT_FOUND };
  if (owned.row.status === "failed") {
    const importError = safeImportCode(owned.row.errorCode);
    return { ok: false, failure: { ...importFailedEnvelope(importError), importError } };
  }
  return { ok: true, started: { importId: owned.row.id, createdHere: false } };
}

/** The job was not created after all: stop a url import this call queued (uploads are the agent's). */
export async function abandonClipImport(started: StartedClipImport | null): Promise<void> {
  if (!started?.createdHere) return;
  await failMediaImport(started.importId, "canceled").catch(() => {});
}

function importFailedEnvelope(importError: string): ClipJobFailure {
  const hint = CLIP_IMPORT_HINT[importError];
  return failure(
    "import_failed",
    `คลิปพิธีกรนำเข้าไม่สำเร็จ (${importError})${hint ? ` — ${hint}` : ""}`,
    "แก้ไฟล์ตามสาเหตุ แล้วส่งใหม่ด้วย clipUrl หรืออัปโหลดใหม่ด้วย create_upload_url(kind: \"presenter\") แล้วเรียก create_video_job อีกครั้ง",
  );
}

const MB = 1024 * 1024;
/** Thai hint per Media Import code (the lane's fixed vocabulary + this module's own two). */
export const CLIP_IMPORT_HINT: Record<string, string> = {
  url_not_https: "ลิงก์ต้องขึ้นต้นด้วย https://",
  url_not_public: "ลิงก์ต้องเปิดได้จากอินเทอร์เน็ตสาธารณะ",
  too_many_redirects: "ลิงก์ส่งต่อ (redirect) หลายทอดเกินไป — ใช้ลิงก์ตรงของไฟล์",
  fetch_failed: "ดาวน์โหลดจากลิงก์ไม่สำเร็จ — ลิงก์ต้องเปิดได้โดยไม่ต้องล็อกอิน หรืออัปโหลดด้วย create_upload_url แทน",
  fetch_timeout: "ดาวน์โหลดหรือประมวลผลไม่ทันเวลา หรือคิวนำเข้าไม่ว่างในตอนนั้น — ส่งไฟล์เดิมใหม่ได้",
  file_too_large: `ไฟล์ใหญ่เกิน ${MAX_PRESENTER_IMPORT_BYTES / MB} MB`,
  payload_too_large: `ไฟล์ใหญ่เกิน ${MAX_PRESENTER_IMPORT_BYTES / MB} MB`,
  unsupported_media: "ต้องเป็นไฟล์วิดีโอ mp4, mov หรือ webm",
  unsupported_type: "ต้องเป็นไฟล์วิดีโอ mp4, mov หรือ webm",
  empty_file: "ไฟล์ว่าง",
  upload_missing: "ยังไม่ได้รับไฟล์ — ขอลิงก์ใหม่ด้วย create_upload_url แล้ว PUT ไฟล์อีกครั้ง",
  upload_incomplete: "ได้รับไฟล์ไม่ครบ — ขอลิงก์ใหม่ด้วย create_upload_url แล้ว PUT ไฟล์อีกครั้ง",
  upload_failed: "รับไฟล์ไม่สำเร็จ — ขอลิงก์ใหม่ด้วย create_upload_url แล้ว PUT ไฟล์อีกครั้ง",
  process_failed: "ประมวลผลไฟล์ไม่สำเร็จ — ลองส่งออกคลิปใหม่เป็น mp4 (H.264)",
  normalize_failed: "แปลงไฟล์ไม่สำเร็จ — ลองส่งออกคลิปใหม่เป็น mp4 (H.264)",
  probe_failed: "อ่านข้อมูลวิดีโอไม่ได้ — ลองส่งออกคลิปใหม่เป็น mp4 (H.264)",
  not_portrait: "คลิปต้องเป็นแนวตั้ง (สูงมากกว่ากว้าง เช่น 1080×1920)",
  too_large_dimensions: "ความละเอียดต้องไม่เกิน 4096 พิกเซลต่อด้าน",
  storage_busy: "พื้นที่เก็บไฟล์ของระบบเต็มชั่วคราว — รอสักครู่แล้วส่งใหม่ (ไม่ได้ตัดโควต้าหรือเครดิต)",
  duration_exceeded: `คลิปยาวเกินเพดานของแผน (PRO ${durationCapSecFor("PRO") / 60} นาที, BUSINESS ${durationCapSecFor("BUSINESS") / 60} นาทีต่อคลิป)`,
  import_missing: "ไม่พบไฟล์นำเข้าของงานนี้แล้ว",
  import_failed: "ไฟล์ที่นำเข้าใช้เป็นคลิปพิธีกรไม่ได้",
};

/** A stored code is echoed to the agent; anything outside the fixed shape reads as import_failed. */
function safeImportCode(code: string | null | undefined): string {
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(code) ? code : "import_failed";
}

/**
 * G28 / T14-A4: only the import lane's own presenter output may become `input.clipUrl` — exactly
 * the name presenterOutputFilename() writes (`presenter-import-<ms>-<uuid>.<mp4|webm>`) under
 * `/api/renders/`, the one prefix the presenter lane serves. No subdirectory, no traversal, no
 * encoding, no query, no scheme; anything else (a B-roll output, a render) is refused.
 */
const PRESENTER_OUTPUT_SRC = /^\/api\/renders\/presenter-import-\d{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm)$/;
export function allowlistedClipSrc(src: string | null | undefined): string | null {
  if (typeof src !== "string" || src.length > 200) return null;
  return PRESENTER_OUTPUT_SRC.test(src) ? src : null;
}

function parseInput(inputJson: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(inputJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type ClipSettleOutcome = "not_waiting" | "waiting" | "queued" | "failed";

async function failWaitingJob(jobId: string, code: string): Promise<ClipSettleOutcome> {
  const hint = CLIP_IMPORT_HINT[code];
  const job = await failJob(
    jobId,
    {
      message: `นำเข้าคลิปพิธีกรไม่สำเร็จ (${code})${hint ? ` — ${hint}` : ""} — ระบบยังไม่ได้เริ่มสร้างวิดีโอ และไม่ได้ตัดโควต้าหรือเครดิต`,
      code,
    },
    { fromStatus: "waiting_import" },
  );
  return job.status === "failed" && job.errorCode === code ? "failed" : "not_waiting";
}

/**
 * Move one parked job on, if its import has finished. Idempotent; a lost race is a no-op.
 * `userId` scopes a caller-driven settle (get_video_status) to the caller's own job.
 */
export async function settleClipImportJob(jobId: string, userId?: string): Promise<ClipSettleOutcome> {
  const row = await prisma.videoJob.findFirst({
    where: { id: jobId, status: "waiting_import", ...(userId ? { userId } : {}) },
    select: { id: true, userId: true, inputJson: true },
  });
  if (!row) return "not_waiting";
  const input = parseInput(row.inputJson);
  const importId = typeof input?.clipImportId === "string" ? input.clipImportId : null;
  const imp = importId
    ? await prisma.mediaImport.findFirst({
        where: { id: importId, userId: row.userId, purpose: "presenter" },
        select: { status: true, errorCode: true, resultSrc: true },
      })
    : null;
  if (!input || !imp) return failWaitingJob(row.id, "import_missing");
  if (imp.status === "failed") return failWaitingJob(row.id, safeImportCode(imp.errorCode));
  if (imp.status !== "ready") return "waiting";
  const clipUrl = allowlistedClipSrc(imp.resultSrc);
  if (!clipUrl) return failWaitingJob(row.id, "import_failed");
  const moved = await withVideoJobSqliteRetry("settle clip import", () => prisma.videoJob.updateMany({
    where: { id: row.id, status: "waiting_import" },
    data: { status: "queued", currentStep: null, inputJson: JSON.stringify({ ...input, clipUrl }) },
  }));
  return moved.count === 1 ? "queued" : "not_waiting";
}

/** Never throws (create, status reads and the watchdog all call it opportunistically). */
export async function settleClipImportJobSafely(jobId: string, userId?: string): Promise<ClipSettleOutcome | null> {
  try {
    return await settleClipImportJob(jobId, userId);
  } catch (error) {
    console.error(`[mcp-clip] settle failed job=${jobId} (${error instanceof Error ? error.name : "unknown"})`);
    return null;
  }
}

/** Watchdog pass: settle every parked job whose import has finished. Returns the ids it moved. */
export async function settleWaitingClipImportJobs(): Promise<string[]> {
  const waiting = await prisma.videoJob.findMany({
    where: { status: "waiting_import" },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true },
  });
  const settled: string[] = [];
  for (const { id } of waiting) {
    const outcome = await settleClipImportJobSafely(id);
    if (outcome === "queued" || outcome === "failed") settled.push(id);
  }
  return settled;
}

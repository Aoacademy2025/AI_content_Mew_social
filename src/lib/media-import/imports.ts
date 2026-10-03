import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { MediaImport, McpUploadToken, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MAX_BROLL_IMAGE_BYTES, MAX_BROLL_VIDEO_BYTES } from "@/lib/media-import/broll-pipeline";

/**
 * Media Import rows, upload links and their DB admission (Task 11, PR-B — plan
 * docs/plans/2026-10-03-mcp-edit-before-export.md G25/G26/G27, ADR 0065).
 *
 * Admission is counted in the database, never in process memory: the web process issues
 * links and receives uploads while mcp-video-worker (a separate process) runs the imports,
 * so an in-memory counter would let each process admit its own cap (critic A9).
 *
 * How a cap holds across processes on SQLite: every admission is ONE interactive
 * transaction holding SQLite's single writer lock from start to commit. Prisma 6 opens
 * SQLite interactive transactions with `BEGIN IMMEDIATE` (checked with query logging), and the
 * first statement is a write anyway (insert the link / consume the link), so a second
 * admission — from this process or another — waits on busy_timeout until this one commits.
 * The counts inside therefore see every admission that won before them, and an over-cap
 * result throws, rolling the write back. Counting OUTSIDE the transaction is exactly the bug
 * scripts/verify-media-import-upload.ts §D catches (two real processes, one SQLite file).
 *
 * "Active" means pending/processing AND still inside `deadlineAt`: a row past its deadline is
 * one the watchdog (Task 12) fails, so it holds neither a user's slot nor staging budget — a
 * stalled lane can never lock a user out. The disk itself is guarded separately by the
 * free-space floor the PUT checks before staging (upload-staging.ts).
 */

export const UPLOAD_KINDS = ["image", "video", "presenter"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export const MEDIA_IMPORT_PURPOSES = ["broll_image", "broll_video", "presenter"] as const;
export type MediaImportPurpose = (typeof MEDIA_IMPORT_PURPOSES)[number];

export const UPLOAD_KIND_PURPOSE: Record<UploadKind, MediaImportPurpose> = {
  image: "broll_image",
  video: "broll_video",
  presenter: "presenter",
};

/** Presenter clip limit — the same 500 MB as the web upload (/api/videos/upload-avatar, G22). */
export const MAX_PRESENTER_IMPORT_BYTES = 500 * 1024 * 1024;

export const UPLOAD_KIND_MAX_BYTES: Record<UploadKind, number> = {
  image: MAX_BROLL_IMAGE_BYTES,
  video: MAX_BROLL_VIDEO_BYTES,
  presenter: MAX_PRESENTER_IMPORT_BYTES,
};

const PURPOSE_MAX_BYTES: Record<MediaImportPurpose, number> = {
  broll_image: MAX_BROLL_IMAGE_BYTES,
  broll_video: MAX_BROLL_VIDEO_BYTES,
  presenter: MAX_PRESENTER_IMPORT_BYTES,
};

// G25 — accepted by Mew 2026-10-03.
export const MAX_ACTIVE_IMPORTS = 3;
export const MAX_IMPORTS_PER_HOUR = 30;
export const MAX_UPLOAD_LINKS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Global staging budget (all users): every active import reserves its purpose's byte cap, and
 * one more is admitted only while the sum stays within this — e.g. 20 presenter clips at once.
 * Bounds what can be parked on the disk prod SQLite shares (security review A1).
 */
export const MAX_STAGED_IMPORT_BYTES = 10 * 1024 ** 3;

/** G26: an upload link dies 15 minutes after it was issued. */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Watchdog bound for a row whose bytes are still streaming in (status "processing"). */
export const UPLOAD_RECEIVE_DEADLINE_MS = 15 * 60 * 1000;
/**
 * G23: wall-clock budget of one import phase in the import lane — waiting in the queue
 * ("pending", set when it is queued), then again from the moment the lane claims it
 * ("processing", reset at claim by lane.ts so a long queue wait cannot eat the fetch budget).
 */
export const IMPORT_DEADLINE_MS = 10 * 60 * 1000;

export const MEDIA_IMPORT_ACTIVE_STATUSES = ["pending", "processing"] as const;

/** Rows that still hold a slot: pending/processing and not yet past their deadline. */
function liveImportsWhere(now: Date) {
  return { status: { in: [...MEDIA_IMPORT_ACTIVE_STATUSES] }, deadlineAt: { gt: now } };
}

/** `heroai_up_` + 32 random bytes (256 bits) as base64url. Only its SHA-256 is stored. */
export const UPLOAD_TOKEN_PREFIX = "heroai_up_";
const UPLOAD_TOKEN_PATTERN = /^heroai_up_[A-Za-z0-9_-]{43}$/;

export function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === "string" && (UPLOAD_KINDS as readonly string[]).includes(value);
}

export function isWellFormedUploadToken(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_TOKEN_PATTERN.test(value);
}

export function hashUploadToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type AdmissionCode = "too_many_active_imports" | "import_hourly_limit" | "upload_link_hourly_limit" | "storage_busy";

class AdmissionRefused extends Error {
  constructor(readonly code: AdmissionCode | "upload_link_invalid") {
    super(code);
  }
}

/** Throws AdmissionRefused when one more import of `purpose` would break a G25 cap or the budget. */
async function assertImportCapacity(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
  purpose: MediaImportPurpose,
): Promise<void> {
  const active = await tx.mediaImport.count({ where: { userId, ...liveImportsWhere(now) } });
  if (active >= MAX_ACTIVE_IMPORTS) throw new AdmissionRefused("too_many_active_imports");
  const lastHour = await tx.mediaImport.count({
    where: { userId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  if (lastHour >= MAX_IMPORTS_PER_HOUR) throw new AdmissionRefused("import_hourly_limit");
  const reserved = await tx.mediaImport.groupBy({ by: ["purpose"], where: liveImportsWhere(now), _count: { _all: true } });
  const reservedBytes = reserved.reduce(
    // An unknown purpose reserves the largest cap.
    (sum, group) => sum + (PURPOSE_MAX_BYTES[group.purpose as MediaImportPurpose] ?? MAX_PRESENTER_IMPORT_BYTES) * group._count._all,
    0,
  );
  if (reservedBytes + PURPOSE_MAX_BYTES[purpose] > MAX_STAGED_IMPORT_BYTES) throw new AdmissionRefused("storage_busy");
}

export type IssuedUploadToken = {
  ok: true;
  /** The raw link token. It is never stored and never logged — it exists only in this reply. */
  token: string;
  /** The MediaImport id the upload will create (= the agent's uploadId). */
  importId: string;
  kind: UploadKind;
  issuedAt: Date;
  expiresAt: Date;
};

/**
 * `create_upload_url`'s admission + issue (G25/G26). Refuses when the user already asked for
 * 10 links this hour, or when one more import would break the active / hourly import caps or
 * the global staging budget.
 */
export async function issueUploadToken(
  userId: string,
  kind: UploadKind,
  now: Date = new Date(),
): Promise<IssuedUploadToken | { ok: false; code: AdmissionCode }> {
  const token = UPLOAD_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const importId = randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      // Write first: takes the writer lock (see the module comment).
      await tx.mcpUploadToken.create({
        data: { tokenHash: hashUploadToken(token), userId, kind, issuedAt: now, importId },
      });
      const linksThisHour = await tx.mcpUploadToken.count({
        where: { userId, issuedAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      });
      if (linksThisHour > MAX_UPLOAD_LINKS_PER_HOUR) throw new AdmissionRefused("upload_link_hourly_limit");
      await assertImportCapacity(tx, userId, now, UPLOAD_KIND_PURPOSE[kind]);
    });
  } catch (error) {
    if (error instanceof AdmissionRefused && error.code !== "upload_link_invalid") return { ok: false, code: error.code };
    throw error;
  }
  return { ok: true, token, importId, kind, issuedAt: now, expiresAt: new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS) };
}

/** The link row behind a raw token, or null when it is malformed, unknown, used or expired. */
export async function findUsableUploadToken(raw: unknown, now: Date = new Date()): Promise<McpUploadToken | null> {
  if (!isWellFormedUploadToken(raw)) return null;
  const row = await prisma.mcpUploadToken.findUnique({ where: { tokenHash: hashUploadToken(raw) } });
  if (!row || row.usedAt || !isUploadKind(row.kind)) return null;
  if (row.issuedAt.getTime() + UPLOAD_TOKEN_TTL_MS <= now.getTime()) return null;
  return row;
}

export type AdmittedUpload = {
  ok: true;
  importId: string;
  userId: string;
  kind: UploadKind;
  purpose: MediaImportPurpose;
  maxBytes: number;
};

/**
 * The PUT's admission: consume the link (single use) and create its MediaImport in
 * "processing" — atomically, and only when the G25 import caps still allow it. A refused
 * admission rolls back, so the link stays usable for a retry within its 15 minutes.
 */
export async function admitUpload(
  link: McpUploadToken,
  now: Date = new Date(),
): Promise<AdmittedUpload | { ok: false; code: AdmissionCode | "upload_link_invalid" }> {
  if (!isUploadKind(link.kind)) return { ok: false, code: "upload_link_invalid" };
  const kind = link.kind;
  const purpose = UPLOAD_KIND_PURPOSE[kind];
  try {
    await prisma.$transaction(async (tx) => {
      // Write first (writer lock), and the conditional write IS the single-use guarantee:
      // of two racing PUTs, only one can move usedAt from null.
      const consumed = await tx.mcpUploadToken.updateMany({
        where: { id: link.id, usedAt: null, issuedAt: { gt: new Date(now.getTime() - UPLOAD_TOKEN_TTL_MS) } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AdmissionRefused("upload_link_invalid");
      await assertImportCapacity(tx, link.userId, now, purpose);
      await tx.mediaImport.create({
        data: {
          id: link.importId,
          userId: link.userId,
          purpose,
          source: "upload",
          status: "processing",
          deadlineAt: new Date(now.getTime() + UPLOAD_RECEIVE_DEADLINE_MS),
        },
      });
    });
  } catch (error) {
    if (error instanceof AdmissionRefused) return { ok: false, code: error.code };
    throw error;
  }
  return { ok: true, importId: link.importId, userId: link.userId, kind, purpose, maxBytes: UPLOAD_KIND_MAX_BYTES[kind] };
}

/**
 * Bytes fully staged: hand the row to the import lane ("pending", fresh deadline). False when
 * the row is no longer "processing" (e.g. the watchdog already failed it) — the caller then
 * discards the staged file.
 */
export async function markUploadStaged(importId: string, now: Date = new Date()): Promise<boolean> {
  const moved = await prisma.mediaImport.updateMany({
    where: { id: importId, status: "processing", source: "upload" },
    data: { status: "pending", deadlineAt: new Date(now.getTime() + IMPORT_DEADLINE_MS) },
  });
  return moved.count === 1;
}

/** Fail an import that has not finished (never overwrites a ready/failed row). */
export async function failMediaImport(importId: string, errorCode: string): Promise<void> {
  await prisma.mediaImport.updateMany({
    where: { id: importId, status: { in: [...MEDIA_IMPORT_ACTIVE_STATUSES] } },
    // A finished import keeps no copy of the agent's link (it may carry a signed token).
    data: { status: "failed", errorCode, sourceUrl: null },
  });
}

// ── ownership (G27) ──────────────────────────────────────────────────────────────────────────

export type MediaImportFailure = { error: "invalid_input"; code: "invalid_input"; message: string; next: string };

/** One reply for "missing", "someone else's" and "wrong kind" — never reveals that an id exists. */
export const MEDIA_IMPORT_NOT_FOUND: MediaImportFailure = Object.freeze({
  error: "invalid_input",
  code: "invalid_input",
  message: "ไม่พบไฟล์นำเข้านี้ในบัญชีของคุณ หรือใช้กับคำสั่งนี้ไม่ได้",
  next: "ใช้ uploadId ที่ได้จาก create_upload_url ของบัญชีนี้ (ชนิดไฟล์ให้ตรงกับงาน) หรือส่งลิงก์สาธารณะ (url) แทน",
}) as MediaImportFailure;

const MEDIA_IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * G27: the caller's own import of one of `purposes`, or the single not-found envelope. One
 * query keyed on (id, userId, purpose), so a foreign or wrong-purpose id is indistinguishable
 * from a missing one — same reply, same code path.
 */
export async function findOwnedMediaImport(
  userId: string,
  id: unknown,
  purposes: readonly MediaImportPurpose[],
): Promise<{ ok: true; row: MediaImport } | { ok: false; failure: MediaImportFailure }> {
  if (typeof id !== "string" || !MEDIA_IMPORT_ID_PATTERN.test(id)) return { ok: false, failure: MEDIA_IMPORT_NOT_FOUND };
  const row = await prisma.mediaImport.findFirst({ where: { id, userId, purpose: { in: [...purposes] } } });
  return row ? { ok: true, row } : { ok: false, failure: MEDIA_IMPORT_NOT_FOUND };
}

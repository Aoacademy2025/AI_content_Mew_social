import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { MediaImport, McpUploadToken, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
import { MAX_BROLL_IMAGE_BYTES, MAX_BROLL_VIDEO_BYTES } from "@/lib/media-import/broll-pipeline";
import {
  ACTIVE_IMPORT_RETRY_SECONDS,
  IMPORT_QUEUE_DEADLINE_MS,
  MAX_ACTIVE_IMPORTS,
  MAX_ACTIVE_IMPORT_BYTES_PER_USER,
  MAX_IMPORT_BYTES_PER_DAY,
  MAX_IMPORT_BYTES_PER_HOUR,
  MAX_PRESENTER_IMPORT_BYTES,
  MAX_STAGED_IMPORT_BYTES,
} from "@/lib/media-import/limits";

export {
  IMPORT_QUEUE_DEADLINE_MS,
  MAX_ACTIVE_IMPORTS,
  MAX_ACTIVE_IMPORT_BYTES_PER_USER,
  MAX_IMPORT_BYTES_PER_DAY,
  MAX_IMPORT_BYTES_PER_HOUR,
  MAX_PRESENTER_IMPORT_BYTES,
  MAX_STAGED_IMPORT_BYTES,
};

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
 * stalled lane can never lock a user out. The disk itself is guarded by the free-space floor,
 * which the PUT's admission checks inside the same transaction (upload-staging.ts).
 *
 * Byte budgets (limits.ts): each import counts `bytes` — the declared Content-Length while an
 * upload streams in, then what was staged or fetched — or, while that is unknown, its purpose's
 * byte cap. Live imports count against the user's staging share and the global budget; ready and
 * live imports count against the user's rolling hour / 24 h budgets; failed or expired ones count
 * nowhere (their files are deleted).
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

// G25 — accepted by Mew 2026-10-03. Raised 2026-10-05 (HERO-69): a real 22-window video needed
// 22 upload links in one agent run and hit the old 10/hour link cap twice (two ~1h waits) — real
// demand, not waste. The old 30/hour import cap was the next wall, at two such videos an hour.
// The active-import cap and the byte budgets live in limits.ts (env-overridable).
export const MAX_IMPORTS_PER_HOUR = 60;
export const MAX_UPLOAD_LINKS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** G26: an upload link dies 15 minutes after it was issued. */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Watchdog bound for a row whose bytes are still streaming in (status "processing"). */
export const UPLOAD_RECEIVE_DEADLINE_MS = 15 * 60 * 1000;
/**
 * G23: wall-clock budget of an import once the lane claims it ("processing", set at claim by
 * lane.ts so a long queue wait cannot eat the fetch budget). Waiting in the queue ("pending")
 * has its own, longer IMPORT_QUEUE_DEADLINE_MS (limits.ts): a burst queues behind other users'.
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

export type AdmissionCode =
  | "too_many_active_imports"
  | "import_hourly_limit"
  | "upload_link_hourly_limit"
  | "active_import_bytes_limit"
  | "import_bytes_hourly_limit"
  | "import_bytes_daily_limit"
  | "storage_busy";

class AdmissionRefused extends Error {
  constructor(
    readonly code: AdmissionCode | "upload_link_invalid",
    /** HERO-69: seconds until the refusal is expected to clear — for a rolling-window cap, when
     *  enough of what it counts ages out of the window; for the active-import caps, a fixed hint
     *  (ACTIVE_IMPORT_RETRY_SECONDS). Unset for `storage_busy`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

/**
 * HERO-69: seconds until `oldest` (the earliest row still counted in the rolling window) ages
 * out of it — `ceil((oldest + window − now) / 1000)`, floored at 1. Since `oldest` is inside the
 * window by construction (`> now - window`), this is always in `[1, window]`.
 */
function retryAfterSecondsFor(oldest: Date, now: Date, windowMs = HOUR_MS): number {
  return Math.max(1, Math.ceil((oldest.getTime() + windowMs - now.getTime()) / 1000));
}

/** What one import counts for in the byte budgets: its known size, else its purpose's cap. */
function countedBytes(row: { purpose: string; bytes: number | null }): number {
  return row.bytes ?? PURPOSE_MAX_BYTES[row.purpose as MediaImportPurpose] ?? MAX_PRESENTER_IMPORT_BYTES;
}

/**
 * A rolling byte window over the user's ready/live imports: null when `reservation` more still
 * fits, else the seconds until enough of the oldest counted bytes leave the window for it to fit.
 */
function byteWindowRetry(
  rows: ReadonlyArray<{ createdAt: Date; counted: number }>,
  reservation: number,
  limit: number,
  windowMs: number,
  now: Date,
): number | null {
  const inWindow = rows.filter((row) => row.createdAt.getTime() > now.getTime() - windowMs);
  let excess = inWindow.reduce((sum, row) => sum + row.counted, 0) + reservation - limit;
  if (excess <= 0) return null;
  for (const row of [...inWindow].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    excess -= row.counted;
    if (excess <= 0) return retryAfterSecondsFor(row.createdAt, now, windowMs);
  }
  return Math.ceil(windowMs / 1000);
}

type CapacityOptions = {
  /** The row the caller already inserted in this transaction (write first) — never counts against itself. */
  excludeId?: string;
  /** Bytes this import reserves (a declared Content-Length); default its purpose's byte cap. */
  bytes?: number;
  /** The PUT: the staging disk must keep its free-space floor after this import AND every upload
   *  still streaming in or import being processed (plan follow-up 2). Throwing = cannot tell. */
  diskRoomFor?: (bytes: number) => boolean;
};

/**
 * Throws AdmissionRefused when one more import of `purpose` would break a G25 cap, a byte budget
 * (limits.ts) or the free-disk floor. Reads the user's own rows from the last 24 h (plus any older
 * one still live), then one grouped sum over every live import for the global budget.
 */
async function assertImportCapacity(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
  purpose: MediaImportPurpose,
  options: CapacityOptions = {},
): Promise<void> {
  const notSelf = options.excludeId ? { id: { not: options.excludeId } } : {};
  const reservation = options.bytes ?? PURPOSE_MAX_BYTES[purpose];
  const live = liveImportsWhere(now);

  // Two index range reads (an OR of both would scan every row the user ever had): the last 24 h,
  // and — normally none — rows created earlier that are somehow still live.
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const select = { status: true, purpose: true, bytes: true, createdAt: true, deadlineAt: true } as const;
  const mine = [
    ...await tx.mediaImport.findMany({ where: { userId, ...notSelf, createdAt: { gt: dayAgo } }, select }),
    // (userId, status) index: only the user's few live rows, of which the older ones are kept.
    ...(await tx.mediaImport.findMany({ where: { userId, ...notSelf, ...live }, select }))
      .filter((row) => row.createdAt.getTime() <= dayAgo.getTime()),
  ];
  const isLive = (row: (typeof mine)[number]) =>
    (MEDIA_IMPORT_ACTIVE_STATUSES as readonly string[]).includes(row.status) && row.deadlineAt.getTime() > now.getTime();
  const mineLive = mine.filter(isLive);

  if (mineLive.length >= MAX_ACTIVE_IMPORTS) throw new AdmissionRefused("too_many_active_imports", ACTIVE_IMPORT_RETRY_SECONDS);

  const lastHour = mine.filter((row) => row.createdAt.getTime() > now.getTime() - HOUR_MS);
  if (lastHour.length >= MAX_IMPORTS_PER_HOUR) {
    const oldest = lastHour.reduce((a, b) => (a.createdAt.getTime() <= b.createdAt.getTime() ? a : b));
    throw new AdmissionRefused("import_hourly_limit", retryAfterSecondsFor(oldest.createdAt, now));
  }

  // Follow-up 1: bytes over a rolling hour / 24 h (ready + live; failed and expired count 0).
  const counted = mine
    .filter((row) => row.status === "ready" || isLive(row))
    .map((row) => ({ createdAt: row.createdAt, counted: countedBytes(row) }));
  const hourRetry = byteWindowRetry(counted, reservation, MAX_IMPORT_BYTES_PER_HOUR, HOUR_MS, now);
  const dayRetry = byteWindowRetry(counted, reservation, MAX_IMPORT_BYTES_PER_DAY, DAY_MS, now);
  if (hourRetry !== null || dayRetry !== null) {
    throw (dayRetry ?? 0) > (hourRetry ?? 0)
      ? new AdmissionRefused("import_bytes_daily_limit", dayRetry!)
      : new AdmissionRefused("import_bytes_hourly_limit", hourRetry!);
  }

  // Follow-up 4: one user's live imports may hold at most their share of the staging budget.
  const mineLiveBytes = mineLive.reduce((sum, row) => sum + countedBytes(row), 0);
  if (mineLiveBytes + reservation > MAX_ACTIVE_IMPORT_BYTES_PER_USER) throw new AdmissionRefused("active_import_bytes_limit", ACTIVE_IMPORT_RETRY_SECONDS);

  const groups = await tx.mediaImport.groupBy({
    by: ["purpose", "status"],
    where: { ...notSelf, ...live },
    _count: { _all: true, bytes: true },
    _sum: { bytes: true },
  });
  let reserved = 0;
  let inFlight = 0;
  for (const group of groups) {
    const unknown = group._count._all - group._count.bytes;
    // An unknown purpose reserves the largest cap.
    const bytes = (group._sum.bytes ?? 0) + unknown * countedBytes({ purpose: group.purpose, bytes: null });
    reserved += bytes;
    // "processing" = bytes still streaming in, being fetched, or being written out by the lane.
    if (group.status === "processing") inFlight += bytes;
  }
  if (reserved + reservation > MAX_STAGED_IMPORT_BYTES) throw new AdmissionRefused("storage_busy");

  if (options.diskRoomFor) {
    let room = false;
    try {
      room = options.diskRoomFor(reservation + inFlight);
    } catch {
      room = false; // cannot tell → fail closed
    }
    if (!room) throw new AdmissionRefused("storage_busy");
  }
}

export const MAX_BATCH_UPLOAD_LINKS = 20;

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

export type IssuedUploadTokenBatch = {
  ok: true;
  items: IssuedUploadToken[];
  kind: UploadKind;
  issuedAt: Date;
  expiresAt: Date;
};

/**
 * `create_upload_url`'s admission + issue (G25/G26, EP5 #16 batch support). Refuses when the user
 * already asked for MAX_UPLOAD_LINKS_PER_HOUR links this hour (including the requested batch), or
 * when one more import would break the active / hourly import caps or the global staging budget.
 */
export async function issueUploadTokens(
  userId: string,
  kind: UploadKind,
  count = 1,
  now: Date = new Date(),
): Promise<IssuedUploadTokenBatch | { ok: false; code: AdmissionCode; retryAfterSeconds?: number }> {
  const n = Math.max(1, Math.min(MAX_BATCH_UPLOAD_LINKS, Math.trunc(count)));
  const expiresAt = new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS);
  try {
    const items = await withTransientSqliteRetry(() => prisma.$transaction(async (tx) => {
      const batchItems: IssuedUploadToken[] = Array.from({ length: n }, () => ({
        ok: true as const,
        token: UPLOAD_TOKEN_PREFIX + randomBytes(32).toString("base64url"),
        importId: randomUUID(),
        kind,
        issuedAt: now,
        expiresAt,
      }));
      // Write first: takes the writer lock (see the module comment).
      await tx.mcpUploadToken.createMany({
        data: batchItems.map((item) => ({
          tokenHash: hashUploadToken(item.token),
          userId,
          kind,
          issuedAt: now,
          importId: item.importId,
        })),
      });
      const linksWhere = { userId, issuedAt: { gt: new Date(now.getTime() - HOUR_MS) } };
      const linksThisHour = await tx.mcpUploadToken.count({ where: linksWhere });
      if (linksThisHour > MAX_UPLOAD_LINKS_PER_HOUR) {
        const oldest = await tx.mcpUploadToken.findFirst({ where: linksWhere, orderBy: { issuedAt: "asc" }, select: { issuedAt: true } });
        throw new AdmissionRefused("upload_link_hourly_limit", oldest ? retryAfterSecondsFor(oldest.issuedAt, now) : undefined);
      }
      await assertImportCapacity(tx, userId, now, UPLOAD_KIND_PURPOSE[kind]);
      return batchItems;
    }));
    return { ok: true, items, kind, issuedAt: now, expiresAt };
  } catch (error) {
    if (error instanceof AdmissionRefused && error.code !== "upload_link_invalid") {
      return { ok: false, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
    }
    throw error;
  }
}

export async function issueUploadToken(
  userId: string,
  kind: UploadKind,
  now: Date = new Date(),
): Promise<IssuedUploadToken | { ok: false; code: AdmissionCode; retryAfterSeconds?: number }> {
  const batch = await issueUploadTokens(userId, kind, 1, now);
  if (!batch.ok) return batch;
  return batch.items[0];
}

export type UrlImportAdmissionCode = Exclude<AdmissionCode, "upload_link_hourly_limit">;

/**
 * `replace_broll_window(url)`'s admission (T13, G23/G25): queue a url B-roll import for the
 * import lane — "pending", queue deadline (the lane resets it to IMPORT_DEADLINE_MS when it
 * claims the row). Its size is unknown until fetched, so it reserves its purpose's byte cap.
 * Queued as broll_video (the lane accepts an image or a video and records what the bytes were),
 * or as presenter for a create_video_job clip (T14: video only, T9's presenter checks).
 * The url is only stored for the lane's guarded fetch (G23 is enforced there, at connect time)
 * and is cleared when the import finishes. Same caps and budget as an upload, counted in one
 * write-first transaction (see the module comment).
 */
export async function createUrlImport(
  userId: string,
  sourceUrl: string,
  now: Date = new Date(),
  /** T14: "presenter" for create_video_job's clipUrl (the lane then applies T9's presenter
   *  checks); B-roll links keep the default. */
  purpose: "broll_video" | "presenter" = "broll_video",
): Promise<{ ok: true; importId: string } | { ok: false; code: UrlImportAdmissionCode; retryAfterSeconds?: number }> {
  try {
    const importId = await withTransientSqliteRetry(() => prisma.$transaction(async (tx) => {
      const id = randomUUID();
      // Write first: takes the writer lock; the capacity check then excludes this row.
      await tx.mediaImport.create({
        data: {
          id,
          userId,
          purpose,
          source: "url",
          status: "pending",
          sourceUrl,
          deadlineAt: new Date(now.getTime() + IMPORT_QUEUE_DEADLINE_MS),
        },
      });
      await assertImportCapacity(tx, userId, now, purpose, { excludeId: id });
      return id;
    }));
    return { ok: true, importId };
  } catch (error) {
    if (error instanceof AdmissionRefused && error.code !== "upload_link_invalid" && error.code !== "upload_link_hourly_limit") {
      return { ok: false, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
    }
    throw error;
  }
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
 * "processing" — atomically, and only when the G25 import caps, the byte budgets and (when
 * `diskRoomFor` is given) the free-disk floor still allow it. A refused admission rolls back, so
 * the link stays usable for a retry within its 15 minutes.
 *
 * `declaredBytes` (a valid Content-Length within the kind's cap) is what the upload reserves and
 * is recorded on the row; without it the upload reserves the kind's cap. The route then stages
 * at most that many bytes.
 */
export async function admitUpload(
  link: McpUploadToken,
  now: Date = new Date(),
  options: { declaredBytes?: number; diskRoomFor?: (bytes: number) => boolean } = {},
): Promise<AdmittedUpload | { ok: false; code: AdmissionCode | "upload_link_invalid"; retryAfterSeconds?: number }> {
  if (!isUploadKind(link.kind)) return { ok: false, code: "upload_link_invalid" };
  const kind = link.kind;
  const purpose = UPLOAD_KIND_PURPOSE[kind];
  const declared = options.declaredBytes;
  const declaredBytes = declared !== undefined && Number.isSafeInteger(declared) && declared > 0 && declared <= UPLOAD_KIND_MAX_BYTES[kind]
    ? declared
    : undefined;
  try {
    await withTransientSqliteRetry(() => prisma.$transaction(async (tx) => {
      // Write first (writer lock), and the conditional write IS the single-use guarantee:
      // of two racing PUTs, only one can move usedAt from null.
      const consumed = await tx.mcpUploadToken.updateMany({
        where: { id: link.id, usedAt: null, issuedAt: { gt: new Date(now.getTime() - UPLOAD_TOKEN_TTL_MS) } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AdmissionRefused("upload_link_invalid");
      await assertImportCapacity(tx, link.userId, now, purpose, { bytes: declaredBytes, diskRoomFor: options.diskRoomFor });
      await tx.mediaImport.create({
        data: {
          id: link.importId,
          userId: link.userId,
          purpose,
          source: "upload",
          status: "processing",
          bytes: declaredBytes ?? null,
          deadlineAt: new Date(now.getTime() + UPLOAD_RECEIVE_DEADLINE_MS),
        },
      });
    }));
  } catch (error) {
    if (error instanceof AdmissionRefused) return { ok: false, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
    throw error;
  }
  return { ok: true, importId: link.importId, userId: link.userId, kind, purpose, maxBytes: declaredBytes ?? UPLOAD_KIND_MAX_BYTES[kind] };
}

/**
 * Bytes fully staged: record how many, and hand the row to the import lane ("pending", queue
 * deadline). False when the row is no longer "processing" (e.g. the watchdog already failed
 * it) — the caller then discards the staged file.
 */
export async function markUploadStaged(importId: string, bytes: number, now: Date = new Date()): Promise<boolean> {
  const moved = await prisma.mediaImport.updateMany({
    where: { id: importId, status: "processing", source: "upload" },
    data: { status: "pending", bytes, deadlineAt: new Date(now.getTime() + IMPORT_QUEUE_DEADLINE_MS) },
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

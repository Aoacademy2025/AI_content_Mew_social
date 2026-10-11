/**
 * Media Import capacity limits (plan docs/plans/2026-10-03-mcp-edit-before-export.md, "Before
 * flipping MCP_EDITOR_PROJECT_PUBLIC" follow-ups 1, 2 and 4; EP5 backlog #16). Enforced in the DB
 * admission (imports.ts) for create_upload_url, the upload PUT and url imports.
 *
 * Every limit can be overridden with the environment variable named beside it (whole bytes /
 * milliseconds / a count). A value that is missing, not a plain whole number, or below the
 * limit's floor falls back to the default — fail closed: a typo never lifts a limit, and never
 * sets one so low that a valid file could not be imported at all. Read once, at module load
 * (a restart with --update-env applies a change).
 *
 * Pure module (no Prisma, no ffmpeg) so the MCP instructions (onboarding.ts) quote the live
 * numbers.
 */

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE_MS = 60_000;

/** Presenter clip limit — the same 500 MB as the web upload (/api/videos/upload-avatar, G22). The
 *  largest single file Media Import accepts, so every byte budget is at least this. */
export const MAX_PRESENTER_IMPORT_BYTES = 500 * MIB;

function envWhole(name: string, fallback: number, floor: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= floor ? value : fallback;
}

/**
 * Imports one user may have pending/processing at once (`MEDIA_IMPORT_MAX_ACTIVE_PER_USER`).
 * Was 3: an agent filling 9 windows got 429 `too_many_active_imports` on its 4th and 8th PUT and
 * had to back off (EP5 backlog #16). 25 lets one agent upload a whole video's windows in a burst;
 * the bytes those imports may hold are bounded by MAX_ACTIVE_IMPORT_BYTES_PER_USER, not this count.
 */
export const MAX_ACTIVE_IMPORTS = envWhole("MEDIA_IMPORT_MAX_ACTIVE_PER_USER", 25, 1);

/**
 * Bytes one user may import in any rolling hour (`MEDIA_IMPORT_USER_BYTES_PER_HOUR`) and any
 * rolling 24 hours (`MEDIA_IMPORT_USER_BYTES_PER_DAY`), counted over every import created in the
 * window that is ready or still live (follow-up 1: one user could otherwise import about 15 GB/h
 * and drive the disk down to the free-disk floor).
 */
export const MAX_IMPORT_BYTES_PER_HOUR = envWhole("MEDIA_IMPORT_USER_BYTES_PER_HOUR", 2 * GIB, MAX_PRESENTER_IMPORT_BYTES);
export const MAX_IMPORT_BYTES_PER_DAY = envWhole("MEDIA_IMPORT_USER_BYTES_PER_DAY", 5 * GIB, MAX_PRESENTER_IMPORT_BYTES);

/**
 * Global staging budget, all users (`MEDIA_IMPORT_STAGING_BUDGET_BYTES`): every live import
 * reserves its size (or its purpose's cap while unknown); one more is admitted only while the sum
 * stays within this. Bounds what can be parked on the disk prod SQLite shares (security review A1)
 * — the free-disk floor (upload-staging.ts, 5 GiB) still guards the disk itself. Was 10 GiB; 15
 * GiB (~a fifth of the ~70 GB free on prod) so it takes ten accounts at their full share to fill.
 */
export const MAX_STAGED_IMPORT_BYTES = envWhole("MEDIA_IMPORT_STAGING_BUDGET_BYTES", 15 * GIB, MAX_PRESENTER_IMPORT_BYTES);

/**
 * One user's share of the global staging budget (`MEDIA_IMPORT_USER_STAGING_SHARE_BYTES`, never
 * more than the budget itself): the bytes of their pending/processing imports — each counted at
 * its known size, or at its purpose's byte cap while the size is unknown — may not pass this
 * (follow-up 4: a few accounts could fill the budget and lock everyone out). 1.5 GiB = three
 * presenter clips, so the three in-flight create_video_job({clipUrl}) jobs a user may run still
 * import at once — and exactly what one user could hold under the old 3-active-import cap.
 */
export const MAX_ACTIVE_IMPORT_BYTES_PER_USER = Math.min(
  envWhole("MEDIA_IMPORT_USER_STAGING_SHARE_BYTES", 1536 * MIB, MAX_PRESENTER_IMPORT_BYTES),
  MAX_STAGED_IMPORT_BYTES,
);

/**
 * How long a queued import ("pending") may wait for the import lane before the watchdog fails it
 * (`MEDIA_IMPORT_QUEUE_DEADLINE_MS`). Was the 10-minute processing budget; a burst of 25 queued
 * behind other users' bursts (one lane slot per user) needs longer. The lane still resets the
 * deadline to IMPORT_DEADLINE_MS when it claims the row. Never shorter than that budget.
 */
export const IMPORT_QUEUE_DEADLINE_MS = envWhole("MEDIA_IMPORT_QUEUE_DEADLINE_MS", 30 * MINUTE_MS, 10 * MINUTE_MS);

/**
 * `retryAfterSeconds` for refusals that clear when the user's own imports finish (count or bytes
 * of active imports). A hint, not a limit: the lane finishes a typical B-roll import in seconds.
 */
export const ACTIVE_IMPORT_RETRY_SECONDS = 30;

/** "2 GB" / "1.5 GB" / "500 MB" — binary units, labelled the way the size caps already are. */
export function formatImportBytes(bytes: number): string {
  if (bytes >= GIB) {
    const gib = bytes / GIB;
    return `${Number.isInteger(gib) ? gib : Math.floor(gib * 10) / 10} GB`;
  }
  return `${Math.floor(bytes / MIB)} MB`;
}

import fs from "node:fs";
import path from "node:path";
import type { MediaImport } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { normalizedMarkerPath } from "@/lib/broll-asset-lib";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
import { MAX_BROLL_IMAGE_BYTES, MAX_BROLL_VIDEO_BYTES } from "@/lib/media-import/broll-pipeline";
import { presenterUploadDir } from "@/lib/media-import/presenter-checks";
import {
  MEDIA_FETCH_DEADLINE_MS,
  MEDIA_FETCH_ERROR_CODES,
  fetchMediaToTempFile,
  mediaImportTempDir,
  sweepStaleImportTemp,
  type FetchedMedia,
  type MediaFetchOptions,
} from "@/lib/media-import/fetch";
import {
  IMPORT_DEADLINE_MS,
  MAX_PRESENTER_IMPORT_BYTES,
  MEDIA_IMPORT_ACTIVE_STATUSES,
  MEDIA_IMPORT_PURPOSES,
  failMediaImport,
  type MediaImportPurpose,
} from "@/lib/media-import/imports";
import {
  mediaImportStagingDir,
  processStagedUpload,
  removeStagedUpload,
  stageFetchedFile,
} from "@/lib/media-import/upload-staging";

/**
 * The Media Import lane (Task 12, PR-B — plan docs/plans/2026-10-03-mcp-edit-before-export.md
 * G23/G24/G25, ADR 0065). It runs inside mcp-video-worker next to the video-job loop, with its
 * own slots: a slow import never holds a video-job slot and a long render never holds an
 * import slot. The one thing they share is T9's process-wide normalize semaphore (B-roll video
 * re-encode, concurrency 1, FIFO): an import can wait behind a video job's B-roll normalize and
 * vice versa — a bounded delay, never a starvation, and the import's deadline still applies.
 *
 * Claiming (G25 fair share): the oldest `pending` row of each user is a candidate; users that
 * already have an import in the lane are skipped (one lane slot per user, so one user can never
 * hold both slots); the remaining users are served least-recently-served first, ties broken by
 * the oldest row. The claim itself is one conditional UPDATE (`status = pending AND deadlineAt >
 * now`), so two processes never claim the same row, and a row past its deadline is never
 * claimed (security review F3) — the watchdog owns it. The per-user slot rule is exact inside
 * one process and best-effort across processes (prod runs one mcp-video-worker).
 *
 * Deadlines: the queue wait is bounded by the `deadlineAt` set when the import was queued; the
 * claim resets it to now + IMPORT_DEADLINE_MS (T11 review A4) and the fetch gets what is left.
 * The watchdog fails every pending/processing row past its deadline — including rows orphaned
 * by a worker restart — and deletes their staged file. A result that lands after the deadline
 * is never marked ready: its output is deleted and the row fails `fetch_timeout`.
 *
 * Files: the staged file (`<tmpdir>/heroai-media-import/<id>.upload`) and any download temp
 * file are deleted on every terminal path; the sweeps at worker start and on every watchdog
 * pass remove what a crash left behind.
 *
 * Rows and logs carry only fixed error codes and ids — never an upstream error text, an IP, a
 * path or the agent's URL. The URL is cleared from the row once the import is finished.
 */

/** G25: imports processed at once, separate from the video-job slots. */
export const MEDIA_IMPORT_LANE_CONCURRENCY = 2;
/** At most one of the lane's slots per user — another user's import always gets a turn. */
export const MAX_LANE_SLOTS_PER_USER = 1;
const CLAIM_SCAN_LIMIT = 200;
const DEFAULT_POLL_MS = 4_000;
const DEFAULT_WATCHDOG_MS = 60_000;
const WATCHDOG_BATCH = 500;
/** A download temp file untouched for this long belongs to no live fetch (deadline 10 min). */
const STALE_TEMP_MS = 2 * MEDIA_FETCH_DEADLINE_MS;
/** Upload links are dead 15 min after issue; their rows are kept a day, then pruned. */
const UPLOAD_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
const TOKEN_PRUNE_EVERY_MS = 60 * 60 * 1000;
const SERVED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Every errorCode the lane may write: G23 fetch codes, T11 staging codes, T9 pipeline codes. */
export const MEDIA_IMPORT_LANE_ERROR_CODES = [
  ...MEDIA_FETCH_ERROR_CODES,
  "upload_missing",
  "upload_incomplete",
  "upload_failed",
  "unsupported_type",
  "empty_file",
  "payload_too_large",
  "process_failed",
  "normalize_failed",
  "probe_failed",
  "not_portrait",
  "too_large_dimensions",
  "duration_exceeded",
] as const;
export type MediaImportLaneErrorCode = (typeof MEDIA_IMPORT_LANE_ERROR_CODES)[number];
const LANE_CODES: ReadonlySet<string> = new Set(MEDIA_IMPORT_LANE_ERROR_CODES);
const FETCH_CODES: ReadonlySet<string> = new Set(MEDIA_FETCH_ERROR_CODES);

/** What each purpose may fetch — the same kind and byte cap as its web upload (G22). */
const FETCH_ACCEPT: Record<MediaImportPurpose, MediaFetchOptions["accept"]> = {
  broll_image: { image: MAX_BROLL_IMAGE_BYTES },
  broll_video: { video: MAX_BROLL_VIDEO_BYTES },
  presenter: { video: MAX_PRESENTER_IMPORT_BYTES },
};

export type MediaImportFetch = (url: string, options: MediaFetchOptions) => Promise<FetchedMedia>;
export type MediaImportLaneLog = { info: (line: string) => void; error: (line: string) => void };

const consoleLog: MediaImportLaneLog = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
}

function isPurpose(value: string): value is MediaImportPurpose {
  return (MEDIA_IMPORT_PURPOSES as readonly string[]).includes(value);
}

function isPrivateDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    return stat.isDirectory() && (uid === null || stat.uid === uid);
  } catch {
    return false;
  }
}

// ── claim ──────────────────────────────────────────────────────────────────────────────────

/**
 * Claim the next import, fair-share across users (see the module comment). Returns the
 * claimed row (now `processing`, `claimedAt` = now, `deadlineAt` = now + 10 min) or null.
 */
export async function claimNextMediaImport(now: Date = new Date()): Promise<MediaImport | null> {
  const pending = await prisma.mediaImport.findMany({
    where: { status: "pending", deadlineAt: { gt: now } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CLAIM_SCAN_LIMIT,
    select: { id: true, userId: true, createdAt: true },
  });
  if (pending.length === 0) return null;

  const oldestByUser = new Map<string, { id: string; createdAt: Date }>();
  for (const row of pending) if (!oldestByUser.has(row.userId)) oldestByUser.set(row.userId, row);
  const userIds = [...oldestByUser.keys()];

  const inLane = await prisma.mediaImport.groupBy({
    by: ["userId"],
    where: { userId: { in: userIds }, status: "processing", claimedAt: { not: null }, deadlineAt: { gt: now } },
    _count: { _all: true },
  });
  const slotsHeld = new Map(inLane.map((r) => [r.userId, r._count._all]));
  const served = await prisma.mediaImport.groupBy({
    by: ["userId"],
    where: {
      userId: { in: userIds },
      createdAt: { gt: new Date(now.getTime() - SERVED_LOOKBACK_MS) },
      claimedAt: { not: null },
    },
    _max: { claimedAt: true },
  });
  const lastServed = new Map(served.map((r) => [r.userId, r._max.claimedAt?.getTime() ?? 0]));

  const candidates = userIds
    .filter((userId) => (slotsHeld.get(userId) ?? 0) < MAX_LANE_SLOTS_PER_USER)
    .sort((a, b) =>
      (lastServed.get(a) ?? 0) - (lastServed.get(b) ?? 0)
      || oldestByUser.get(a)!.createdAt.getTime() - oldestByUser.get(b)!.createdAt.getTime());

  for (const userId of candidates) {
    const { id } = oldestByUser.get(userId)!;
    const claimed = await withTransientSqliteRetry(() => prisma.mediaImport.updateMany({
      where: { id, status: "pending", deadlineAt: { gt: now } },
      data: { status: "processing", claimedAt: now, deadlineAt: new Date(now.getTime() + IMPORT_DEADLINE_MS) },
    }));
    if (claimed.count === 1) return prisma.mediaImport.findUnique({ where: { id } });
  }
  return null;
}

// ── process ────────────────────────────────────────────────────────────────────────────────

/** Delete an output the lane produced but may not publish (its row expired meanwhile). */
function removeOutput(resultSrc: string, stocksDir: string): void {
  const name = path.basename(resultSrc);
  const dir = resultSrc.startsWith("/api/renders/") ? presenterUploadDir() : stocksDir;
  const file = path.join(dir, name);
  for (const target of [file, normalizedMarkerPath(file)]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // best-effort
    }
  }
}

type ProcessDeps = {
  fetchMedia: MediaImportFetch;
  processStaged: typeof processStagedUpload;
  stocksDir: string;
  log: MediaImportLaneLog;
};

async function processClaimedImport(row: MediaImport, deps: ProcessDeps): Promise<void> {
  let stage: "fetch" | "process" = "process";
  let fetchedPath: string | null = null;
  let code: MediaImportLaneErrorCode | null = null;
  let failure = "";
  try {
    if (!isPurpose(row.purpose) || (row.source !== "url" && row.source !== "upload")) {
      code = "unsupported_media";
    } else {
      if (row.source === "url") {
        stage = "fetch";
        const remainingMs = row.deadlineAt.getTime() - Date.now();
        if (remainingMs <= 0) {
          code = "fetch_timeout";
        } else {
          const fetched = await deps.fetchMedia(row.sourceUrl ?? "", {
            accept: FETCH_ACCEPT[row.purpose],
            deadlineMs: Math.min(remainingMs, MEDIA_FETCH_DEADLINE_MS),
          });
          fetchedPath = fetched.path;
          stage = "process";
          stageFetchedFile(row.id, fetched.path);
          fetchedPath = null;
        }
      }

      // The watchdog may have failed the row while it was downloading: do no more work.
      if (!code) {
        const live = await prisma.mediaImport.count({
          where: { id: row.id, status: "processing", deadlineAt: { gt: new Date() } },
        });
        if (live !== 1) code = "fetch_timeout";
      }

      if (!code) {
        const user = await prisma.user.findUnique({ where: { id: row.userId } });
        const plan = user ? classifyEntitlement(user).effectivePlan : "FREE";
        const result = await deps.processStaged({ importId: row.id, purpose: row.purpose, plan, stocksDir: deps.stocksDir });
        if (!result.ok) {
          code = LANE_CODES.has(result.errorCode) ? (result.errorCode as MediaImportLaneErrorCode) : "process_failed";
        } else {
          let published = false;
          try {
            const done = await withTransientSqliteRetry(() => prisma.mediaImport.updateMany({
              where: { id: row.id, status: "processing", deadlineAt: { gt: new Date() } },
              data: { status: "ready", resultSrc: result.resultSrc, durationMs: result.durationMs, errorCode: null, sourceUrl: null },
            }));
            published = done.count === 1;
          } finally {
            if (!published) removeOutput(result.resultSrc, deps.stocksDir);
          }
          if (!published) code = "fetch_timeout";
        }
      }
    }
  } catch (error) {
    const raw = (error as { code?: unknown } | null)?.code;
    code = stage === "fetch"
      ? (typeof raw === "string" && FETCH_CODES.has(raw) ? (raw as MediaImportLaneErrorCode) : "fetch_failed")
      : "process_failed";
    if (code === "fetch_failed" || code === "process_failed") failure = ` (${errorName(error)})`;
  } finally {
    removeStagedUpload(row.id);
    if (fetchedPath) {
      try {
        fs.rmSync(fetchedPath, { force: true });
      } catch {
        // swept later
      }
    }
  }

  if (code) {
    try {
      await withTransientSqliteRetry(() => failMediaImport(row.id, code!));
    } catch (error) {
      // The watchdog fails it at its deadline.
      deps.log.error(`[media-import] ${row.id} could not be marked failed (${errorName(error)})`);
    }
    // An unexpected throw is ours to look at; every other code is about the agent's media.
    const line = `[media-import] ${row.id} failed ${code}${failure}`;
    if (failure) deps.log.error(line);
    else deps.log.info(line);
  } else {
    deps.log.info(`[media-import] ${row.id} ready`);
  }
}

// ── watchdog + sweeps ──────────────────────────────────────────────────────────────────────

/**
 * Fail every pending/processing import past its deadline and delete its staged file. A row
 * whose bytes were still streaming in (upload never finished) fails `upload_incomplete`; any
 * other expired row — queued too long, or claimed by a lane that died or ran out of time —
 * fails `fetch_timeout`. Each update is conditional, so a row that finished meanwhile is kept.
 */
export async function runMediaImportWatchdog(now: Date = new Date()): Promise<{ failed: number }> {
  const expired = await prisma.mediaImport.findMany({
    where: { status: { in: [...MEDIA_IMPORT_ACTIVE_STATUSES] }, deadlineAt: { lte: now } },
    select: { id: true, status: true, source: true, claimedAt: true },
    orderBy: { deadlineAt: "asc" },
    take: WATCHDOG_BATCH,
  });
  let failed = 0;
  for (const row of expired) {
    const errorCode = row.status === "processing" && row.source === "upload" && !row.claimedAt
      ? "upload_incomplete"
      : "fetch_timeout";
    const result = await withTransientSqliteRetry(() => prisma.mediaImport.updateMany({
      where: { id: row.id, status: { in: [...MEDIA_IMPORT_ACTIVE_STATUSES] }, deadlineAt: { lte: now } },
      data: { status: "failed", errorCode, sourceUrl: null },
    }));
    if (result.count === 1) {
      failed += 1;
      removeStagedUpload(row.id);
    }
  }
  return { failed };
}

const STAGED_FILE = /^([A-Za-z0-9_-]{1,64})\.upload$/;

/**
 * Remove what a crash left behind: download temp files untouched for 2 × the fetch deadline
 * (T10 review A1), and staged files whose import is no longer live (T11 review A3). A staged
 * file always has its row committed first (T11 creates the row, then the file), so "no live
 * row" means nobody will ever read it. Neither directory is swept when it is a symlink or not
 * ours, and only regular files with the module's own name pattern are touched.
 */
export async function sweepMediaImportFiles(): Promise<{ tempRemoved: number; stagedRemoved: number }> {
  const tempDir = mediaImportTempDir();
  const tempRemoved = isPrivateDir(tempDir) ? sweepStaleImportTemp(STALE_TEMP_MS, tempDir) : 0;

  let stagedRemoved = 0;
  const stagingDir = mediaImportStagingDir();
  if (isPrivateDir(stagingDir)) {
    const staged = new Map<string, string>();
    for (const name of fs.readdirSync(stagingDir)) {
      const match = STAGED_FILE.exec(name);
      if (match) staged.set(match[1], name);
    }
    if (staged.size > 0) {
      const live = new Set<string>();
      const ids = [...staged.keys()];
      for (let i = 0; i < ids.length; i += 500) {
        const rows = await prisma.mediaImport.findMany({
          where: { id: { in: ids.slice(i, i + 500) }, status: { in: [...MEDIA_IMPORT_ACTIVE_STATUSES] } },
          select: { id: true },
        });
        for (const row of rows) live.add(row.id);
      }
      for (const [id, name] of staged) {
        if (live.has(id)) continue;
        const full = path.join(stagingDir, name);
        try {
          if (!fs.lstatSync(full).isFile()) continue;
          fs.unlinkSync(full);
          stagedRemoved += 1;
        } catch {
          // gone already
        }
      }
    }
  }
  return { tempRemoved, stagedRemoved };
}

/** Delete upload-link rows older than a day (T11 security review §5: nothing else deletes them). */
export async function pruneUploadTokens(now: Date = new Date()): Promise<number> {
  const result = await prisma.mcpUploadToken.deleteMany({
    where: { issuedAt: { lt: new Date(now.getTime() - UPLOAD_TOKEN_RETENTION_MS) } },
  });
  return result.count;
}

// ── the lane ───────────────────────────────────────────────────────────────────────────────

export type MediaImportLaneOptions = {
  concurrency?: number;
  pollMs?: number;
  watchdogMs?: number;
  /** Tests only: the production lane always fetches through T10's G23 guard. */
  fetchMedia?: MediaImportFetch;
  /** Tests only: wraps T11's `processStagedUpload` (the production lane always calls it as is). */
  processStaged?: typeof processStagedUpload;
  /** Tests only: where B-roll output goes (default `<cwd>/stocks`, as the web upload). */
  stocksDir?: string;
  log?: MediaImportLaneLog;
};

export type MediaImportLane = {
  /** Start the claim loop and the watchdog loop. Returns at once. */
  start(): void;
  /** Stop claiming, then wait for in-flight imports to finish. Idempotent. */
  stop(): Promise<void>;
  /** Imports currently being processed. */
  readonly inFlight: number;
};

export function createMediaImportLane(options: MediaImportLaneOptions = {}): MediaImportLane {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? MEDIA_IMPORT_LANE_CONCURRENCY));
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const watchdogMs = Math.max(10, options.watchdogMs ?? DEFAULT_WATCHDOG_MS);
  const deps: ProcessDeps = {
    fetchMedia: options.fetchMedia ?? fetchMediaToTempFile,
    processStaged: options.processStaged ?? processStagedUpload,
    stocksDir: options.stocksDir ?? path.join(process.cwd(), "stocks"),
    log: options.log ?? consoleLog,
  };
  const log = deps.log;
  const active = new Set<Promise<void>>();
  const wakers = new Set<() => void>();
  let running = false;
  let loops: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let lastTokenPrune = 0;

  const pause = (ms: number) => new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });
  const waitForSlot = () => new Promise<void>((resolve) => {
    const done = () => {
      wakers.delete(done);
      resolve();
    };
    wakers.add(done);
    void Promise.race(active).then(done, done);
  });

  async function claimLoop(): Promise<void> {
    while (running) {
      try {
        while (running && active.size < concurrency) {
          const row = await claimNextMediaImport();
          if (!row) break;
          const job: Promise<void> = processClaimedImport(row, deps)
            .catch((error) => log.error(`[media-import] ${row.id} lane error (${errorName(error)})`))
            .finally(() => active.delete(job));
          active.add(job);
        }
      } catch (error) {
        log.error(`[media-import] claim failed (${errorName(error)})`);
      }
      if (!running) break;
      if (active.size >= concurrency) await waitForSlot();
      else await pause(pollMs);
    }
  }

  async function watchdogLoop(): Promise<void> {
    while (running) {
      try {
        const { failed } = await runMediaImportWatchdog();
        if (failed > 0) log.info(`[media-import] watchdog failed ${failed} expired import(s)`);
        const swept = await sweepMediaImportFiles();
        if (swept.tempRemoved + swept.stagedRemoved > 0) {
          log.info(`[media-import] swept ${swept.tempRemoved} temp / ${swept.stagedRemoved} staged file(s)`);
        }
        if (Date.now() - lastTokenPrune >= TOKEN_PRUNE_EVERY_MS) {
          lastTokenPrune = Date.now();
          await pruneUploadTokens();
        }
      } catch (error) {
        log.error(`[media-import] watchdog failed (${errorName(error)})`);
      }
      if (!running) break;
      await pause(watchdogMs);
    }
  }

  return {
    start() {
      if (running || stopping) return;
      running = true;
      loops = Promise.all([claimLoop(), watchdogLoop()]).then(() => undefined);
    },
    stop() {
      if (stopping) return stopping;
      running = false;
      for (const wake of [...wakers]) wake();
      stopping = (async () => {
        await loops;
        await Promise.allSettled([...active]);
      })();
      return stopping;
    },
    get inFlight() {
      return active.size;
    },
  };
}

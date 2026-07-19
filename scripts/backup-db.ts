// Daily SQLite backup (STAB-3). Team tsx-cron pattern — run manually or via the
// `db-backup` PM2 cron (ecosystem.config.js, 02:00 daily, BEFORE the 03:00 cleanup).
//
// What it does:
//   1. Snapshots the live DB with `sqlite3 <db> "VACUUM INTO <dest>"`. VACUUM INTO reads
//      a consistent snapshot under a read transaction (WAL-safe: it captures committed
//      WAL frames, and under WAL a reader does NOT block writers), and writes a single,
//      self-contained, compacted rollback-mode file — no -wal/-shm sidecars to ship
//      off-box (unlike `.backup`, whose copy inherits WAL mode + stray sidecars).
//   2. Writes to $BACKUP_DIR/dev-<YYYY-MM-DD>.db (default /var/backups/heroai).
//   3. Prunes backups older than $BACKUP_RETENTION_DAYS (default 14).
//   4. If $BACKUP_RSYNC_TARGET is set, rsyncs the fresh snapshot off-box; if unset it
//      logs that off-box is NOT configured and skips (local backup still succeeds).
//
// RUN (local):  npx tsx scripts/backup-db.ts
//   Override for a safe local test:
//     BACKUP_DIR=/tmp/heroai-bak DATABASE_URL="file:./dev.db" npx tsx scripts/backup-db.ts
//
// RUN (prod, inside /var/www/ai-content — prod .env supplies the absolute DATABASE_URL):
//   npx tsx scripts/backup-db.ts
//
// RESTORE (from a snapshot — do off-peak; the app should be stopped or quiesced):
//   pm2 stop ai-content render-worker mcp-video-worker
//   cp /var/backups/heroai/dev-<date>.db /var/www/ai-content/prisma/dev.db
//   rm -f /var/www/ai-content/prisma/dev.db-wal /var/www/ai-content/prisma/dev.db-shm
//   pm2 start ai-content render-worker mcp-video-worker   # or: bash deploy/deploy.sh
//   (The snapshot is a self-contained DB with no WAL sidecar — removing any stale
//    -wal/-shm from the OLD db before swapping avoids a mismatched sidecar.)
//
// Exit codes: 0 = ok · 1 = backup failed (no valid snapshot written) · 2 = snapshot
// written OK but a CONFIGURED off-box rsync failed (surfaced loud for the logs/watchdog).
import "dotenv/config";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const BACKUP_DIR = (process.env.BACKUP_DIR || "/var/backups/heroai").trim();
const RSYNC_TARGET = (process.env.BACKUP_RSYNC_TARGET || "").trim();
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);
const BUSY_TIMEOUT_MS = 10000; // wait out a busy writer instead of erroring
const PREFIX = "dev-";
const SUFFIX = ".db";

function stamp(): string {
  return new Date().toISOString();
}
function log(msg: string): void {
  console.log(`[backup-db] ${stamp()} ${msg}`);
}
function warn(msg: string): void {
  console.warn(`[backup-db] ${stamp()} WARN ${msg}`);
}
function fail(msg: string): never {
  console.error(`[backup-db] ${stamp()} ERROR ${msg}`);
  process.exit(1);
}

// True if a command exists on PATH (portable — `command -v` is a POSIX builtin).
function haveCmd(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Resolve the on-disk DB path from DATABASE_URL.
// - `file:` / `file://` prefix stripped, query string dropped.
// - Absolute paths used as-is (prod: file:/var/www/ai-content/prisma/dev.db).
// - Relative paths resolved against the prisma/ dir, matching how Prisma resolves
//   relative SQLite URLs (relative to schema.prisma's dir), so local
//   `file:./dev.db` correctly points at prisma/dev.db regardless of cwd.
function resolveDbPath(): string {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set — cannot locate the DB to back up");
  let raw = url;
  if (raw.startsWith("file://")) raw = raw.slice("file://".length);
  else if (raw.startsWith("file:")) raw = raw.slice("file:".length);
  raw = raw.split("?")[0];
  if (path.isAbsolute(raw)) return raw;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  return path.resolve(repoRoot, "prisma", raw);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Remove a DB file plus any stray SQLite sidecars (defensive — VACUUM INTO produces
// none, but never leave orphans behind a discarded/partial file).
function rmDbFile(p: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(`${p}${suffix}`, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// Snapshot dbPath -> dest via VACUUM INTO, then integrity-gate the copy and only rename
// it into place if it is a valid, readable DB (atomic-ish: a partial or corrupt copy
// never replaces a good prior snapshot of the same day).
function runBackup(dbPath: string, dest: string): void {
  const tmp = `${dest}.partial`;
  rmDbFile(tmp); // clear any leftover partial from a prior interrupted run
  // .timeout waits out a busy writer instead of erroring; VACUUM INTO fails if dest exists.
  execFileSync(
    "sqlite3",
    ["-cmd", `.timeout ${BUSY_TIMEOUT_MS}`, dbPath, `VACUUM INTO '${tmp}';`],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const check = execFileSync("sqlite3", [tmp, "PRAGMA quick_check;"], {
    encoding: "utf8",
  }).trim();
  if (check !== "ok") {
    rmDbFile(tmp);
    fail(`backup integrity check failed (${check}) — snapshot discarded`);
  }
  fs.renameSync(tmp, dest);
}

// Delete our own snapshots older than the retention window. Only touches files that
// match the dev-*.db naming so unrelated files in BACKUP_DIR are never removed.
function prune(): number {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const full = path.join(BACKUP_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed++;
        log(`pruned old backup ${name}`);
      }
    } catch (e) {
      warn(`could not prune ${name}: ${(e as Error).message}`);
    }
  }
  return removed;
}

// Copy the fresh snapshot off-box. Returns true if not-configured (skip) or success;
// false only if a CONFIGURED target failed (caller surfaces that loudly).
function offbox(dest: string): boolean {
  if (!RSYNC_TARGET) {
    log("BACKUP_RSYNC_TARGET not set — off-box copy NOT configured (local backup only)");
    return true;
  }
  if (!haveCmd("rsync")) {
    warn("rsync not found on PATH — cannot copy off-box (install with: apt-get install -y rsync)");
    return false;
  }
  try {
    execFileSync("rsync", ["-az", dest, RSYNC_TARGET], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    log(`off-box copy sent -> ${RSYNC_TARGET}`);
    return true;
  } catch (e) {
    warn(`off-box rsync FAILED (local snapshot is safe): ${(e as Error).message}`);
    return false;
  }
}

function main(): void {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    fail(`BACKUP_RETENTION_DAYS must be a positive number (got "${process.env.BACKUP_RETENTION_DAYS}")`);
  }
  if (!haveCmd("sqlite3")) {
    fail("sqlite3 CLI not found — install with: apt-get install -y sqlite3");
  }
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) fail(`database file not found: ${dbPath}`);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `${PREFIX}${todayStamp()}${SUFFIX}`);
  log(`source=${dbPath} dest=${dest} retentionDays=${RETENTION_DAYS}`);

  runBackup(dbPath, dest);
  const sizeMb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  log(`snapshot OK (${sizeMb} MB, integrity=ok)`);

  const removed = prune();
  log(`prune done (removed=${removed}, retention=${RETENTION_DAYS}d)`);

  const offboxOk = offbox(dest);
  if (!offboxOk) {
    console.error(`[backup-db] ${stamp()} ERROR configured off-box copy failed — FIX rsync/target`);
    process.exit(2);
  }
  log("done");
  process.exit(0);
}

try {
  main();
} catch (e) {
  fail(`unexpected: ${(e as Error).stack || (e as Error).message}`);
}

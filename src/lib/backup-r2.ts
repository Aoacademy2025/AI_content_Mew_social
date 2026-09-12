// Off-box copy of the nightly SQLite snapshot (scripts/backup-db.ts, Task C9).
//
// Reuses the existing R2 client/config plumbing from media-storage-r2.ts (same
// bucket by default, `BACKUP_R2_BUCKET` to use a different one) instead of
// re-implementing S3 auth/config validation. This module only adds the parts
// specific to backups: a fixed `db-backups/` key prefix, a plain upload (no
// MediaIdentity/media-catalog involved), and prefix-scoped retention pruning.
import { stat } from "node:fs/promises";
import {
  AwsR2ObjectClient,
  R2ConfigurationError,
  r2StorageConfigFromEnv,
  type R2ObjectClientPort,
  type R2ObjectInventoryPort,
  type R2StorageConfig,
} from "@/lib/media-storage-r2";
import { mediaFileDigests } from "@/lib/media-storage-support";

export const BACKUP_R2_PREFIX = "db-backups/";
const DEFAULT_RETENTION_DAYS = 30;

export type BackupR2Env = Record<string, string | undefined>;

/** Injection seam for tests — the real client is `AwsR2ObjectClient` (see media-storage-r2.ts). */
export type BackupR2Client = R2ObjectClientPort & R2ObjectInventoryPort;

export type BackupR2Config = {
  storage: R2StorageConfig;
  retentionDays: number;
};

function boundedRetentionDays(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_RETENTION_DAYS;
}

// Returns null when R2 is not configured (missing/invalid env) — callers treat
// that as "off-box copy not configured", never as an error.
export function backupR2ConfigFromEnv(env: BackupR2Env = process.env): BackupR2Config | null {
  const bucketOverride = (env.BACKUP_R2_BUCKET ?? "").trim();
  const envForConfig = bucketOverride ? { ...env, R2_BUCKET: bucketOverride } : env;
  let storage: R2StorageConfig;
  try {
    storage = r2StorageConfigFromEnv(envForConfig, "write");
  } catch (error) {
    if (error instanceof R2ConfigurationError) return null;
    throw error;
  }
  return { storage, retentionDays: boundedRetentionDays(env.BACKUP_R2_RETENTION_DAYS) };
}

export function createBackupR2Client(storage: R2StorageConfig): BackupR2Client {
  return new AwsR2ObjectClient(storage);
}

export function backupObjectKey(filename: string): string {
  return `${BACKUP_R2_PREFIX}${filename}`;
}

// Uploads the snapshot at sourcePath to `key`. A same-day rerun that finds the
// object already there (precondition_failed + a matching head) is treated as
// success, not an error — the local file is never touched either way.
export async function uploadBackupSnapshot(
  client: BackupR2Client,
  input: { key: string; sourcePath: string },
): Promise<void> {
  const stats = await stat(input.sourcePath);
  const { sha256, contentMd5Base64 } = await mediaFileDigests(input.sourcePath);
  const result = await client.put({
    key: input.key,
    sourcePath: input.sourcePath,
    sizeBytes: stats.size,
    contentType: "application/vnd.sqlite3",
    sha256,
    contentMd5Base64,
  });
  if (result === "precondition_failed") {
    const existing = await client.head(input.key);
    if (!existing) {
      throw new Error(`R2 precondition failed and no object exists at ${input.key}`);
    }
  }
}

// Deletes objects under BACKUP_R2_PREFIX older than retentionDays. Never
// touches any other prefix (media lives at `media/v1/...` in the same
// bucket) — both because `list` is called with the backups prefix and, in
// case a fake test client ignores that, by re-checking every key here too.
export async function pruneBackupObjects(
  client: BackupR2Client,
  input: { retentionDays: number; now?: Date },
): Promise<{ removed: string[] }> {
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.list(BACKUP_R2_PREFIX, continuationToken);
    for (const object of page.objects) {
      if (!object.key.startsWith(BACKUP_R2_PREFIX)) continue;
      if (object.lastModified.getTime() < cutoffMs) {
        await client.delete(object.key);
        removed.push(object.key);
      }
    }
    continuationToken = page.continuationToken ?? undefined;
  } while (continuationToken);
  return { removed };
}

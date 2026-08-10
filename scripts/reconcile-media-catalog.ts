import "dotenv/config";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  MediaCatalog,
  type MediaCatalogFailedLocalRow,
} from "../src/lib/media-catalog";
import { mediaRootPaths } from "../src/lib/media-cleanup";
import { buildMediaReferenceGraph } from "../src/lib/media-reference-graph";
import {
  mediaObjectKey,
  type MediaArea,
  type MediaIdentity,
} from "../src/lib/media-storage";
import { safeMediaIdentity } from "../src/lib/media-storage-support";
import { prisma } from "../src/lib/prisma";

type ReconcileMode = "dry-run" | "apply";

type ManifestRecord = {
  id: string;
  version: number;
  key: string;
  objectKey: string;
  sizeBytes: string;
  lastErrorCode: string;
  updatedAt: string;
};

const ALLOWED_FAILURES = new Set([
  "LocalMediaMissing",
  "UnsafeMediaFileError",
]);

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function stringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function manifestSha256(records: readonly ManifestRecord[]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function identityFor(row: MediaCatalogFailedLocalRow): MediaIdentity | null {
  try {
    const identity = safeMediaIdentity({
      area: row.area as MediaArea,
      filename: row.filename,
    });
    return mediaObjectKey(identity) === row.objectKey ? identity : null;
  } catch {
    return null;
  }
}

function manifestRecord(
  row: MediaCatalogFailedLocalRow,
  identity: MediaIdentity,
): ManifestRecord {
  return {
    id: row.id,
    version: row.version,
    key: `${identity.area}/${identity.filename}`,
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes.toString(),
    lastErrorCode: row.lastErrorCode!,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function main(): Promise<void> {
  const known = [
    "--apply",
    "--summary",
    "--manifestSha256=",
    "--maxObjects=",
    "--olderThanMinutes=",
  ];
  const unknown = process.argv.slice(2).find((arg) =>
    !known.some((item) => item.endsWith("=") ? arg.startsWith(item) : arg === item)
  );
  if (unknown) throw new Error("unknown media catalog reconciliation argument");

  const mode: ReconcileMode = hasFlag("apply") ? "apply" : "dry-run";
  if (mode === "apply" && process.env.MEDIA_CATALOG_RECONCILE !== "1") {
    throw new Error("media catalog reconciliation apply requires MEDIA_CATALOG_RECONCILE=1");
  }

  const maxObjects = boundedInteger(stringArg("maxObjects"), 25, 1, 100);
  const olderThanMinutes = boundedInteger(
    stringArg("olderThanMinutes"),
    30,
    15,
    7 * 24 * 60,
  );
  const now = new Date();
  const cutoff = now.getTime() - olderThanMinutes * 60_000;
  const catalog = new MediaCatalog(prisma);
  const roots = mediaRootPaths(process.cwd());
  const graph = await buildMediaReferenceGraph(now, {
    workspaceRoot: process.cwd(),
  });
  const inventory = await catalog.failedLocalInventory();
  const skipped = {
    graph_error: graph.errors.length,
    invalid_identity: 0,
    remote_observed: 0,
    unsupported_error: 0,
    retry_grace: 0,
    referenced: 0,
    local_present: 0,
    local_stat_error: 0,
    limit: 0,
    catalog_changed: 0,
  };
  const eligible: Array<{
    row: MediaCatalogFailedLocalRow;
    identity: MediaIdentity;
  }> = [];

  if (graph.errors.length === 0) {
    for (const row of inventory) {
      const identity = identityFor(row);
      if (!identity) {
        skipped.invalid_identity += 1;
        continue;
      }
      if (
        row.sha256 !== null ||
        row.remoteFilename !== null ||
        row.r2Etag !== null ||
        row.lastVerifiedAt !== null
      ) {
        skipped.remote_observed += 1;
        continue;
      }
      if (!row.lastErrorCode || !ALLOWED_FAILURES.has(row.lastErrorCode)) {
        skipped.unsupported_error += 1;
        continue;
      }
      if (
        row.updatedAt.getTime() > cutoff ||
        (row.nextRetryAt && row.nextRetryAt.getTime() > now.getTime())
      ) {
        skipped.retry_grace += 1;
        continue;
      }
      const key = `${identity.area}/${identity.filename}`;
      if ((graph.refs.get(key) ?? []).length > 0) {
        skipped.referenced += 1;
        continue;
      }
      const localPath = path.join(roots[identity.area], identity.filename);
      try {
        await lstat(localPath);
        skipped.local_present += 1;
        continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          skipped.local_stat_error += 1;
          continue;
        }
      }
      eligible.push({ row, identity });
    }
  }

  const selected = eligible.slice(0, maxObjects);
  skipped.limit = Math.max(eligible.length - selected.length, 0);
  const records = selected.map(({ row, identity }) =>
    manifestRecord(row, identity)
  );
  const sha256 = manifestSha256(records);
  let abandoned = 0;

  if (mode === "apply" && records.length > 0) {
    if (stringArg("manifestSha256") !== sha256) {
      throw new Error("media catalog reconciliation manifest mismatch");
    }
    const changed = await catalog.abandonMissingFailed(
      selected.map(({ row }) => ({ id: row.id, version: row.version })),
    );
    if (!changed) {
      skipped.catalog_changed = selected.length;
    } else {
      abandoned = selected.length;
    }
  }

  const report = {
    mode,
    generatedAt: now.toISOString(),
    manifestSha256: sha256,
    scanned: inventory.length,
    eligible: eligible.length,
    selected: selected.length,
    abandoned,
    skipped,
    errors: graph.errors.length + skipped.local_stat_error + skipped.catalog_changed,
    records,
  };
  const output = hasFlag("summary")
    ? { ...report, records: undefined }
    : report;
  console.log(JSON.stringify(output));
  if (report.errors > 0) process.exitCode = 1;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "media catalog reconciliation failed");
    process.exit(1);
  });

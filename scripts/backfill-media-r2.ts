import "dotenv/config";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { MediaCatalog, type MediaCatalogClaim } from "../src/lib/media-catalog";
import {
  LocalMediaStorageAdapter,
  MediaCollisionError,
  UnsafeMediaFileError,
  contentAddressedMediaIdentity,
  defaultLocalMediaRoots,
  type MediaDescriptor,
  type MediaArea,
  type MediaIdentity,
} from "../src/lib/media-storage";
import { sha256MediaFile } from "../src/lib/media-storage-support";
import { createR2MediaStorageFromEnv } from "../src/lib/media-storage-r2";
import { prisma } from "../src/lib/prisma";

type BackfillMode = "dry-run" | "apply";

function modeFromArgs(args: string[]): BackfillMode {
  const known = new Set(["--apply", "--dry-run"]);
  if (args.some((arg) => !known.has(arg))) throw new Error("unknown backfill argument");
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("choose either --apply or --dry-run");
  }
  return args.includes("--apply") ? "apply" : "dry-run";
}

function boundedMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000 ? parsed : 100;
}

type CatalogInspection = Awaited<ReturnType<MediaCatalog["inspect"]>>;

function localObservationMatches(
  row: CatalogInspection,
  descriptor: MediaDescriptor,
  localMtimeMs: number,
): boolean {
  return Boolean(
    row &&
    row.sizeBytes === BigInt(descriptor.sizeBytes) &&
    row.localMtimeMs === BigInt(Math.trunc(localMtimeMs)),
  );
}

function verifiedRemoteIdentity(
  identity: MediaIdentity,
  descriptor: MediaDescriptor,
  localMtimeMs: number,
  row: CatalogInspection,
): MediaIdentity | null {
  if (row?.remoteState !== "verified" || !localObservationMatches(row, descriptor, localMtimeMs)) {
    return null;
  }
  if (typeof row.sha256 === "string" && row.remoteFilename) {
    const physical = contentAddressedMediaIdentity(identity, row.sha256);
    return row.remoteFilename === physical.filename ? physical : null;
  }
  // Existing verified renders may remain on their immutable legacy v1 key.
  return identity.area === "renders" && !row.remoteFilename ? identity : null;
}

async function localIdentities(
  roots: ReturnType<typeof defaultLocalMediaRoots>,
): Promise<MediaIdentity[]> {
  const identities: MediaIdentity[] = [];
  for (const area of ["renders", "stocks"] as const satisfies readonly MediaArea[]) {
    const root = roots[area];
    const rootStat = await lstat(root).catch(() => null);
    if (!rootStat) continue;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`unsafe ${area} media root`);
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const transient =
        /^\.tmp-\d+-\d+-/.test(entry.name) ||
        /\.tmp-\d+-\d+\.[a-z0-9]+$/i.test(entry.name);
      if (entry.isFile() && !transient) {
        identities.push({ area, filename: entry.name });
      }
    }
  }
  return identities;
}

async function main() {
  const mode = modeFromArgs(process.argv.slice(2));
  if (mode === "apply" && process.env.R2_BACKFILL_ENABLED !== "1") {
    throw new Error("R2 backfill apply requires R2_BACKFILL_ENABLED=1");
  }

  const maxUploads = boundedMax(process.env.R2_BACKFILL_MAX_OBJECTS);
  const roots = defaultLocalMediaRoots();
  const local = new LocalMediaStorageAdapter(roots);
  const catalog = new MediaCatalog(prisma);
  const remote = mode === "apply"
    ? createR2MediaStorageFromEnv(process.env, "write")
    : null;
  const totals = {
    scanned: 0,
    candidates: 0,
    attempted: 0,
    verified: 0,
    alreadyVerified: 0,
    deferred: 0,
    conflicts: 0,
    failed: 0,
    skippedInvalid: 0,
  };

  try {
    for (const identity of await localIdentities(roots)) {
      totals.scanned += 1;
      let descriptor;
      try {
        descriptor = await local.stat(identity);
      } catch (error) {
        if (error instanceof UnsafeMediaFileError) {
          totals.skippedInvalid += 1;
          continue;
        }
        throw error;
      }
      if (!descriptor) continue;
      const localMtimeMs = descriptor.lastModified.getTime();
      const row = await catalog.inspect(identity);

      if (mode === "dry-run") {
        const verified = verifiedRemoteIdentity(identity, descriptor, localMtimeMs, row);
        if (verified) totals.alreadyVerified += 1;
        else totals.candidates += 1;
        if (totals.candidates >= maxUploads) break;
        continue;
      }

      let materialized = null as Awaited<ReturnType<typeof local.materialize>>;
      let activeClaim: MediaCatalogClaim | null = null;
      try {
        let remoteIdentity =
          verifiedRemoteIdentity(identity, descriptor, localMtimeMs, row);
        let expectedSha256: string | undefined;
        if (!remoteIdentity) {
          materialized = await local.materialize(identity);
          if (!materialized) {
            totals.deferred += 1;
            continue;
          }
          try {
            expectedSha256 = await sha256MediaFile(materialized.absolutePath);
          } catch {
            totals.deferred += 1;
            continue;
          }
          remoteIdentity = contentAddressedMediaIdentity(identity, expectedSha256);
        }

        const claimed = await catalog.claim({
          descriptor,
          localMtimeMs,
          remoteIdentity,
        });
        if (claimed.status === "verified") {
          totals.alreadyVerified += 1;
          continue;
        }
        if (claimed.status === "deferred" || claimed.status === "busy") {
          totals.deferred += 1;
          continue;
        }
        if (claimed.status === "conflict") {
          totals.conflicts += 1;
          continue;
        }
        activeClaim = claimed.claim;

        totals.candidates += 1;
        totals.attempted += 1;
        materialized ??= await local.materialize(identity);
        if (!materialized) {
          await catalog.markFailed(claimed.claim, new Error("LocalMediaMissing"));
          totals.failed += 1;
          continue;
        }
        const receipt = await remote!.commit({
          identity: claimed.claim.remoteIdentity,
          sourcePath: materialized.absolutePath,
          expectedSha256,
        });
        if (!await catalog.markVerified(claimed.claim, receipt)) {
          throw new Error("MediaCatalogLeaseLost");
        }
        totals.verified += 1;
      } catch (error) {
        if (!activeClaim) throw error;
        await catalog.markFailed(activeClaim, error);
        if (error instanceof MediaCollisionError) totals.conflicts += 1;
        else totals.failed += 1;
      } finally {
        await materialized?.release();
      }
      if (totals.attempted >= maxUploads) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(JSON.stringify({ mode, maxUploads, ...totals }));
  if (totals.failed > 0 || totals.conflicts > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "R2 backfill failed");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

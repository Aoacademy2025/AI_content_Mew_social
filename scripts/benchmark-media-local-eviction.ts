import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = mkdtempSync(path.join(tmpdir(), "hero41-media-eviction-benchmark-"));
const databasePath = path.join(root, "benchmark.db");
const fileCount = 18_865;
const verifiedCount = 938;
const evictionCount = 326;
const bytes = Buffer.alloc(4 * 1024, 0x41);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const now = new Date("2026-09-23T12:00:00.000Z");
const old = new Date(now.getTime() - 20 * 86_400_000);
const renderRoot = path.join(root, "public", "renders");
const filenames = Array.from(
  { length: fileCount },
  (_, index) => `fixture-${String(index).padStart(5, "0")}.mp4`,
);

process.env.DATABASE_URL = `file:${databasePath}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "ignore",
});

function writeFixtureFile(filename: string): void {
  const absolutePath = path.join(renderRoot, filename);
  writeFileSync(absolutePath, bytes);
  utimesSync(absolutePath, old, old);
}

async function main(): Promise<void> {
  const [{ prisma }, { MediaCatalog }, { getMediaCleanupPlan }, { runLocalMediaEviction }] =
    await Promise.all([
      import("../src/lib/prisma"),
      import("../src/lib/media-catalog"),
      import("../src/lib/media-cleanup"),
      import("../src/lib/media-local-eviction"),
    ]);
  mkdirSync(renderRoot, { recursive: true });
  for (const filename of filenames) writeFixtureFile(filename);
  await prisma.mediaObject.createMany({
    data: filenames.slice(0, verifiedCount).map((filename) => ({
      area: "renders",
      filename,
      objectKey: `media/v1/renders/${filename}`,
      contentType: "video/mp4",
      sizeBytes: BigInt(bytes.length),
      sha256,
      remoteState: "verified",
      localState: "present",
      localMtimeMs: BigInt(old.getTime()),
    })),
  });

  const catalog = new MediaCatalog(prisma);
  const runs = [];
  for (let index = 0; index < 3; index++) {
    if (index > 0) {
      for (const filename of filenames.slice(0, evictionCount)) writeFixtureFile(filename);
      await prisma.mediaObject.updateMany({
        where: { filename: { in: filenames.slice(0, evictionCount) } },
        data: { localState: "present" },
      });
    }

    const operations = {
      catalogReads: 0,
      catalogWrites: 0,
      remoteVerifications: 0,
    };
    const countedCatalog = new Proxy(catalog, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "inspect" || property === "localEvictionInventory") {
            operations.catalogReads++;
          }
          if (property === "markLocalEvicted" || property === "markLocalPresent") {
            operations.catalogWrites++;
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    const remote = {
      verifyReplica: async () => {
        operations.remoteVerifications++;
        return true;
      },
    };

    const rssBefore = process.memoryUsage().rss;
    const planStarted = performance.now();
    const plan = await getMediaCleanupPlan({ cwd: root, now, includeStocks: true });
    const planMs = performance.now() - planStarted;
    const evictionStarted = performance.now();
    const report = await runLocalMediaEviction(plan, {
      mode: "apply",
      now,
      catalog: countedCatalog,
      remote,
      maxObjects: evictionCount,
      maxBytes: 50 * 1024 * 1024 * 1024,
      env: {
        MEDIA_READ_MODE: "r2-local",
        MEDIA_LOCAL_EVICTION: "1",
        MEDIA_R2_DELETE: "0",
      },
    });
    const evictionMs = performance.now() - evictionStarted;
    assert.equal(report.scanned, fileCount);
    assert.equal(report.skipped.catalog_unverified, fileCount - verifiedCount);
    assert.equal(report.skipped.limit, verifiedCount - evictionCount);
    assert.equal(report.evicted.count, evictionCount);
    assert.equal(report.errors, 0);
    assert.equal(operations.remoteVerifications, evictionCount * 2);
    assert.equal(operations.catalogWrites, evictionCount);
    runs.push({
      run: index + 1,
      planMs: Math.round(planMs),
      evictionMs: Math.round(evictionMs),
      totalMs: Math.round(planMs + evictionMs),
      rssBeforeMiB: Math.round(rssBefore / 1024 / 1024),
      rssAfterMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      operations,
      outcome: {
        scanned: report.scanned,
        catalogUnverified: report.skipped.catalog_unverified,
        limited: report.skipped.limit,
        evicted: report.evicted.count,
        errors: report.errors,
      },
    });
  }

  console.log(JSON.stringify({
    fixture: {
      files: fileCount,
      verifiedCatalogRows: verifiedCount,
      selectedEvictions: evictionCount,
      bytesPerFile: bytes.length,
    },
    runs,
  }, null, 2));
  await prisma.$disconnect();
}

main()
  .finally(() => rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

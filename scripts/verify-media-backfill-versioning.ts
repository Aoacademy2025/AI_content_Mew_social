import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  contentAddressedStockIdentity,
  mediaObjectKey,
} from "../src/lib/media-storage";

const repositoryRoot = path.resolve(__dirname, "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "media-backfill-versioning-"));
const databaseUrl = `file:${path.join(fixtureRoot, "fixture.db")}`;
process.env.DATABASE_URL = databaseUrl;

function backfillSummary() {
  const result = spawnSync(
    path.join(repositoryRoot, "node_modules", ".bin", "tsx"),
    [
      "--tsconfig",
      path.join(repositoryRoot, "tsconfig.json"),
      path.join(repositoryRoot, "scripts", "backfill-media-r2.ts"),
    ],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DOTENV_CONFIG_QUIET: "true",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const summaryLine = result.stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  assert(summaryLine, "backfill must print a machine-readable summary");
  return JSON.parse(summaryLine);
}

async function main() {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "ignore",
  });

  const stocksRoot = path.join(fixtureRoot, "stocks");
  mkdirSync(stocksRoot, { recursive: true });
  const filename = "mutable-stock.mp4";
  const payload = "current stock bytes";
  const filePath = path.join(stocksRoot, filename);
  writeFileSync(filePath, payload);
  const fileStat = statSync(filePath);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const logicalIdentity = { area: "stocks" as const, filename };
  const physicalIdentity = contentAddressedStockIdentity(logicalIdentity, sha256);

  const { prisma } = await import("../src/lib/prisma");
  await prisma.mediaObject.create({
    data: {
      area: "stocks",
      filename,
      objectKey: mediaObjectKey(logicalIdentity),
      contentType: "video/mp4",
      sizeBytes: BigInt(fileStat.size),
      sha256,
      remoteState: "verified",
      localState: "present",
      localMtimeMs: BigInt(fileStat.mtime.getTime()),
      lastVerifiedAt: new Date(),
    },
  });
  await prisma.$disconnect();

  const legacy = backfillSummary();
  assert.equal(legacy.candidates, 1);
  assert.equal(legacy.alreadyVerified, 0);

  const { prisma: updatePrisma } = await import("../src/lib/prisma");
  const updatedRow = await updatePrisma.mediaObject.update({
    where: { objectKey: mediaObjectKey(logicalIdentity) },
    data: { remoteFilename: physicalIdentity.filename },
  });
  assert.equal(updatedRow.remoteFilename, physicalIdentity.filename);
  assert.equal(updatedRow.sha256, sha256);
  assert.equal(updatedRow.sizeBytes, BigInt(fileStat.size));
  assert.equal(updatedRow.localMtimeMs, BigInt(fileStat.mtime.getTime()));
  await updatePrisma.$disconnect();

  const versioned = backfillSummary();
  assert.equal(versioned.candidates, 0, JSON.stringify(versioned));
  assert.equal(versioned.alreadyVerified, 1, JSON.stringify(versioned));

  console.log("PASS media backfill stock versioning");
}

main()
  .finally(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

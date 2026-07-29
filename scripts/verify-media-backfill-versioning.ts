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
  contentAddressedMediaIdentity,
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

  const rendersRoot = path.join(fixtureRoot, "public", "renders");
  mkdirSync(rendersRoot, { recursive: true });
  const renderFilename = "legacy-render.mp4";
  const renderPayload = "legacy immutable render bytes";
  const renderPath = path.join(rendersRoot, renderFilename);
  writeFileSync(renderPath, renderPayload);
  const renderStat = statSync(renderPath);
  const renderSha256 = createHash("sha256").update(renderPayload).digest("hex");
  const renderIdentity = { area: "renders" as const, filename: renderFilename };
  const renderPhysicalIdentity =
    contentAddressedMediaIdentity(renderIdentity, renderSha256);

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
  await prisma.mediaObject.createMany({
    data: [
      {
        area: "renders",
        filename: renderFilename,
        objectKey: mediaObjectKey(renderIdentity),
        contentType: "video/mp4",
        sizeBytes: BigInt(renderStat.size),
        sha256: renderSha256,
        remoteState: "verified",
        localState: "present",
        localMtimeMs: BigInt(renderStat.mtime.getTime()),
        lastVerifiedAt: new Date(),
      },
      {
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
    ],
  });
  await prisma.$disconnect();

  const legacy = backfillSummary();
  assert.equal(legacy.candidates, 1);
  assert.equal(legacy.alreadyVerified, 1);

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
  assert.equal(versioned.alreadyVerified, 2, JSON.stringify(versioned));

  const { prisma: conflictPrisma } = await import("../src/lib/prisma");
  await conflictPrisma.mediaObject.update({
    where: { objectKey: mediaObjectKey(renderIdentity) },
    data: {
      remoteState: "conflict",
      lastErrorCode: "MediaCollisionError",
    },
  });
  await conflictPrisma.$disconnect();

  const renderConflict = backfillSummary();
  assert.equal(renderConflict.candidates, 1, JSON.stringify(renderConflict));
  assert.equal(renderConflict.alreadyVerified, 1, JSON.stringify(renderConflict));

  const { prisma: recoveredPrisma } = await import("../src/lib/prisma");
  await recoveredPrisma.mediaObject.update({
    where: { objectKey: mediaObjectKey(renderIdentity) },
    data: {
      remoteFilename: renderPhysicalIdentity.filename,
      sha256: renderSha256,
      remoteState: "verified",
      lastErrorCode: null,
    },
  });
  await recoveredPrisma.$disconnect();

  const recovered = backfillSummary();
  assert.equal(recovered.candidates, 0, JSON.stringify(recovered));
  assert.equal(recovered.alreadyVerified, 2, JSON.stringify(recovered));

  console.log("PASS media backfill versioning compatibility");
}

main()
  .finally(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

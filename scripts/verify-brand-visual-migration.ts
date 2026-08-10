import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "brand-visual-migration-"));
const database = path.join(directory, "baseline.db");
const cleanDatabase = path.join(directory, "clean.db");
const migration = readFileSync(
  path.resolve("prisma/migrations/20260809000000_brand_visual_system/migration.sql"),
  "utf8",
);

function sqlite(sql: string): string {
  return execFileSync("sqlite3", [database], { input: sql, encoding: "utf8" }).trim();
}

function sqliteAt(target: string, sql: string): string {
  return execFileSync("sqlite3", [target], { input: sql, encoding: "utf8" }).trim();
}

try {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: path.resolve("."),
    env: { ...process.env, DATABASE_URL: `file:${cleanDatabase}` },
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM sqlite_master
      WHERE type='table' AND name IN (
        'BrandProfile', 'BrandProfileRevision', 'ContentPreflight',
        'BrandLookPreviewBatch', 'StarterAiImageAllowance'
      );
    `),
    "5",
    "the checked-in migration chain provisions a clean database",
  );
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM pragma_table_info('VideoJob')
      WHERE name IN ('contentPreflightId', 'projectVisualContextJson', 'brandVisualAcceptanceJson');
    `),
    "3",
    "clean deploy includes immutable VideoJob preflight/context/access pins",
  );
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM pragma_table_info('BrandLookPreviewBatch')
      WHERE name='requestId';
    `),
    "1",
    "clean deploy includes durable preview request identity",
  );
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM sqlite_master
      WHERE type='index' AND name='BrandLookPreviewBatch_userId_requestId_key';
    `),
    "1",
    "preview request identity is unique per owner",
  );
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM sqlite_master
      WHERE type='index' AND name='BrandProfileRevision_sourceVideoJobId_key';
    `),
    "1",
    "completed-clip promotion has durable replay identity",
  );
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM sqlite_master
      WHERE type='index' AND name='BrandProfileRevision_sourcePreflightId_key';
    `),
    "1",
    "Project Look promotion has durable replay identity before and after render",
  );
  assert.equal(
    sqliteAt(cleanDatabase, `
      SELECT count(*) FROM sqlite_master
      WHERE type='index' AND name='BrandLookPreviewItem_status_updatedAt_idx';
    `),
    "1",
    "interrupted preview recovery uses a covering status/update index",
  );
  assert.equal(sqliteAt(cleanDatabase, "PRAGMA foreign_key_check;"), "");

  sqlite(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "BrandProfile" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    CREATE INDEX "BrandProfile_userId_idx" ON "BrandProfile"("userId");
    CREATE TABLE "EditorProject" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    CREATE TABLE "VideoJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "inputJson" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    CREATE TABLE "AiGenerationJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    INSERT INTO "User" VALUES ('legacy-user');
    INSERT INTO "BrandProfile" VALUES ('legacy-brand', 'legacy-user', CURRENT_TIMESTAMP);
    INSERT INTO "EditorProject" VALUES ('legacy-project', 'legacy-user', CURRENT_TIMESTAMP);
    INSERT INTO "VideoJob" VALUES ('legacy-video-job', 'legacy-user', '{}', CURRENT_TIMESTAMP);
    INSERT INTO "AiGenerationJob" VALUES ('legacy-image-job', 'legacy-user', CURRENT_TIMESTAMP);
  `);

  sqlite(migration);

  const preserved = JSON.parse(sqlite(`
    SELECT json_object(
      'profiles', (SELECT count(*) FROM "BrandProfile" WHERE "id"='legacy-brand'),
      'projects', (SELECT count(*) FROM "EditorProject" WHERE "id"='legacy-project'),
      'videoJobs', (SELECT count(*) FROM "VideoJob" WHERE "id"='legacy-video-job'),
      'jobs', (SELECT count(*) FROM "AiGenerationJob" WHERE "id"='legacy-image-job'),
      'revision', (SELECT "activeRevisionNumber" FROM "BrandProfile" WHERE "id"='legacy-brand'),
      'funding', (SELECT "fundingSource" FROM "AiGenerationJob" WHERE "id"='legacy-image-job')
    );
  `)) as Record<string, unknown>;
  assert.deepEqual(preserved, {
    profiles: 1,
    projects: 1,
    videoJobs: 1,
    jobs: 1,
    revision: 0,
    funding: "credits",
  });
  assert.equal(
    sqlite(`
      SELECT count(*) FROM pragma_table_info('VideoJob')
      WHERE name IN ('contentPreflightId', 'projectVisualContextJson', 'brandVisualAcceptanceJson');
    `),
    "3",
  );

  const requiredTables = new Set(sqlite(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN (
      'BrandProfileDraft', 'BrandProfileRevision', 'ContentPreflight',
      'ProjectVisualBeat', 'BrandLookPreviewBatch', 'BrandLookPreviewItem',
      'StarterAiImageAllowance'
    ) ORDER BY name;
  `).split("\n"));
  assert.equal(requiredTables.size, 7);
  assert.equal(sqlite("PRAGMA foreign_key_check;"), "");

  sqlite(`
    INSERT INTO "BrandProfileRevision"
      ("id", "brandProfileId", "version", "payloadJson", "visualRecipeJson")
      VALUES ('revision-1', 'legacy-brand', 1, '{}', '{}');
    UPDATE "EditorProject" SET "brandProfileRevisionId"='revision-1'
      WHERE "id"='legacy-project';
    INSERT INTO "StarterAiImageAllowance"
      ("id", "userId", "windowStartedAt", "updatedAt")
      VALUES ('allowance-window-1', 'legacy-user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);
  assert.equal(sqlite("PRAGMA foreign_key_check;"), "");
  console.log("brand visual migration verification: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "brand-visual-migration-"));
const database = path.join(directory, "baseline.db");
const migration = readFileSync(
  path.resolve("prisma/migrations/20260809000000_brand_visual_system/migration.sql"),
  "utf8",
);

function sqlite(sql: string): string {
  return execFileSync("sqlite3", [database], { input: sql, encoding: "utf8" }).trim();
}

try {
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
    CREATE TABLE "AiGenerationJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    INSERT INTO "User" VALUES ('legacy-user');
    INSERT INTO "BrandProfile" VALUES ('legacy-brand', 'legacy-user', CURRENT_TIMESTAMP);
    INSERT INTO "EditorProject" VALUES ('legacy-project', 'legacy-user', CURRENT_TIMESTAMP);
    INSERT INTO "AiGenerationJob" VALUES ('legacy-image-job', 'legacy-user', CURRENT_TIMESTAMP);
  `);

  sqlite(migration);

  const preserved = JSON.parse(sqlite(`
    SELECT json_object(
      'profiles', (SELECT count(*) FROM "BrandProfile" WHERE "id"='legacy-brand'),
      'projects', (SELECT count(*) FROM "EditorProject" WHERE "id"='legacy-project'),
      'jobs', (SELECT count(*) FROM "AiGenerationJob" WHERE "id"='legacy-image-job'),
      'revision', (SELECT "activeRevisionNumber" FROM "BrandProfile" WHERE "id"='legacy-brand'),
      'funding', (SELECT "fundingSource" FROM "AiGenerationJob" WHERE "id"='legacy-image-job')
    );
  `)) as Record<string, unknown>;
  assert.deepEqual(preserved, {
    profiles: 1,
    projects: 1,
    jobs: 1,
    revision: 0,
    funding: "credits",
  });

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
      ("userId", "windowStartedAt", "updatedAt")
      VALUES ('legacy-user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);
  assert.equal(sqlite("PRAGMA foreign_key_check;"), "");
  console.log("brand visual migration verification: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(__dirname, "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "media-backfill-invalid-"));

try {
  const stocksRoot = path.join(fixtureRoot, "stocks");
  mkdirSync(stocksRoot, { recursive: true });
  writeFileSync(path.join(stocksRoot, "legacy-empty.mp4"), "");
  writeFileSync(path.join(stocksRoot, ".tmp-123-1-preview.mp4"), "temporary");
  writeFileSync(
    path.join(stocksRoot, "preview.mp4.tmp-123-1785460777118.mp4"),
    "temporary",
  );

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
        DATABASE_URL: `file:${path.join(fixtureRoot, "fixture.db")}`,
        DOTENV_CONFIG_QUIET: "true",
      },
    },
  );

  assert.equal(
    result.status,
    0,
    `zero-byte legacy media must be skipped instead of stopping reconciliation\n${result.stderr}`,
  );
  const summaryLine = result.stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  assert(summaryLine, "backfill must print a machine-readable summary");
  const summary = JSON.parse(summaryLine);
  assert.deepEqual(
    {
      mode: summary.mode,
      scanned: summary.scanned,
      candidates: summary.candidates,
      skippedInvalid: summary.skippedInvalid,
      failed: summary.failed,
      conflicts: summary.conflicts,
    },
    {
      mode: "dry-run",
      scanned: 1,
      candidates: 0,
      skippedInvalid: 1,
      failed: 0,
      conflicts: 0,
    },
  );

  console.log("PASS media backfill invalid-file handling");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runpod-image-cost-"));
const databasePath = path.join(temporaryDirectory, "test.db");
const env = {
  ...process.env,
  DATABASE_URL: `file:${databasePath}?connection_limit=1`,
};

try {
  const pushed = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  if (pushed.status !== 0) {
    process.stderr.write(pushed.stdout);
    process.stderr.write(pushed.stderr);
    process.exit(pushed.status ?? 1);
  }

  const verified = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/verify-runpod-image-cost-runtime.ts",
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  process.stdout.write(verified.stdout);
  process.stderr.write(verified.stderr);
  process.exitCode = verified.status ?? 1;
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

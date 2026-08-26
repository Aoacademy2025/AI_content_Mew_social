import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hero-user-voice-storage-"));
const databasePath = path.join(root, "test.db");
const storagePath = path.join(root, "private-references");
const env = {
  ...process.env,
  DATABASE_URL: `file:${databasePath}?connection_limit=1`,
  USER_VOICE_STORAGE_DIR: storagePath,
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
    ["--conditions=react-server", "--import", "tsx", "scripts/verify-user-voice-storage-runtime.ts"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  process.stdout.write(verified.stdout);
  process.stderr.write(verified.stderr);
  process.exitCode = verified.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

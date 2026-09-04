import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HeroVoiceDeletionCrashStep } from "../src/lib/hero-voice-deletion-coordinator.server";

const crashSteps: HeroVoiceDeletionCrashStep[] = [
  "after-upload-intent",
  "after-upload-raw",
  "before-upload-conversion",
  "after-upload-normalized",
  "after-upload-final-rename",
  "after-upload-row-commit",
];

for (const crashStep of crashSteps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hero-voice-upload-crash-"));
  const databasePath = path.join(root, "canary.sqlite");
  const voiceRoot = path.join(root, "private-references");
  const reviewRoot = path.join(root, "private-review");
  fs.mkdirSync(voiceRoot, { mode: 0o700 });
  fs.mkdirSync(reviewRoot, { mode: 0o700 });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: `file:${databasePath}?connection_limit=1`,
    HERO_VOICE_CANARY_EXECUTION_MODE: "1",
    HERO_VOICE_CANARY_ROOT: root,
    HERO_VOICE_CANARY_REVIEW_ROOT: reviewRoot,
    HERO_VOICE_CANARY_REVIEW_KEY: Buffer.alloc(32, 17).toString("base64url"),
    HERO_VOICE_CANARY_AUTH_ISSUER: "https://test.clerk.invalid",
    USER_VOICE_STORAGE_DIR: voiceRoot,
  };
  const run = (mode: "setup" | "crash" | "recover") => spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/verify-hero-voice-upload-crash-runtime.ts",
      mode,
      crashStep,
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  try {
    const pushed = spawnSync(
      "npx",
      ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(pushed.status, 0, `${crashStep} schema push failed: ${pushed.stderr}`);
    fs.chmodSync(databasePath, 0o600);

    const setup = run("setup");
    assert.equal(setup.status, 0, `${crashStep} setup failed: ${setup.stdout}${setup.stderr}`);
    const crashed = run("crash");
    assert.equal(crashed.status, 86, `${crashStep} did not process-crash: ${crashed.stdout}${crashed.stderr}`);
    const recovered = run("recover");
    assert.equal(recovered.status, 0, `${crashStep} recovery failed: ${recovered.stdout}${recovered.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("Hero Voice upload process-crash matrix passed.");

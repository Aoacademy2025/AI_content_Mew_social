import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CompositeExecutionError,
  executeCompositeFfmpeg,
  isCompositeStabilityCanary,
  resolveCompositeTimeoutMs,
  type CompositeExecFile,
} from "../src/lib/composite-execution";

const AFFECTED_COMPOSITE_CANARY_USER_ID = "cmpz3vpis002clce2ygzhty3m";

type EcosystemApp = {
  name: string;
  env?: Record<string, string>;
  env_production?: Record<string, string>;
};

const ecosystem = require("../ecosystem.config.js") as { apps: EcosystemApp[] };

function canaryIds(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "composite-execution-"));

async function main() {
  const web = ecosystem.apps.find((app) => app.name === "ai-content");
  const renderWorker = ecosystem.apps.find((app) => app.name === "render-worker");
  assert.ok(web?.env && web.env_production, "web runtime config must define both PM2 environments");
  assert.ok(renderWorker?.env, "render worker runtime config must exist");
  assert.ok(
    canaryIds(web.env.COMPOSITE_STABILITY_CANARY_USER_IDS).includes(AFFECTED_COMPOSITE_CANARY_USER_ID),
    "the approved composite canary must survive normal PM2 deploys",
  );
  assert.ok(
    canaryIds(web.env_production.COMPOSITE_STABILITY_CANARY_USER_IDS).includes(AFFECTED_COMPOSITE_CANARY_USER_ID),
    "the approved composite canary must survive PM2 production deploys",
  );
  assert.equal(web.env.COMPOSITE_ADMISSION_ENABLED, "1", "web composite admission must be enabled");
  assert.equal(web.env_production.COMPOSITE_ADMISSION_ENABLED, "1", "production web composite admission must be enabled");
  assert.equal(renderWorker.env.COMPOSITE_ADMISSION_ENABLED, "1", "render workers must honor composite admission");

  assert.equal(
    resolveCompositeTimeoutMs({ userId: "normal-user", env: {} }),
    30 * 60 * 1000,
    "non-canary users keep the legacy timeout",
  );
  assert.equal(
    resolveCompositeTimeoutMs({
      userId: "canary-user",
      env: { COMPOSITE_STABILITY_CANARY_USER_IDS: "other, canary-user" },
    }),
    55 * 60 * 1000,
    "canary users receive the bounded canary timeout",
  );
  assert.equal(
    resolveCompositeTimeoutMs({
      userId: "canary-user",
      env: {
        COMPOSITE_STABILITY_CANARY_USER_IDS: "canary-user",
        COMPOSITE_CANARY_TIMEOUT_MS: String(70 * 60 * 1000),
      },
    }),
    55 * 60 * 1000,
    "timeout overrides cannot exceed the safety ceiling",
  );
  assert.equal(
    isCompositeStabilityCanary({
      userId: "canary-user",
      env: { COMPOSITE_STABILITY_CANARY_USER_IDS: "other, canary-user" },
    }),
    true,
    "stability features are enabled only for an explicit canary user",
  );
  assert.equal(
    isCompositeStabilityCanary({ userId: "normal-user", env: {} }),
    false,
    "stability features remain disabled for non-canary users",
  );

  const timeoutOutput = path.join(root, "timeout.mp4");
  const timeoutExec: CompositeExecFile = (_file, args, _options, callback) => {
    fs.writeFileSync(String(args.at(-1)), "partial-video");
    const error = Object.assign(new Error("Command failed due to timeout"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    callback(error, "", "frame=120 fps=1.8");
    return undefined;
  };

  await assert.rejects(
    executeCompositeFfmpeg({
      ffmpegPath: "/fake/ffmpeg",
      args: ["-y", "-i", "input.mp4", timeoutOutput],
      outputPath: timeoutOutput,
      timeoutMs: 100,
      execFile: timeoutExec,
    }),
    (error: unknown) => error instanceof CompositeExecutionError
      && error.code === "COMPOSITE_TIMEOUT"
      && error.retryable === false,
  );
  assert.equal(fs.existsSync(timeoutOutput), false, "timeout never publishes a final output");
  assert.equal(fs.existsSync(path.join(root, "timeout.part.mp4")), false, "timeout removes its partial output");

  // Node's execFile timeout often kills ffmpeg, which then exits 255 with no signal.
  // Prod 2026-08-23 full-avatar chromakey hit this and was mislabeled COMPOSITE_FAILED.
  const nodeTimeoutOutput = path.join(root, "node-timeout.mp4");
  const nodeTimeoutExec: CompositeExecFile = (_file, args, _options, callback) => {
    fs.writeFileSync(String(args.at(-1)), "partial-video");
    const error = Object.assign(new Error("Command failed: ffmpeg"), {
      killed: true,
      signal: null,
      code: 255,
    });
    callback(error, "", "frame=3948 fps=2.2 time=00:02:11.81 speed=0.0732x");
    return undefined;
  };
  await assert.rejects(
    executeCompositeFfmpeg({
      ffmpegPath: "/fake/ffmpeg",
      args: ["-y", "-i", "input.mp4", nodeTimeoutOutput],
      outputPath: nodeTimeoutOutput,
      timeoutMs: 100,
      execFile: nodeTimeoutExec,
    }),
    (error: unknown) => error instanceof CompositeExecutionError
      && error.code === "COMPOSITE_TIMEOUT"
      && error.retryable === false
      && error.message === "ประกอบวิดีโอใช้เวลานานเกินกำหนด",
    "killed=true with exit 255 and no signal is a composite timeout, not a generic ffmpeg failure",
  );
  assert.equal(fs.existsSync(nodeTimeoutOutput), false, "Node timeout never publishes a final output");
  assert.equal(fs.existsSync(path.join(root, "node-timeout.part.mp4")), false, "Node timeout removes its partial output");

  const successOutput = path.join(root, "success.mp4");
  const successExec: CompositeExecFile = (_file, args, _options, callback) => {
    fs.writeFileSync(String(args.at(-1)), "complete-video");
    callback(null, "", "frame=300");
    return undefined;
  };
  await executeCompositeFfmpeg({
    ffmpegPath: "/fake/ffmpeg",
    args: ["-y", "-i", "input.mp4", successOutput],
    outputPath: successOutput,
    timeoutMs: 100,
    execFile: successExec,
  });
  assert.equal(fs.readFileSync(successOutput, "utf8"), "complete-video", "success atomically publishes the completed output");
  assert.equal(fs.existsSync(path.join(root, "success.part.mp4")), false, "success leaves no partial output");

  console.log("ALL PASS");
}

main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

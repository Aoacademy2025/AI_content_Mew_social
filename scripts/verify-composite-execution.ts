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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "composite-execution-"));

async function main() {
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

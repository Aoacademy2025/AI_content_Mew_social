import assert from "node:assert/strict";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import loadConfig from "next/dist/server/config";

class DefinePlugin {
  constructor(readonly definitions: Record<string, unknown>) {}
}

async function main() {
  const config = await loadConfig(PHASE_PRODUCTION_BUILD, process.cwd(), { silent: true });

  assert.equal(
    config.experimental.webpackBuildWorker,
    true,
    "production webpack compilers must run in isolated workers",
  );
  assert.equal(config.experimental.cpus, 1, "production builds must remain serial");
  assert.equal(config.experimental.workerThreads, false, "production builds must keep process workers");
  assert.equal(config.typescript.ignoreBuildErrors, false, "production builds must keep type checking enabled");
  assert.deepEqual(
    config.outputFileTracingExcludes?.["/**"],
    ["./public/renders/**/*", "./stocks/**/*"],
    "runtime media must remain outside every server trace",
  );

  for (const packageName of [
    "@remotion/bundler",
    "@remotion/renderer",
    "esbuild",
    "fluent-ffmpeg",
    "@ffmpeg-installer/ffmpeg",
    "onnxruntime-node",
    "sharp",
    "prisma",
  ]) {
    assert.ok(
      config.serverExternalPackages.includes(packageName),
      `${packageName} must remain external to the Next server bundle`,
    );
  }

  assert.equal(typeof config.webpack, "function", "the Sentry-wrapped webpack hook must remain active");
  const webpackInput = {
    entry: {},
    module: { rules: [] },
    plugins: [],
    resolve: {},
  };
  const webpackOutput = config.webpack!(webpackInput as never, {
    buildId: "verify-build-worker-config",
    dev: true,
    isServer: false,
    defaultLoaders: { babel: {} },
    dir: process.cwd(),
    nextRuntime: undefined,
    totalPages: 1,
    webpack: { DefinePlugin },
  } as never);
  const rules = webpackOutput.module.rules as Array<{ test?: RegExp }>;

  assert.ok(
    rules.some((rule) => rule.test?.test("fixture.wasm")),
    "the wrapped webpack hook must keep WASM files as emitted assets",
  );
  assert.ok(
    rules.some((rule) => rule.test?.test("README.md") && rule.test.test("fixture.txt")),
    "the wrapped webpack hook must keep leaked text files loadable as sources",
  );
  assert.ok(
    webpackOutput.plugins.some((plugin: unknown) => plugin instanceof DefinePlugin),
    "the wrapped webpack hook must keep Sentry's build-time instrumentation",
  );

  console.log("PASS isolated webpack compiler and wrapped build config contract");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

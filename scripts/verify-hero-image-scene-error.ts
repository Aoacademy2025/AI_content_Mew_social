import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  isSqliteWriteContentionError,
} from "../src/lib/hero-image-resilience";

// Run the actual runHeroSceneJob callback from the video route with a local
// failure injected at its generation seam. The provider and telemetry are stubs;
// the route's catch, failure record, and retry decision are real source.
const route = process.env.VERIFY_BASELINE_ROUTE === "1"
  ? execFileSync("git", ["show", "origin/main:src/app/api/videos/fetch-stock/route.ts"], { encoding: "utf8" })
  : readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
const start = route.indexOf("const runHeroSceneJob = async (");
const end = route.indexOf("// Provider phase first:", start);
assert.ok(start >= 0 && end > start, "the video scene callback must be present");
const callback = ts.transpileModule(route.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

class HeroImageGenerationError extends Error {
  constructor(readonly code: string, readonly providerFailure?: { code: string; systemic: boolean; retryable: boolean; stopBatch: boolean }) {
    super(code);
  }
}

async function exercise(error: Error | null) {
  const events: Array<{ properties: Record<string, unknown> }> = [];
  const failures: Array<{ code: string; stopBatch: boolean }> = [];
  const aiTelemetry = {
    aiGenAttemptCount: 0, aiGenFailedCount: 0, aiChargedCount: 0,
    aiCreditsSpent: 0, aiCreditsSpentGranted: 0, aiCreditsSpentPurchased: 0,
  };
  const generatedScenes: unknown[] = [];
  let generationCalls = 0;
  const dependencies = {
    aiTelemetry,
    stockTelemetry: { downloadFailCount: 0 },
    heroBriefByScene: new Map([[0, { includesInterface: false }]]),
    brollPreference: { brollRegionPreference: "global", brollVisualStyle: "cinematic" },
    buildHeroImagePrompt: () => "synthetic scene prompt",
    resolveHeroImageProviderStyle: () => "cinematic",
    generateHeroImageForVideo: async () => {
      generationCalls++;
      if (error) throw error;
      return {
        fundingSource: "credits", creditCost: 2,
        creditsFromGranted: 1, creditsFromPromotional: 0, creditsFromPurchased: 1,
      };
    },
    userId: "synthetic-user",
    user: { plan: "PRO" },
    videoJobId: "synthetic-video",
    heroProviderAttempt: 1,
    subtitleTexts: [],
    brandVisualAcceptance: null,
    generatedScenes,
    failures,
    recordTelemetryEvent: async (_userId: string, event: { properties: Record<string, unknown> }) => { events.push(event); },
    HeroImageGenerationError,
    isSqliteWriteContentionError,
  };
  const names = Object.keys(dependencies);
  const run = new Function(...names, `${callback}\nreturn runHeroSceneJob;`)(
    ...Object.values(dependencies),
  ) as (job: { keyword: string; sourceIndex: number; kenBurnsDurationSec: number }, retry: 0 | 1) => Promise<{ stopBatch: boolean }>;
  const outcome = await run({ keyword: "synthetic", sourceIndex: 0, kenBurnsDurationSec: 5 }, 0);
  assert.equal(generationCalls, 1, "one scene attempt calls generation once");
  if (error) {
    assert.equal(aiTelemetry.aiGenFailedCount, 1);
    assert.equal(failures.length, 1);
    assert.equal(events.length, 1);
  } else {
    assert.equal(aiTelemetry.aiChargedCount, 1);
    assert.equal(aiTelemetry.aiCreditsSpent, 2);
    assert.equal(generatedScenes.length, 1);
    assert.equal(failures.length, 0);
    assert.equal(events.length, 0);
  }
  return { outcome, failure: failures[0], event: events[0] };
}

async function main() {
  const contention = await exercise(Object.assign(new Error("Socket timeout"), { code: "P1008" }));
  assert.equal(contention.failure.code, "DB_CONTENTION", "local DB timeout must not be called provider polling failure");
  assert.equal(contention.event.properties.errorCode, "DB_CONTENTION");
  assert.equal(contention.outcome.stopBatch, false, "isolated retry remains available");

  const provider = await exercise(new HeroImageGenerationError("PROVIDER_POLL_FAILED", {
    code: "RUNPOD_FAILED", systemic: false, retryable: true, stopBatch: true,
  }));
  assert.equal(provider.failure.code, "PROVIDER_POLL_FAILED");
  assert.equal(provider.event.properties.providerErrorCode, "RUNPOD_FAILED");
  assert.equal(provider.outcome.stopBatch, true, "actual provider poll outage still stops the batch");

  const output = await exercise(new Error("image output could not be persisted"));
  assert.equal(output.failure.code, "OUTPUT_INVALID", "other local failures retain their classification");
  const success = await exercise(null);
  assert.equal(success.outcome.stopBatch, false, "successful scenes retain normal delivery and charge flow");
  console.log("verify-hero-image-scene-error: ALL PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBrandVisualBenchmarkCases } from "../src/lib/brand-visual-system";
import {
  BRAND_VISUAL_GATE_COMPILER_CONTRACT,
  qualityGateCaseHash,
  qualityGateCompilerHash,
  qualityGateEntrySelected,
  reconcileQualityGateEntry,
  type QualityGateEntry,
} from "./brand-visual-quality-gate-manifest";

const cases = buildBrandVisualBenchmarkCases();
assert.equal(cases.length, 21, "V1 pre-UI gate remains the fixed 21-image matrix");

const entries = cases.map((item): QualityGateEntry => {
  const base = {
    id: item.id,
    benchmark: item.benchmark,
    sceneId: item.sceneId,
    variant: item.variant,
    visualFormatId: item.visualFormatId,
    recipeVersion: item.compiled.recipeVersion,
    seed: item.seed,
    prompt: item.compiled.positive,
    negativePrompt: item.compiled.negative,
  };
  return {
    ...base,
    caseHash: qualityGateCaseHash({
      ...base,
      endpointId: "z-image-turbo",
      model: "z-image-turbo",
      width: 720,
      height: 1280,
    }),
    status: "pending",
  };
});
assert.match(qualityGateCompilerHash(entries), /^[a-f0-9]{64}$/);
assert.equal(BRAND_VISUAL_GATE_COMPILER_CONTRACT, "brand-visual-v1-provider-input-v2");
assert.equal(entries.filter((entry) => qualityGateEntrySelected(entry.id, "retro-story")).length, 3);
assert.equal(entries.length, 21, "selective generation must not truncate the persisted evidence set");

const current = entries[0];
const reviewedPrior: QualityGateEntry = {
  ...current,
  status: "completed",
  providerJobId: "provider-current",
  imagePath: `images/${current.id}.png`,
  sha256: "a".repeat(64),
  reviewDecision: "pass",
  reviewCriteriaVersion: "brand-visual-v1",
  reviewedBy: "manual-reviewer",
  reviewedAt: "2026-08-10T00:00:00.000Z",
};
const resumed = reconcileQualityGateEntry({
  current,
  prior: reviewedPrior,
  imageExists: () => true,
});
assert.equal(resumed.status, "completed");
assert.equal(resumed.providerJobId, "provider-current");
assert.equal(resumed.reviewDecision, "pass");
assert.equal(resumed.reviewedBy, "manual-reviewer");
assert.equal(resumed.prompt, current.prompt, "current compiler fields always win");

const stalePrior: QualityGateEntry = {
  ...reviewedPrior,
  prompt: `${current.prompt} stale compiler suffix`,
  caseHash: "b".repeat(64),
  providerJobId: "provider-stale",
};
const invalidated = reconcileQualityGateEntry({
  current,
  prior: stalePrior,
  imageExists: () => true,
});
assert.equal(invalidated.status, "pending");
assert.equal(invalidated.providerJobId, undefined);
assert.equal(invalidated.imagePath, undefined);
assert.equal(invalidated.reviewDecision, undefined, "stale visual review cannot bless a new prompt");
assert.equal(invalidated.prompt, current.prompt);

const missingArtifact = reconcileQualityGateEntry({
  current,
  prior: reviewedPrior,
  imageExists: () => false,
});
assert.equal(missingArtifact.status, "pending");
assert.equal(missingArtifact.reviewDecision, undefined);

const runnerSource = readFileSync("scripts/run-brand-visual-quality-gate.ts", "utf8");
assert.match(runnerSource, /reconcileQualityGateEntry/);
assert.doesNotMatch(
  runnerSource,
  /\.\.\.\(prior\s*\?\?\s*\{\}\)/,
  "a prior manifest can never overwrite freshly compiled fields",
);

console.log("verify-brand-visual-quality-gate-runner: PASS exact-input resume + stale invalidation");

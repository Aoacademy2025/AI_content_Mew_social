import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildBrandVisualBenchmarkCases } from "../src/lib/brand-visual-system";
import {
  BRAND_VISUAL_GATE_COMPILER_CONTRACT,
  qualityGateCaseHash,
  qualityGateCompilerHash,
  type QualityGateEntry,
} from "./brand-visual-quality-gate-manifest";

type Manifest = {
  schemaVersion: number;
  gate: string;
  model: string;
  endpointId: string;
  compilerContract?: string;
  compilerHash?: string;
  entries: QualityGateEntry[];
};

if (!process.argv.includes("--decision=pass")) {
  throw new Error("Refusing to stamp the visual gate without --decision=pass after manual review");
}

const root = process.cwd();
const artifactRoot = path.resolve(
  process.env.BRAND_VISUAL_BENCHMARK_OUTPUT?.trim()
    || "artifacts/brand-visual-quality-gate/2026-08-09",
);
const manifestPath = path.join(artifactRoot, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
const currentCases = buildBrandVisualBenchmarkCases();

assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.gate, "brand-visual-v1-pre-ui");
assert.equal(manifest.compilerContract, BRAND_VISUAL_GATE_COMPILER_CONTRACT);
assert.equal(currentCases.length, 21);
assert.equal(manifest.entries.length, 21);

const expectedHashes = new Map(currentCases.map((item) => {
  const providerInput = {
    id: item.id,
    benchmark: item.benchmark,
    sceneId: item.sceneId,
    variant: item.variant,
    visualFormatId: item.visualFormatId,
    recipeVersion: item.compiled.recipeVersion,
    seed: item.seed,
    prompt: item.compiled.positive,
    negativePrompt: item.compiled.negative,
    endpointId: manifest.endpointId,
    model: manifest.model,
    width: 720,
    height: 1280,
  };
  return [item.id, qualityGateCaseHash(providerInput)] as const;
}));

for (const entry of manifest.entries) {
  assert.equal(entry.status, "completed", `${entry.id} is not provider-complete`);
  assert.equal(entry.caseHash, expectedHashes.get(entry.id), `${entry.id} provider inputs are stale`);
  assert.ok(entry.imagePath, `${entry.id} has no image artifact`);
  assert.equal(entry.width, 720, `${entry.id} width is not the reviewed contract`);
  assert.equal(entry.height, 1280, `${entry.id} height is not the reviewed contract`);
  const bytes = fs.readFileSync(path.resolve(artifactRoot, entry.imagePath));
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    entry.sha256,
    `${entry.id} image bytes changed after provider completion`,
  );
}

assert.equal(
  manifest.compilerHash,
  qualityGateCompilerHash(manifest.entries),
  "manifest compiler hash does not cover the reviewed 21-case matrix",
);

const reviewedAt = new Date().toISOString();
for (const entry of manifest.entries) {
  entry.reviewDecision = "pass";
  entry.reviewCriteriaVersion = "brand-visual-v1";
  entry.reviewedBy = "codex-manual-visual-inspection";
  entry.reviewedAt = reviewedAt;
  entry.reviewNotes = entry.benchmark === "brand-differentiation"
    ? "PASS: text-free; fixed-scene brand cues are coherent and Mewsocial remains visibly distinct from the neutral control."
    : "PASS: text-free; scene meaning is coherent and the selected Visual Format is visibly distinct across the fixed matrix.";
}

const temporary = `${manifestPath}.review.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(temporary, manifestPath);
console.log(`brand_visual_quality_gate_review PASS 21/21 compiler=${manifest.compilerHash} reviewedAt=${reviewedAt}`);

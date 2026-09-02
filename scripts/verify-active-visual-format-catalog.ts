import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import loadConfig from "next/dist/server/config";
import { hasLocalMatch } from "next/dist/shared/lib/match-local-pattern";
import {
  SUPPORTED_VISUAL_FORMAT_IDS,
  VISUAL_FORMAT_IDS,
  VISUAL_FORMATS,
  compileBrandVisualPrompt,
  visualFormatThaiLabel,
} from "../src/lib/brand-visual-system";
import { visualFormatPreviewUrl } from "../src/lib/brand-visual-format-preview";

async function main() {
const resolvedNextConfig = await loadConfig(PHASE_PRODUCTION_BUILD, process.cwd(), { silent: true });
assert.equal(
  hasLocalMatch(
    resolvedNextConfig.images.localPatterns,
    "/brand-visual-formats/cinematic-realism.webp?v=reviewed-content-hash",
  ),
  true,
  "Next Image must accept content-versioned Brand Visual previews instead of returning HTTP 400",
);
assert.equal(
  hasLocalMatch(resolvedNextConfig.images.localPatterns, "/icon.svg?unreviewed=query"),
  false,
  "the preview cache-bust exception must not permit arbitrary query-bearing local images",
);
assert.deepEqual(
  VISUAL_FORMATS.map(({ id, label }) => ({ id, label })),
  [
    { id: "cinematic-realism", label: "ภาพสมจริงแบบหนัง" },
    { id: "simple-editorial-story", label: "ภาพวาดเล่าเรื่องเรียบง่าย" },
    { id: "dramatic-comic", label: "คอมิกเข้มข้น" },
    { id: "clear-infographic", label: "อินโฟกราฟิกเข้าใจง่าย" },
    { id: "retro-story", label: "เล่าเรื่องย้อนยุค" },
  ],
  "new creator choices expose exactly five active formats with Simple Editorial Story replacing Stick Figure",
);
assert.deepEqual(VISUAL_FORMAT_IDS, VISUAL_FORMATS.map((format) => format.id));
assert.equal(VISUAL_FORMAT_IDS.includes("stick-figure-story" as never), false,
  "new selections cannot create another Stick Figure profile or project look");
assert.ok(SUPPORTED_VISUAL_FORMAT_IDS.includes("stick-figure-story"),
  "the persisted format union keeps legacy Stick Figure pins readable");
assert.equal(visualFormatThaiLabel("simple-editorial-story"), "ภาพวาดเล่าเรื่องเรียบง่าย");
assert.equal(visualFormatThaiLabel("stick-figure-story"), "แนวภาพรุ่นเดิม",
  "legacy summaries never leak an internal ID or the retired format name when the active catalog hides Stick Figure");
assert.equal(existsSync("public/brand-visual-formats/simple-editorial-story.webp"), true,
  "the active format card has a local preview asset before it can be exposed by the API");

type VisualFormatSampleManifest = {
  batchId: string;
  sceneId: string;
  seed: number;
  renderer: string;
  width: number;
  height: number;
  formats: Array<{
    id: string;
    recipeVersion: string;
    file: string;
    sha256: string;
  }>;
};

const sampleRoot = path.resolve("public/brand-visual-formats");
const sampleManifestPath = path.join(sampleRoot, "manifest.json");
assert.equal(
  existsSync(sampleManifestPath),
  true,
  "the five creator-facing format cards must carry one shared-batch provenance manifest",
);
const sampleManifest = JSON.parse(readFileSync(sampleManifestPath, "utf8")) as VisualFormatSampleManifest;
assert.match(sampleManifest.batchId, /^visual-format-cards-/);
assert.equal(sampleManifest.sceneId, "hook", "every card must depict the same benchmark scene");
assert.equal(sampleManifest.seed, 202608091, "every card must use the benchmark scene's shared seed");
assert.ok(sampleManifest.renderer.trim(), "the sample renderer must be explicit");
assert.equal(sampleManifest.width, 720);
assert.equal(sampleManifest.height, 1280);
assert.deepEqual(
  sampleManifest.formats.map((item) => item.id),
  VISUAL_FORMATS.map((format) => format.id),
  "the manifest must cover exactly the active formats in creator-facing order",
);
for (const format of VISUAL_FORMATS) {
  const item = sampleManifest.formats.find((candidate) => candidate.id === format.id);
  assert.ok(item, `${format.id} must belong to the shared sample batch`);
  assert.equal(item.recipeVersion, format.recipeVersion,
    `${format.id} must preview the recipe currently offered to creators`);
  assert.equal(item.file, `${format.id}.webp`);
  assert.equal(
    visualFormatPreviewUrl(format.id),
    `/brand-visual-formats/${format.id}.webp?v=${item.sha256.slice(0, 16)}`,
    `${format.id} preview URL must change whenever the reviewed bytes change`,
  );
  const assetPath = path.join(sampleRoot, item.file);
  const bytes = readFileSync(assetPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256,
    `${format.id} must match the reviewed shared-batch asset`);
  const metadata = await sharp(bytes).metadata();
  assert.deepEqual([metadata.width, metadata.height], [sampleManifest.width, sampleManifest.height],
    `${format.id} must use the same card framing as the rest of the set`);
}

const legacyPinned = compileBrandVisualPrompt({
  visualFormatId: "stick-figure-story",
  recipeVersion: "stick-figure-story-v6",
  contentDomain: "home maintenance",
  treatment: "grounded practical explanation",
  visualBeat: {
    phase: "close",
    subject: "an adult Thai renter and a repaired tap",
    action: "the renter checks the repaired tap",
    setting: "a home kitchen in daylight",
    emotion: "quiet relief",
    emphasis: "the completed repair",
  },
});
assert.equal(legacyPinned.recipeVersion, "stick-figure-story-v6");
assert.match(legacyPinned.positive, /stick-figure marker doodle/i,
  "legacy Scene Reroll compiles the exact historical recipe instead of adopting the replacement style");

console.log("verify-active-visual-format-catalog: PASS one coherent five-card sample batch, active replacement, and legacy read compatibility");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

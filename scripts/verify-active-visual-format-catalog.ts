import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  SUPPORTED_VISUAL_FORMAT_IDS,
  VISUAL_FORMAT_IDS,
  VISUAL_FORMATS,
  compileBrandVisualPrompt,
  visualFormatThaiLabel,
} from "../src/lib/brand-visual-system";

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
assert.equal(visualFormatThaiLabel("stick-figure-story"), "ก้างปลาเล่าเรื่อง",
  "legacy summaries never leak an internal ID when the active catalog hides Stick Figure");
assert.equal(existsSync("public/brand-visual-formats/simple-editorial-story.webp"), true,
  "the active format card has a local preview asset before it can be exposed by the API");

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

console.log("verify-active-visual-format-catalog: PASS active replacement and legacy read compatibility");

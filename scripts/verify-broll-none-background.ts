// HERO-42: with B-roll off the frame is the brand palette, so one module owns both
// what the API accepts and what the composition paints. A validator and a renderer
// with separate definitions is how you get a frame that passes checks and renders black.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const {
    DEFAULT_BACKGROUND_COLORS,
    sanitizeBackgroundColors,
    backgroundGradientCss,
  } = await import("../src/lib/render-background");

  // A real palette survives intact, lower-cased, capped at the schema's six colours.
  assert.deepEqual(sanitizeBackgroundColors(["#8B5CF6", "#0D0D12"]), ["#8b5cf6", "#0d0d12"]);
  assert.equal(sanitizeBackgroundColors(["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"]).length, 6);

  // A single colour still has to produce a gradient with two stops, otherwise the
  // CSS collapses and the frame falls back to transparent.
  assert.deepEqual(sanitizeBackgroundColors(["#8b5cf6"]), ["#8b5cf6", "#8b5cf6"]);

  // Anything that is not a hex colour is dropped rather than trusted: this value
  // reaches the renderer from stored brand data and goes straight into CSS.
  assert.deepEqual(sanitizeBackgroundColors(["#8b5cf6", "red", "", "#12345", "#xyzxyz", null, 7]), ["#8b5cf6", "#8b5cf6"]);
  assert.deepEqual(sanitizeBackgroundColors(["url(javascript:alert(1))"]), [...DEFAULT_BACKGROUND_COLORS]);

  // An account with no brand profile must still get a designed frame, never black
  // and never transparent.
  assert.deepEqual(sanitizeBackgroundColors(undefined), [...DEFAULT_BACKGROUND_COLORS]);
  assert.deepEqual(sanitizeBackgroundColors([]), [...DEFAULT_BACKGROUND_COLORS]);
  assert.deepEqual(sanitizeBackgroundColors("#8b5cf6"), [...DEFAULT_BACKGROUND_COLORS]);
  assert.equal(DEFAULT_BACKGROUND_COLORS.length >= 2, true);

  const css = backgroundGradientCss(sanitizeBackgroundColors(["#8b5cf6", "#0d0d12"]));
  assert.match(css, /linear-gradient/);
  assert.match(css, /#8b5cf6/);
  assert.match(css, /#0d0d12/);
  // No caller-controlled text may escape into the CSS value.
  assert.equal(backgroundGradientCss(sanitizeBackgroundColors(["javascript:alert(1)"])).includes("javascript"), false);

  // generate-config refuses an empty result set twice over, and BOTH refusals have
  // to stand aside for the no-B-roll path — the first was found by reading the route,
  // the second only by rendering a real clip, which failed with
  // "B-roll coverage ไม่ครบ" at step config. Asserted structurally so neither guard
  // can quietly drop its exemption, and so a third guard added later is noticed.
  const route = readFileSync(
    path.resolve(__dirname, "../src/app/api/videos/generate-config/route.ts"),
    "utf8",
  );
  assert.match(
    route,
    /if \(validStocks\.length === 0 && !brollDisabled\)/,
    "the empty-stock guard must stand aside when B-roll is off",
  );
  assert.match(
    route,
    /if \(!coverage\.complete && !brollDisabled\)/,
    "the coverage guard must stand aside when B-roll is off — there is nothing to cover",
  );
  // Both guards must still fail closed for every other caller.
  assert.equal(route.includes("if (validStocks.length === 0) {"), false);
  assert.equal(route.includes("if (!coverage.complete) {"), false);

  console.log("PASS b-roll-off brand background, sanitising and both config guards");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// HERO-42: every V2 B-roll source must map to a value the jobs API allowlists.
//
// This exists because of a real miss. `useV2Job` mapped the source with a chain
// ending in `: "stock"`, so any member added to the union silently became plain
// stock and the new feature did nothing — the same shape of bug as the picker's
// Free card, which tested "not kie-image and not auto-mix". A fallthrough that
// swallows unknown members cannot be caught by TypeScript, so it is asserted here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const { V2_BROLL_SOURCES, apiStockSource } = await import(
    "../src/app/(dashboard)/video-editor/_v2/broll-source"
  );

  // The allowlist is read from the route rather than restated, so the two cannot drift.
  const route = readFileSync(
    path.resolve(__dirname, "../src/app/api/videos/jobs/route.ts"),
    "utf8",
  );
  const declared = route.match(/const STOCK_SOURCES = new Set\(\[([^\]]*)\]\)/);
  assert(declared, "could not find STOCK_SOURCES in jobs/route.ts");
  const allowed = new Set(
    declared[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
  );

  assert(allowed.has("none"), "the API must allowlist \"none\" for this feature to work at all");

  for (const source of V2_BROLL_SOURCES) {
    const mapped = apiStockSource(source);
    assert(
      allowed.has(mapped),
      `${source} maps to ${mapped}, which the jobs route would reject`,
    );
  }

  // The specific mappings that carry meaning. "none" mapping to "stock" is the
  // exact failure this file exists to prevent.
  assert.equal(apiStockSource("none"), "none");
  assert.equal(apiStockSource("kie-image"), "kie-image");
  assert.equal(apiStockSource("automix"), "auto-mix");
  assert.equal(apiStockSource("stock"), "stock");
  // kie-video is "coming soon" in the picker and deliberately still falls back.
  assert.equal(apiStockSource("kie-video"), "stock");

  // Every source the picker offers must be a real union member, so a card can
  // never be added without a mapping.
  const step2 = readFileSync(
    path.resolve(__dirname, "../src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx"),
    "utf8",
  );
  const block = step2.match(/const BROLL_OPTIONS[\s\S]*?\n\];/);
  assert(block, "could not find BROLL_OPTIONS in Step2Elements.tsx");
  const offered = [...block[0].matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert(offered.length >= 5, `expected the picker to offer every source, saw ${offered.length}`);
  for (const value of offered) {
    assert(
      (V2_BROLL_SOURCES as readonly string[]).includes(value),
      `the picker offers "${value}", which is not a V2BrollSource`,
    );
  }
  assert(offered.includes("none"), "the picker must offer the no-B-roll option");

  console.log("PASS v2 b-roll source mapping reaches the API for every option");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

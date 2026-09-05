import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { activeStylePacks } from "../src/lib/style-pack-catalog";
import { stylePackSample } from "../src/lib/style-pack-samples";
import manifest from "../src/lib/style-pack-sample-manifest.json";

async function main() {
  for (const pack of activeStylePacks()) {
    const sample = stylePackSample(pack.id);
    assert.equal(sample.status, "illustrative", `${pack.id}: current recipe must have an honest illustration`);
    const entry = manifest.entries.find((e) => e.id === pack.id)!;
    const bytes = readFileSync(`public${sample.imageUrl}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${pack.id}: provenance hash`);
    const decoded = await sharp(bytes).metadata();
    assert.equal(decoded.width, 720); assert.equal(decoded.height, 1280);
    assert.ok(bytes.length <= 120 * 1024);
    assert.equal(entry.review.status, "agent-reviewed");
  }
  assert.equal(stylePackSample("dark-story").status, "unavailable", "unqualified packs do not acquire sample claims");
  console.log("PASS seven versioned, decodable, size-limited style samples match their catalog identity and hashes");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

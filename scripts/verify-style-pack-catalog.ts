import assert from "node:assert/strict";
import * as cat from "../src/lib/style-pack-catalog";
import { TREATMENT_PRESET_IDS } from "../src/lib/brand-treatment-catalog";
import { VISUAL_FORMAT_IDS } from "../src/lib/brand-visual-system";
import { normalizeSubtitleStylePresetConfig } from "../src/lib/editor-style-preset-contract";

assert.equal(cat.STYLE_PACKS.length, 12);
assert.equal(cat.activeStylePacks().length, 7);
for (const pack of cat.STYLE_PACKS) {
  assert.ok(/[฀-๿]/u.test(pack.thaiLabel));
  assert.ok(VISUAL_FORMAT_IDS.includes(pack.visualFormatId));
  if (pack.status === "active") assert.ok((TREATMENT_PRESET_IDS as readonly string[]).includes(pack.treatmentPresetId), `${pack.id} active pack must use a qualified treatment`);
  assert.match(pack.stockMood.queryToken, /^[a-z]+$/);
  assert.ok(pack.stockMood.positive.length >= 8 && pack.stockMood.avoid.length >= 4 && pack.stockMood.fallbackQueries.length === 5);
  assert.ok(pack.stockMood.direction.split(/\s+/).length <= 20);
  assert.ok(pack.palette.every((hex) => /^#[0-9A-F]{6}$/.test(hex)));
  assert.deepEqual(normalizeSubtitleStylePresetConfig(pack.subtitle), pack.subtitle, `${pack.id} subtitle must satisfy the preset contract`);
  assert.ok([...pack.tagline].length <= 40, `${pack.id} tagline must be <= 40 code points`);
  assert.ok([...pack.personality].length <= 60, `${pack.id} personality must be <= 60 code points`);
}
assert.equal(cat.stylePackForTreatment("thai-supernatural-horror")?.id, "thai-ghost");
assert.equal(cat.stylePackForTreatment("dharma-storytelling"), null, "pending packs are never recommended");
assert.deepEqual(cat.PACING_CADENCE_MULTIPLIER, { slow: 1.6, normal: 1, fast: 0.7 });
console.log("verify-style-pack-catalog: ok");

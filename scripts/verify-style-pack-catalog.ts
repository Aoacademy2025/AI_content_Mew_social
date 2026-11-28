import assert from "node:assert/strict";
import * as cat from "../src/lib/style-pack-catalog";
import { TREATMENT_PRESET_IDS } from "../src/lib/brand-treatment-catalog";
import { VISUAL_FORMAT_IDS } from "../src/lib/brand-visual-system";
import { isBrollTransition } from "../src/lib/broll-window-style";
import { normalizeSubtitleStylePresetConfig } from "../src/lib/editor-style-preset-contract";
import { isHeadlineHookPreset } from "../src/lib/headline-hook";
import { isSfxMode } from "../src/lib/transition-sfx";

assert.equal(cat.STYLE_PACKS.length, 21);
assert.equal(cat.activeStylePacks().length, 16);
assert.deepEqual(
  cat.activeStylePacks().map((p) => p.id),
  [...cat.ACTIVE_STYLE_PACK_IDS],
  "ACTIVE_STYLE_PACK_IDS stays in exact order sync with activeStylePacks()",
);
// HERO-35, HERO-94 & Trending Style Packs: shared treatments preserve existing first-match tie-breaks
// (`life-drama` for human drama, `finance-clear` for clear-infographic × expert-clarity,
// `premium-product` for cinematic-realism × premium-product-lifestyle,
// `news-fast` for cinematic-realism × investigative-news-crime).
assert.equal(cat.stylePack("comic-story").visualFormatId, "dramatic-comic");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "thai-human-drama", visualFormatId: "cinematic-realism" })?.id, "life-drama");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "thai-human-drama", visualFormatId: "dramatic-comic" })?.id, "comic-story");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "expert-clarity", visualFormatId: "clear-infographic" })?.id, "finance-clear");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "expert-clarity", visualFormatId: "simple-editorial-story" })?.id, "health-simple");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "premium-product-lifestyle", visualFormatId: "cinematic-realism" })?.id, "premium-product");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "modern-business-technology", visualFormatId: "cinematic-realism" })?.id, "ai-tech-doc");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "investigative-news-crime", visualFormatId: "cinematic-realism" })?.id, "news-fast");
assert.equal(cat.stylePackForRecommendation({ treatmentPresetId: "practical-documentary", visualFormatId: "cinematic-realism" })?.id, "self-growth");
for (const pack of cat.STYLE_PACKS) {
  assert.ok(/[฀-๿]/u.test(pack.thaiLabel));
  assert.ok(VISUAL_FORMAT_IDS.includes(pack.visualFormatId));
  if (pack.status === "active") assert.ok((TREATMENT_PRESET_IDS as readonly string[]).includes(pack.treatmentPresetId), `${pack.id} active pack must use a qualified treatment`);
  assert.match(pack.stockMood.queryToken, /^[a-z]+$/);
  assert.ok(pack.stockMood.positive.length >= 8 && pack.stockMood.avoid.length >= 4 && pack.stockMood.fallbackQueries.length === 5);
  assert.ok(pack.stockMood.direction.split(/\s+/).length <= 20);
  assert.ok(pack.palette.every((hex) => /^#[0-9A-F]{6}$/.test(hex)));
  assert.deepEqual(normalizeSubtitleStylePresetConfig(pack.subtitle), pack.subtitle, `${pack.id} subtitle must satisfy the preset contract`);
  const mergedSub = cat.stylePackSubtitlePreset(pack);
  assert.deepEqual(normalizeSubtitleStylePresetConfig(mergedSub), mergedSub, `${pack.id} merged template subtitle preset must satisfy the preset contract`);
  assert.ok(isHeadlineHookPreset(pack.headlineHookPreset), `${pack.id} headlineHookPreset must be valid`);
  assert.equal(typeof pack.highlightKeywords, "boolean");
  assert.equal(typeof pack.statCards, "boolean");
  assert.ok(isSfxMode(pack.sfxMode), `${pack.id} sfxMode must be valid`);
  assert.equal(typeof pack.punchZoom, "boolean");
  assert.ok(isBrollTransition(pack.brollTransition), `${pack.id} brollTransition must be valid`);
  assert.ok([...pack.tagline].length <= 40, `${pack.id} tagline must be <= 40 code points`);
  assert.ok([...pack.personality].length <= 60, `${pack.id} personality must be <= 60 code points`);
}
assert.equal(cat.stylePackForTreatment("thai-supernatural-horror")?.id, "thai-ghost");
assert.equal(cat.stylePackForTreatment("dharma-storytelling"), null, "pending packs are never recommended");
assert.deepEqual(cat.PACING_CADENCE_MULTIPLIER, { slow: 1.6, normal: 1, fast: 0.7 });
console.log("verify-style-pack-catalog: ok");

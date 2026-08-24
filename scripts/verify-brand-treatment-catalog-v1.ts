import assert from "node:assert/strict";
import {
  GENERIC_TREATMENT_PLACEHOLDER,
  TREATMENT_PRESETS,
  catalogTreatmentPinForVersion,
  createCatalogTreatmentPin,
  isGenericTreatmentPlaceholder,
  parseTreatmentPin,
  treatmentPromptDirection,
  treatmentPresetThaiLabel,
} from "../src/lib/brand-treatment-catalog";
import { createBlankBrandProfileSeed } from "../src/lib/brand-profile-seed";

const expectedCatalog = [
  ["expert-clarity", "ผู้เชี่ยวชาญอธิบายชัด"],
  ["practical-documentary", "สาธิตจากชีวิตจริง"],
  ["thai-human-drama", "ดราม่าชีวิตไทย"],
  ["modern-business-technology", "ธุรกิจและเทคทันสมัย"],
  ["premium-product-lifestyle", "โฆษณาสินค้าพรีเมียม"],
  ["investigative-news-crime", "ข่าวสืบสวนเข้มข้น"],
  ["thai-history-period-storytelling", "ประวัติศาสตร์และตำนานไทย"],
  ["thai-supernatural-horror", "หนังผีไทย"],
] as const;

assert.deepEqual(
  TREATMENT_PRESETS.map((preset) => [preset.id, preset.thaiLabel]),
  expectedCatalog,
  "the approved V1 catalog is closed, ordered, and creator-facing in Thai",
);

for (const [id, thaiLabel] of expectedCatalog) {
  const pin = createCatalogTreatmentPin(id, "adaptive");
  assert.equal(pin.kind, "catalog");
  assert.equal(pin.presetId, id);
  assert.match(pin.version, /^v1\./, "every catalog selection pins an immutable V1 version");
  assert.equal(treatmentPresetThaiLabel(pin), thaiLabel);
  assert.ok(treatmentPromptDirection(pin).length > 20);
  assert.ok(TREATMENT_PRESETS.find((preset) => preset.id === id)?.versions.some(
    (recipe) => recipe.version === pin.version,
  ), "the current version is retained in the append-only recipe registry");
  assert.deepEqual(parseTreatmentPin(JSON.stringify(pin)), pin);
}
assert.equal(catalogTreatmentPinForVersion("expert-clarity", "v1.99.0", "adaptive"), null);

const blankProfile = createBlankBrandProfileSeed();
assert.equal(blankProfile.visual.treatmentPolicy, "adaptive");
assert.equal(blankProfile.visual.lockedTreatmentPresetId, null);

assert.equal(isGenericTreatmentPlaceholder(GENERIC_TREATMENT_PLACEHOLDER), true);
assert.equal(isGenericTreatmentPlaceholder(` ${GENERIC_TREATMENT_PLACEHOLDER} `), true);
assert.equal(isGenericTreatmentPlaceholder("ชัดเจน สมดุล และอ่านเรื่องได้ทันที"), false);
assert.equal(parseTreatmentPin(JSON.stringify({
  kind: "legacy-custom",
  value: "creator-authored vintage warmth",
  source: "legacy",
})), null, "new pin parsing never turns arbitrary free text into a catalog pin");

console.log("verify-brand-treatment-catalog-v1: PASS closed catalog, Thai labels, versioned pins, adaptive default");

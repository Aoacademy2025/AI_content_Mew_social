import assert from "node:assert/strict";
import {
  brandProfilePayloadSchema,
  resolveBrandProfileTreatmentPolicy,
} from "../src/lib/brand-profile-library.server";
import { createBlankBrandProfileSeed } from "../src/lib/brand-profile-seed";
import { brandLookPreviewTreatment } from "../src/lib/brand-look-preview.server";

const current = { ...createBlankBrandProfileSeed(), name: "Benchmark Brand" };
const adaptive = brandProfilePayloadSchema.parse(current);
assert.deepEqual(resolveBrandProfileTreatmentPolicy(adaptive), { policy: "adaptive" });

const legacy = structuredClone(current) as Record<string, unknown> & {
  visual: Record<string, unknown>;
};
delete legacy.visual.treatmentPolicy;
delete legacy.visual.lockedTreatmentPresetId;
const parsedLegacy = brandProfilePayloadSchema.parse(legacy);
assert.deepEqual(
  resolveBrandProfileTreatmentPolicy(parsedLegacy),
  { policy: "adaptive" },
  "a stored pre-V1 profile remains readable and adopts the zero-friction adaptive policy",
);

const locked = brandProfilePayloadSchema.parse({
  ...current,
  visual: {
    ...current.visual,
    treatmentPolicy: "locked",
    lockedTreatmentPresetId: "thai-supernatural-horror",
  },
});
assert.deepEqual(resolveBrandProfileTreatmentPolicy(locked), {
  policy: "locked",
  treatmentPresetId: "thai-supernatural-horror",
});

const adaptivePreview = brandLookPreviewTreatment({
  ...adaptive,
  visual: { ...adaptive.visual, defaultTreatment: "creator free form must be ignored" },
});
assert.equal(adaptivePreview.treatmentPin, undefined);
assert.doesNotMatch(adaptivePreview.treatment, /creator free form/i);
const lockedPreview = brandLookPreviewTreatment(locked);
assert.equal(lockedPreview.treatmentPin?.presetId, "thai-supernatural-horror");
assert.equal(lockedPreview.treatmentPin?.version, "v1.0.0");

assert.equal(brandProfilePayloadSchema.safeParse({
  ...current,
  visual: {
    ...current.visual,
    treatmentPolicy: "locked",
    lockedTreatmentPresetId: null,
  },
}).success, false, "locked policy cannot publish without one approved catalog option");

assert.equal(brandProfilePayloadSchema.safeParse({
  ...current,
  visual: {
    ...current.visual,
    treatmentPolicy: "locked",
    lockedTreatmentPresetId: "creator free-form treatment",
  },
}).success, false, "locked policy cannot create a free-form treatment");

console.log("verify-brand-treatment-profile-policy-v1: PASS adaptive compatibility and catalog-only locked policy");

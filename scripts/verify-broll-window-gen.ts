// Compatibility entrypoint for the per-window image verification. The product
// now uses Hero AI Image/RunPod; the migration contract exercises the real
// route and browser seams. Keep the KIE auth classification assertions because
// KIE remains a separate Cloud API/AutoMix engine.
import assert from "node:assert/strict";
import "./verify-hero-broll-window-migration";
import {
  interpretKieCreditResponse,
  isKieAuthenticationError,
} from "../src/lib/kie-client";

assert.equal(
  isKieAuthenticationError(new Error("kie.ai createTask error: Unauthorized – Authentication failed")),
  true,
);
assert.equal(
  isKieAuthenticationError(new Error("kie.ai task timed out after 180000ms")),
  false,
);
const authFailure = interpretKieCreditResponse(200, { code: 401, msg: "Unauthorized" });
assert.equal(authFailure.ok, false);
if (!authFailure.ok) assert.equal(authFailure.reason, "auth");
const creditOk = interpretKieCreditResponse(200, { code: 200, data: 12.5 });
assert.deepEqual(creditOk, { ok: true, credits: 12.5 });

import { parseHeroBrollWindowRequest } from "../src/lib/broll-window-hero";
import { TREATMENT_PRESET_IDS, isTreatmentPresetId, createCatalogTreatmentPin, treatmentPromptDirection } from "../src/lib/brand-treatment-catalog";
import { compileBrandVisualPrompt, visualBeatFromCustomPrompt, MAX_HERO_BROLL_CUSTOM_PROMPT_LENGTH } from "../src/lib/brand-visual-system";

// HERO-65: per-window treatment preset + custom prompt contract
assert.equal(isTreatmentPresetId("practical-documentary"), true);
assert.equal(isTreatmentPresetId("not-a-preset"), false);
const withOverrides = parseHeroBrollWindowRequest({
  requestId: "fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3",
  videoJobId: "video-job-123456",
  sceneIndex: 1,
  durationSec: 6,
  treatment: "thai-human-drama",
  prompt: "  บาริสต้าเทลาเต้อาร์ตบนเคาน์เตอร์ไม้แสงเช้าอบอุ่น  ",
});
assert.equal(withOverrides.ok, true);
if (withOverrides.ok) {
  assert.equal(withOverrides.value.treatment, "thai-human-drama");
  assert.equal(withOverrides.value.prompt, "บาริสต้าเทลาเต้อาร์ตบนเคาน์เตอร์ไม้แสงเช้าอบอุ่น");
}
const invalidTreatment = parseHeroBrollWindowRequest({
  requestId: "fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3",
  videoJobId: "video-job-123456",
  sceneIndex: 1,
  durationSec: 6,
  treatment: "invalid-style",
});
assert.equal(invalidTreatment.ok, false);
if (!invalidTreatment.ok) assert.equal(invalidTreatment.error, "invalid_treatment");

const overlongPrompt = parseHeroBrollWindowRequest({
  requestId: "fdfbf8f4-1964-4ac8-98f7-6cc25bf86fd3",
  videoJobId: "video-job-123456",
  sceneIndex: 1,
  durationSec: 6,
  prompt: "ก".repeat(MAX_HERO_BROLL_CUSTOM_PROMPT_LENGTH + 1),
});
assert.equal(overlongPrompt.ok, false);
if (!overlongPrompt.ok) assert.equal(overlongPrompt.error, "prompt_too_long");

const maxLenPromptText = "a ".repeat(220) + "barista pouring latte art";
const customBeat = visualBeatFromCustomPrompt(maxLenPromptText, "explain");
assert.ok(customBeat.subject.includes("barista pouring latte art"), "500-char custom prompt is not truncated at 260 chars");
for (const presetId of TREATMENT_PRESET_IDS) {
  const pin = createCatalogTreatmentPin(presetId, "creator");
  const compiled = compileBrandVisualPrompt({
    visualFormatId: "cinematic-realism",
    contentDomain: "coffee shop",
    treatment: treatmentPromptDirection(pin),
    treatmentPin: pin,
    visualBeat: customBeat,
  });
  assert.ok(compiled.positive.includes("barista pouring latte art"));
  assert.equal(compiled.treatmentPin?.presetId, presetId);
}

console.log("verify-broll-window-gen: ALL PASS");

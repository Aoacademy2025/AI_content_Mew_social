import assert from "node:assert/strict";
import { createBlankBrandProfileSeed } from "../src/lib/brand-profile-seed";
import { TREATMENT_PRESET_IDS } from "../src/lib/brand-treatment-catalog";
import { VISUAL_FORMAT_IDS } from "../src/lib/brand-visual-system";
import { activeStylePacks, stylePack } from "../src/lib/style-pack-catalog";
import {
  applyStylePackToPayload,
  clearStylePack,
  stylePackOfPayload,
} from "../src/lib/style-pack-apply";
import type { BrandProfilePayload } from "../src/lib/brand-profile-library.server";

// ── The blank seed carries the two pack columns, unset ──────────────────────
const seed = createBlankBrandProfileSeed();
assert.equal(
  seed.visual.stylePackId,
  null,
  "a new brand starts with no pack applied — the look is whatever the creator authors",
);
assert.equal(seed.visual.stylePackVersion, null, "no pack means no pinned pack version");

/** The blank seed as a fully-defaulted payload (the two retired scene inputs
 *  and languageMode are supplied by the Zod defaults on a real write). */
function blankPayload(): BrandProfilePayload {
  const blank = createBlankBrandProfileSeed();
  return {
    ...blank,
    visual: {
      ...blank.visual,
      peopleAndSetting: "",
      memorableCues: [],
      stylePackId: null,
      stylePackVersion: null,
    },
  };
}

const ghostPack = stylePack("thai-ghost");

// ── One tap resolves the whole look onto the existing payload axes ──────────
const ghost = applyStylePackToPayload(blankPayload(), ghostPack);
assert.equal(ghost.visual.stylePackId, "thai-ghost");
assert.equal(ghost.visual.stylePackVersion, "v1.0.0");
assert.equal(
  ghost.visual.primaryVisualFormatId,
  "cinematic-realism",
  "the pack resolves onto the existing Visual Format axis, it does not add a third axis",
);
assert.equal(ghost.visual.treatmentPolicy, "locked");
assert.equal(ghost.visual.lockedTreatmentPresetId, "thai-supernatural-horror");
assert.deepEqual(ghost.visual.palette, ["#0B0F1A", "#7C1D2B", "#C9A24C"]);
assert.equal(ghost.visual.personality, ghostPack.personality);
assert.equal(ghost.subtitle.config.preset, "bold-shadow");
assert.deepEqual(
  ghost.subtitle.config,
  { ...ghostPack.subtitle },
  "a creator who never chose a subtitle style gets the pack's full subtitle contract",
);
assert.equal(ghost.script.tone, ghostPack.scriptTone);

// ── Applying a pack never mutates the payload it was handed ─────────────────
const untouched = blankPayload();
const untouchedJson = JSON.stringify(untouched);
applyStylePackToPayload(untouched, ghostPack);
assert.equal(
  JSON.stringify(untouched),
  untouchedJson,
  "applying a pack is pure — the caller's payload is never mutated in place",
);

// ── A creator's own choices win over the pack ───────────────────────────────
const ownSubtitlePayload: BrandProfilePayload = {
  ...blankPayload(),
  subtitle: { presetId: "mine", config: { preset: "box", fontSize: 42 } },
};
const ownSubtitleApplied = applyStylePackToPayload(ownSubtitlePayload, ghostPack);
assert.deepEqual(
  ownSubtitleApplied.subtitle,
  { presetId: "mine", config: { preset: "box", fontSize: 42 } },
  "a creator who saved their own subtitle style keeps it when a pack is applied",
);
assert.equal(
  ownSubtitleApplied.visual.stylePackId,
  "thai-ghost",
  "keeping an own subtitle style does not stop the rest of the pack from applying",
);

const customTone = "เล่าแบบพี่สอนน้อง ใช้คำง่าย";
const customTonePayload: BrandProfilePayload = {
  ...blankPayload(),
  script: { ...blankPayload().script, tone: customTone },
};
assert.equal(
  applyStylePackToPayload(customTonePayload, ghostPack).script.tone,
  customTone,
  "an authored tone is the creator's writing, not a default the pack may overwrite",
);
assert.equal(
  applyStylePackToPayload(customTonePayload, ghostPack).visual.stylePackId,
  "thai-ghost",
);

// ── Packs awaiting the benchmark are never selectable (ADR 0058) ────────────
assert.throws(
  () => applyStylePackToPayload(blankPayload(), stylePack("dharma")),
  (error: unknown) => error instanceof Error && error.message === "ชุดสไตล์นี้ยังไม่เปิดให้ใช้",
  "a pending-benchmark pack cannot be applied, and says so in Thai",
);

// ── Clearing keeps the resolved look; only the pack link goes ───────────────
const cleared = clearStylePack(ghost);
assert.equal(cleared.visual.stylePackId, null);
assert.equal(cleared.visual.stylePackVersion, null);
assert.equal(cleared.visual.treatmentPolicy, "locked");
assert.equal(cleared.visual.lockedTreatmentPresetId, "thai-supernatural-horror");
assert.deepEqual(cleared.visual.palette, ghost.visual.palette);
assert.equal(cleared.visual.personality, ghost.visual.personality);
assert.deepEqual(cleared.subtitle.config, ghost.subtitle.config);
assert.equal(cleared.script.tone, ghost.script.tone);
const clearedSource = JSON.stringify(ghost);
clearStylePack(ghost);
assert.equal(JSON.stringify(ghost), clearedSource, "clearing is pure too");

// ── Reading the pack back off a payload ─────────────────────────────────────
assert.equal(stylePackOfPayload(ghost)?.id, "thai-ghost");
assert.equal(stylePackOfPayload(cleared), null, "a cleared look is custom, not a pack");
assert.equal(stylePackOfPayload(blankPayload()), null);

// ── Every active pack lands on axes the payload can actually hold ───────────
for (const pack of activeStylePacks()) {
  const applied = applyStylePackToPayload(blankPayload(), pack);
  assert.ok(
    (VISUAL_FORMAT_IDS as readonly string[]).includes(applied.visual.primaryVisualFormatId),
    `${pack.id} must resolve to a Visual Format a new write can select`,
  );
  assert.equal(applied.visual.treatmentPolicy, "locked", `${pack.id} pins one narrative treatment`);
  assert.ok(
    applied.visual.lockedTreatmentPresetId
      && (TREATMENT_PRESET_IDS as readonly string[]).includes(applied.visual.lockedTreatmentPresetId),
    `${pack.id} must resolve to a qualified treatment preset`,
  );
  assert.equal(applied.visual.stylePackVersion, pack.version);
  assert.equal(stylePackOfPayload(applied)?.id, pack.id);
}

console.log("verify-style-pack-apply: PASS pack applies onto the payload, pending packs refused");

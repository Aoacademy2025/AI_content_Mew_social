import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Every literal in a UI source that already contains Thai — i.e. the strings a
 * customer actually reads. Comments and imports are stripped first so an
 * explanatory comment about the Treatment catalog is not mistaken for copy. */
function thaiCustomerCopy(source: string): string[] {
  const withoutNoise = source
    .replace(/^import [\s\S]*?;$/gmu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
  const literals = withoutNoise.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`|>[^<>{}]+</gu) ?? [];
  return literals.filter((literal) => /[\u0E00-\u0E7F]/u.test(literal));
}

async function main() {
  const {
    buildTreatmentChoiceGroups,
    buildVisualSummary,
    lookChangeConfirmation,
  } = await import("../src/lib/brand-treatment-presentation");

  const groups = buildTreatmentChoiceGroups("thai-supernatural-horror", [
    "thai-supernatural-horror",
    "thai-human-drama",
    "thai-history-period-storytelling",
  ]);
  assert.deepEqual(groups.featured.map((option) => option.id), [
    "thai-supernatural-horror",
    "thai-human-drama",
    "thai-history-period-storytelling",
  ]);
  assert.equal(groups.featured[0]?.role, "recommended");
  assert.equal(groups.featured[1]?.role, "alternative");
  assert.equal(groups.all.length, 8);
  assert.ok(groups.all.every((option) => /[\u0E00-\u0E7F]/u.test(option.label)));
  assert.equal(buildVisualSummary("คนสมจริง", "หนังผีไทย"), "คนสมจริง · หนังผีไทย");
  assert.equal(
    buildVisualSummary("ภาพสมจริงแบบหนัง", "หนังผีไทย"),
    "คนสมจริง · หนังผีไทย",
    "the existing long catalog label must collapse to the plain-language project summary",
  );
  assert.equal(buildVisualSummary("คนสมจริง", "anything", true), "คนสมจริง · ใช้แนวที่ตั้งไว้เดิม");

  // Wave 1 Task 7: when the clip's look IS a Style Pack, the summary says the
  // pack's own Thai name and where it came from — the pack is the whole look,
  // so repeating the format/treatment underneath it would only add noise.
  assert.equal(
    buildVisualSummary("คนสมจริง", "หนังผีไทย", false, { thaiLabel: "หนังผีไทย", source: "project" }),
    "หนังผีไทย · จากคลิปนี้",
    "a pack chosen for this clip is reported as this clip's own choice",
  );
  assert.equal(
    buildVisualSummary("คนสมจริง", "หนังผีไทย", false, { thaiLabel: "หนังผีไทย", source: "brand" }),
    "หนังผีไทย · จากแบรนด์",
    "a pack inherited from the Brand says so, so the creator knows what changing it affects",
  );
  assert.equal(
    buildVisualSummary("คนสมจริง", "หนังผีไทย", false, null),
    "คนสมจริง · หนังผีไทย",
    "a custom look keeps the existing format · treatment summary",
  );

  const confirmation = lookChangeConfirmation(4, 2);
  assert.equal(confirmation.quotedCredits, 8);
  assert.deepEqual(confirmation.options.map((option) => option.id), ["regenerate-all"]);
  assert.doesNotMatch(JSON.stringify(confirmation), /new-only|เฉพาะภาพที่สร้างต่อจากนี้/);

  const selectorSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx",
    "utf8",
  );
  assert.match(
    selectorSource,
    /aria-controls="brand-visual-options"[\s\S]*เปลี่ยนแนวเล่าเรื่อง/,
    "the narrative-style action must be a dedicated, labelled disclosure button",
  );
  assert.match(
    selectorSource,
    /disabled=\{brandSelectionDisabled\}[\s\S]*brand-profile-analysis-help/,
    "brand selection must stay disabled until the current content analysis is ready",
  );
  assert.match(
    selectorSource,
    /ยังไม่มีการเปลี่ยนแบรนด์หรือคิดเครดิตภาพ/,
    "analysis failures must reassure customers that the failed attempt changed nothing and spent no image credit",
  );
  assert.match(
    selectorSource,
    /const canChooseFormatBeforeTranscript = p\.mode === "upload" && !narrative;/,
    "upload Step 2 must expose image-format selection before transcription",
  );
  assert.match(
    selectorSource,
    /deferTreatmentUntilPreflight: !treatmentPresetId/,
    "a pre-transcript format choice must defer content treatment to the upload analysis",
  );
  assert.match(
    selectorSource,
    /canManageBrandVisual && \(selectedTreatmentPresetId \|\| canChooseFormatBeforeTranscript\)[\s\S]*formats\.map/,
    "fresh uploads must render the image-format choices even without an analyzed treatment",
  );
  assert.doesNotMatch(selectorSource, /ก้างปลา/, "retired format name must not reach creators");
  // Wave 1 Task 7: the per-clip pack picker.
  assert.match(
    selectorSource,
    /import \{ StylePackPicker \} from "@\/app\/\(dashboard\)\/brands\/_components\/StylePackPicker"/,
    "the editor reuses the one pack picker instead of duplicating the catalog on the client",
  );
  assert.match(
    selectorSource,
    /setPackPickerOpen\(\(value\) => !value\)[\s\S]{0,600}?เปลี่ยนเฉพาะคลิปนี้/u,
    "เปลี่ยนเฉพาะคลิปนี้ is the affordance that opens the ready-made style picker",
  );
  assert.match(
    selectorSource,
    /\{packPickerOpen && [\s\S]{0,200}?<StylePackPicker/u,
    "the picker is what that affordance reveals",
  );
  assert.match(
    selectorSource,
    /look: \{ stylePackId: packId \}/,
    "choosing a pack goes through the SAME Project Look save path, guard included",
  );
  assert.match(
    selectorSource,
    /stylePackId: null/,
    "กำหนดเอง unlinks the pack through the same save path",
  );
  assert.doesNotMatch(
    selectorSource,
    /STYLE_PACKS|activeStylePacks/,
    "the pack catalog must reach this client only through the server payload",
  );
  // Customer copy is Thai. English SYSTEM names are the leak this guards: any
  // literal that already contains Thai is customer-facing, so an internal name
  // sitting inside one is a bug, while identifiers like `treatmentPresetId`
  // are code and must stay readable.
  for (const file of [
    "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx",
    "src/app/(dashboard)/brands/_components/StylePackPicker.tsx",
  ]) {
    for (const copy of thaiCustomerCopy(readFileSync(file, "utf8"))) {
      assert.doesNotMatch(
        copy,
        /Treatment|Preset|Pin|Trend Pack|Style Pack|Brand Visual|Hero AI Image|Video Editor|ก้างปลา/u,
        `${file} leaks an English system name into customer copy: ${copy}`,
      );
    }
  }
  const brandVisualSystemSource = readFileSync("src/lib/brand-visual-system.ts", "utf8");
  assert.doesNotMatch(
    brandVisualSystemSource,
    /ก้างปลา/,
    "the retired format's catalog entry (label/description) must not reach creators via visualFormatThaiLabel or any format list",
  );
  for (const file of [
    "src/app/(dashboard)/brands/_components/BrandVisualLockedPreview.tsx",
    "src/lib/brand-visual-access.server.ts",
    "src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /Brand Visual|Hero AI Image|Video Editor/, `${file} leaks an English system name`);
  }

  const visualContextRouteSource = readFileSync(
    "src/app/api/editor-projects/[id]/visual-context/route.ts",
    "utf8",
  );
  assert.match(
    visualContextRouteSource,
    /deferTreatmentUntilPreflight === true[\s\S]*saveUploadProjectVisualFormatAwaitingPreflight/,
    "the Step 2 API must persist a pre-transcript image-format choice at the deferred server seam",
  );
  assert.match(
    visualContextRouteSource,
    /context\.source === "project-look"[\s\S]*stylePackSnapshotFromJson\([\s\S]*visualRecipeJson/,
    "the per-clip pack pinned on the project context must be read BEFORE the Brand recipe",
  );
  assert.match(
    visualContextRouteSource,
    /return NextResponse\.json\(\{[\s\S]*\n\s+stylePackSource,\n/u,
    "Step 2 must be told whether the pack came from this clip or from the Brand",
  );

  console.log("verify-brand-treatment-ui-v1: PASS Thai catalog, upload pre-transcript format choice, guarded brand selection, all-or-cancel");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

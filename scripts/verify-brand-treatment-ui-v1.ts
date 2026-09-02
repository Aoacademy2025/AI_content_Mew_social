import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

  console.log("verify-brand-treatment-ui-v1: PASS Thai catalog, upload pre-transcript format choice, guarded brand selection, all-or-cancel");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

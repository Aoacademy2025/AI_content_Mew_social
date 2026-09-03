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
  // Every pending look change must have somewhere to be confirmed. A clip that
  // already has AI images answers a style change with the all-or-cancel 409, so
  // without this branch the creator gets a blocked Step 2 and a blank panel.
  assert.match(
    selectorSource,
    /\{pending\?\.kind === "pack" && <PendingChangeConfirmation/u,
    "a per-clip style change over existing images must render the same confirmation as every other look change",
  );
  // Changing format or treatment unlinks the pack SERVER-side, so the panel has
  // to re-read the authoritative style; otherwise Step 2 keeps naming a pack
  // that is gone and the per-window search keeps sending its stock mood.
  assert.match(
    selectorSource,
    /await loadContext\(\);[^;]*?\n\s*toast\.success\([\s\S]{0,200}?บันทึกแนวภาพของคลิปนี้แล้ว/u,
    "a format/treatment change must refresh the pinned style it just unlinked",
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

  // ── Wave 1b Task 3 (#430): every plan can pin, AI images stay gated ────────
  // R7: the client must never OFFER an AI-image affordance for an unadmitted
  // pin — these source guards pin each migrated call site to the ADMITTED
  // predicate (`hasAdmittedVisualPin` project-level / `brandVisualAllowed`
  // account-level) instead of the bare pin, and freeze the one deliberate
  // exception (D2's pack-context transmission, which must stay on the bare
  // pin so an unadmitted pin still renders with its pinned style).
  assert.match(
    selectorSource,
    /คลิปนี้ใช้ชุดสไตล์กับฟุตเทจ ซับ และเพลงแล้ว · ภาพ AI ของแบรนด์ยังไม่เปิดสำหรับแผนนี้/,
    "a pinned-but-unadmitted project must disclose that images are not part of the pack, verbatim",
  );
  assert.match(
    selectorSource,
    /p\.hasPersistedVisualPin && !p\.hasAdmittedVisualPin[\s\S]{0,300}?คลิปนี้ใช้ชุดสไตล์กับฟุตเทจ/u,
    "the notice must key off a pin that exists without image admission, not off library access",
  );
  assert.match(
    selectorSource,
    /p\.setHasAdmittedVisualPin\(visualResult\.body\.hasAdmittedVisualPin === true\)/,
    "the panel must re-read the render-time admitted predicate from the server on every context load",
  );

  const stepTwoElementsSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx",
    "utf8",
  );
  assert.match(
    stepTwoElementsSource,
    /const hasFunding = p\.hasAdmittedVisualPin \|\| starterRemaining\(p\) === null/,
    "the AI-image source cards' funding check must read the admitted pin",
  );
  assert.match(
    stepTwoElementsSource,
    /const hasAiRenderAccess = p\.heroAiImageEligible \|\| p\.hasAdmittedVisualPin/,
    "the AI-image source cards' access check must read the admitted pin",
  );
  assert.match(
    stepTwoElementsSource,
    /const locked = !\(p\.heroAiImageEligible \|\| p\.hasAdmittedVisualPin\)/,
    "the AutoMix intensity lock must read the admitted pin, matching the source cards",
  );
  assert.doesNotMatch(
    stepTwoElementsSource,
    /hasFunding = p\.hasPersistedVisualPin|hasAiRenderAccess = p\.heroAiImageEligible \|\| p\.hasPersistedVisualPin|locked = !\(p\.heroAiImageEligible \|\| p\.hasPersistedVisualPin\)/,
    "no AI-image source affordance may fall back to reading the bare pin",
  );

  const editorJobSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Job.ts",
    "utf8",
  );
  assert.match(
    editorJobSource,
    /disclosedAiSlots !== null\s*\n\s*&& \(p\.brandVisualAllowed \|\| p\.hasAdmittedVisualPin\)/,
    "sizing the retained-AI-image disclosure must read the admitted pin",
  );
  // D2 exception (deliberate, do not migrate): the pinned pack's context must
  // reach the render for a library user with a pin regardless of admission,
  // so this ONE call site stays on the bare pin.
  assert.match(
    editorJobSource,
    /\(p\.brandVisualAllowed \|\| p\.hasPersistedVisualPin\) && p\.projectId \? \{\s*\n\s*narrativeSourceKind: p\.narrativeSourceKind/,
    "submitting the pinned pack's context (D2) must stay on the bare pin so an unadmitted pin still renders styled",
  );

  const renderReceiptSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx",
    "utf8",
  );
  assert.match(
    renderReceiptSource,
    /!\(p\.brandVisualAllowed \|\| p\.hasAdmittedVisualPin\) \|\| !p\.projectId \|\| !p\.brandContentPreflightId/,
    "the retained-AI-scene quote must read the admitted pin (R6/R7)",
  );
  assert.match(
    renderReceiptSource,
    /\}, \[open, p\.brandVisualAllowed, p\.hasAdmittedVisualPin, p\.projectId, p\.brandContentPreflightId\]\);/,
    "the retained-AI-scene effect must re-run off the admitted pin, not the bare one",
  );

  const editorProjectHookSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
    "utf8",
  );
  assert.match(
    editorProjectHookSource,
    /const logoEligible = brandVisualAllowed \|\| hasAdmittedVisualPin \|\| plan === "PRO" \|\| plan === "BUSINESS"/,
    "R12: the logo overlay stays PRO\/BUSINESS-plan-gated — a bare pin must not widen it",
  );
  assert.match(
    editorProjectHookSource,
    /setHasAdmittedVisualPin\(project\.hasAdmittedVisualPin === true\)/,
    "the project's admitted-pin flag must hydrate from the authoritative server snapshot",
  );
  assert.match(
    editorProjectHookSource,
    /setBrandLibraryAllowed\(resolveBrandLibraryClientAccess\(m\)\)/,
    "the account's library capability must hydrate from /api/user/me",
  );

  const videoJobsRouteSourceForLogo = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  assert.match(
    videoJobsRouteSourceForLogo,
    /brandVisualAllowed: brandVisualAccess\.canUse\s*\n\s*\|\| await projectHasAdmittedPersistedPin\(\{ userId: user\.id, projectId: sourceProjectId \}\)/,
    "R12: export logo staging must read the ADMITTED pin, not the bare one — the logo overlay is not widened by wave 1b",
  );
  assert.match(
    videoJobsRouteSourceForLogo,
    /&& await projectHasPersistedVisualPin\(\{ userId: user\.id, projectId \}\)\.catch\(\(error\) => \{\s*\n\s*if \(error instanceof ProjectLookError\) return false;/,
    "M-5: the library-snapshot pin read must fail open on a vanished project instead of throwing",
  );

  const editorProjectsSource = readFileSync("src/lib/editor-projects.ts", "utf8");
  assert.match(
    editorProjectsSource,
    /hasAdmittedVisualPin ⟹ hasPersistedVisualPin.*does NOT hold/u,
    "M-1: the two pin fields' non-implication must be documented so they are never reconciled",
  );

  // "Save this look as a Brand" is a LIBRARY action (from-project-look accepts
  // every library user), so it must follow library access, not the AI-image
  // gate — otherwise a FREE creator who CAN save one never sees the prompt.
  for (const [file, propType] of [
    ["src/app/(dashboard)/video-editor/_v2/SaveProjectLookPrompt.tsx", /brandLibraryAllowed: boolean/],
    ["src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", /brandLibraryAllowed: boolean/],
    ["src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", /brandLibraryAllowed: boolean/],
  ] as const) {
    const src = readFileSync(file, "utf8");
    assert.match(src, propType, `${file} must thread brandLibraryAllowed, not the AI-image gate`);
    assert.doesNotMatch(
      src,
      /brandVisualAllowed/,
      `${file} must not gate the save-as-Brand prompt on the AI-image gate`,
    );
  }
  const shellSourceForSavePrompt = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx",
    "utf8",
  );
  assert.match(
    shellSourceForSavePrompt,
    /brandLibraryAllowed: p\.brandLibraryAllowed,/,
    "the shell must pass the library flag into the save-as-Brand prompt's prop chain",
  );

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

  console.log("verify-brand-treatment-ui-v1: PASS Thai catalog, upload pre-transcript format choice, guarded brand selection, all-or-cancel, wave 1b pin/admission client guards");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

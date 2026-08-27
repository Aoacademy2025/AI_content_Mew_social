// Run: npx tsx scripts/verify-editor-style-presets.ts
// Proves named subtitle/logo presets round-trip, remain account-scoped, and keep
// referenced logo assets alive until the final preset is removed.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "editor-style-presets-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", {
  stdio: "inherit",
  env: process.env,
});

let passed = 0;
function ok(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
  passed += 1;
}

const SUBTITLE_CONFIG = {
  preset: "stroke",
  effect: "pop",
  cardLen: "3",
  fontFamily: "'Kanit', sans-serif",
  bold: false,
  fontWeight: 600,
  fontSize: 80,
  textColor: "#FFFFFF",
  accentColor: "#FFE500",
  shadow: true,
  outline: false,
  outlineSize: 2,
  verticalPos: 82,
} as const;

const HEADLINE_CONFIG = {
  preset: "news",
  durationMs: 6_500,
  topPercent: 24,
  fontFamily: "Prompt",
  fontSize: 88,
  fontWeight: 600,
  subheadlineFontSize: 46,
} as const;

async function main() {
  const {
    EditorStylePresetError,
    deleteEditorStylePreset,
    listEditorStylePresets,
    saveEditorStylePreset,
  } = await import("../src/lib/editor-style-presets.server");
  const { deleteBrandAssetIfUnreferenced } = await import("../src/lib/brand-assets.server");
  const { prisma } = await import("../src/lib/prisma");
  const { MAX_EDITOR_STYLE_PRESETS_PER_KIND } = await import("../src/lib/editor-style-preset-contract");

  const owner = await prisma.user.create({
    data: { name: "Owner", email: "preset-owner@test.local", plan: "PRO" },
  });
  const other = await prisma.user.create({
    data: { name: "Other", email: "preset-other@test.local", plan: "PRO" },
  });
  const free = await prisma.user.create({
    data: { name: "Free", email: "preset-free@test.local", plan: "FREE" },
  });

  const subtitle = await saveEditorStylePreset({
    userId: owner.id,
    plan: owner.plan,
    kind: "subtitle",
    name: "  คลิปความรู้   ",
    config: SUBTITLE_CONFIG,
  });
  ok(subtitle.name === "คลิปความรู้", "subtitle preset trims and normalizes its display name");
  ok(subtitle.kind === "subtitle" && subtitle.config.fontSize === 80, "subtitle preset round-trips its complete style");
  ok(
    subtitle.kind === "subtitle" && subtitle.config.fontWeight === 600,
    "subtitle preset round-trips the medium font weight",
  );
  ok(
    subtitle.kind === "subtitle" && subtitle.config.cardLen === "3",
    "subtitle preset round-trips the selected ≤3-word card length",
  );

  const updatedSubtitle = await saveEditorStylePreset({
    userId: owner.id,
    plan: owner.plan,
    kind: "subtitle",
    name: "คลิปความรู้",
    config: { ...SUBTITLE_CONFIG, fontSize: 96 },
  });
  ok(updatedSubtitle.id === subtitle.id, "saving the same normalized name updates instead of duplicating");
  ok((await listEditorStylePresets(owner.id)).length === 1, "same-name update keeps one preset row");
  ok((await listEditorStylePresets(other.id)).length === 0, "preset lists are isolated by account");

  const headline = await saveEditorStylePreset({
    userId: owner.id,
    plan: owner.plan,
    kind: "headline",
    name: "พาดหัวข่าว",
    config: {
      ...HEADLINE_CONFIG,
      enabled: true,
      headline: "ข้อความเฉพาะคลิป ห้ามบันทึก",
      subheadline: "บรรทัดเฉพาะคลิป ห้ามบันทึก",
    },
  });
  ok(
    headline.kind === "headline"
      && headline.config.preset === "news"
      && headline.config.durationMs === 6_500
      && headline.config.topPercent === 24
      && headline.config.fontFamily === "Prompt"
      && headline.config.fontSize === 88
      && headline.config.fontWeight === 600
      && headline.config.subheadlineFontSize === 46,
    "headline preset round-trips style, position, and duration",
  );
  ok(
    headline.kind === "headline"
      && !("headline" in headline.config)
      && !("subheadline" in headline.config)
      && !("enabled" in headline.config),
    "headline preset never carries project-specific copy or layer state",
  );

  await prisma.editorStylePreset.create({
    data: {
      userId: owner.id,
      kind: "future-editor-kind",
      name: "Future",
      nameKey: "future",
      configJson: "{}",
    },
  });
  const knownAfterUnknown = await listEditorStylePresets(owner.id);
  ok(
    knownAfterUnknown.some((preset) => preset.kind === "headline")
      && !knownAfterUnknown.some((preset) => (preset as { kind: string }).kind === "future-editor-kind"),
    "unknown stored preset kinds are skipped without breaking the shelf",
  );

  const asset = await prisma.brandAsset.create({
    data: {
      userId: owner.id,
      storageKey: `${owner.id}/brand.webp`,
      originalName: "brand.webp",
      mimeType: "image/webp",
      sizeBytes: 128,
      width: 512,
      height: 256,
    },
  });

  let freePlanRejected = false;
  try {
    await saveEditorStylePreset({
      userId: free.id,
      plan: free.plan,
      kind: "logo",
      name: "โลโก้หลัก",
      config: {
        enabled: true,
        assetId: asset.id,
        position: "top-right",
        sizePct: 18,
        opacity: 0.9,
      },
    });
  } catch (error) {
    freePlanRejected = error instanceof EditorStylePresetError && error.code === "plan_required";
  }
  ok(freePlanRejected, "logo presets keep the existing paid-plan entitlement");

  let crossOwnerRejected = false;
  try {
    await saveEditorStylePreset({
      userId: other.id,
      plan: other.plan,
      kind: "logo",
      name: "โลโก้คนอื่น",
      config: {
        enabled: true,
        assetId: asset.id,
        position: "top-left",
        sizePct: 20,
        opacity: 1,
      },
    });
  } catch (error) {
    crossOwnerRejected = error instanceof EditorStylePresetError && error.code === "asset_not_found";
  }
  ok(crossOwnerRejected, "a logo preset cannot claim another account's asset");

  const logo = await saveEditorStylePreset({
    userId: owner.id,
    plan: owner.plan,
    kind: "logo",
    name: "มุมขวาบน",
    config: {
      enabled: true,
      assetId: asset.id,
      position: "top-right",
      sizePct: 24,
      opacity: 0.82,
    },
  });
  ok(logo.kind === "logo" && logo.config.assetId === asset.id, "logo preset round-trips asset and layout");

  let referencedAssetProtected = false;
  try {
    await deleteBrandAssetIfUnreferenced(owner.id, asset.id);
  } catch (error) {
    referencedAssetProtected =
      error instanceof Error
      && "code" in error
      && error.code === "asset_in_use";
  }
  ok(referencedAssetProtected, "a logo asset cannot retire while a named preset references it");

  ok(await deleteEditorStylePreset(owner.id, logo.id), "owner can delete a named preset");
  ok(!await deleteEditorStylePreset(other.id, subtitle.id), "another account cannot delete the preset");
  ok(await deleteBrandAssetIfUnreferenced(owner.id, asset.id), "asset can retire after its final preset reference is removed");

  let invalidSubtitleRejected = false;
  try {
    await saveEditorStylePreset({
      userId: owner.id,
      plan: owner.plan,
      kind: "subtitle",
      name: "ค่าพัง",
      config: { ...SUBTITLE_CONFIG, fontSize: 999 },
    });
  } catch (error) {
    invalidSubtitleRejected = error instanceof EditorStylePresetError && error.code === "invalid_config";
  }
  ok(invalidSubtitleRejected, "invalid subtitle values are rejected instead of persisted");

  let invalidHeadlineRejected = false;
  try {
    await saveEditorStylePreset({
      userId: owner.id,
      plan: owner.plan,
      kind: "headline",
      name: "พาดหัวค่าพัง",
      config: { ...HEADLINE_CONFIG, durationMs: 99_999 },
    });
  } catch (error) {
    invalidHeadlineRejected = error instanceof EditorStylePresetError && error.code === "invalid_config";
  }
  ok(invalidHeadlineRejected, "invalid headline style values are rejected instead of persisted");

  // ── 2026-07-26 audit M9/B-3 note: MAX_EDITOR_STYLE_PRESETS_PER_KIND (the one
  //    anti-DoS guard on this feature) had zero test coverage — cover the cap here. ──
  const limitOwner = await prisma.user.create({
    data: { name: "LimitOwner", email: "preset-limit-owner@test.local", plan: "PRO" },
  });
  for (let i = 0; i < MAX_EDITOR_STYLE_PRESETS_PER_KIND; i += 1) {
    await saveEditorStylePreset({
      userId: limitOwner.id,
      plan: limitOwner.plan,
      kind: "subtitle",
      name: `พรีเซ็ต ${i + 1}`,
      config: SUBTITLE_CONFIG,
    });
  }
  ok(
    (await listEditorStylePresets(limitOwner.id)).length === MAX_EDITOR_STYLE_PRESETS_PER_KIND,
    `saving reaches the ${MAX_EDITOR_STYLE_PRESETS_PER_KIND}-preset cap for one kind`,
  );

  let limitRejected = false;
  try {
    await saveEditorStylePreset({
      userId: limitOwner.id,
      plan: limitOwner.plan,
      kind: "subtitle",
      name: "เกินโควต้า",
      config: SUBTITLE_CONFIG,
    });
  } catch (error) {
    limitRejected = error instanceof EditorStylePresetError && error.code === "limit_reached";
  }
  ok(limitRejected, "saving a new preset past the per-kind cap is rejected (limit_reached, anti-DoS)");
  ok(
    (await listEditorStylePresets(limitOwner.id)).length === MAX_EDITOR_STYLE_PRESETS_PER_KIND,
    "a rejected over-limit save leaves no partial row behind",
  );

  let updateAtLimitFailed = false;
  try {
    await saveEditorStylePreset({
      userId: limitOwner.id,
      plan: limitOwner.plan,
      kind: "subtitle",
      name: "พรีเซ็ต 1",
      config: { ...SUBTITLE_CONFIG, fontSize: 100 },
    });
  } catch {
    updateAtLimitFailed = true;
  }
  ok(!updateAtLimitFailed, "updating an existing preset by name still works right at the cap (upsert is not blocked)");
  const afterLimitUpdate = await listEditorStylePresets(limitOwner.id);
  ok(afterLimitUpdate.length === MAX_EDITOR_STYLE_PRESETS_PER_KIND, "updating at the cap does not add a row");
  const updatedAtLimit = afterLimitUpdate.find((preset) => preset.name === "พรีเซ็ต 1");
  ok(
    updatedAtLimit?.kind === "subtitle" && updatedAtLimit.config.fontSize === 100,
    "the updated-at-cap preset carries the new config instead of being silently dropped",
  );

  // ── The rest of M1/M2/M9 lives in the useEditorStylePresets/usePostPhaseEditor
  //    React hooks (no DB, no server round-trip) — source-level contract checks in the
  //    same regex-on-source style already used by this repo's other v2-editor verify
  //    scripts (layers / broll-window-mgmt / logo) for UI-hook-only logic. ──
  const postPhaseEditorSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
    "utf8",
  );
  const stylePresetsCallMatch = postPhaseEditorSource.match(
    /const stylePresets = useEditorStylePresets\(\{[\s\S]*?\n {2}\}\);/,
  );
  ok(!!stylePresetsCallMatch, "usePostPhaseEditor wires useEditorStylePresets (M1/M2 source contract present)");
  const stylePresetsCall = stylePresetsCallMatch![0];
  ok(
    /onApplySubtitle:\s*\(config,\s*presetCardLen\)\s*=>\s*\{\s*setCfg\(config\);\s*applyCardLen\(presetCardLen\);\s*\}/.test(stylePresetsCall),
    "M1: apply(subtitle preset) restores card length through applyCardLen, which also clears stale per-card overrides",
  );
  ok(
    /canApplyLogo:\s*canRunProjectOperation/.test(stylePresetsCall),
    "M2: apply(logo preset) is wired to the same canRunProjectOperation readiness check every other project mutation already gates on",
  );

  const stylePresetsHookSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useEditorStylePresets.ts",
    "utf8",
  );
  ok(
    stylePresetsHookSource.includes("headlineStylePresetConfig(input.headlineConfig)"),
    "headline save derives a style-only config instead of serializing headline copy",
  );
  ok(
    stylePresetsHookSource.includes("input.onApplyHeadline(preset.config)"),
    "headline apply restores the saved style through the editor's headline mutation boundary",
  );
  const applyFnMatch = stylePresetsHookSource.match(/function apply\(preset: EditorStylePreset\) \{[\s\S]*?\n  \}\n/);
  ok(!!applyFnMatch, "useEditorStylePresets exposes an apply() function to source-check (M2/M9 contract present)");
  const applyFn = applyFnMatch![0];
  ok(
    /if \(input\.canApplyLogo && !input\.canApplyLogo\(\)\) \{\s*toast\.error\(PROJECT_OPERATION_BLOCKED_MESSAGE\);\s*return;\s*\}/.test(applyFn),
    "M2: apply(logo) exits with toast.error (never toast.success) before calling onApplyLogo when the project can't accept the mutation",
  );
  ok(
    /input\.onApplyLogo\(\{ \.\.\.preset\.config, enabled: input\.logoConfig\?\.enabled \?\? true \}\)/.test(applyFn),
    "M9: apply(logo) ignores the preset's stored `enabled` and keeps whatever layer-toggle state is live now (no live state = on, so the preset is visibly applied)",
  );
  const blockedGuardReturnIndex = applyFn.indexOf("toast.error(PROJECT_OPERATION_BLOCKED_MESSAGE");
  const successToastIndex = applyFn.indexOf("toast.success(");
  ok(
    blockedGuardReturnIndex !== -1 && blockedGuardReturnIndex < successToastIndex,
    "M2: the not-ready guard runs strictly before the shared success toast, so a blocked apply cannot also report success",
  );

  // Medium weight must use one shared resolver in preview and burn, while legacy drafts that
  // only stored `bold` keep their historical 900/400 behavior.
  const { DEFAULT_V2_SUB, buildV2BurnConfig, resolveV2FontWeight } = await import(
    "../src/app/(dashboard)/video-editor/_v2/subtitle-style"
  );
  ok(resolveV2FontWeight({ ...DEFAULT_V2_SUB, bold: false, fontWeight: 600 }) === 600,
    "medium font weight resolves to 600");
  ok(resolveV2FontWeight({ ...DEFAULT_V2_SUB, bold: true, fontWeight: undefined }) === 900,
    "legacy bold-only subtitle config still resolves to 900");
  const burn = buildV2BurnConfig(
    "/preview.mp4",
    [{ text: "ระดับกลาง", startMs: 0, endMs: 1_000, tag: "body" }],
    1_000,
    { ...DEFAULT_V2_SUB, bold: false, fontWeight: 600 },
  );
  ok(burn.keywordPopups[0]?.fontWeight === 600,
    "burn payload uses the same 600 medium weight as the editor config");

  const desktopSource = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
  const mobileSource = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");
  const previewSource = readFileSync("src/app/(dashboard)/video-editor/_v2/V2CaptionOverlay.tsx", "utf8");
  const headlineControlsSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/HeadlineHookControls.tsx",
    "utf8",
  );
  ok(
    headlineControlsSource.includes('kind="headline"')
      && headlineControlsSource.includes("editor.stylePresets.headline"),
    "the shared headline controls expose the same preset shelf on desktop and mobile",
  );
  ok(desktopSource.includes('value: "medium", label: "กลาง"'), "desktop exposes the medium weight control");
  ok(mobileSource.includes('value: "medium", label: "กลาง"'), "mobile exposes the medium weight control");
  ok(previewSource.includes("resolveV2FontWeight(cfg)"), "live subtitle preview uses the shared weight resolver");

  console.log(`\n✅ ALL ${passed} EDITOR STYLE PRESET CHECKS PASSED`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

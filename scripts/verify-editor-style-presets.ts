// Run: npx tsx scripts/verify-editor-style-presets.ts
// Proves named subtitle/logo presets round-trip, remain account-scoped, and keep
// referenced logo assets alive until the final preset is removed.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
  fontFamily: "'Kanit', sans-serif",
  bold: true,
  fontSize: 80,
  textColor: "#FFFFFF",
  accentColor: "#FFE500",
  shadow: true,
  outline: false,
  outlineSize: 2,
  verticalPos: 82,
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

  console.log(`\n✅ ALL ${passed} EDITOR STYLE PRESET CHECKS PASSED`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "first-pass-visual-acceptance-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const {
    firstPassVisualRejectionEvent,
    firstPassVisualExportEvent,
    firstPassVisualExportDedupeKey,
    recordFirstPassVisualExport,
  } = await import("../src/lib/first-pass-visual-acceptance.server");
  const { prisma } = await import("../src/lib/prisma");
  const { stylePack } = await import("../src/lib/style-pack-catalog");
  const { stylePackSnapshotOf } = await import("../src/lib/style-pack-snapshot");
  const context = JSON.stringify({
    schemaVersion: 2,
    source: "suggested",
    visualFormatId: "cinematic-realism",
    recipeVersion: "cinematic-realism-v4",
    treatment: "หนังผีไทย",
    treatmentPin: {
      kind: "catalog", presetId: "thai-supernatural-horror", version: "v1.0.0", source: "adaptive",
    },
    brandVisualLanguage: null,
  });
  // Same treatment pin ("thai-supernatural-horror"), now with the pinned
  // Style Pack that resolves to it — packId must ride along on both event
  // types once a pack is pinned for the clip.
  const contextWithPack = JSON.stringify({
    schemaVersion: 2,
    source: "project-look",
    visualFormatId: "cinematic-realism",
    recipeVersion: "cinematic-realism-v4",
    treatment: "หนังผีไทย",
    treatmentPin: {
      kind: "catalog", presetId: "thai-supernatural-horror", version: "v1.0.0", source: "adaptive",
    },
    brandVisualLanguage: null,
    stylePack: stylePackSnapshotOf(stylePack("thai-ghost")),
  });
  const customer = { role: "USER", email: "creator@example.test" };
  for (const reason of ["scene_reroll", "stock_replacement", "upload_replacement", "broll_disabled"] as const) {
    const event = firstPassVisualRejectionEvent({
      actor: customer,
      projectId: "project-1",
      videoJobId: "job-1",
      sceneIndex: 2,
      reason,
      projectVisualContextJson: context,
    });
    assert.equal(event?.name, "first_pass_visual_rejected");
    assert.equal(event?.status, reason);
    assert.equal(event?.properties?.treatmentPresetId, "thai-supernatural-horror");
    assert.equal(event?.properties?.treatmentPresetVersion, "v1.0.0");
    assert.equal(event?.properties?.packId, null, "no pack pinned on this context → packId is null, not absent");

    const eventWithPack = firstPassVisualRejectionEvent({
      actor: customer,
      projectId: "project-1",
      videoJobId: "job-1",
      sceneIndex: 2,
      reason,
      projectVisualContextJson: contextWithPack,
    });
    assert.equal(eventWithPack?.properties?.packId, "thai-ghost", "a pinned pack rides along on the rejection event");
  }
  assert.equal(firstPassVisualRejectionEvent({
    actor: { role: "ADMIN", email: "admin@example.test" }, projectId: "p", videoJobId: "j",
    sceneIndex: 0, reason: "scene_reroll", projectVisualContextJson: context,
  }), null);
  assert.equal(firstPassVisualRejectionEvent({
    actor: { role: "USER", email: "qa@aoacademy.co" }, projectId: "p", videoJobId: "j",
    sceneIndex: 0, reason: "scene_reroll", projectVisualContextJson: context,
  }), null);
  assert.equal(firstPassVisualRejectionEvent({
    actor: customer, projectId: "p", videoJobId: "j", sceneIndex: 0,
    reason: "scene_reroll", projectVisualContextJson: JSON.stringify({
      source: "project-look", visualFormatId: "retro-story", recipeVersion: "retro-story-v3",
      treatment: "legacy custom", brandVisualLanguage: null,
    }),
  }), null, "legacy custom projects are not falsely assigned to a catalog segment");

  const exported = firstPassVisualExportEvent({
    actor: customer,
    projectId: "project-1",
    videoJobId: "job-1",
    projectVisualContextJson: context,
    initialAiWindowCount: 5,
  });
  assert.equal(exported?.name, "first_pass_visual_exported");
  assert.equal(exported?.value, 5);
  assert.equal(exported?.properties?.treatmentPresetId, "thai-supernatural-horror");
  assert.equal(exported?.properties?.packId, null, "no pack pinned on this context → packId is null, not absent");

  const exportedWithPack = firstPassVisualExportEvent({
    actor: customer,
    projectId: "project-1",
    videoJobId: "job-1",
    projectVisualContextJson: contextWithPack,
    initialAiWindowCount: 5,
  });
  assert.equal(exportedWithPack?.properties?.packId, "thai-ghost", "a pinned pack rides along on the export event");

  const user = await prisma.user.create({
    data: { name: "Concurrent exporter", email: "first-pass-export@example.test" },
  });
  await Promise.all(Array.from({ length: 12 }, () => recordFirstPassVisualExport(user.id, {
    actor: customer,
    projectId: "project-concurrent-export",
    videoJobId: "job-concurrent-export",
    projectVisualContextJson: context,
    initialAiWindowCount: 5,
  })));
  assert.equal(await prisma.telemetryEvent.count({
    where: { userId: user.id, name: "first_pass_visual_exported" },
  }), 1, "concurrent export completion records the first project export exactly once");
  const exportDedupeKey = firstPassVisualExportDedupeKey(user.id, "project-concurrent-export");
  assert.ok(!exportDedupeKey.includes(user.id) && !exportDedupeKey.includes("project-concurrent-export"),
    "the retained marker key hashes user/project identifiers");
  const cleanupSource = readFileSync("src/app/api/cron/cleanup-videos/route.ts", "utf8");
  assert.match(
    cleanupSource,
    /telemetryEvent\.updateMany[\s\S]+dedupeKey:\s*\{\s*not:\s*null\s*\}[\s\S]+userId:\s*null[\s\S]+properties:\s*null/,
    "expired exactly-once rows retain only a scrubbed marker",
  );
  assert.match(
    cleanupSource,
    /telemetryEvent\.deleteMany[\s\S]+dedupeKey:\s*null/,
    "the 90-day telemetry sweep retains durable exactly-once marker rows",
  );

  console.log("verify-first-pass-visual-acceptance-v1: PASS rejection paths, atomic export denominator, Admin/QA exclusion");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

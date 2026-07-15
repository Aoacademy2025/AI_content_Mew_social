// Run with: npx tsx scripts/verify-logo-project-default.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as logoOverlayModule from "../src/lib/logo-overlay";
import {
  logoOverlayForNewProject,
  type LogoOverlayConfig,
} from "../src/lib/logo-overlay";

type DraftCanonicalizer = <T extends object>(
  draft: T,
) => Omit<T, "logoOverlay"> & { logoOverlay?: LogoOverlayConfig };

const canonicalizeDraftLogoOverlay = (
  logoOverlayModule as unknown as {
    canonicalizeDraftLogoOverlay?: DraftCanonicalizer;
  }
).canonicalizeDraftLogoOverlay ?? ((draft) => ({ ...draft }));

const accountDefault: LogoOverlayConfig = {
  enabled: true,
  assetId: "logo_asset_1",
  position: "bottom-right",
  sizePct: 22,
  opacity: 0.75,
};

const inherited = logoOverlayForNewProject({
  hasExistingDraft: false,
  accountDefault,
});
assert.deepEqual(inherited, accountDefault, "blank new projects inherit the account default");
assert.notEqual(inherited, accountDefault, "inherited config is a copy");

assert.equal(
  logoOverlayForNewProject({ hasExistingDraft: false, accountDefault: null }),
  undefined,
  "new projects omit logoOverlay when there is no account default",
);
assert.equal(
  logoOverlayForNewProject({ hasExistingDraft: true, accountDefault }),
  undefined,
  "local drafts are never backfilled",
);
assert.equal(
  logoOverlayForNewProject({ hasExistingDraft: true, accountDefault }),
  undefined,
  "server project drafts are never backfilled",
);

type DraftWithOptionalLogo = {
  mode?: "script" | "upload";
  script?: string;
  logoOverlay?: LogoOverlayConfig;
};
const legacyDraft = JSON.parse('{"mode":"script","script":"legacy"}') as DraftWithOptionalLogo;
assert.equal(legacyDraft.script, "legacy", "legacy draft JSON still parses");
assert.equal(legacyDraft.logoOverlay, undefined, "legacy drafts may omit logoOverlay");

const maliciousLocalDraft = {
  mode: "script" as const,
  script: "untrusted local draft",
  logoOverlay: {
    enabled: false,
    assetId: "  logo_asset_malicious  ",
    position: "off-canvas",
    sizePct: 999,
    opacity: -4,
    unexpected: "must not survive",
  },
};
const canonicalLocalDraft = canonicalizeDraftLogoOverlay(maliciousLocalDraft);
assert.deepEqual(
  canonicalLocalDraft,
  {
    mode: "script",
    script: "untrusted local draft",
    logoOverlay: {
      enabled: false,
      assetId: "logo_asset_malicious",
      position: "top-right",
      sizePct: 35,
      opacity: 0.2,
    },
  },
  "local POST candidate contains only an exact normalized logo config",
);
assert.notEqual(canonicalLocalDraft, maliciousLocalDraft, "canonicalization copies the draft");

const blankAssetLocalDraft = {
  mode: "upload" as const,
  logoOverlay: {
    enabled: true,
    assetId: "   ",
    position: "bottom-left",
    sizePct: 20,
    opacity: 0.8,
    unexpected: "must not survive",
  },
};
assert.deepEqual(
  canonicalizeDraftLogoOverlay(blankAssetLocalDraft),
  { mode: "upload" },
  "invalid local logo config is omitted from the POST candidate",
);

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `source contract start exists: ${start}`);
  assert.notEqual(endIndex, -1, `source contract end exists: ${end}`);
  return source.slice(startIndex, endIndex);
}

const projectSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
  "utf8",
);
const serverLoadSource = sourceBetween(
  projectSource,
  "if (existingProjectId) {",
  "const localDraft =",
);
assert.doesNotMatch(projectSource, /resolveEditorProjectBootstrap/,
  "the temporary async bootstrap adapter is gone");
assert.doesNotMatch(
  serverLoadSource,
  /loadAccountLogoDefault/,
  "server project load never backfills an account default",
);
assert.match(
  serverLoadSource,
  /const legacyLocalDraft\s*=\s*storedProjectId\s*===\s*existingProjectId/,
  "legacy recovery remains associated with the requested project id",
);
const idleWaitIndex = serverLoadSource.indexOf("await editorProjectSaveQueue.whenIdle(existingProjectId)");
const getIndex = serverLoadSource.indexOf("await fetch(", idleWaitIndex);
const journalIndex = serverLoadSource.indexOf("readEditorProjectRecoveryJournal", getIndex);
const decisionIndex = serverLoadSource.indexOf("decideEditorProjectBootstrap", journalIndex);
assert.ok(
  idleWaitIndex >= 0 && getIndex > idleWaitIndex && journalIndex > getIndex && decisionIndex > journalIndex,
  "existing project recovery waits for the lane and server before choosing either candidate",
);
assert.match(
  serverLoadSource,
  /revisionWatermark:\s*editorProjectSaveQueue\.revisionWatermark\(existingProjectId\)/,
  "bootstrap compares GET with the local queue watermark",
);
assert.match(
  serverLoadSource,
  /decision\.kind\s*===\s*"resume-local"[\s\S]{0,900}applyDraft\(localCandidate\.draft as V2Draft\)/,
  "trusted local recovery is the only automatically resumed local draft",
);
assert.match(
  serverLoadSource,
  /decision\.kind\s*===\s*"server"[\s\S]{0,360}applyDraft\(serverCandidate\.draft as V2Draft\)/,
  "safe current GET applies only the server draft",
);
assert.match(serverLoadSource, /decision\.kind\s*===\s*"conflict"[\s\S]{0,520}setProjectReady\(false\)/,
  "ambiguous logo drafts remain locked behind an explicit conflict choice");

const localSeedSource = sourceBetween(
  projectSource,
  "const hasLocalDraft =",
  "storage?.setItem(PROJECT_ID_KEY, id);",
);
assert.match(
  localSeedSource,
  /const seedDraft = hasLocalDraft \? localDraft : buildDraft\(\);/,
  "local draft is treated as existing work",
);
assert.match(
  localSeedSource,
  /if \(!hasLocalDraft\) \{\s+const accountDefault = await loadAccountLogoDefault\(\);/,
  "account default lookup is limited to a blank new project",
);

const autosaveSource = sourceBetween(
  projectSource,
  "// Persist draft (debounce 1s)",
  "// ข้อมูลอวตาร",
);
assert.match(
  projectSource,
  /async function saveEditorProjectDraft[\s\S]{0,1200}draftRevision:\s*snapshot\.revision[\s\S]{0,240}expectedDraftRevision:\s*snapshot\.expectedDraftRevision[\s\S]{0,500}signal,/,
  "the queued save sends an immutable conditional revision snapshot and abort signal",
);
assert.match(
  autosaveSource,
  /onStatus:[\s\S]{0,160}setSaveStatus\(status\)/,
  "the queue's latest terminal result drives visible save status",
);
assert.match(
  projectSource,
  /async function loadAuthoritativeEditorProjectDraft[\s\S]{0,700}cache:\s*"no-store"/,
  "ambiguous autosaves use one authoritative no-store reconciliation GET",
);
assert.doesNotMatch(
  autosaveSource,
  /!projectReady[\s\S]{0,320}(?:writeEditorProjectRecoveryJournal|editorProjectSaveQueue\.enqueue)/,
  "unready existing projects neither journal nor autosave default state",
);
const enqueueIndex = autosaveSource.indexOf("editorProjectSaveQueue.enqueue");
const reconcileIndex = autosaveSource.indexOf("reconcile:", enqueueIndex);
const reconciliationLoadIndex = autosaveSource.indexOf("loadAuthoritativeEditorProjectDraft", reconcileIndex);
assert.ok(
  enqueueIndex >= 0 && reconcileIndex > enqueueIndex && reconciliationLoadIndex > reconcileIndex,
  "the queue-owned reconciliation calls the authoritative GET helper",
);
assert.match(
  autosaveSource,
  /isActive:\s*\(\)\s*=>\s*ownsAutosaveLineage\(tracker,\s*generation\)/,
  "unmounted and previous-project saves cannot update visible status",
);
const retrySource = sourceBetween(
  projectSource,
  "const retryProjectBootstrap = useCallback",
  "const retryProjectSave = useCallback",
);
assert.match(retrySource, /recoveryRef\.current\.status\s*===\s*"load-error"/);
assert.match(retrySource, /setBootstrapRetryRevision/);
assert.doesNotMatch(retrySource, /setSaveRevision|setItem|writeEditorProjectRecoveryJournal|markUserDraftMutation/,
  "bootstrap Retry cannot turn defaults into recovery data");
assert.match(
  autosaveSource,
  /logoOverlay, projectId, projectReady,[\s\S]{0,180}ownsAutosaveLineage, saveRevision\]\);/,
  "save revision participates in the autosave effect dependencies",
);
assert.match(
  projectSource,
  /\}, \[createServerProject, bootstrapRetryRevision, invalidateAutosaveLineage\]\);/,
  "bootstrap Retry reruns the existing-project load without creating an alternate path",
);
assert.match(
  localSeedSource,
  /const canonicalSeedDraft = canonicalizeDraftLogoOverlay\(seedDraft\);[\s\S]{0,240}applyDraft\(canonicalSeedDraft\);[\s\S]{0,320}createServerProject\(canonicalSeedDraft,\s*\{/,
  "the same canonical local draft is applied and posted",
);

console.log("logo-project-default: all checks passed");

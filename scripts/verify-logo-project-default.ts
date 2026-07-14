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
  "const hasLocalDraft =",
);
assert.match(
  projectSource,
  /resolveEditorProjectBootstrap/,
  "existing-project load uses the pure bootstrap resolver",
);
assert.doesNotMatch(
  serverLoadSource,
  /loadAccountLogoDefault/,
  "server project load never backfills an account default",
);
assert.match(
  serverLoadSource,
  /const associatedLocalDraft\s*=\s*storedProjectId\s*===\s*existingProjectId/,
  "local recovery is associated with the requested project id",
);
const earlyLocalApplyIndex = serverLoadSource.indexOf("applyDraft(associatedLocalDraft)");
const idleWaitIndex = serverLoadSource.indexOf("await editorProjectSaveQueue.whenIdle(existingProjectId)");
assert.ok(
  earlyLocalApplyIndex >= 0 && idleWaitIndex > earlyLocalApplyIndex,
  "valid local recovery is applied before waiting for the lane or GET",
);
assert.match(
  serverLoadSource,
  /revisionWatermark:\s*editorProjectSaveQueue\.revisionWatermark\(existingProjectId\)/,
  "bootstrap compares GET with the local queue watermark",
);
assert.match(
  serverLoadSource,
  /isLocalDirty:\s*\(\)\s*=>\s*bootstrapLocalDirtyRef\.current/,
  "bootstrap retry knows whether the user edited while unready",
);
assert.match(
  serverLoadSource,
  /bootstrapLocalDirtyRef\.current\s*&&\s*!bootstrapLocalRecoveryValidRef\.current[\s\S]{0,80}return null/,
  "a failed local write cannot reuse an older recovery draft for a newer edit",
);
assert.match(
  serverLoadSource,
  /readLocalDraft:[\s\S]{0,360}getItem\(PROJECT_ID_KEY\)[\s\S]{0,140}existingProjectId/,
  "recovery re-checks the current local project association after pending edits",
);
const bootstrapErrorSource = sourceBetween(
  serverLoadSource,
  'if (outcome.kind === "error")',
  'if (outcome.kind !== "missing")',
);
assert.match(bootstrapErrorSource, /setProjectReady\(false\)/);
assert.match(bootstrapErrorSource, /setSaveStatus\("error"\)/);
assert.match(bootstrapErrorSource, /return;/,
  "network, non-404, and unsafe stale GET outcomes remain explicitly unready");
assert.match(
  serverLoadSource,
  /outcome\.kind\s*===\s*"local"[\s\S]{0,240}applyDraft\(outcome\.draft as V2Draft\)/,
  "retry/recovery applies the latest valid local draft",
);
assert.match(
  serverLoadSource,
  /outcome\.kind\s*===\s*"server"[\s\S]{0,300}project\.draft[\s\S]{0,160}applyDraft/,
  "safe current GET applies only the server draft",
);

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
  /async function saveEditorProjectDraft[\s\S]{0,900}draftRevision:\s*revision[\s\S]{0,500}signal,[\s\S]{0,500}return res\.ok;/,
  "the queued save sends its revision and abort signal while reporting non-OK responses as failures",
);
assert.match(
  autosaveSource,
  /onStatus:[\s\S]{0,160}setSaveStatus\(status\)/,
  "the queue's latest terminal result drives visible save status",
);
assert.match(
  autosaveSource,
  /!projectReady\s*&&\s*existingBootstrapProjectIdRef\.current[\s\S]{0,420}setItem\(DRAFT_KEY,[\s\S]{0,220}bootstrapLocalDirtyRef\.current\s*=\s*true[\s\S]{0,220}return/,
  "edits while an existing project is unready persist locally and stop before PATCH",
);
assert.match(
  autosaveSource,
  /let localWriteSucceeded\s*=\s*false[\s\S]{0,260}localWriteSucceeded\s*=\s*true[\s\S]{0,220}bootstrapLocalRecoveryValidRef\.current\s*=\s*localWriteSucceeded/,
  "unready recovery is valid only when the latest local write succeeds",
);
assert.match(
  autosaveSource,
  /!isFirst\s*&&\s*!projectReady\s*&&\s*existingBootstrapProjectIdRef\.current[\s\S]{0,180}bootstrapLocalDirtyRef\.current\s*=\s*true[\s\S]{0,140}bootstrapLocalRecoveryValidRef\.current\s*=\s*false/,
  "an edit is marked unconfirmed before its debounce can race a pending GET",
);
const unreadyPersistSource = sourceBetween(
  autosaveSource,
  "if (!projectReady && existingBootstrapProjectIdRef.current)",
  "if (projectReady && projectId)",
);
assert.match(
  unreadyPersistSource,
  /setItem\(DRAFT_KEY,[\s\S]{0,180}setItem\(PROJECT_ID_KEY,\s*existingBootstrapProjectIdRef\.current\)/,
  "a successful unready local write associates the draft with the existing project id",
);
assert.doesNotMatch(
  unreadyPersistSource,
  /setSaveStatus\("saved"\)|editorProjectSaveQueue\.enqueue/,
  "unready local-only persistence never reports durable saved or queues PATCH",
);
assert.doesNotMatch(
  autosaveSource,
  /\bfetch\(/,
  "autosave never launches an unordered PATCH directly",
);
assert.match(
  autosaveSource,
  /mountedRef\.current[\s\S]{0,100}currentProjectIdRef\.current\s*===\s*saveProjectId/,
  "unmounted and previous-project saves cannot update visible status",
);
const retrySource = sourceBetween(
  projectSource,
  "const retryProjectSave = useCallback",
  "const firstPersistRun",
);
assert.match(retrySource, /!projectReadyRef\.current\s*&&\s*existingBootstrapProjectIdRef\.current/);
assert.match(retrySource, /setBootstrapRetryRevision/);
assert.match(retrySource, /setSaveRevision/,
  "Retry reruns bootstrap while unready and autosave while ready");
assert.match(
  retrySource,
  /!projectReadyRef\.current\s*&&\s*existingBootstrapProjectIdRef\.current[\s\S]{0,420}latestDraftRef\.current[\s\S]{0,240}bootstrapLocalRecoveryValidRef\.current\s*=\s*localWriteSucceeded[\s\S]{0,260}setBootstrapRetryRevision/,
  "Retry flushes the latest in-memory edit to recovery storage before GET",
);
assert.match(
  autosaveSource,
  /logoOverlay, projectId, projectReady, saveRevision\]\);/,
  "save revision participates in the autosave effect dependencies",
);
assert.match(
  projectSource,
  /\}, \[createServerProject, bootstrapRetryRevision\]\);/,
  "bootstrap Retry reruns the existing-project load without creating an alternate path",
);
assert.match(
  localSeedSource,
  /const canonicalSeedDraft = canonicalizeDraftLogoOverlay\(seedDraft\);\s+applyDraft\(canonicalSeedDraft\);\s+const id = await createServerProject\(canonicalSeedDraft\);/,
  "the same canonical local draft is applied and posted",
);

console.log("ALL LOGO PROJECT DEFAULT CHECKS PASSED");

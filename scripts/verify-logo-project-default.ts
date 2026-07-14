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
  serverLoadSource,
  /applyDraft\(project\.draft as V2Draft\)/,
  "server project applies only its persisted draft",
);
assert.doesNotMatch(
  serverLoadSource,
  /loadAccountLogoDefault/,
  "server project load never backfills an account default",
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
assert.match(
  projectSource,
  /const retryProjectSave = useCallback\(\(\) => setSaveRevision\(\(revision\) => revision \+ 1\), \[\]\);/,
  "retry increments the save revision",
);
assert.match(
  autosaveSource,
  /logoOverlay, projectId, projectReady, saveRevision\]\);/,
  "save revision participates in the autosave effect dependencies",
);
assert.match(
  localSeedSource,
  /const canonicalSeedDraft = canonicalizeDraftLogoOverlay\(seedDraft\);\s+applyDraft\(canonicalSeedDraft\);\s+const id = await createServerProject\(canonicalSeedDraft\);/,
  "the same canonical local draft is applied and posted",
);

console.log("ALL LOGO PROJECT DEFAULT CHECKS PASSED");

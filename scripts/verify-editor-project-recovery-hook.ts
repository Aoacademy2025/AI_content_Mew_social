// Run with: npx tsx scripts/verify-editor-project-recovery-hook.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  verifyRuntimeHookContract,
  verifyRuntimeHookMutationSensitivity,
} from "./editor-project-recovery-hook-runtime-harness";
import {
  verifyProjectJobGateMutationSensitivity,
  verifyProjectJobRuntimeGate,
} from "./editor-project-job-runtime-harness";
import { decideEditorProjectBootstrap } from "../src/lib/editor-project-bootstrap";
import {
  clearEditorProjectRecoveryJournal,
  readEditorProjectRecoveryJournal,
  writeEditorProjectRecoveryJournal,
  type RecoveryStorage,
} from "../src/lib/editor-project-recovery-journal";

type RecoveryCandidate = {
  draft: Record<string, unknown>;
  revision: number | null;
  updatedAt: string | null;
  trusted: boolean;
};

type RecoveryHookSeams = {
  createRecoveryCandidate?: (input: {
    projectId: string;
    draft: unknown;
    revision: number | null;
    updatedAt: string | null;
    trusted: boolean;
  }) => RecoveryCandidate | null;
  buildLocalConflictPatchBody?: (
    conflict: { local: RecoveryCandidate; server: RecoveryCandidate },
    revision: number,
  ) => Record<string, unknown>;
  isLatestSavedProjectRevision?: (
    event: { projectId: string; revision: number; status: string },
    latest: { projectId: string | null; revision: number | null },
  ) => boolean;
};

const hookPath = "src/app/(dashboard)/video-editor/_v2/useV2Project.ts";
const source = readFileSync(hookPath, "utf8");

function parseHook(value: string): ts.SourceFile {
  return ts.createSourceFile(hookPath, value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function namedFunction(root: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found?.body, `function ${name} exists`);
  return found;
}

function variableInitializer(root: ts.SourceFile, name: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer
    ) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, `variable ${name} exists`);
  return found;
}

function userStateDeclaration(
  root: ts.SourceFile,
  expectedNames: readonly [string, string, string],
): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isArrayBindingPattern(node.name)
      && node.name.elements.map((element) => element.name.getText(root)).join(",")
        === expectedNames.join(",")
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === "useUserDraftState"
    ) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function sourceBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `source contract start exists: ${start}`);
  assert.notEqual(endIndex, -1, `source contract end exists: ${end}`);
  return value.slice(startIndex, endIndex);
}

function assertCallCount(value: string, callee: string, expected: number, label: string): void {
  const root = parseHook(value);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.equal(count, expected, label);
}

const stateContracts = [
  ["projectTitle", "setProjectTitle", "setProjectTitleRaw", "projectTitle"],
  ["mode", "setMode", "setModeRaw", "mode"],
  ["script", "setScript", "setScriptRaw", "script"],
  ["clipUrlState", "setClipUrlStateFromUser", "setClipUrlStateRaw", "clipUrl"],
  ["clipDurationSecState", "setClipDurationSecStateFromUser", "setClipDurationSecStateRaw", "clipDurationSec"],
  ["brollSource", "setBrollSource", "setBrollSourceRaw", "brollSource"],
  ["voiceEngine", "setVoiceEngine", "setVoiceEngineRaw", "voiceEngine"],
  ["geminiVoiceName", "setGeminiVoiceName", "setGeminiVoiceNameRaw", "geminiVoiceName"],
  ["voiceId", "setVoiceId", "setVoiceIdRaw", "voiceId"],
  ["musicTrack", "setMusicTrack", "setMusicTrackRaw", "musicTrack"],
  ["musicTrackKind", "setMusicTrackKind", "setMusicTrackKindRaw", "musicTrackKind"],
  ["bgmVolume", "setBgmVolume", "setBgmVolumeRaw", "bgmVolume"],
  ["useAvatar", "setUseAvatar", "setUseAvatarRaw", "useAvatar"],
  ["avatarId", "setAvatarId", "setAvatarIdRaw", "avatarId"],
  ["targetClipCount", "setTargetClipCount", "setTargetClipCountRaw", "targetClipCount"],
  ["avatarMode", "setAvatarMode", "setAvatarModeRaw", "avatarMode"],
  ["avatarIntroSecs", "setAvatarIntroSecs", "setAvatarIntroSecsRaw", "avatarIntroSecs"],
  ["avatarTailSecs", "setAvatarTailSecs", "setAvatarTailSecsRaw", "avatarTailSecs"],
  ["kieModel", "setKieModel", "setKieModelRaw", "kieModel"],
  ["autoMixProviders", "setAutoMixProviders", "setAutoMixProvidersRaw", "autoMixProviders"],
  ["brollRegionPreference", "setBrollRegionPreference", "setBrollRegionPreferenceRaw", "brollRegionPreference"],
  ["brollVisualStyle", "setBrollVisualStyle", "setBrollVisualStyleRaw", "brollVisualStyle"],
  ["logoOverlay", "setLogoOverlay", "setLogoOverlayRaw", "logoOverlay"],
  ["mixPreset", "setMixPresetFromUser", "setMixPresetRaw", "mixPreset"],
] as const;

function verifyHookSource(value: string): void {
  const root = parseHook(value);
  assert.equal(root.parseDiagnostics.length, 0, "hook source parses as TypeScript");
  assert.doesNotMatch(value, /bootstrapLocalDirtyRef|bootstrapLocalRecoveryValidRef/);
  assert.doesNotMatch(value, /resolveEditorProjectBootstrap/,
    "the temporary async bootstrap adapter is absent");

  const userState = namedFunction(root, "useUserDraftState").getText(root);
  assert.match(userState, /if \(!canAcceptUserMutation\(\)\) return;[\s\S]*setSynchronized\(next\)/,
    "the public setter rejects user mutation before touching synchronized state");
  assert.match(userState, /setSynchronized\(next\);[\s\S]*markUserMutation\(\)/,
    "the public setter synchronizes the effective draft before marking provenance");
  assert.match(userState, /valueRef\.current[\s\S]*effectiveDraftRef\.current[\s\S]*setRaw\(resolved\)/,
    "functional and direct setters synchronously update the effective draft mirror");
  assertCallCount(userState, "markUserMutation", 1,
    "useUserDraftState has exactly one user-provenance boundary");
  const userMarker = variableInitializer(root, "markUserDraftMutation").getText(root);
  assert.match(userMarker, /userDraftMutationTokenRef\.current\s*\+=\s*1[\s\S]*stageExplicitUserDraftMutationRef\.current\(\)/,
    "the setter boundary stages the explicit user draft synchronously after advancing its token");
  const operationGate = variableInitializer(root, "canRunProjectOperation").getText(root);
  assert.match(
    operationGate,
    /projectInitializationRef\.current\s*===\s*"ready"[\s\S]*projectReadyRef\.current[\s\S]*recoveryRef\.current\.status\s*===\s*"none"/,
    "the shared synchronous operation gate requires initialization, readiness, and recovery ownership",
  );

  for (const [field, userSetter, rawSetter, draftField] of stateContracts) {
    const declaration = userStateDeclaration(root, [field, userSetter, rawSetter]);
    assert.ok(
      declaration
        && declaration.arguments.length === 5
        && ts.isStringLiteral(declaration.arguments[1])
        && declaration.arguments[1].text === draftField
        && ts.isIdentifier(declaration.arguments[2])
        && declaration.arguments[2].text === "effectiveDraftRef"
        && ts.isIdentifier(declaration.arguments[3])
        && declaration.arguments[3].text === "canAcceptUserMutation"
        && ts.isIdentifier(declaration.arguments[4])
        && declaration.arguments[4].text === "markUserDraftMutation",
      `${field} synchronizes ${draftField} and keeps separate user/raw provenance`,
    );
  }

  const applyDraft = namedFunction(root, "applyDraft").getText(root);
  assert.doesNotMatch(applyDraft, /markUserDraftMutation|FromUser/,
    "applyDraft cannot manufacture user provenance");
  for (const [, , rawSetter] of stateContracts) {
    assert.match(applyDraft, new RegExp(`\\b${rawSetter}\\(`),
      `applyDraft uses ${rawSetter}`);
  }

  const retry = variableInitializer(root, "retryProjectBootstrap").getText(root);
  assert.match(retry, /recoveryRef\.current\.status\s*===\s*"load-error"/);
  assert.match(retry, /setBootstrapRetryRevision\(\(value\)\s*=>\s*value\s*\+\s*1\)/);
  assert.doesNotMatch(retry, /browserStorage|writeEditorProjectRecoveryJournal|markUserDraftMutation|setSaveRevision|enqueue|fetch/,
    "retry while unready only advances the bootstrap retry token");

  const reset = variableInitializer(root, "resetProject").getText(root);
  assert.doesNotMatch(reset, /markUserDraftMutation|FromUser/,
    "reset uses programmatic setters only");
  assert.match(reset, /setLogoOverlayRaw\(inherited\)/);
  assert.match(reset, /setMixPresetRaw\(/);
  assert.match(reset, /setProjectReady\(false\);\s*setProjectInitialization\("loading-defaults"\);[\s\S]*await loadAccountLogoDefault/,
    "Reset blocks synchronously before awaiting account defaults");
  assert.match(reset, /if \(!isCurrentReset\(\)\) return null;[\s\S]*setProjectInitialization\("creating-project"\);[\s\S]*createServerProject/,
    "only the owned Reset advances from defaults to project creation");

  const clipUrlSetter = variableInitializer(root, "setClipUrl").getText(root);
  assert.match(clipUrlSetter, /if \(!canAcceptUserMutation\(\)\) return;[\s\S]*setClipDurationSecStateRaw/,
    "the clip URL composite setter guards before its coupled raw duration write");
  const mixPresetSetter = variableInitializer(root, "setMixPreset").getText(root);
  assert.match(mixPresetSetter, /if \(!canAcceptUserMutation\(\)\) return;[\s\S]*setBrollSourceRaw/,
    "the mix preset composite setter guards before coupled raw writes");

  const settings = sourceBetween(value, "// ค่า default จริงของผู้ใช้", "// Persist draft (debounce 1s)");
  assert.doesNotMatch(settings, /markUserDraftMutation|FromUser/,
    "video settings and fetchMe initialization use raw setters");
  assert.match(settings, /setAvatarIdRaw/);
  assert.match(settings, /setVoiceIdRaw/);
  assert.match(settings, /setVoiceEngineRaw/);
  assert.match(settings, /setGeminiVoiceNameRaw/);
  assert.match(settings, /setMixPresetRaw/);

  const stageExplicit = variableInitializer(root, "stageExplicitUserDraftMutation").getText(root);
  assert.match(stageExplicit, /canonicalizeDraftLogoOverlay\(effectiveDraftRef\.current\)/,
    "explicit staging materializes the synchronized effective draft");
  assert.match(stageExplicit, /tracker\.latestLocal\s*=\s*latestLocal[\s\S]*latestDraftRef\.current\s*=\s*latestLocal/,
    "explicit staging publishes one immutable candidate to conflict and autosave paths");
  assert.match(stageExplicit, /writeEditorProjectRecoveryJournal[\s\S]*draft:\s*latestLocal\.draft/,
    "the synchronous explicit candidate is journaled before passive effects");
  assert.match(stageExplicit, /tracker\.blocked\s*=\s*true[\s\S]*status:\s*"load-error"/,
    "failed explicit materialization fails closed visibly");

  const acknowledge = variableInitializer(root, "acknowledgeAutosaveCandidate").getText(root);
  assert.match(acknowledge, /pruneIssuedAutosaveSnapshotsThrough\(tracker,\s*candidate\.revision\)/,
    "an exact acknowledgement retires proven issued snapshots");
  const prune = namedFunction(root, "pruneIssuedAutosaveSnapshotsThrough").getText(root);
  assert.match(prune, /revision\s*<=\s*confirmedRevision[\s\S]*tracker\.issued\.delete\(revision\)/,
    "issued pruning removes only revisions proven by the confirmed acknowledgement");

  const autosaveStaging = sourceBetween(value, "// Persist draft (debounce 1s)", "// ข้อมูลอวตาร");
  assert.match(autosaveStaging, /stagedUserDraftMutationTokenRef\.current\s*===\s*userDraftMutationTokenRef\.current[\s\S]*const draft = stagedLocal\?\.draft/,
    "passive autosave consumes the exact synchronous user snapshot for its token");
  assert.match(autosaveStaging, /result\.kind\s*===\s*"error"[\s\S]*tracker\.issued\.delete\(snapshot\.revision\)/,
    "a definite write error retires its impossible-to-commit snapshot");
  assert.match(autosaveStaging, /isLatestSavedProjectRevision\(event,\s*latestQueuedSaveRef\.current\)[\s\S]*userDraftMutationTokenRef\.current\s*===\s*lastPersistedUserMutationTokenRef\.current[\s\S]*clearProjectRecoveryData/,
    "an older acknowledgement cannot clear a newer synchronously staged journal");

  const existing = sourceBetween(value, "if (existingProjectId) {", "const localDraft =");
  assert.match(existing, /setRecoveryState\(\{\s*status:\s*"loading"\s*\}\)/);
  assert.match(existing, /setProjectReady\(false\)/);
  const idleIndex = existing.indexOf("await editorProjectSaveQueue.whenIdle(existingProjectId)");
  const getIndex = existing.indexOf("await fetch(", idleIndex);
  const journalIndex = existing.indexOf("readEditorProjectRecoveryJournal", getIndex);
  const decisionIndex = existing.indexOf("decideEditorProjectBootstrap", journalIndex);
  assert.ok(idleIndex >= 0 && getIndex > idleIndex && journalIndex > getIndex && decisionIndex > journalIndex,
    "bootstrap waits, GETs, validates the journal, then makes the pure decision");
  const loadFailure = sourceBetween(existing, "if (!response", "const project =");
  assert.match(loadFailure, /status:\s*"load-error"/);
  assert.match(loadFailure, /setProjectReady\(false\)/);
  assert.doesNotMatch(loadFailure, /createServerProject|method:\s*"PATCH"|writeEditorProjectRecoveryJournal/,
    "load failure stays locked without POST/PATCH or journal writes");
  const conflictBranch = sourceBetween(existing, 'if (decision.kind === "conflict")', 'if (decision.kind === "locked-error")');
  assert.match(conflictBranch, /status:\s*"conflict"/);
  assert.match(conflictBranch, /setProjectReady\(false\)/);
  assert.match(conflictBranch, /requiresServerRefresh:\s*false/);

  const chooseLocal = variableInitializer(root, "chooseLocalProjectDraft").getText(root);
  assert.match(chooseLocal, /const conflict = recoveryRef\.current/);
  assert.match(chooseLocal, /reserveRevisionAbove\(projectId,\s*expected\)/);
  assert.match(chooseLocal, /buildLocalConflictPatchBody\(conflict,\s*revision\)/,
    "local choice sends the displayed immutable conflict snapshot");
  assert.match(chooseLocal, /createEditorProjectAutosaveSnapshot[\s\S]*expectedDraftRevision:\s*expected/,
    "local choice owns an immutable conditional snapshot");
  assert.match(chooseLocal, /method:\s*"PATCH"/);
  assert.match(chooseLocal, /signal:\s*controller\.signal/,
    "local choice PATCH is abortable at lifecycle boundaries");
  assert.match(chooseLocal, /const stillCurrentChoice[\s\S]*recoveryRef\.current\.resolving\s*===\s*"local"/,
    "local choice callbacks are bound to the active conflict and request generation");
  assert.match(chooseLocal, /savedAutosaveCandidate\.revision\s*===\s*choiceSnapshot\.revision[\s\S]*savedAutosaveCandidate\.fingerprint\s*===\s*choiceSnapshot\.fingerprint/,
    "a 200 acknowledgement must match both the dispatched revision and fingerprint");
  assert.ok(chooseLocal.split("if (!stillCurrentChoice()) return;").length - 1 >= 5,
    "local choice re-checks ownership after awaits and before side effects");
  const unavailableLogoIndex = chooseLocal.indexOf(
    'res.status === 422 && payload?.error === "brand_asset_unavailable"',
  );
  const lifecycleConflictIndex = chooseLocal.indexOf("res.status === 409");
  assert.ok(
    unavailableLogoIndex >= 0 && lifecycleConflictIndex > unavailableLogoIndex,
    "definite unavailable Logo handling runs before generic 409/acknowledgement reconciliation",
  );
  const unavailableLogoBranch = chooseLocal.slice(unavailableLogoIndex, lifecycleConflictIndex);
  assert.match(
    unavailableLogoBranch,
    /\.\.\.conflict[\s\S]*resolving:\s*false[\s\S]*ไม่พบไฟล์โลโก้เดิม กรุณาอัปโหลดโลโก้ใหม่แล้วเลือกอีกครั้ง/,
    "Logo 422 restores the exact conflict candidates with an actionable error",
  );
  assert.doesNotMatch(
    unavailableLogoBranch,
    /clearProjectRecoveryData|setProjectReady\(true\)|status:\s*"none"|applyDraft/,
    "Logo 422 cannot acknowledge the local choice or clear its recovery journal",
  );
  assert.match(chooseLocal, /res\.status\s*===\s*409[\s\S]*local:\s*conflict\.local[\s\S]*server:/,
    "409 keeps the same local candidate and refreshes the server candidate");
  assert.match(chooseLocal, /clearProjectRecoveryData/);

  const chooseServer = variableInitializer(root, "chooseServerProjectDraft").getText(root);
  assert.match(chooseServer, /applyDraft\(conflict\.server\.draft as V2Draft\)/);
  assert.match(chooseServer, /clearProjectRecoveryData/);
  assert.doesNotMatch(chooseServer, /fetch|PATCH|enqueue|saveEditorProjectDraft/,
    "server choice performs no server write");

  const retryConflictRefresh = variableInitializer(root, "retryConflictServerRefresh").getText(root);
  assert.match(retryConflictRefresh, /requiresServerRefresh/);
  assert.match(retryConflictRefresh, /resolving:\s*"refresh"/,
    "conflict Retry owns a dedicated refresh spinner state");
  assert.match(retryConflictRefresh, /signal:\s*controller\.signal/,
    "conflict Retry GET is abortable at lifecycle boundaries");
  assert.match(retryConflictRefresh, /const stillCurrentRefresh[\s\S]*localChoiceGenerationRef\.current[\s\S]*recoveryRef\.current\.resolving\s*===\s*"refresh"/,
    "conflict Retry callbacks are bound to the active conflict and request generation");
  assert.match(retryConflictRefresh, /refreshConflictAfterAmbiguousWrite\(projectId,\s*conflict/,
    "conflict Retry reuses the authoritative GET seam");
  assert.doesNotMatch(retryConflictRefresh, /method:\s*"PATCH"|chooseLocalProjectDraft|chooseServerProjectDraft|applyDraft|clearProjectRecoveryData|writeEditorProjectRecoveryJournal/,
    "conflict Retry cannot choose, PATCH, mutate local draft, or clear recovery provenance");

  const autosave = sourceBetween(value, "// Persist draft (debounce 1s)", "// ข้อมูลอวตาร");
  assert.match(autosave, /writeEditorProjectRecoveryJournal[\s\S]*editorProjectSaveQueue\.enqueue/,
    "a user-authored journal is written before enqueueing autosave");
  assert.match(autosave, /if \(!journalWritten\) clearEditorProjectRecoveryJournal/,
    "a failed newer journal write removes an older cached candidate");
  assert.match(autosave, /createEditorProjectAutosaveCandidate[\s\S]*latestLocal/,
    "the latest explicit local candidate is materialized before debounce dispatch");
  assert.match(autosave, /createEditorProjectAutosaveSnapshot[\s\S]*expectedDraftRevision/,
    "each dispatched autosave owns an immutable conditional snapshot");
  assert.match(autosave, /save:[\s\S]*acknowledgeAutosaveCandidate[\s\S]*reconcile:/,
    "definite acknowledgements update lineage inside the save path before visible status");
  assert.match(autosave, /reconcile:[\s\S]*decideEditorProjectAutosaveObservation/,
    "ambiguous outcomes reconcile through the pure fingerprint decision");
  assert.match(autosave, /onBlocked:/, "blocked queue outcomes drop the pending autosave lane");
  assert.match(autosave, /userDraftMutationTokenRef\.current/);
  assert.match(autosave, /if \(!latestLocal\)[\s\S]{0,260}status:\s*"load-error"/,
    "an invalid latest local draft enters visible recovery instead of recovery none");
  assert.doesNotMatch(autosave, /!projectReady[\s\S]{0,300}writeEditorProjectRecoveryJournal/,
    "unready renders do not write or allocate recovery");

  const returned = sourceBetween(value, "return {", "};\n}\n\nexport type V2Project");
  assert.match(returned, /projectInitialization/,
    "hook exposes project initialization ownership");
  assert.match(returned, /recovery,\s*retryProjectBootstrap,\s*chooseLocalProjectDraft,\s*chooseServerProjectDraft,\s*retryConflictServerRefresh/,
    "hook exposes the deterministic recovery contract");

  const saveDraft = namedFunction(root, "saveEditorProjectDraft").getText(root);
  assert.match(saveDraft, /expectedDraftRevision:\s*snapshot\.expectedDraftRevision/,
    "ordinary autosave PATCH binds its draft revision to the observed base");
  assert.doesNotMatch(saveDraft, /seedRevision/,
    "a 409 payload never seeds or advances the queue watermark");
  const authoritativeLoad = namedFunction(root, "loadAuthoritativeEditorProjectDraft").getText(root);
  assert.match(authoritativeLoad, /cache:\s*"no-store"/,
    "ambiguous outcomes use a fresh authoritative observation");

  const newProject = sourceBetween(value, "await Promise.resolve();", "storage?.setItem(projectIdStorageKeyRef.current, id)");
  assert.match(newProject, /if \(!isCurrentBootstrap\(\)\) return;[\s\S]*createServerProject\(canonicalSeedDraft,\s*\{/,
    "StrictMode cleanup wins before the only new-project POST");
  assert.match(newProject, /setProjectInitialization\("creating-project"\);[\s\S]*createServerProject/,
    "blank bootstrap exposes its owned creating-project phase");
  assert.match(autosave, /const t = setTimeout[\s\S]*return \(\) => \{ clearTimeout\(t\); \}/,
    "StrictMode cleanup cancels the first autosave setup before PATCH");
}

function verifyReviewerRegressions(): void {
  assert.deepEqual(decideEditorProjectBootstrap({
    projectId: "project-no-edit-retry",
    serverRevision: 5,
    revisionWatermark: 5,
    journal: null,
  }), { kind: "server" }, "no-edit Retry at server revision five chooses server");

  assert.deepEqual(decideEditorProjectBootstrap({
    projectId: "project-missing-journal",
    serverRevision: 0,
    revisionWatermark: 1,
    journal: null,
  }), { kind: "locked-error", code: "missing_recovery" },
  "a missing journal plus watermark one never turns defaults into local recovery");

  const projectId = "project-failed-write";
  const values = new Map<string, string>();
  let failWrites = false;
  const storage: RecoveryStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (failWrites) throw new Error("quota");
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); },
  };
  assert.equal(writeEditorProjectRecoveryJournal(storage, {
    version: 1,
    projectId,
    baseRevision: 3,
    editedAt: "2026-07-15T10:00:00.000Z",
    draft: { script: "cached A" },
  }), true);
  failWrites = true;
  const wroteB = writeEditorProjectRecoveryJournal(storage, {
    version: 1,
    projectId,
    baseRevision: 3,
    editedAt: "2026-07-15T10:01:00.000Z",
    draft: { script: "in-memory B" },
  });
  if (!wroteB) clearEditorProjectRecoveryJournal(storage, projectId);
  assert.equal(readEditorProjectRecoveryJournal(storage, projectId), null,
    "failed journal write cannot reload cached A over in-memory B");
}

async function verifyPureSeams(): Promise<void> {
  const hookModule = await import("../src/app/(dashboard)/video-editor/_v2/useV2Project") as RecoveryHookSeams;
  assert.equal(typeof hookModule.createRecoveryCandidate, "function");
  assert.equal(typeof hookModule.buildLocalConflictPatchBody, "function");
  assert.equal(typeof hookModule.isLatestSavedProjectRevision, "function");

  const localDraft = { script: "local", nested: { clips: ["a"] } };
  const local = hookModule.createRecoveryCandidate!({
    projectId: "project-a",
    draft: localDraft,
    revision: 4,
    updatedAt: "2026-07-15T10:00:00.000Z",
    trusted: true,
  });
  assert.ok(local);
  localDraft.nested.clips[0] = "mutated input";
  assert.deepEqual(local.draft, { script: "local", nested: { clips: ["a"] } },
    "candidate is an immutable snapshot rather than an input alias");
  assert.equal(Object.isFrozen(local), true);
  assert.equal(Object.isFrozen(local.draft), true);
  assert.equal(Object.isFrozen((local.draft.nested as { clips: string[] }).clips), true);

  const server = hookModule.createRecoveryCandidate!({
    projectId: "project-a",
    draft: { script: "server" },
    revision: 5,
    updatedAt: null,
    trusted: true,
  });
  assert.ok(server);
  const body = hookModule.buildLocalConflictPatchBody!({ local, server }, 6);
  assert.equal(body.draft, local.draft, "PATCH uses the displayed frozen local snapshot");
  assert.deepEqual(body, {
    draft: local.draft,
    draftRevision: 6,
    expectedDraftRevision: 5,
    touchLastOpened: true,
  });

  assert.equal(hookModule.isLatestSavedProjectRevision!(
    { projectId: "project-a", revision: 6, status: "saved" },
    { projectId: "project-a", revision: 6 },
  ), true);
  for (const event of [
    { projectId: "project-b", revision: 6, status: "saved" },
    { projectId: "project-a", revision: 5, status: "saved" },
    { projectId: "project-a", revision: 6, status: "error" },
  ]) {
    assert.equal(hookModule.isLatestSavedProjectRevision!(event, {
      projectId: "project-a",
      revision: 6,
    }), false, "only the latest matching successful save clears recovery");
  }
}

async function main(): Promise<void> {
  verifyHookSource(source);
  await verifyPureSeams();
  verifyReviewerRegressions();
  await verifyRuntimeHookContract();
  await verifyRuntimeHookMutationSensitivity();
  await verifyProjectJobRuntimeGate();
  await verifyProjectJobGateMutationSensitivity();

  const missingBoundary = source.replace(
    /(const\s*\[\s*projectTitle\s*,\s*setProjectTitle\s*,\s*setProjectTitleRaw\s*\]\s*=\s*useUserDraftState(?:<[^;]+?>)?\([\s\S]*?effectiveDraftRef,\s*canAcceptUserMutation,\s*)markUserDraftMutation(,\s*\);)/,
    "$1(() => {})$2",
  );
  assert.notEqual(missingBoundary, source, "public-setter mutation applied");
  assert.throws(
    () => verifyHookSource(missingBoundary),
    /projectTitle synchronizes projectTitle/,
    "removing markUserDraftMutation from a public setter makes verification fail",
  );

  const applyMutation = source.replace(
    "function applyDraft(next: V2Draft) {",
    "function applyDraft(next: V2Draft) {\n    markUserDraftMutation();",
  );
  assert.notEqual(applyMutation, source, "applyDraft mutation applied");
  assert.throws(
    () => verifyHookSource(applyMutation),
    /applyDraft cannot manufacture user provenance/,
    "adding markUserDraftMutation to applyDraft makes verification fail",
  );

  const missingRecoveryGate = source.replace(
    `      && projectReadyRef.current
      && recoveryRef.current.status === "none",`,
    `      && projectReadyRef.current,`,
  );
  assert.notEqual(missingRecoveryGate, source, "recovery gate mutation applied");
  assert.throws(
    () => verifyHookSource(missingRecoveryGate),
    /shared synchronous operation gate requires initialization, readiness, and recovery ownership/,
    "removing recovery ownership from the public operation gate makes verification fail",
  );

  console.log("editor-project-recovery-hook: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Run with: npx tsx scripts/verify-logo-project-default.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
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

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function identifierCalls(root: ts.Node, name: string): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === name,
  );
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    const propertyName = property.name;
    return propertyName !== undefined
      && (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName))
      && propertyName.text === name;
  });
}

function blankProjectDefaultGuard(root: ts.SourceFile): ts.IfStatement {
  const guards = descendants(root, ts.isIfStatement).filter((statement) => {
    const expression = statement.expression;
    return ts.isPrefixUnaryExpression(expression)
      && expression.operator === ts.SyntaxKind.ExclamationToken
      && ts.isIdentifier(expression.operand)
      && expression.operand.text === "hasLocalDraft";
  });
  assert.equal(
    guards.length,
    1,
    "blank-project account default has exactly one !hasLocalDraft guard",
  );
  return guards[0];
}

function verifyBlankProjectDefaultContract(source: string): void {
  const root = ts.createSourceFile(
    "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const guard = blankProjectDefaultGuard(root);
  assert.ok(ts.isBlock(guard.thenStatement), "blank-project default work stays in one guarded block");

  const loadCalls = identifierCalls(guard.thenStatement, "loadAccountLogoDefault");
  assert.equal(loadCalls.length, 1, "blank-project guard owns the account-default lookup");
  const loadCall = loadCalls[0];
  const awaitedDefault = loadCall.parent;
  assert.ok(ts.isAwaitExpression(awaitedDefault), "blank-project account-default lookup is awaited");
  const defaultAssignment = awaitedDefault.parent;
  assert.ok(
    ts.isBinaryExpression(defaultAssignment)
      && defaultAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(defaultAssignment.left),
    "resolved account default is retained for blank-project inheritance",
  );
  const accountDefaultName = defaultAssignment.left.text;

  const loadTry = descendants(guard.thenStatement, ts.isTryStatement).filter(
    (statement) => loadCall.pos >= statement.tryBlock.pos && loadCall.end <= statement.tryBlock.end,
  );
  assert.equal(loadTry.length, 1, "blank-project default lookup is fail-closed by try/catch");
  const catchClause = loadTry[0].catchClause;
  assert.ok(catchClause, "blank-project default lookup has an owned failure path");

  const ownershipReturns = descendants(catchClause.block, ts.isIfStatement).filter((statement) => {
    const expression = statement.expression;
    const thenStatements = ts.isBlock(statement.thenStatement)
      ? statement.thenStatement.statements
      : [statement.thenStatement];
    return ts.isPrefixUnaryExpression(expression)
      && expression.operator === ts.SyntaxKind.ExclamationToken
      && ts.isCallExpression(expression.operand)
      && ts.isIdentifier(expression.operand.expression)
      && expression.operand.expression.text === "isCurrentBootstrap"
      && thenStatements.some(ts.isReturnStatement);
  });
  assert.equal(ownershipReturns.length, 1, "default-load failure checks bootstrap ownership");

  const readyCalls = identifierCalls(catchClause.block, "setProjectReady");
  assert.ok(
    readyCalls.some((call) => call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword),
    "owned default-load failure keeps the project unready",
  );
  const initializationCalls = identifierCalls(catchClause.block, "setProjectInitialization");
  assert.ok(
    initializationCalls.some((call) => stringLiteralText(call.arguments[0]) === "error"),
    "owned default-load failure sets project initialization error",
  );
  const saveStatusCalls = identifierCalls(catchClause.block, "setSaveStatus");
  assert.ok(
    saveStatusCalls.some((call) => stringLiteralText(call.arguments[0]) === "error"),
    "owned default-load failure exposes an error save status",
  );
  const recoveryCalls = identifierCalls(catchClause.block, "setRecoveryState");
  assert.ok(
    recoveryCalls.some((call) => {
      const state = call.arguments[0];
      if (!state || !ts.isObjectLiteralExpression(state)) return false;
      const status = propertyNamed(state, "status");
      return status !== undefined
        && ts.isPropertyAssignment(status)
        && stringLiteralText(status.initializer) === "load-error";
    }),
    "owned default-load failure exposes load-error recovery",
  );
  assert.ok(
    catchClause.block.statements.length > 0
      && ts.isReturnStatement(catchClause.block.statements[catchClause.block.statements.length - 1]),
    "owned default-load failure returns before applying or creating a project",
  );
  assert.equal(identifierCalls(catchClause.block, "applyDraft").length, 0);
  assert.equal(identifierCalls(catchClause.block, "createServerProject").length, 0);

  const inheritedCalls = identifierCalls(guard.thenStatement, "logoOverlayForNewProject");
  assert.equal(inheritedCalls.length, 1, "blank-project guard owns default inheritance");
  const inheritedCall = inheritedCalls[0];
  assert.ok(loadCall.end < inheritedCall.pos, "the resolved default feeds blank-project inheritance");
  const inheritedInput = inheritedCall.arguments[0];
  assert.ok(
    inheritedInput !== undefined && ts.isObjectLiteralExpression(inheritedInput),
    "blank-project inheritance has explicit ownership input",
  );
  const existingDraftProperty = propertyNamed(inheritedInput, "hasExistingDraft");
  assert.ok(
    existingDraftProperty !== undefined
      && ts.isPropertyAssignment(existingDraftProperty)
      && existingDraftProperty.initializer.kind === ts.SyntaxKind.FalseKeyword,
    "only the blank seed requests account-default inheritance",
  );
  const accountDefaultProperty = propertyNamed(inheritedInput, "accountDefault");
  assert.ok(
    accountDefaultProperty !== undefined
      && (
        (
          ts.isShorthandPropertyAssignment(accountDefaultProperty)
          && accountDefaultProperty.name.text === accountDefaultName
        )
        || (
          ts.isPropertyAssignment(accountDefaultProperty)
          && ts.isIdentifier(accountDefaultProperty.initializer)
          && accountDefaultProperty.initializer.text === accountDefaultName
        )
      ),
    "the resolved account default is passed to blank-project inheritance",
  );
  const inheritedDeclaration = inheritedCall.parent;
  assert.ok(
    ts.isVariableDeclaration(inheritedDeclaration) && ts.isIdentifier(inheritedDeclaration.name),
    "blank-project inheritance result is retained for the seed",
  );
  const inheritedName = inheritedDeclaration.name.text;
  const seedAssignments = descendants(guard.thenStatement, ts.isBinaryExpression).filter(
    (assignment) => assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(assignment.left)
      && ts.isIdentifier(assignment.left.expression)
      && assignment.left.expression.text === "seedDraft"
      && assignment.left.name.text === "logoOverlay"
      && ts.isIdentifier(assignment.right)
      && assignment.right.text === inheritedName,
  );
  assert.equal(seedAssignments.length, 1, "only the blank seed receives the inherited Logo config");

  assert.ok(ts.isBlock(guard.parent), "blank-project guard remains in the bootstrap block");
  const guardIndex = guard.parent.statements.indexOf(guard);
  const followingStatements = guard.parent.statements.slice(guardIndex + 1);
  assert.ok(
    followingStatements.some((statement) => identifierCalls(statement, "applyDraft").length > 0),
    "draft application remains after the fail-closed blank-project guard",
  );
  assert.ok(
    followingStatements.some((statement) => identifierCalls(statement, "createServerProject").length > 0),
    "project creation remains after the fail-closed blank-project guard",
  );
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
verifyBlankProjectDefaultContract(projectSource);

const projectRoot = ts.createSourceFile(
  "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
  projectSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const blankGuard = blankProjectDefaultGuard(projectRoot);
const unguardedMutation = projectSource.slice(0, blankGuard.expression.getStart(projectRoot))
  + "true"
  + projectSource.slice(blankGuard.expression.end);
assert.throws(
  () => verifyBlankProjectDefaultContract(unguardedMutation),
  /blank-project account default has exactly one !hasLocalDraft guard/,
  "verifier rejects removal of the blank-project guard",
);

const initializationErrorCall = identifierCalls(blankGuard.thenStatement, "setProjectInitialization")
  .find((call) => stringLiteralText(call.arguments[0]) === "error");
assert.ok(initializationErrorCall, "mutation target includes the initialization error transition");
assert.ok(
  ts.isExpressionStatement(initializationErrorCall.parent),
  "initialization error transition is a removable statement",
);
const missingErrorTransitionMutation = projectSource.slice(
  0,
  initializationErrorCall.parent.getFullStart(),
) + projectSource.slice(initializationErrorCall.parent.end);
assert.throws(
  () => verifyBlankProjectDefaultContract(missingErrorTransitionMutation),
  /owned default-load failure sets project initialization error/,
  "verifier rejects removal of the fail-closed initialization transition",
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
  /logoOverlay, projectId, projectReady,[\s\S]{0,220}setRecoveryState, saveRevision\]\);/,
  "save revision participates in the autosave effect dependencies",
);
assert.match(
  projectSource,
  /\},\s*\[\s*createServerProject,\s*bootstrapRetryRevision,\s*invalidateAutosaveLineage,\s*invalidateLocalChoiceRequest,[^\]]*\bsetProjectInitialization\b[^\]]*\]\);/,
  "bootstrap Retry reruns the existing-project load without creating an alternate path",
);
assert.match(
  localSeedSource,
  /const canonicalSeedDraft = canonicalizeDraftLogoOverlay\(seedDraft\);[\s\S]{0,240}applyDraft\(canonicalSeedDraft\);[\s\S]{0,320}createServerProject\(canonicalSeedDraft,\s*\{/,
  "the same canonical local draft is applied and posted",
);

console.log("logo-project-default: all checks passed");

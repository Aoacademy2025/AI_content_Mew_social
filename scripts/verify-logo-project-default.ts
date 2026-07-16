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

function variableInitializer(root: ts.SourceFile, name: string): ts.Expression {
  const declarations = descendants(root, ts.isVariableDeclaration).filter(
    (declaration) => ts.isIdentifier(declaration.name)
      && declaration.name.text === name
      && declaration.initializer !== undefined,
  );
  assert.equal(declarations.length, 1, `variable ${name} has one initializer`);
  return declarations[0].initializer!;
}

function containsNode(container: ts.Node, node: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

function isBlankDraftGuard(statement: ts.IfStatement): boolean {
  const expression = statement.expression;
  return ts.isPrefixUnaryExpression(expression)
    && expression.operator === ts.SyntaxKind.ExclamationToken
    && ts.isIdentifier(expression.operand)
    && expression.operand.text === "hasLocalDraft";
}

function directIdentifierCall(
  statement: ts.Statement,
  name: string,
): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement)) return null;
  const expression = statement.expression;
  return ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === name
    ? expression
    : null;
}

function isOwnershipReturn(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const expression = statement.expression;
  if (
    !ts.isPrefixUnaryExpression(expression)
    || expression.operator !== ts.SyntaxKind.ExclamationToken
    || !ts.isCallExpression(expression.operand)
    || !ts.isIdentifier(expression.operand.expression)
    || expression.operand.expression.text !== "isCurrentBootstrap"
    || expression.operand.arguments.length !== 0
  ) return false;
  const ownedStatements = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements
    : [statement.thenStatement];
  return ownedStatements.length === 1 && ts.isReturnStatement(ownedStatements[0]);
}

function unwrapAssignmentTarget(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function assignmentRoots(expression: ts.Expression): ts.Identifier[] {
  let current = unwrapAssignmentTarget(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
    current = unwrapAssignmentTarget(current);
  }
  if (ts.isIdentifier(current)) return [current];
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) => {
      if (ts.isOmittedExpression(element)) return [];
      return assignmentRoots(ts.isSpreadElement(element) ? element.expression : element);
    });
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property)) return assignmentRoots(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      if (ts.isSpreadAssignment(property)) return assignmentRoots(property.expression);
      return [];
    });
  }
  return [];
}

function writesIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    return operator >= ts.SyntaxKind.FirstAssignment
      && operator <= ts.SyntaxKind.LastAssignment
      && assignmentRoots(node.left).some((root) => root.text === name);
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const isUpdate = node.operator === ts.SyntaxKind.PlusPlusToken
      || node.operator === ts.SyntaxKind.MinusMinusToken;
    return isUpdate && assignmentRoots(node.operand).some((root) => root.text === name);
  }
  return ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === name
    && node.initializer !== undefined;
}

function parseProjectWithSymbols(source: string): {
  root: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "src/app/(dashboard)/video-editor/_v2/useV2Project.ts";
  const root = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (requested) => requested === fileName ? root : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (requested) => requested === fileName,
    readFile: (requested) => requested === fileName ? source : undefined,
    getCanonicalFileName: (requested) => requested,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([fileName], options, host);
  const boundRoot = program.getSourceFile(fileName);
  assert.ok(boundRoot, "project hook is bound for symbol-identity checks");
  return { root: boundRoot, checker: program.getTypeChecker() };
}

type ProjectDefaultFlow = {
  guard: ts.IfStatement;
  loadCall: ts.CallExpression;
  loadTry: ts.TryStatement;
  catchClause: ts.CatchClause;
};

function projectDefaultFlow(root: ts.SourceFile): ProjectDefaultFlow {
  const globalLoadCalls = identifierCalls(root, "loadAccountLogoDefault");
  assert.equal(
    globalLoadCalls.length,
    2,
    "hook has exactly the approved Reset and blank-bootstrap account-default lookups",
  );

  const resetProject = variableInitializer(root, "resetProject");
  const resetLoadCalls = identifierCalls(resetProject, "loadAccountLogoDefault");
  assert.equal(resetLoadCalls.length, 1, "Reset owns exactly one approved account-default lookup");
  const resetTry = descendants(resetProject, ts.isTryStatement).filter(
    (statement) => containsNode(statement.tryBlock, resetLoadCalls[0]),
  );
  assert.equal(resetTry.length, 1, "Reset lookup remains in its approved fail-closed flow");
  assert.ok(ts.isAwaitExpression(resetLoadCalls[0].parent), "Reset awaits its account-default lookup");

  const blankLoadCalls = globalLoadCalls.filter((call) => !containsNode(resetProject, call));
  assert.equal(blankLoadCalls.length, 1, "one account-default lookup belongs to blank bootstrap");
  const loadCall = blankLoadCalls[0];
  const containingGuards = descendants(root, ts.isIfStatement).filter(
    (statement) => isBlankDraftGuard(statement) && containsNode(statement.thenStatement, loadCall),
  );
  assert.equal(
    containingGuards.length,
    1,
    "the sole non-Reset lookup is owned by the blank-project guard",
  );
  const guard = containingGuards[0];
  assert.ok(ts.isBlock(guard.thenStatement), "blank-project default work stays in one guarded block");

  const loadTry = descendants(guard.thenStatement, ts.isTryStatement).filter(
    (statement) => containsNode(statement.tryBlock, loadCall),
  );
  assert.equal(loadTry.length, 1, "blank-project default lookup is fail-closed by try/catch");
  const catchClause = loadTry[0].catchClause;
  assert.ok(catchClause, "blank-project default lookup has an owned failure path");
  return { guard, loadCall, loadTry: loadTry[0], catchClause };
}

function directTransitionIndex(
  catchClause: ts.CatchClause,
  name: string,
  matches: (call: ts.CallExpression) => boolean,
  label: string,
): number {
  const allCalls = identifierCalls(catchClause.block, name);
  assert.equal(allCalls.length, 1, `${label} occurs exactly once on the failure path`);
  const indexes = catchClause.block.statements
    .map((statement, index) => ({ call: directIdentifierCall(statement, name), index }))
    .filter((entry) => entry.call !== null && matches(entry.call));
  assert.equal(indexes.length, 1, `${label} is a direct top-level catch transition`);
  return indexes[0].index;
}

function verifyBlankProjectDefaultContract(source: string): void {
  const { root, checker } = parseProjectWithSymbols(source);
  const { guard, loadCall, loadTry, catchClause } = projectDefaultFlow(root);
  const guardBlock = guard.thenStatement;
  assert.ok(ts.isBlock(guardBlock), "classified blank-project guard owns a block");

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

  const catchStatements = catchClause.block.statements;
  assert.ok(
    catchStatements.length > 0 && isOwnershipReturn(catchStatements[0]),
    "bootstrap ownership return is the first top-level failure statement",
  );
  assert.ok(
    catchStatements.length > 1 && ts.isReturnStatement(catchStatements[catchStatements.length - 1]),
    "owned default-load failure ends with a top-level return",
  );
  const readyIndex = directTransitionIndex(
    catchClause,
    "setProjectReady",
    (call) => call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword,
    "project-unready transition",
  );
  const initializationIndex = directTransitionIndex(
    catchClause,
    "setProjectInitialization",
    (call) => stringLiteralText(call.arguments[0]) === "error",
    "project initialization error transition",
  );
  const saveStatusIndex = directTransitionIndex(
    catchClause,
    "setSaveStatus",
    (call) => stringLiteralText(call.arguments[0]) === "error",
    "save-status error transition",
  );
  const recoveryIndex = directTransitionIndex(
    catchClause,
    "setRecoveryState",
    (call) => {
      const state = call.arguments[0];
      if (!state || !ts.isObjectLiteralExpression(state)) return false;
      const status = propertyNamed(state, "status");
      return status !== undefined
        && ts.isPropertyAssignment(status)
        && stringLiteralText(status.initializer) === "load-error";
    },
    "load-error recovery transition",
  );
  assert.ok(
    readyIndex > 0
      && initializationIndex > readyIndex
      && saveStatusIndex > initializationIndex
      && recoveryIndex > saveStatusIndex
      && recoveryIndex < catchStatements.length - 1,
    "owned failure transitions follow ownership and precede the final return",
  );
  for (const dangerousCall of ["applyDraft", "createServerProject"]) {
    assert.equal(
      identifierCalls(catchClause.block, dangerousCall).length,
      0,
      `catch cannot call ${dangerousCall}`,
    );
    assert.equal(
      loadTry.finallyBlock ? identifierCalls(loadTry.finallyBlock, dangerousCall).length : 0,
      0,
      `finally cannot call ${dangerousCall}`,
    );
  }

  const inheritedCalls = identifierCalls(guardBlock, "logoOverlayForNewProject");
  assert.equal(inheritedCalls.length, 1, "blank-project guard owns default inheritance");
  const inheritedCall = inheritedCalls[0];
  assert.ok(loadCall.end < inheritedCall.pos, "the resolved default feeds blank-project inheritance");
  const writesBetween = descendants(guardBlock, (node): node is ts.Node => (
    writesIdentifier(node, accountDefaultName)
  )).filter(
    (node) => node.getStart(root) >= defaultAssignment.end
      && node.getStart(root) < inheritedCall.getStart(root),
  );
  assert.equal(
    writesBetween.length,
    0,
    "resolved account default is not rewritten before inheritance",
  );

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
  const inheritedUseGuards = guardBlock.statements.filter(
    (statement): statement is ts.IfStatement => ts.isIfStatement(statement)
      && ts.isIdentifier(statement.expression)
      && statement.expression.text === inheritedName,
  );
  assert.equal(inheritedUseGuards.length, 1, "inherited Logo is guarded once before seed assignment");
  const inheritedUseGuard = inheritedUseGuards[0];
  const inheritedGuardReference = inheritedUseGuard.expression;
  assert.ok(ts.isIdentifier(inheritedGuardReference), "inherited Logo guard reads the retained result");
  assert.equal(inheritedUseGuard.elseStatement, undefined, "inherited Logo guard has no alternate use");
  const inheritedUseStatements = ts.isBlock(inheritedUseGuard.thenStatement)
    ? inheritedUseGuard.thenStatement.statements
    : [inheritedUseGuard.thenStatement];
  assert.equal(inheritedUseStatements.length, 1, "inherited Logo guard owns one seed write");
  const inheritedAssignmentStatement = inheritedUseStatements[0];
  assert.ok(
    ts.isExpressionStatement(inheritedAssignmentStatement)
      && ts.isBinaryExpression(inheritedAssignmentStatement.expression),
    "inherited Logo use is the blank seed assignment",
  );
  const inheritedAssignment = inheritedAssignmentStatement.expression;
  const inheritedAssignmentReference = inheritedAssignment.right;
  assert.ok(
    inheritedAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(inheritedAssignment.left)
      && ts.isIdentifier(inheritedAssignment.left.expression)
      && inheritedAssignment.left.expression.text === "seedDraft"
      && inheritedAssignment.left.name.text === "logoOverlay"
      && ts.isIdentifier(inheritedAssignmentReference)
      && inheritedAssignmentReference.text === inheritedName,
    "only the blank seed receives the inherited Logo config",
  );
  const inheritedSymbol = checker.getSymbolAtLocation(inheritedDeclaration.name);
  assert.ok(inheritedSymbol, "the inherited Logo declaration has semantic identity");
  const inheritedReferences = descendants(guardBlock, ts.isIdentifier).filter(
    (identifier) => identifier !== inheritedDeclaration.name
      && checker.getSymbolAtLocation(identifier) === inheritedSymbol,
  );
  assert.equal(inheritedReferences.length, 2, "inherited Logo has no use beyond guard and seed write");
  assert.ok(
    inheritedReferences.includes(inheritedGuardReference)
      && inheritedReferences.includes(inheritedAssignmentReference),
    "inherited Logo references are limited to its guard and seed write",
  );

  assert.ok(ts.isBlock(guard.parent), "blank-project guard remains in the bootstrap block");
  const hasLocalDraftDeclarations = descendants(guard.parent, ts.isVariableDeclaration).filter(
    (declaration) => ts.isIdentifier(declaration.name)
      && declaration.name.text === "hasLocalDraft"
      && declaration.end < guard.pos,
  );
  assert.equal(hasLocalDraftDeclarations.length, 1, "guard belongs to the local-or-blank seed flow");
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
const originalFlow = projectDefaultFlow(projectRoot);
const blankGuard = originalFlow.guard;
const unguardedMutation = projectSource.slice(0, blankGuard.expression.getStart(projectRoot))
  + "true"
  + projectSource.slice(blankGuard.expression.end);
assert.throws(
  () => verifyBlankProjectDefaultContract(unguardedMutation),
  /the sole non-Reset lookup is owned by the blank-project guard/,
  "verifier rejects removal of the blank-project guard",
);

const initializationErrorStatement = originalFlow.catchClause.block.statements.find((statement) => {
  const call = directIdentifierCall(statement, "setProjectInitialization");
  return call !== null && stringLiteralText(call.arguments[0]) === "error";
});
assert.ok(
  initializationErrorStatement,
  "mutation target includes the validated catch initialization error transition",
);
const initializationErrorCall = directIdentifierCall(
  initializationErrorStatement,
  "setProjectInitialization",
);
assert.ok(initializationErrorCall, "mutation target includes the initialization error transition");
const missingErrorTransitionMutation = projectSource.slice(
  0,
  initializationErrorStatement.getFullStart(),
) + projectSource.slice(initializationErrorStatement.end);
assert.throws(
  () => verifyBlankProjectDefaultContract(missingErrorTransitionMutation),
  /project initialization error transition occurs exactly once on the failure path/,
  "verifier rejects removal of the fail-closed initialization transition",
);

const blankLoadTry = originalFlow.loadTry;
const catchStatements = originalFlow.catchClause.block.statements;
const ownershipStatement = catchStatements[0];
assert.ok(ownershipStatement, "mutation target includes the ownership statement");
const inheritedCall = identifierCalls(blankGuard.thenStatement, "logoOverlayForNewProject")[0];
assert.ok(
  ts.isVariableDeclaration(inheritedCall.parent) && ts.isIdentifier(inheritedCall.parent.name),
  "mutation target includes the inherited result",
);
const inheritedName = inheritedCall.parent.name.text;
const inheritedSeedAssignment = descendants(blankGuard.thenStatement, ts.isBinaryExpression).find(
  (assignment) => assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(assignment.left)
    && ts.isIdentifier(assignment.left.expression)
    && assignment.left.expression.text === "seedDraft"
    && assignment.left.name.text === "logoOverlay"
    && ts.isIdentifier(assignment.right)
    && assignment.right.text === inheritedName,
);
assert.ok(
  inheritedSeedAssignment && ts.isExpressionStatement(inheritedSeedAssignment.parent),
  "mutation target includes the blank seed assignment",
);

const unrelatedGuardMutation = projectSource.slice(0, blankGuard.getFullStart())
  + "\n      if (!hasLocalDraft) { void 0; }\n"
  + projectSource.slice(blankGuard.getFullStart());
const extraGlobalLookupMutation = projectSource.slice(0, blankGuard.getFullStart())
  + "\n      void loadAccountLogoDefault();\n"
  + projectSource.slice(blankGuard.getFullStart());
const setterBeforeOwnershipMutation = projectSource.slice(0, ownershipStatement.getStart(projectRoot))
  + initializationErrorStatement.getText(projectRoot)
  + "\n          "
  + ownershipStatement.getText(projectRoot)
  + projectSource.slice(ownershipStatement.end, initializationErrorStatement.getStart(projectRoot))
  + projectSource.slice(initializationErrorStatement.end);
const nestedUnreachableSetterMutation = projectSource.slice(
  0,
  initializationErrorStatement.getStart(projectRoot),
) + `if (false) { ${initializationErrorStatement.getText(projectRoot)} }`
  + projectSource.slice(initializationErrorStatement.end);
const resetDefaultBeforeInheritanceMutation = projectSource.slice(0, blankLoadTry.end)
  + "\n        accountDefault = null;"
  + projectSource.slice(blankLoadTry.end);
const parenthesizedDefaultRewriteMutation = projectSource.slice(0, blankLoadTry.end)
  + "\n        (accountDefault) = null;"
  + projectSource.slice(blankLoadTry.end);
const assertedDefaultRewriteMutation = projectSource.slice(0, blankLoadTry.end)
  + "\n        (accountDefault as LogoOverlayConfig | null) = null;"
  + projectSource.slice(blankLoadTry.end);
const arrayDestructuringDefaultRewriteMutation = projectSource.slice(0, blankLoadTry.end)
  + "\n        [accountDefault] = [null];"
  + projectSource.slice(blankLoadTry.end);
const objectDestructuringDefaultRewriteMutation = projectSource.slice(0, blankLoadTry.end)
  + "\n        ({ value: accountDefault } = { value: null });"
  + projectSource.slice(blankLoadTry.end);
const extraInheritedUseMutation = projectSource.slice(0, inheritedSeedAssignment.parent.end)
  + `\n        void ${inheritedName};`
  + projectSource.slice(inheritedSeedAssignment.parent.end);
const shadowedAndPropertyKeyAcceptance = projectSource.slice(
  0,
  inheritedSeedAssignment.parent.end,
) + `\n        void { ${inheritedName}: true };\n`
  + `        void ((${inheritedName}: string) => ${inheritedName})("shadow");`
  + projectSource.slice(inheritedSeedAssignment.parent.end);

assert.doesNotThrow(
  () => verifyBlankProjectDefaultContract(unrelatedGuardMutation),
  "unrelated !hasLocalDraft guards do not replace the call-containing default guard",
);
assert.throws(
  () => verifyBlankProjectDefaultContract(extraGlobalLookupMutation),
  /hook has exactly the approved Reset and blank-bootstrap account-default lookups/,
  "verifier rejects an extra unclassified account-default lookup",
);
assert.throws(
  () => verifyBlankProjectDefaultContract(setterBeforeOwnershipMutation),
  /bootstrap ownership return is the first top-level failure statement/,
  "verifier rejects an error setter moved before the ownership check",
);
assert.throws(
  () => verifyBlankProjectDefaultContract(nestedUnreachableSetterMutation),
  /project initialization error transition is a direct top-level catch transition/,
  "verifier rejects a nested unreachable initialization setter",
);
assert.throws(
  () => verifyBlankProjectDefaultContract(resetDefaultBeforeInheritanceMutation),
  /resolved account default is not rewritten before inheritance/,
  "verifier rejects resetting the resolved default before inheritance",
);
for (const [label, mutation] of [
  ["parenthesized", parenthesizedDefaultRewriteMutation],
  ["type-asserted", assertedDefaultRewriteMutation],
  ["array destructuring", arrayDestructuringDefaultRewriteMutation],
  ["object destructuring", objectDestructuringDefaultRewriteMutation],
] as const) {
  assert.throws(
    () => verifyBlankProjectDefaultContract(mutation),
    /resolved account default is not rewritten before inheritance/,
    `verifier rejects a ${label} resolved-default rewrite`,
  );
}
assert.throws(
  () => verifyBlankProjectDefaultContract(extraInheritedUseMutation),
  /inherited Logo has no use beyond guard and seed write/,
  "verifier rejects an extra use of the inherited Logo result",
);
assert.doesNotThrow(
  () => verifyBlankProjectDefaultContract(shadowedAndPropertyKeyAcceptance),
  "shadowed bindings and same-text property keys are not uses of the inherited Logo declaration",
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

import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), "utf8");

function section(source: string, from: string, to?: string): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing section marker: ${from}`);
  const end = to ? source.indexOf(to, start + from.length) : source.length;
  assert.notEqual(end, -1, `missing section marker: ${to}`);
  return source.slice(start, end);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = path.join(dir, name);
    return statSync(absolute).isDirectory()
      ? sourceFiles(absolute)
      : /\.[cm]?[jt]sx?$/.test(name)
        ? [absolute]
        : [];
  });
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

type FetchAudit = {
  relative: string;
  endpoint: string | null;
  method: string;
  fileMentionsManagedCache: boolean;
};

function auditFetchSource(source: string, relative: string): FetchAudit[] {
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const constants = new Map<string, ts.Expression | null>();
  const audits: FetchAudit[] = [];

  function collectConstants(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(
        node.name.text,
        constants.has(node.name.text) ? null : node.initializer,
      );
    }
    ts.forEachChild(node, collectConstants);
  }

  function staticText(expression: ts.Expression | null | undefined, depth = 0): string | null {
    if (!expression || depth > 6) return null;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) {
      return expression.head.text + expression.templateSpans.map((span) => "${*}" + span.literal.text).join("");
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(expression.left, depth + 1);
      const right = staticText(expression.right, depth + 1);
      return left !== null && right !== null ? left + right : null;
    }
    if (ts.isIdentifier(expression)) return staticText(constants.get(expression.text), depth + 1);
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      && expression.expression.text === "encodeURIComponent") return "${*}";
    return null;
  }

  function objectMethod(expression: ts.Expression | null | undefined, depth = 0): string {
    if (expression === undefined) return "GET";
    if (expression === null) return "UNKNOWN";
    if (depth > 6) return "UNKNOWN";
    if (ts.isIdentifier(expression)) return objectMethod(constants.get(expression.text), depth + 1);
    if (!ts.isObjectLiteralExpression(expression)) return "UNKNOWN";
    if (expression.properties.some(ts.isSpreadAssignment)) return "UNKNOWN";
    const methodProperty = expression.properties.find((property) =>
      ts.isPropertyAssignment(property)
      && ((ts.isIdentifier(property.name) && property.name.text === "method")
        || (ts.isStringLiteral(property.name) && property.name.text === "method")),
    );
    if (!methodProperty || !ts.isPropertyAssignment(methodProperty)) return "GET";
    return staticText(methodProperty.initializer, depth + 1)?.toUpperCase() ?? "UNKNOWN";
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const isFetch = (ts.isIdentifier(node.expression) && node.expression.text === "fetch")
        || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "fetch");
      const isDeleteMember = ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text.toLowerCase() === "delete";
      const endpoint = staticText(node.arguments[0]);
      const managedEndpoint = endpoint !== null && isManagedCacheEndpoint(endpoint);
      const deleteReceiver = isDeleteMember && ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression.getText(sourceFile)
        : "";
      const isHttpDeleteMember = isDeleteMember
        && (managedEndpoint || /(?:axios|http|api|client)/i.test(deleteReceiver));
      if (!isFetch && !isHttpDeleteMember) {
        ts.forEachChild(node, visit);
        return;
      }
      audits.push({
        relative,
        endpoint,
        method: isHttpDeleteMember ? "DELETE" : objectMethod(node.arguments[1]),
        fileMentionsManagedCache: source.includes("/api/stocks") || source.includes("/cache"),
      });
    }
    ts.forEachChild(node, visit);
  }

  collectConstants(sourceFile);
  visit(sourceFile);
  return audits;
}

function auditFetchCalls(absolute: string): FetchAudit[] {
  return auditFetchSource(readFileSync(absolute, "utf8"), path.relative(ROOT, absolute));
}

function isManagedCacheEndpoint(endpoint: string): boolean {
  return /^\/api\/stocks(?:[/?]|$)/.test(endpoint)
    || /^\/api\/admin\/users\/.*\/cache(?:[/?]|$)/.test(endpoint);
}

function isDestructiveManagedCacheCall(audit: FetchAudit): boolean {
  if (audit.endpoint !== null && isManagedCacheEndpoint(audit.endpoint)) return audit.method !== "GET";
  return audit.method === "DELETE" && audit.endpoint === null && audit.fileMentionsManagedCache;
}

function assertDeleteHandlerCallAllowlist(source: string, label: string, allowedCalls: string[]) {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let deleteHandler: ts.FunctionDeclaration | undefined;
  sourceFile.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "DELETE") deleteHandler = node;
  });
  assert.ok(deleteHandler, `${label} must export a DELETE function declaration`);

  function callName(expression: ts.LeftHandSideExpression): string {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      return `${callName(expression.expression)}.${expression.name.text}`;
    }
    return `<${ts.SyntaxKind[expression.kind]}>`;
  }

  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) calls.push(callName(node.expression));
    ts.forEachChild(node, visit);
  }
  visit(deleteHandler);
  assert.deepEqual(
    calls.filter((call) => !allowedCalls.includes(call)),
    [],
    `${label} may call only explicitly reviewed auth/response helpers`,
  );
}

function assertLifecycleGate(handler: string, authorizationMarker: string, label: string) {
  const authIndex = handler.indexOf(authorizationMarker);
  const lifecycleIndex = handler.indexOf("media_lifecycle_managed");
  assert.ok(authIndex >= 0, `${label} must keep its authorization check`);
  assert.ok(lifecycleIndex >= 0, `${label} must expose the lifecycle-managed response code`);
  assert.ok(authIndex < lifecycleIndex, `${label} must authorize before the lifecycle gate`);
  assert.doesNotMatch(
    handler,
    /(?:fs|prisma)\.|\b(?:applyMediaCleanupPlan|executeMediaCleanup|purgeQuarantine|restoreQuarantine|unlinkSync|rmSync|writeFile|rename|copyFile|spawn|exec|fetch|\$transaction)\s*\(/,
    `${label} must not invoke any filesystem, database, cleanup, process, or network mutation`,
  );
}

function assertNoAutomaticCustomerMediaDeletion() {
  const cron = read("src/app/api/cron/cleanup-videos/route.ts");
  assert.doesNotMatch(cron, /deleteLowResPreviewForVideoUrl|unlinkSync|prisma\.video\./);
  assert.equal(count(cron, /fs\.rmSync\(/g), 1, "cron may only remove its reviewed Remotion tmp child");
  assert.match(cron, /path\.join\(process\.cwd\(\), "\.tmp", "remotion"\)/);
  assert.doesNotMatch(cron, /public["'],\s*["']renders|["']stocks["']/);
  assert.match(cron, /prisma\.payment\.findMany/);
  assert.match(cron, /cleanupOldChildren/);
  assert.match(cron, /prisma\.telemetryEvent\.deleteMany/);
  assert.match(cron, /writeCronHeartbeat\("cleanup-videos"\)/);

  const videos = read("src/app/api/videos/route.ts");
  const videosGet = section(videos, "export async function GET()", "// POST /api/videos");
  assert.doesNotMatch(videosGet, /deleteLowResPreviewForVideoUrl|unlinkSync|rmSync|safeUnlink|prisma\.video\.delete/);
  assert.match(videosGet, /isGalleryClipFileMissing/);
  assert.match(videosGet, /expiresAt/);

  const explicitVideoDelete = read("src/app/api/videos/[id]/route.ts");
  assert.match(explicitVideoDelete, /export async function DELETE/);
  assert.match(explicitVideoDelete, /prisma\.video\.deleteMany/);

  const stocks = read("src/app/api/stocks/route.ts");
  const stocksGet = section(stocks, "export async function GET()", "/** DELETE /api/stocks");
  assert.doesNotMatch(stocksGet, /unlinkSync|rmSync|safeUnlink|cleanOldUserStocks|MAX_AGE_MS/);
  const stocksDelete = section(stocks, "export async function DELETE()");
  assert.doesNotMatch(stocksDelete, /unlinkSync|rmSync|safeUnlink|readdirSync|statSync/);
  assert.match(stocksDelete, /media_lifecycle_managed/);
  assert.match(stocksDelete, /graph.*quarantine|quarantine.*graph/is);
  assert.match(stocksDelete, /status:\s*409/);
  assertLifecycleGate(stocksDelete, "if (!authUser)", "stock DELETE");
  assertDeleteHandlerCallAllowlist(stocks, "stock DELETE", ["getCurrentUser", "NextResponse.json"]);

  const adminCache = read("src/app/api/admin/users/[id]/cache/route.ts");
  const adminCacheDelete = section(adminCache, "export async function DELETE(");
  assert.doesNotMatch(adminCacheDelete, /unlinkSync|rmSync|safeUnlink|readdirSync|statSync|includeRenders/);
  assert.match(adminCacheDelete, /media_lifecycle_managed/);
  assert.match(adminCacheDelete, /graph.*quarantine|quarantine.*graph/is);
  assert.match(adminCacheDelete, /status:\s*409/);
  assert.match(adminCacheDelete, /if \(!authUser\)/);
  assertLifecycleGate(adminCacheDelete, 'authUser.role !== "ADMIN"', "admin cache DELETE");
  assertDeleteHandlerCallAllowlist(adminCache, "admin cache DELETE", ["getCurrentUser", "NextResponse.json", "apiError"]);
  const adminCacheGet = section(adminCache, "export async function GET(", "// DELETE");
  assert.match(adminCacheGet, /stockCount/);
  assert.match(adminCacheGet, /renderCount/);
  assert.match(adminCacheGet, /openTickets/);

  const fetchStock = read("src/app/api/videos/fetch-stock/route.ts");
  assert.doesNotMatch(fetchStock, /MAX_AGE_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(fetchStock, /Date\.now\(\)\s*-\s*fs\.statSync\(fp\)\.mtimeMs/);
  assert.equal(count(fetchStock, /mtimeMs/g), 1, "fetch-stock may age-check only reviewed temporary suffixes");
  assert.match(fetchStock, /cleanupStaleTempFiles\(rendersDir, userPrefix, 30 \* 60 \* 1000\)/);
  assert.match(fetchStock, /name\.endsWith\("\.part"\).*name\.endsWith\("\.norm\.mp4"\)/s);

  const images = read("src/app/api/images/route.ts");
  const imagesGet = section(images, "export async function GET()", "export async function POST");
  assert.doesNotMatch(imagesGet, /generatedImage\.deleteMany/);
  assert.match(imagesGet, /generatedImage\.findMany/);
  assert.match(imagesGet, /createdAt:\s*\{\s*gte:\s*expiryDate\s*\}/);

  const productionSources = sourceFiles(path.join(ROOT, "src"));
  const ownerRowDeletes = productionSources.flatMap((absolute) => {
    const source = readFileSync(absolute, "utf8");
    return [...source.matchAll(/prisma\.(video|generatedImage)\.delete(?:Many)?\s*\(/g)].map((match) => ({
      relative: path.relative(ROOT, absolute),
      owner: match[1],
      offset: match.index ?? -1,
      source,
    }));
  });
  assert.deepEqual(
    ownerRowDeletes.map(({ relative, owner }) => `${owner}:${relative}`),
    [
      "generatedImage:src/app/api/images/[id]/route.ts",
      "video:src/app/api/videos/[id]/route.ts",
    ],
    "only explicit authenticated DELETE routes may delete customer-media owner rows",
  );
  assert.ok(
    ownerRowDeletes.every(({ offset, source }) => offset > source.indexOf("export async function DELETE")),
    "all remaining customer-media owner-row deletes must stay inside DELETE handlers",
  );

  const ageDrivenFilesystemDeletes = productionSources.flatMap((absolute) => {
    const lines = readFileSync(absolute, "utf8").split("\n");
    return lines.flatMap((line, index) => {
      if (!/(?:unlinkSync|rmSync|safeUnlink)\s*\(/.test(line)) return [];
      const context = lines.slice(Math.max(0, index - 12), index + 1).join("\n");
      if (!/(?:mtimeMs|expiresAt|MAX_AGE|EXPIRY_DAYS)/.test(context)) return [];
      return [`${path.relative(ROOT, absolute)}:${index + 1}`];
    });
  });
  const reviewedAgeDeleters = new Set([
    "src/lib/disk-watch.ts",
    "src/lib/media-cleanup.ts",
    "src/lib/media-quarantine.ts",
    "src/app/api/cron/cleanup-videos/route.ts",
    "src/app/api/videos/fetch-stock/route.ts",
  ]);
  assert.deepEqual(
    ageDrivenFilesystemDeletes.filter((site) => !reviewedAgeDeleters.has(site.split(":")[0])),
    [],
    "all age-driven filesystem deletion must be graph/quarantine or reviewed transient/build cleanup",
  );
  const diskWatch = read("src/lib/disk-watch.ts");
  assert.match(diskWatch, /const TMP_DIR = "\/tmp"/);
  assert.match(diskWatch, /path\.join\(cwd, "\.next\.old"\)/);
  assert.doesNotMatch(diskWatch, /["']stocks["']|["']renders["']/);

  const creatorUi = read("src/app/(dashboard)/video-creator/page.tsx");
  assert.doesNotMatch(creatorUi, /fetch\(["']\/api\/stocks["'][\s\S]{0,160}method:\s*["']DELETE["']/);
  assert.doesNotMatch(creatorUi, /clearStockCache|clearingCache|ลบ stock cache สำเร็จ|ล้าง Cache แล้ว/);
  assert.doesNotMatch(creatorUi, /Media Retention อัตโนมัติ/);
  assert.match(creatorUi, /pipe\.current = \{\}/);
  assert.match(creatorUi, /รีเซ็ตข้อมูลในเบราว์เซอร์/);
  assert.match(creatorUi, /<span>Media Retention · อ่านอย่างเดียว<\/span>/);

  const adminUsersUi = read("src/app/(dashboard)/admin/users/page.tsx");
  assert.doesNotMatch(adminUsersUi, /fetch\(`\/api\/admin\/users\/\$\{userId\}\/cache`[\s\S]{0,180}method:\s*["']DELETE["']/);
  assert.doesNotMatch(adminUsersUi, /clearCache\(|Stock\+Render|เคลียร์ stock|เคลียร์แคชสำเร็จ/);
  assert.match(adminUsersUi, /loadCacheInfo\(user\.id\)/);
  assert.match(adminUsersUi, /Media Retention/);

  const fetchAudits = productionSources.flatMap(auditFetchCalls);
  const destructiveCacheCallers = fetchAudits.filter(isDestructiveManagedCacheCall);
  assert.deepEqual(destructiveCacheCallers, [], "no production UI/server caller may invoke direct cache deletion");

  assert.throws(
    () => assertDeleteHandlerCallAllowlist(
      `export async function DELETE() { const auth = await getCurrentUser(); destroyStocks(); return NextResponse.json({ error: "media_lifecycle_managed" }, { status: 409 }); }`,
      "synthetic helper bypass",
      ["getCurrentUser", "NextResponse.json"],
    ),
    /destroyStocks/,
    "the verifier must reject arbitrary helper-based deletion",
  );
  const syntheticCallerBypasses = [
    `window.fetch("/api/stocks?confirm=1", { method: "DELETE" });`,
    `axios.delete("/api/stocks/");`,
    `const endpoint = "/api/admin/users/user-1/cache"; const options = { method: "DELETE" }; fetch(endpoint, options);`,
    `function unsafe() { const endpoint = "/api/stocks"; fetch(endpoint, { method: "DELETE" }); } function unrelated() { const endpoint = "/api/health"; return endpoint; }`,
    `function unsafe() { const options = { method: "DELETE" }; fetch("/api/stocks", options); } function unrelated() { const options = { method: "GET" }; return options; }`,
  ].flatMap((source, index) => auditFetchSource(source, `synthetic-${index}.ts`))
    .filter(isDestructiveManagedCacheCall);
  assert.equal(syntheticCallerBypasses.length, 5, "query, trailing-slash, member-call, const indirection, and shadowed endpoint/options bindings must be rejected");
}

function assertDeployShaGate() {
  const deploy = read("deploy/deploy.sh");
  const gate = deploy.indexOf('if [ -n "$APPROVED_DEPLOY_SHA" ]');
  assert.ok(gate >= 0, "deploy must support APPROVED_DEPLOY_SHA");
  for (const laterMutation of ["npm install", "cp \"$APP_DIR/deploy/.env.production\"", "npx prisma db push", "npm run build"]) {
    const later = deploy.indexOf(laterMutation);
    assert.ok(later >= 0, `missing deploy stage: ${laterMutation}`);
    assert.ok(gate < later, `SHA gate must occur before ${laterMutation}`);
  }
  assert.match(deploy, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(deploy, /git rev-parse --verify HEAD/);
  assert.doesNotMatch(deploy, /git (?:checkout|switch).*APPROVED_DEPLOY_SHA/);

  const sandbox = mkdtempSync(path.join(tmpdir(), "media-deploy-sha-"));
  try {
    const appDir = path.join(sandbox, "app");
    const fakeBin = path.join(sandbox, "bin");
    const trace = path.join(sandbox, "trace.log");
    const testDeploy = path.join(sandbox, "deploy.sh");
    mkdirSync(path.join(appDir, ".git"), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    copyFileSync(path.join(ROOT, "deploy/deploy.sh"), testDeploy);
    const isolatedDeploy = readFileSync(testDeploy, "utf8").replace(
      'APP_DIR="/var/www/ai-content"',
      `APP_DIR=${JSON.stringify(appDir)}`,
    );
    writeFileSync(testDeploy, isolatedDeploy);
    chmodSync(testDeploy, 0o755);

    writeFileSync(path.join(fakeBin, "git"), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> "$TRACE"\nif [ "$1" = "rev-parse" ]; then printf '%s\\n' "$ACTUAL_SHA"; fi\nexit 0\n`);
    for (const command of ["npm", "npx", "pm2", "systemctl", "cp"]) {
      writeFileSync(path.join(fakeBin, command), `#!/bin/sh\nprintf '${command} %s\\n' "$*" >> "$TRACE"\nexit 97\n`);
    }
    for (const command of ["git", "npm", "npx", "pm2", "systemctl", "cp"]) {
      chmodSync(path.join(fakeBin, command), 0o755);
    }

    const runMismatch = (approved: string) => spawnSync("bash", [testDeploy], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TRACE: trace,
        ACTUAL_SHA: "1".repeat(40),
        APPROVED_DEPLOY_SHA: approved,
      },
    });

    const mismatch = runMismatch("2".repeat(40));
    assert.notEqual(mismatch.status, 0, "mismatched approved SHA must abort deploy");
    assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /approved deploy sha.*does not match|does not match.*approved deploy sha/i);
    let traceText = readFileSync(trace, "utf8");
    assert.ok(
      traceText.indexOf("git pull origin main") < traceText.indexOf("git rev-parse --verify HEAD"),
      "SHA assertion must happen after protected branch fetch/checkout/pull",
    );
    assert.doesNotMatch(traceText, /2{40}/, "approved input must never be passed to git checkout/switch");
    assert.doesNotMatch(traceText, /^(?:npm|npx|pm2|systemctl|cp) /m, "mismatch must abort before later mutations");

    rmSync(trace, { force: true });
    const shortSha = runMismatch("abc123");
    assert.notEqual(shortSha.status, 0, "short approved SHA must abort deploy");
    assert.match(`${shortSha.stdout}\n${shortSha.stderr}`, /40.*hex|full.*sha/i);
    traceText = readFileSync(trace, "utf8");
    assert.doesNotMatch(traceText, /^(?:npm|npx|pm2|systemctl|cp) /m, "invalid SHA must abort before later mutations");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function assertRolloutConfigurationStillSafe() {
  const ecosystem = read("ecosystem.config.js");
  const mediaCleanup = section(ecosystem, 'name: "media-cleanup"', "},");
  assert.doesNotMatch(mediaCleanup, /--apply|--purge-quarantine|--restore-run/);

  const changed = spawnSync("git", ["status", "--porcelain=v1"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(changed.status, 0);
  const changedPaths = changed.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
  const allowedTaskPaths = new Set([
    "deploy/deploy.sh",
    "scripts/verify-media-rollout-safety.ts",
    "scripts/verify-video-job-expiry.ts",
    "src/app/api/cron/cleanup-videos/route.ts",
    "src/app/api/images/route.ts",
    "src/app/api/stocks/route.ts",
    "src/app/api/admin/users/[id]/cache/route.ts",
    "src/app/api/videos/fetch-stock/route.ts",
    "src/app/api/videos/route.ts",
    "src/app/(dashboard)/admin/users/page.tsx",
    "src/app/(dashboard)/video-creator/page.tsx",
    "src/lib/mcp/video-job.ts",
  ]);
  assert.deepEqual(
    changedPaths.filter((changedPath) => !allowedTaskPaths.has(changedPath)),
    [],
    "Task 9 must not mutate rollout, PM2, cron, webhook, Discord, or unrelated configuration",
  );
  const protectedConfigDiff = spawnSync("git", [
    "diff",
    "--exit-code",
    "5c4aab41d8aa73e6dd7338a8ac569cd66f298ad1",
    "--",
    "ecosystem.config.js",
    "scripts/ops-watchdog.sh",
    "deploy/.env.production",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(protectedConfigDiff.status, 0, "protected rollout/alert configuration must remain byte-unchanged");
  const deployDiff = spawnSync("git", [
    "diff",
    "5c4aab41d8aa73e6dd7338a8ac569cd66f298ad1",
    "--",
    "deploy/deploy.sh",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(deployDiff.status, 0);
  assert.doesNotMatch(deployDiff.stdout, /DISCORD_WEBHOOK|discord(?:app)?\.com\/api\/webhooks/i);
}

assertNoAutomaticCustomerMediaDeletion();
assertDeployShaGate();
assertRolloutConfigurationStillSafe();
console.log("PASS media rollout safety");

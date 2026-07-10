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
  assert.match(stocksDelete, /unlinkSync/);

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
    "src/app/api/videos/fetch-stock/route.ts",
    "src/app/api/videos/route.ts",
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

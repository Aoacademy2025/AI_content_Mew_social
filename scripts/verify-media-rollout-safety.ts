import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const routeSource = fs.readFileSync(
  path.join(repoRoot, "src/app/api/cron/cleanup-videos/route.ts"),
  "utf8",
);
const runnerSource = fs.readFileSync(path.join(repoRoot, "scripts/cleanup-videos.js"), "utf8");
const videosRouteSource = fs.readFileSync(path.join(repoRoot, "src/app/api/videos/route.ts"), "utf8");
const stocksRouteSource = fs.readFileSync(path.join(repoRoot, "src/app/api/stocks/route.ts"), "utf8");
const fetchStockRouteSource = fs.readFileSync(
  path.join(repoRoot, "src/app/api/videos/fetch-stock/route.ts"),
  "utf8",
);
const imagesRouteSource = fs.readFileSync(path.join(repoRoot, "src/app/api/images/route.ts"), "utf8");
const adminCacheRouteSource = fs.readFileSync(
  path.join(repoRoot, "src/app/api/admin/users/[id]/cache/route.ts"),
  "utf8",
);
const adminUsersPageSource = fs.readFileSync(
  path.join(repoRoot, "src/app/(dashboard)/admin/users/page.tsx"),
  "utf8",
);
const videoCreatorPageSource = fs.readFileSync(
  path.join(repoRoot, "src/app/(dashboard)/video-creator/page.tsx"),
  "utf8",
);

function exportedHandlerSource(source: string, name: "GET" | "POST" | "DELETE", nextName: "POST" | "DELETE") {
  const startMarker = `export async function ${name}`;
  const endMarker = `export async function ${nextName}`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${name} handler`);
  assert.notEqual(end, -1, `missing ${nextName} handler after ${name}`);
  return source.slice(start, end);
}

const videosGetSource = exportedHandlerSource(videosRouteSource, "GET", "POST");
const stocksGetSource = exportedHandlerSource(stocksRouteSource, "GET", "DELETE");
const stocksDeleteStart = stocksRouteSource.indexOf("export async function DELETE");
assert.notEqual(stocksDeleteStart, -1, "missing stocks DELETE handler");
const stocksDeleteSource = stocksRouteSource.slice(stocksDeleteStart);
const imagesGetSource = exportedHandlerSource(imagesRouteSource, "GET", "POST");
const adminCacheDeleteStart = adminCacheRouteSource.indexOf("export async function DELETE");
assert.notEqual(adminCacheDeleteStart, -1, "missing admin cache DELETE handler");
const adminCacheDeleteSource = adminCacheRouteSource.slice(adminCacheDeleteStart);

// The scheduled legacy endpoint remains useful for bounded, non-customer-media
// housekeeping. Lock those duties in so disabling the destructive legacy sweep
// cannot silently disable operational hygiene or its health signal.
assert.match(routeSource, /process\.env\.CRON_SECRET/, "cleanup route must require CRON_SECRET");
assert.match(routeSource, /export const runtime = "nodejs"/, "cleanup route must retain the Node.js runtime");
assert.match(routeSource, /timingSafeStrEqual/, "cleanup route must compare its bearer token safely");
assert.match(routeSource, /status:\s*401/, "cleanup route must reject unauthorized requests");
assert.match(routeSource, /prisma\.payment\.findMany/, "cleanup route must find stale PENDING payments");
assert.match(routeSource, /stripe\.checkout\.sessions\.expire/, "cleanup route must expire stale Stripe sessions");
assert.match(routeSource, /prisma\.payment\.updateMany/, "cleanup route must update stale payment status");
assert.match(routeSource, /cleanupOldChildren\(/, "cleanup route must retain Remotion tmp cleanup");
assert.match(routeSource, /activeRemotionBundleNames\(/, "cleanup route must protect active Remotion bundles");
assert.match(routeSource, /prisma\.telemetryEvent\.deleteMany/, "cleanup route must retain telemetry retention");
assert.match(routeSource, /writeCronHeartbeat\("cleanup-videos"\)/, "cleanup route must retain its heartbeat");

// Customer media lifecycle becomes exclusively graph -> reviewed manifest ->
// quarantine after PR2. This legacy endpoint must have no primitive capable of
// discovering/deleting Video rows or deleting customer files/previews.
assert.doesNotMatch(routeSource, /prisma\.video\./i, "legacy cleanup route must not query or mutate Video rows");
assert.doesNotMatch(routeSource, /deleteLowResPreviewForVideoUrl/, "legacy cleanup route must not delete previews");
assert.doesNotMatch(routeSource, /\b(?:un)?linkSync\b/, "legacy cleanup route must not unlink customer media");
assert.doesNotMatch(routeSource, /videosDeleted/, "legacy cleanup response must not imply direct Video deletion");

// The one-shot PM2 wrapper may only authenticate and call the route. It must not
// acquire file/DB deletion capabilities of its own.
assert.match(runnerSource, /\/api\/cron\/cleanup-videos/, "PM2 wrapper must keep calling the authenticated route");
assert.match(runnerSource, /authorization:\s*`Bearer \$\{SECRET\}`/, "PM2 wrapper must keep bearer authentication");
assert.doesNotMatch(runnerSource, /\b(?:unlink|rm|rmdir)(?:Sync)?\b/, "PM2 wrapper must not delete files directly");
assert.doesNotMatch(runnerSource, /(?:Prisma|prisma\.)/, "PM2 wrapper must not delete database rows directly");

// Read/list request paths must not become an unreviewed lifecycle mechanism.
// They may hide expired or missing records from a response, but only the PR2
// graph/quarantine flow may mutate customer files or ownership rows.
assert.match(videosGetSource, /prisma\.video\.findMany/, "gallery GET must retain its authenticated read");
assert.match(videosGetSource, /getCurrentUser\(\)/, "gallery GET must retain authentication");
assert.match(videosGetSource, /status:\s*401/, "gallery GET must reject unauthenticated requests");
assert.match(videosGetSource, /v\.expiresAt[\s\S]*?continue;/, "gallery GET must hide expired records");
assert.match(videosGetSource, /isGalleryClipFileMissing[\s\S]*?continue;/, "gallery GET must hide missing records");
assert.doesNotMatch(videosGetSource, /prisma\.video\.(?:delete|deleteMany)/, "gallery GET must not delete Video rows");
assert.doesNotMatch(videosGetSource, /deleteLowResPreviewForVideoUrl/, "gallery GET must not delete previews");
assert.doesNotMatch(videosGetSource, /\b(?:un)?linkSync\b/, "gallery GET must not unlink media");
assert.doesNotMatch(videosGetSource, /enqueueLowResPreview/, "gallery GET must remain read-only");

assert.match(stocksGetSource, /fs\.readdirSync/, "stocks GET must retain read-only usage metrics");
assert.match(stocksGetSource, /fs\.statSync/, "stocks GET must retain byte-size metrics");
assert.match(stocksGetSource, /getCurrentUser\(\)/, "stocks GET must retain authentication");
assert.match(stocksGetSource, /status:\s*401/, "stocks GET must reject unauthenticated requests");
assert.doesNotMatch(stocksGetSource, /cleanOldUserStocks/, "stocks GET must not invoke age deletion");
assert.doesNotMatch(stocksGetSource, /\b(?:un)?linkSync\b/, "stocks GET must not unlink user stock media");

assert.match(imagesGetSource, /prisma\.generatedImage\.findMany/, "images GET must retain its authenticated read");
assert.match(imagesGetSource, /getCurrentUser\(\)/, "images GET must retain authentication");
assert.match(imagesGetSource, /status:\s*401/, "images GET must reject unauthenticated requests");
assert.doesNotMatch(
  imagesGetSource,
  /prisma\.generatedImage\.(?:delete|deleteMany)/,
  "images GET must not delete graph-protected ownership rows",
);

// Fetch-stock may reap only clearly transient, user-prefixed partial/normalize
// files. Completed stock media has no request-triggered age sweep.
assert.match(fetchStockRouteSource, /name\.endsWith\("\.part"\)/, "fetch-stock must retain .part cleanup");
assert.match(fetchStockRouteSource, /name\.endsWith\("\.norm\.mp4"\)/, "fetch-stock must retain normalize-temp cleanup");
assert.match(
  fetchStockRouteSource,
  /cleanupStaleTempFiles\(rendersDir, userPrefix, 30 \* 60 \* 1000\)/,
  "fetch-stock temp cleanup must remain user-scoped and bounded",
);
assert.doesNotMatch(fetchStockRouteSource, /const MAX_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1000/, "fetch-stock must not age-delete completed media");
assert.doesNotMatch(fetchStockRouteSource, /fs\.unlinkSync\(fp\)/, "fetch-stock must not directly unlink completed media");

// Admin cache tools must not expose the old global public/renders sweep. That
// sweep protected only one user's Gallery rows while deleting every other file,
// including live project/job references owned by any user.
assert.doesNotMatch(adminCacheDeleteSource, /includeRenders/, "admin cache DELETE must not accept render deletion");
assert.doesNotMatch(adminCacheDeleteSource, /public["'],\s*["']renders/, "admin cache DELETE must not scan public/renders");
assert.doesNotMatch(adminCacheDeleteSource, /rendersDir/, "admin cache DELETE must not acquire a render directory");
assert.doesNotMatch(adminUsersPageSource, /Stock\+Render/, "admin UI must not offer direct render deletion");
assert.doesNotMatch(adminUsersPageSource, /clearCache\(user\.id,\s*true\)/, "admin UI must not request render deletion");

// Explicit cache buttons are also unsafe when completed stock files remain
// referenced by a saved draft or active render. Keep the authenticated endpoints
// as fail-closed compatibility surfaces, but never mutate files directly.
assert.match(stocksDeleteSource, /media_lifecycle_managed/, "stocks DELETE must explain managed lifecycle");
assert.match(stocksDeleteSource, /status:\s*409/, "stocks DELETE must fail closed");
assert.match(stocksDeleteSource, /getCurrentUser\(\)/, "stocks DELETE must retain authentication");
assert.match(stocksDeleteSource, /status:\s*401/, "stocks DELETE must reject unauthenticated requests");
assert.doesNotMatch(stocksDeleteSource, /fs\.(?:unlink|rm|rmdir)(?:Sync)?/, "stocks DELETE must not delete files");
assert.doesNotMatch(stocksDeleteSource, /fs\.readdirSync/, "stocks DELETE must not scan customer media");
assert.match(adminCacheDeleteSource, /media_lifecycle_managed/, "admin cache DELETE must explain managed lifecycle");
assert.match(adminCacheDeleteSource, /status:\s*409/, "admin cache DELETE must fail closed");
assert.match(adminCacheDeleteSource, /getCurrentUser\(\)/, "admin cache DELETE must retain authentication");
assert.match(adminCacheDeleteSource, /role\s*!==\s*"ADMIN"/, "admin cache DELETE must retain role authorization");
assert.match(adminCacheDeleteSource, /status:\s*403/, "admin cache DELETE must reject non-admin users");
assert.doesNotMatch(adminCacheDeleteSource, /fs\.(?:unlink|rm|rmdir)(?:Sync)?/, "admin cache DELETE must not delete files");
assert.doesNotMatch(adminCacheDeleteSource, /fs\.readdirSync/, "admin cache DELETE must not scan customer media");
assert.doesNotMatch(
  videoCreatorPageSource,
  /fetch\("\/api\/stocks",\s*\{\s*method:\s*"DELETE"/,
  "Video Creator must not request direct stock deletion",
);
assert.doesNotMatch(
  adminUsersPageSource,
  /fetch\(`\/api\/admin\/users\/\$\{userId\}\/cache`,\s*\{\s*method:\s*"DELETE"/,
  "admin UI must not request direct cache deletion",
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ecosystem = require("../ecosystem.config.js") as {
  apps?: Array<{
    name?: string;
    script?: string;
    args?: string;
    cron_restart?: string;
    autorestart?: boolean;
  }>;
};

const cleanupJobs = (ecosystem.apps ?? []).filter((app) => app.name === "cleanup-videos");
assert.equal(cleanupJobs.length, 1, "expected exactly one cleanup-videos PM2 app");
assert.equal(cleanupJobs[0].script, "scripts/cleanup-videos.js", "cleanup-videos must keep its wrapper");
assert.equal(cleanupJobs[0].cron_restart, "0 3 * * *", "cleanup-videos must keep its schedule");
assert.equal(cleanupJobs[0].autorestart, false, "cleanup-videos must remain a scheduled one-shot");

const mediaCleanupJobs = (ecosystem.apps ?? []).filter((app) => app.name === "media-cleanup");
assert.equal(mediaCleanupJobs.length, 1, "expected exactly one media-cleanup PM2 app");
assert.equal(mediaCleanupJobs[0].cron_restart, "30 3 * * *", "media-cleanup must keep its schedule");
assert.doesNotMatch(
  mediaCleanupJobs[0].args ?? "",
  /(?:^|\s)--apply(?:\s|$)/,
  "media-cleanup must remain dry-run during rollout",
);

console.log("PASS legacy cron keeps safe duties and cannot delete customer media");
console.log("PASS cleanup schedules remain present and media-cleanup remains dry-run");

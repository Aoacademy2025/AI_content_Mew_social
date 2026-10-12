import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ops batch 2026-10-12 (Sentry HERO-STUDIO-WEB-1J): the dashboard's `/api/user/stats` fetch
 * chain had no `.catch`, so an offline visitor's "Load failed" became an unhandled promise
 * rejection on iOS. Source-level check (no browser/jsdom harness in this repo for this page) —
 * asserts the `.then().then().catch().finally()` shape so this cannot regress silently.
 */
function main() {
  const source = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/dashboard/page.tsx"),
    "utf8",
  );

  const statsLine = source
    .split("\n")
    .find((line) => line.includes('fetch("/api/user/stats")'));
  assert(statsLine, "the /api/user/stats fetch call must still exist in the dashboard effect");
  assert.match(
    statsLine!,
    /fetch\("\/api\/user\/stats"\)\.then\(r => r\.json\(\)\)\.then\(setStats\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => setLoading\(false\)\)/,
    "the /api/user/stats chain must have a .catch() before .finally() so a network failure never becomes an unhandled rejection",
  );

  // The sibling fetchMe() chain already catches (setMe(ME_FALLBACK)) — regression-guard it too,
  // so a future edit cannot silently drop the one that already worked.
  assert.match(
    source,
    /fetchMe\(\)\.then\(d => \{[\s\S]*?\}\)\.catch\(\(\) => setMe\(ME_FALLBACK\)\);/,
    "the sibling fetchMe() chain must keep its own .catch(() => setMe(ME_FALLBACK))",
  );

  console.log("verify-dashboard-stats-fetch-catch: ALL PASS");
}

main();

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insightsRangeHref, readInsightsRange } from "../src/lib/insights-range";

assert.equal(readInsightsRange(new URLSearchParams("days=30")), 30, "a shared 30-day URL opens the 30-day range");
assert.equal(readInsightsRange(new URLSearchParams("days=7")), 7, "a shared 7-day URL opens the 7-day range");
for (const query of ["", "days=0", "days=2", "days=31", "days=30.5", "days=wat", "days=7&days=30"]) {
  assert.equal(readInsightsRange(new URLSearchParams(query)), 1, `invalid or missing "${query}" falls back to one day`);
}
assert.equal(
  insightsRangeHref("/admin/insights", new URLSearchParams("source=overview&days=1"), 30),
  "/admin/insights?source=overview&days=30",
  "changing the range preserves other URL state and creates a navigable target",
);

const page = readFileSync("src/app/(dashboard)/admin/insights/page.tsx", "utf8");
assert.match(page, /useSearchParams/, "Insights derives its active range from browser navigation");
assert.match(page, /const days = readInsightsRange\(searchParams\)/, "the URL range drives both selection and fetch state");
assert.match(page, /window\.history\.pushState\(null, "", insightsRangeHref\(/, "range selection adds a browser-history entry");
assert.match(page, /fetch\(`\/api\/admin\/insights\?days=\$\{days\}`/, "the selected URL range is sent to the existing API");
assert.match(page, /let cancelled = false;[\s\S]*if \(!cancelled\) setData\(body\);/, "a superseded request cannot overwrite newer results");

console.log("verify-admin-insights-range: PASS");

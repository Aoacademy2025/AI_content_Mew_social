import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sidebarPath = "src/components/layout/sidebar.tsx";
const sidebarSource = readFileSync(sidebarPath, "utf8");

const fetchCallIndex = sidebarSource.indexOf('fetch("/api/updates?summary=1"');
assert.ok(fetchCallIndex >= 0, "the updates-summary fetch exists in the sidebar");

const effectStart = sidebarSource.lastIndexOf("useEffect(() => {", fetchCallIndex);
assert.ok(effectStart >= 0, "the updates-summary fetch sits inside a useEffect");

const effectEnd = sidebarSource.indexOf("}, [", effectStart);
const depsEnd = sidebarSource.indexOf(");", effectEnd);
assert.ok(
  effectEnd > fetchCallIndex && depsEnd > effectEnd,
  "the useEffect containing the updates-summary fetch has a dependency array",
);

const depsArraySource = sidebarSource.slice(effectEnd + "}, [".length, sidebarSource.indexOf("]", effectEnd));
const effectBody = sidebarSource.slice(effectStart, effectEnd);

assert.doesNotMatch(
  depsArraySource,
  /\bpathname\b/,
  "the updates-summary effect must not depend on pathname, or it refetches on every navigation",
);
assert.match(
  depsArraySource,
  /\bsessionLoaded\b/,
  "the updates-summary effect still waits for the session to load once",
);
assert.match(
  effectBody,
  /window\.addEventListener\("product-updates-read",\s*loadUpdatesSummary\)/,
  "the product-updates-read listener still clears the badge when updates are read",
);
assert.match(
  effectBody,
  /window\.removeEventListener\("product-updates-read",\s*loadUpdatesSummary\)/,
  "the product-updates-read listener is still cleaned up on unmount",
);

console.log(
  "verify-sidebar-updates-summary-once: PASS updates summary fetches once per session, not on every navigation",
);

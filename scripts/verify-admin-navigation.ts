import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Task C3 (admin re-org): the old /admin tabs became one route per task and the
// admin nav regrouped into five Thai sections (ADR 0062). This is a source-level
// check (team pattern — see scripts/verify-support-ticket-ui-regressions.ts):
// no server/DB needed, so it runs the same in CI as locally.

const REPO_ROOT = path.resolve(__dirname, "..");
const sidebarPath = "src/components/layout/sidebar.tsx";
const sidebarSource = readFileSync(path.join(REPO_ROOT, sidebarPath), "utf8");

// ── 1. Locate the adminGroups literal ──────────────────────────────────────
const groupsStart = sidebarSource.indexOf("const adminGroups: Array<{ label: string; items: SidebarNavItem[] }> = [");
assert.ok(groupsStart >= 0, `${sidebarPath} defines adminGroups`);
const groupsEnd = sidebarSource.indexOf("\n];", groupsStart);
assert.ok(groupsEnd > groupsStart, "adminGroups literal is closed");
const groupsSource = sidebarSource.slice(groupsStart, groupsEnd);

// ── 2. Group labels are exactly the five Thai strings, in this order ──────
const EXPECTED_GROUP_LABELS = ["ภาพรวม", "รายได้", "ลูกค้า", "คุณภาพระบบ", "ตั้งค่า & ระบบ"];
const groupLabelMatches = Array.from(groupsSource.matchAll(/\{\s*label:\s*"([^"]+)"/g), (m) => m[1]);
assert.deepEqual(
  groupLabelMatches,
  EXPECTED_GROUP_LABELS,
  `adminGroups labels must be exactly the five Thai group names in order, got: ${JSON.stringify(groupLabelMatches)}`,
);

// ── 3. Every item href in adminGroups has a page.tsx under the dashboard route group ──
const hrefMatches = Array.from(groupsSource.matchAll(/href:\s*"([^"]+)"/g), (m) => m[1]);
assert.ok(hrefMatches.length >= 10, `adminGroups has the expected number of nav items, found ${hrefMatches.length}`);

const missingRoutes: string[] = [];
for (const href of hrefMatches) {
  assert.ok(href.startsWith("/admin"), `admin nav href "${href}" stays under /admin`);
  const routeDir = href === "/admin" ? "admin" : `admin/${href.slice("/admin/".length)}`;
  const pagePath = path.join(REPO_ROOT, "src/app/(dashboard)", routeDir, "page.tsx");
  if (!existsSync(pagePath)) missingRoutes.push(`${href} -> ${path.relative(REPO_ROOT, pagePath)}`);
}
assert.deepEqual(missingRoutes, [], `every admin nav href needs a page.tsx: missing ${JSON.stringify(missingRoutes)}`);

// ── 4. admin/page.tsx no longer carries the old AdminTab state/type ────────
const adminPagePath = "src/app/(dashboard)/admin/page.tsx";
const adminPageSource = readFileSync(path.join(REPO_ROOT, adminPagePath), "utf8");
assert.doesNotMatch(
  adminPageSource,
  /AdminTab/,
  `${adminPagePath} must not reference the old AdminTab type/state — the old tabs are now their own routes`,
);

// ── 5. The four extracted admin sub-pages exist and are client components ──
for (const route of ["support", "storage", "music", "settings"]) {
  const pagePath = `src/app/(dashboard)/admin/${route}/page.tsx`;
  const source = readFileSync(path.join(REPO_ROOT, pagePath), "utf8");
  assert.match(source, /^"use client";/, `${pagePath} is a client component`);
}

console.log(
  "verify-admin-navigation: PASS — five Thai admin groups, every href has a route, AdminTab removed from admin/page.tsx",
);

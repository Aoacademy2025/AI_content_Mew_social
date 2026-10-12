// verify-mcp-stock-gate — proof for the settings UX fix (2026-10-12, defect #3 in
// docs/plans/.../settings-ux-spec.md): create_video_job must not refuse a keyless
// user when MANAGED_STOCK (#297, ADR 0025) would serve them on the web path, the
// same way /api/videos/jobs already does. An own stock key always still wins.
//
// The MCP route's gate decision is extracted as a pure boolean function
// (`mcpStockKeyRefusal`, src/lib/mcp/broll-source.ts) specifically so it can be
// unit-tested here without the route's auth/DB/preflight plumbing. The real
// `resolveManagedStockAccess` resolver (which decides `managedStockEligible`) is
// already covered end-to-end by scripts/verify-managed-stock-server.ts — this file
// proves the GATE built on top of it, plus that the route actually calls through
// to that resolver instead of refusing on raw key presence alone.
import { readFileSync } from "node:fs";
import { mcpStockKeyRefusal } from "../src/lib/mcp/broll-source";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures += 1;
}

// ── Pure decision ────────────────────────────────────────────────────────────
check(
  "keyless user + managed stock ON (eligible) → NOT refused",
  mcpStockKeyRefusal({ needsStockKey: true, hasOwnStockKey: false, managedStockEligible: true }) === false,
);
check(
  "keyless user + managed stock OFF/ineligible → still refused",
  mcpStockKeyRefusal({ needsStockKey: true, hasOwnStockKey: false, managedStockEligible: false }) === true,
);
check(
  "own stock key present → NOT refused regardless of managed eligibility",
  mcpStockKeyRefusal({ needsStockKey: true, hasOwnStockKey: true, managedStockEligible: false }) === false,
);
check(
  "own stock key present + managed also eligible → NOT refused",
  mcpStockKeyRefusal({ needsStockKey: true, hasOwnStockKey: true, managedStockEligible: true }) === false,
);
check(
  "fillYourself / brollSource that needs no stock provider → NOT refused regardless of keys",
  mcpStockKeyRefusal({ needsStockKey: false, hasOwnStockKey: false, managedStockEligible: false }) === false,
);

// ── Wiring: the route actually calls through, not just the key check ────────
const route = readFileSync(new URL("../src/app/api/[transport]/route.ts", import.meta.url), "utf8");
check(
  "the gate no longer refuses on raw key presence alone (old bug)",
  !/if \(needsStockKey && !u\.pexelsKey && !u\.pixabayKey\) return missingKeyError/.test(route),
);
check(
  "create_video_job consults resolveManagedStockAccess for a keyless stock request",
  route.includes("resolveManagedStockAccess(u, { hasOwnPexelsKey: false, hasOwnPixabayKey: false })"),
);
check(
  "the managed lookup only runs when it is actually needed (keyless + stock required)",
  /needsStockKey && !hasOwnStockKey\s*\n\s*\? await resolveManagedStockAccess/.test(route),
);
check(
  "the refusal itself goes through the tested pure decision function",
  /if \(mcpStockKeyRefusal\(\{[\s\S]{0,200}return missingKeyError\("broll"\)/.test(route),
);

console.log(failures === 0 ? "\n✅ ALL MCP STOCK GATE CHECKS PASSED" : `\n❌ ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

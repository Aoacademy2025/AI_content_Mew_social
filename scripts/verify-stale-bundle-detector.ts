// Unit tests for isStaleBundleSignal / isStaleBundleResourceError (run: npx tsx scripts/verify-stale-bundle-detector.ts)
//
// Task 8 (pre-launch stability): a browser tab open across a deploy holds a stale Server
// Action ID / JS-CSS chunk hash → "Failed to find Server Action" ×18 in prod logs + CSS
// chunk 404s. This locks the detector's two positive signatures (exact strings verified
// against the installed next@15.3.9 source — see src/lib/stale-bundle.ts for paths) and,
// just as importantly, locks that ordinary network flakiness does NOT trip it.
import { isStaleBundleResourceError, isStaleBundleSignal } from "../src/lib/stale-bundle";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// --- positive: Server Action not found (exact prod-observed shapes) ---
check(
  "server action not found (no id)",
  isStaleBundleSignal({
    message:
      "Failed to find Server Action. This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action",
  }),
);
check(
  "server action not found (with quoted id)",
  isStaleBundleSignal({
    message:
      'Failed to find Server Action "40613b02e2c2b3b1e4b9a1c7f8f3b1a2c3d4e5f6". This request might be from an older or newer deployment.',
  }),
);

// --- positive: chunk load errors ---
check("ChunkLoadError by name", isStaleBundleSignal({ name: "ChunkLoadError", message: "Loading chunk 4231 failed." }));
check(
  "ChunkLoadError by message alone (name missing)",
  isStaleBundleSignal({ message: "Loading chunk 4231 failed.\n(missing: https://studio.heroaiengine.com/_next/static/chunks/4231.abcd1234.js)" }),
);
check("CSS chunk load failed", isStaleBundleSignal({ message: "Loading css chunk 12 failed." }));
check(
  "dynamic import fetch failure (ESM path)",
  isStaleBundleSignal({ message: "Failed to fetch dynamically imported module: https://studio.heroaiengine.com/_next/static/chunks/app/page.js" }),
);

// --- negative: must NOT fire on ordinary network flakiness ---
check("plain 'Failed to fetch' does not match", !isStaleBundleSignal({ message: "Failed to fetch", name: "TypeError" }));
check("generic NetworkError does not match", !isStaleBundleSignal({ message: "NetworkError when attempting to fetch resource.", name: "TypeError" }));
check("unrelated app error does not match", !isStaleBundleSignal({ message: "Cannot read properties of undefined (reading 'id')", name: "TypeError" }));
check("empty signal does not match", !isStaleBundleSignal({}));
check("random 'chunk' mention in prose does not match", !isStaleBundleSignal({ message: "uploaded video chunk 3 of 5" }));

// --- resource error URL matching (CSS/JS <link>/<script> 404s) ---
check(
  "next static css asset matches",
  isStaleBundleResourceError("https://studio.heroaiengine.com/_next/static/css/abcd1234.css"),
);
check(
  "next static js asset matches",
  isStaleBundleResourceError("https://studio.heroaiengine.com/_next/static/chunks/4231.abcd1234.js"),
);
check("third-party script 404 does not match", !isStaleBundleResourceError("https://fonts.googleapis.com/css2?family=Inter"));
check("null url does not match", !isStaleBundleResourceError(null));
check("undefined url does not match", !isStaleBundleResourceError(undefined));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll stale-bundle-detector checks passed.");

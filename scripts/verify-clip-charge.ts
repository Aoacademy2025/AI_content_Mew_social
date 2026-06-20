// Run with: npm run verify:clip-charge
// Proves the "count a clip ONCE per video" contract: a base render charges + records a
// ChargedClip; a BURN of that user's OWN paid render is recognized as free; a BURN of an
// unknown / foreign / external / fabricated source is NOT free (so it charges → no bypass);
// and URL normalization matches the stored form across relative/absolute/`/renders/` variants.
//
// Self-contained: spins a throwaway SQLite DB, pushes the schema, dynamically imports the
// helpers (so the DB env is set before prisma init), asserts, exits non-zero on failure.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "clipcharge-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { canonicalRenderUrl, recordChargedClip, isBurnAlreadyPaid } = await import("../src/lib/clip-charge");
  const { prisma } = await import("../src/lib/prisma");

  // --- canonicalRenderUrl: pure normalization (store ↔ lookup must agree) ---
  const canon = "/api/renders/render-1700000000000-abc123.mp4";
  ok(canonicalRenderUrl(canon) === canon, "relative /api/renders/<file> is canonical (unchanged)");
  ok(
    canonicalRenderUrl("/renders/render-1700000000000-abc123.mp4") === canon,
    "/renders/<file> normalizes to /api/renders/<file>",
  );
  ok(
    canonicalRenderUrl("https://studio.heroaiengine.com/api/renders/render-1700000000000-abc123.mp4") === canon,
    "absolute https .../api/renders/<file> normalizes to the same canonical form",
  );
  ok(
    canonicalRenderUrl("http://localhost:3000/renders/render-1700000000000-abc123.mp4") === canon,
    "absolute http .../renders/<file> normalizes to the same canonical form",
  );
  ok(
    canonicalRenderUrl("/api/renders/render-1700000000000-abc123.mp4?v=2#frag") === canon,
    "query/hash stripped before canonicalizing",
  );
  // Non-render / hostile inputs → null (can never match a stored charge → always charges)
  ok(canonicalRenderUrl(null) === null, "null → null");
  ok(canonicalRenderUrl("") === null, "empty → null");
  ok(canonicalRenderUrl("https://evil.example.com/video.mp4") === null, "external host path (not /renders) → null");
  ok(canonicalRenderUrl("/api/stocks/stock-1.mp4") === null, "a non-render internal path → null");
  ok(canonicalRenderUrl("/api/renders/../../etc/passwd") === null, "traversal in the render path → null (no widening)");
  ok(canonicalRenderUrl("/api/renders/sub/dir/file.mp4") === null, "nested render path → null (render outputs are flat files)");

  // --- end-to-end: record a charge, then check burn freeness ---
  const userA = "user-A";
  const userB = "user-B";
  const renderUrl = "/api/renders/render-1700000000001-xyz789.mp4"; // what runRender returns

  // Before recording: a burn of this render is NOT free (the base render hasn't been charged yet).
  ok((await isBurnAlreadyPaid(userA, renderUrl)) === false, "burn before any charge → NOT free (charges)");

  // Base render completes → record the charge.
  await recordChargedClip(userA, renderUrl);
  const rows = await prisma.chargedClip.findMany({ where: { userId: userA } });
  ok(rows.length === 1 && rows[0].outputUrl === renderUrl, "recordChargedClip stored the canonical outputUrl for user A");

  // (a) burn referencing user A's own paid render → recognized as FREE.
  ok((await isBurnAlreadyPaid(userA, renderUrl)) === true, "(a) burn of user A's OWN paid render → FREE");

  // (c) URL normalization: a burn that sends the SAME render via /renders/ or absolute
  // forms still matches the stored /api/renders/ canonical → still FREE.
  ok(
    (await isBurnAlreadyPaid(userA, "/renders/render-1700000000001-xyz789.mp4")) === true,
    "(c) /renders/ form of the paid render still matches the stored canonical → FREE",
  );
  ok(
    (await isBurnAlreadyPaid(userA, "https://studio.heroaiengine.com/api/renders/render-1700000000001-xyz789.mp4")) === true,
    "(c) absolute-URL form of the paid render still matches → FREE",
  );

  // (b) burn referencing an UNKNOWN render this user never paid for → NOT free (charges).
  ok(
    (await isBurnAlreadyPaid(userA, "/api/renders/render-9999999999999-nope000.mp4")) === false,
    "(b) burn of an unknown render → NOT free (charges)",
  );
  // (b) FOREIGN: user B burning user A's render → NOT free (the charge belongs to A, not B).
  ok((await isBurnAlreadyPaid(userB, renderUrl)) === false, "(b) burn of ANOTHER user's render → NOT free (no cross-user bypass)");
  // (b) EXTERNAL/FABRICATED: a non-render or external URL → NOT free.
  ok((await isBurnAlreadyPaid(userA, "https://evil.example.com/free.mp4")) === false, "(b) external URL burn source → NOT free (charges)");
  ok((await isBurnAlreadyPaid(userA, "/api/stocks/stock-1.mp4")) === false, "(b) non-render internal URL burn source → NOT free (charges)");
  ok((await isBurnAlreadyPaid(userA, null)) === false, "(b) missing burn source → NOT free (charges)");

  // recordChargedClip is fail-open on a non-render url: it records nothing (no throw),
  // so such a burn source stays uncharged-as-free-able → it will charge.
  await recordChargedClip(userA, "https://evil.example.com/free.mp4");
  const rowsAfter = await prisma.chargedClip.findMany({ where: { userId: userA } });
  ok(rowsAfter.length === 1, "recordChargedClip ignores a non-render url (no spurious row)");

  await prisma.$disconnect();
  if (failures) { console.error(`\n${failures} FAILED (${passed} passed)`); process.exit(1); }
  console.log(`\nALL ${passed} CLIP-CHARGE CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); process.exit(1); });

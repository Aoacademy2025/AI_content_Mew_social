// Run: npx tsx scripts/verify-avatar-gen-framing.ts
// Locks the HeyGen GEN framing to a safe, whole-avatar default and guards the bug class that
// cut bunchar's head (2026-07-01): a gen caller sending a zoom > native bakes an unrecoverable
// head/limb crop into HeyGen's output (a head missing from the source can't be recovered in
// the composite). See docs/superpowers/specs/2026-07-01-avatar-safe-gen-framing-design.md.
//   1. HEYGEN_GEN_FRAMING must never zoom in (scale ≤ 1.0) or lift the head (offsetY === 0).
//   2. MCP re-exports the same constant (no drift).
//   3. No gen payload file hardcodes the historical head-cutters (scale 2.02 / 1.6).
import fs from "fs";
import path from "path";
import { HEYGEN_GEN_FRAMING } from "../src/lib/avatar-gen-framing";
import { HEYGEN_FRAMING as MCP_FRAMING } from "../src/lib/mcp/avatar-steps";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

// ── 1. the shared constant: safe whole-avatar framing ──
ok(typeof HEYGEN_GEN_FRAMING.scale === "number" && typeof HEYGEN_GEN_FRAMING.offsetX === "number" && typeof HEYGEN_GEN_FRAMING.offsetY === "number", "shared framing has scale/offsetX/offsetY");
ok(HEYGEN_GEN_FRAMING.scale === 1.0, `gen scale is 1.0 (native, whole avatar) — got ${HEYGEN_GEN_FRAMING.scale}`);
ok(HEYGEN_GEN_FRAMING.scale <= 1.0, "gen scale never zooms IN (≤ 1.0 = can't cut a head HeyGen framed)");
ok(HEYGEN_GEN_FRAMING.offsetX === 0, `gen offsetX is 0 (centered) — got ${HEYGEN_GEN_FRAMING.offsetX}`);
ok(HEYGEN_GEN_FRAMING.offsetY === 0, `gen offsetY is 0 (no upward lift → head stays in frame) — got ${HEYGEN_GEN_FRAMING.offsetY}`);

// ── 2. MCP shares the exact same constant (no per-caller drift) ──
ok(MCP_FRAMING === HEYGEN_GEN_FRAMING, "MCP avatar-steps re-exports the shared constant (no drift)");

// ── 3. no gen payload file hardcodes a head-cutter scale (every caller uses the constant) ──
// Matches `scale: 2.02` / `scale: 1.6` in a character payload. `scale * 1.6` (font math,
// video-creator line-height) has no colon → not matched.
const GEN_FILES = [
  "src/app/api/heygen/generate-with-bg/route.ts",
  "src/app/api/videos/create-avatar/route.ts",
  "src/app/api/videos/heygen-direct/route.ts",
  "src/app/api/heygen/test-avatar/route.ts",
  "src/lib/mcp/avatar-steps.ts",
  "src/app/(dashboard)/video-editor/page.tsx",
  "src/app/(dashboard)/video-creator/page.tsx",
];
const BANNED = /scale:\s*(2\.02|1\.6)\b/;
for (const rel of GEN_FILES) {
  const src = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
  const hit = src.split("\n").findIndex((l) => BANNED.test(l));
  ok(hit === -1, `${rel}: no hardcoded gen scale 2.02/1.6${hit === -1 ? "" : ` (line ${hit + 1})`}`);
}

console.log(`\n✅ ALL ${p} AVATAR-GEN-FRAMING CHECKS PASSED`);

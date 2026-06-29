// Run: npx tsx scripts/verify-avatar-gen-framing.ts
// Locks the single source of truth for HeyGen GEN framing (no per-caller drift — the C1 bug).
import { HEYGEN_GEN_FRAMING } from "../src/lib/avatar-gen-framing";
import { HEYGEN_FRAMING as MCP_FRAMING } from "../src/lib/mcp/avatar-steps";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

ok(typeof HEYGEN_GEN_FRAMING.scale === "number" && typeof HEYGEN_GEN_FRAMING.offsetX === "number" && typeof HEYGEN_GEN_FRAMING.offsetY === "number", "shared framing has scale/offsetX/offsetY");
ok(HEYGEN_GEN_FRAMING.scale >= 1.0 && HEYGEN_GEN_FRAMING.scale <= 3, "gen scale within HeyGen-safe range (1.0–3)");
ok(Math.abs(HEYGEN_GEN_FRAMING.offsetX) <= 1 && Math.abs(HEYGEN_GEN_FRAMING.offsetY) <= 1, "gen offsets are HeyGen fractions (−1..1)");
ok(MCP_FRAMING === HEYGEN_GEN_FRAMING, "MCP avatar-steps re-exports the shared constant (no drift)");

console.log(`\n✅ ALL ${p} GEN-FRAMING CHECKS PASSED`);

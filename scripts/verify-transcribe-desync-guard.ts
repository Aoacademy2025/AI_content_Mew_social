// Proof of the transcribe desync guard (2026-06): when Gemini reports a timeline
// well past the real audio it lost timestamp sync → reject (retryable) instead of
// silently shipping drifted/gappy subs. Pure-logic — run:
//   npx tsx scripts/verify-transcribe-desync-guard.ts
import assert from "node:assert/strict";

const TAIL_MS = 2000;
const BOGUS_DURATION_MAX_RATIO = 1.10;

// Replicates the guard decision in transcribe/route.ts.
//   ok     = within tail, not flagged
//   clamp  = flagged bogus but mild (<=10%) → clamp + ship (today's behaviour)
//   reject = severe overshoot (>10%) → 422 retryable error
function classify(rawMaxMs: number, realMs: number): "ok" | "clamp" | "reject" {
  if (!(realMs > 0 && rawMaxMs > realMs + TAIL_MS)) return "ok";
  if (rawMaxMs > realMs * BOGUS_DURATION_MAX_RATIO) return "reject";
  return "clamp";
}

let passed = 0;
function check(name: string, cond: boolean) { assert.ok(cond, name); console.log("✓ " + name); passed++; }

// ── real prod data ──
check("6-min clip (378400 vs 357120, +6%) → clamp (mild, still shipped)", classify(378400, 357120) === "clamp");
check("5.48-min Gemini-TTS clip (348500 vs 282780, +23%) → REJECT", classify(348500, 282780) === "reject");

// ── boundaries ──
check("within tail (+1000ms) → ok (not flagged)", classify(101000, 100000) === "ok");
check("over tail, <10% (+5000) → clamp", classify(105000, 100000) === "clamp");
check("exactly +10% → clamp (not strictly over)", classify(110000, 100000) === "clamp");
check("just over +10% (+10001) → reject", classify(110001, 100000) === "reject");
check("+20% → reject", classify(120000, 100000) === "reject");
check("real duration unknown (0) → ok (guard disabled)", classify(120000, 0) === "ok");

console.log(`\n✅ ALL ${passed} DESYNC-GUARD CHECKS PASSED`);

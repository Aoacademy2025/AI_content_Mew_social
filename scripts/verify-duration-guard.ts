// Proof of the duration pre-flight gate (Mew, 2026-06): block over-cap clips BEFORE
// paying for TTS/HeyGen instead of only at the final render. Pure-logic checks — run:
//   npx tsx scripts/verify-duration-guard.ts
import assert from "node:assert/strict";
import { estimateScriptDurationSec } from "../src/app/(dashboard)/video-editor/_lib/estimate-duration";
import {
  limitsForPlan,
  nextPlanFor,
  durationCapSecFor,
  PLAN_LABEL,
  audioDurationLimitViolation,
} from "../src/lib/plan-limits";

let passed = 0;
function check(name: string, cond: boolean) { assert.ok(cond, name); console.log("✓ " + name); passed++; }

// Replicates the client gate threshold (page.tsx checkDurationWithinPlan):
// estimate gets a 10% margin so a rough pre-TTS guess never false-blocks a
// borderline clip; the exact post-TTS check uses the hard cap.
function gateOk(durationSec: number, plan: string, isEstimate: boolean): boolean {
  if (!durationSec || durationSec <= 0) return true;
  const cap = limitsForPlan(plan).durationSec;
  const threshold = isEstimate ? cap * 1.1 : cap;
  return durationSec <= threshold;
}

// ── estimator (~2 Thai chars/sec + ~3 EN words/sec) ──
check("100 Thai chars ≈ 50s", Math.abs(estimateScriptDurationSec("ก".repeat(100)) - 50) < 1e-6);
check("30 EN words ≈ 10s", Math.abs(estimateScriptDurationSec(Array(30).fill("word").join(" ")) - 10) < 1e-6);
check("mixed Thai+EN adds up (2 thai +3 en = 2s)", Math.abs(estimateScriptDurationSec("กก word word word") - 2) < 1e-6);
check("empty script = 0s", estimateScriptDurationSec("") === 0);

// ── plan caps (single source) ──
check("FREE cap 120s (2min)", durationCapSecFor("FREE") === 120);
check("PRO cap 360s (6min)", durationCapSecFor("PRO") === 360);
check("BUSINESS cap 600s (10min)", durationCapSecFor("BUSINESS") === 600);

// ── nextPlanFor (drives the right upgrade target) ──
check("FREE → PRO", nextPlanFor("FREE") === "PRO");
check("PRO → BUSINESS", nextPlanFor("PRO") === "BUSINESS");
check("BUSINESS → null (top tier, no upgrade)", nextPlanFor("BUSINESS") === null);

// ── exact gate (Gate 2 / server backstop) ──
check("PRO exact: 360s ok", gateOk(360, "PRO", false) === true);
check("PRO exact: 361s blocked", gateOk(361, "PRO", false) === false);
check("PRO exact: 6.18min (371s, Mew's clip) blocked", gateOk(371, "PRO", false) === false);

// ── estimate gate (Gate 1, 10% margin → 396s for PRO) ──
check("PRO estimate: 390s passes (within margin → let exact decide)", gateOk(390, "PRO", true) === true);
check("PRO estimate: 397s blocked (clearly over)", gateOk(397, "PRO", true) === false);

// ── BUSINESS top tier ──
check("BUSINESS exact: 600s ok", gateOk(600, "BUSINESS", false) === true);
check("BUSINESS exact: 601s blocked", gateOk(601, "BUSINESS", false) === false);

// ── shared server exact-audio seam (called immediately after TTS) ──
check("server PRO: exactly 360s has no violation", audioDurationLimitViolation(360_000, "PRO") === null);
check("server PRO: 361s returns structured violation", audioDurationLimitViolation(361_000, "PRO")?.neededPlan === "BUSINESS");
check("server BUSINESS: exactly 600s has no violation", audioDurationLimitViolation(600_000, "BUSINESS") === null);
check("server BUSINESS: 601s blocks without impossible upgrade", audioDurationLimitViolation(601_000, "BUSINESS")?.neededPlan === null);
check("server unknown/zero duration fails open", audioDurationLimitViolation(0, "PRO") === null);

// ── unknown duration must pass (later checks decide) ──
check("0s / unknown passes", gateOk(0, "PRO", false) === true);

// ── labels ──
check("PLAN_LABEL maps Business", PLAN_LABEL["BUSINESS"] === "Business");

console.log(`\n✅ ALL ${passed} DURATION-GUARD CHECKS PASSED`);

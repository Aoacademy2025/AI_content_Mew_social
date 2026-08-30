// Proof of the transcribe desync guard (2026-06, re-scoped by ADR 0056 on 08-30):
// when Gemini reports a timeline well past the real audio it lost timestamp sync.
// It used to be a 422 — now the overshoot is repaired deterministically and the
// finding is reported as a WARNING, because refusing the clip never made a single
// subtitle more accurate. Pure-logic — run:
//   npx tsx scripts/verify-transcribe-desync-guard.ts
import assert from "node:assert/strict";
import { repairCaptionTiming } from "../src/lib/mcp/subtitle-quality";
import {
  mergeTranscribeWarning,
  type TranscribeWarning,
} from "../src/lib/transcribe-partial-coverage";

const TAIL_MS = 2000;
const BOGUS_DURATION_MAX_RATIO = 1.10;

// Replicates the guard decision in transcribe/route.ts.
//   ok    = within tail, not flagged
//   clamp = flagged bogus but mild (<=10%) → clamp + ship
//   warn  = severe overshoot (>10%) → clamp + ship + transcribe_desynced warning
function classify(rawMaxMs: number, realMs: number): "ok" | "clamp" | "warn" {
  if (!(realMs > 0 && rawMaxMs > realMs + TAIL_MS)) return "ok";
  if (rawMaxMs > realMs * BOGUS_DURATION_MAX_RATIO) return "warn";
  return "clamp";
}

type Caption = { text: string; startMs: number; endMs: number };

// Mirrors the tail of transcribe/route.ts: guard → deterministic repair → respond.
// 422 survives for exactly one reason: nothing to show.
function respond(captions: Caption[], realMs: number): {
  status: number; captions: Caption[]; warnings: TranscribeWarning[];
} {
  const warnings: TranscribeWarning[] = [];
  const rawMaxMs = captions[captions.length - 1]?.endMs ?? 0;
  if (classify(rawMaxMs, realMs) === "warn") {
    mergeTranscribeWarning(warnings, "transcribe_desynced", realMs, rawMaxMs);
  }
  const repaired = repairCaptionTiming(captions, realMs);
  return {
    status: repaired.captions.length > 0 ? 200 : 422,
    captions: repaired.captions,
    warnings,
  };
}

let passed = 0;
function check(name: string, cond: boolean) { assert.ok(cond, name); console.log("✓ " + name); passed++; }

// ── real prod data ──
check("6-min clip (378400 vs 357120, +6%) → clamp (mild, still shipped)", classify(378400, 357120) === "clamp");
check("5.48-min Gemini-TTS clip (348500 vs 282780, +23%) → warn (ADR 0056, was REJECT)", classify(348500, 282780) === "warn");

// ── boundaries ──
check("within tail (+1000ms) → ok (not flagged)", classify(101000, 100000) === "ok");
check("over tail, <10% (+5000) → clamp", classify(105000, 100000) === "clamp");
check("exactly +10% → clamp (not strictly over)", classify(110000, 100000) === "clamp");
check("just over +10% (+10001) → warn", classify(110001, 100000) === "warn");
check("+20% → warn", classify(120000, 100000) === "warn");
check("real duration unknown (0) → ok (guard disabled)", classify(120000, 0) === "ok");


// ── ADR 0056: a >10% overshoot ships repaired, with a warning ────────────────
// Production 2026-08-27..30: this exact shape returned 422 transcribe_desynced
// and failed the whole upload job, throwing away a transcript that covered the
// entire clip. It now clamps into the audio and reports the finding instead.
const REAL_MS = 282_780;
const desynced = [
  { text: "การ์ดแรก", startMs: 0, endMs: 120_000 },
  { text: "การ์ดกลาง", startMs: 120_000, endMs: 240_000 },
  { text: "การ์ดท้าย", startMs: 240_000, endMs: 348_500 },
];
const desyncedResponse = respond(desynced, REAL_MS);
check("desynced transcript → HTTP 200 (never a 422)", desyncedResponse.status === 200);
check("desynced transcript → one warning", desyncedResponse.warnings.length === 1);
check("desynced transcript → code transcribe_desynced", desyncedResponse.warnings[0].code === "transcribe_desynced");
check("desynced transcript → warning span is audio-end → reported end",
  desyncedResponse.warnings[0].fromMs === REAL_MS && desyncedResponse.warnings[0].toMs === 348_500);
check("desynced transcript → every card kept, text untouched",
  desyncedResponse.captions.length === 3
  && desyncedResponse.captions.map((c) => c.text).join("|") === "การ์ดแรก|การ์ดกลาง|การ์ดท้าย");
check("desynced transcript → repairCaptionTiming clamps the tail into the audio",
  desyncedResponse.captions[desyncedResponse.captions.length - 1].endMs <= REAL_MS);
check("desynced transcript → repaired timeline is monotonic",
  desyncedResponse.captions.every((c, i, a) => c.endMs > c.startMs && (i === 0 || c.startMs >= a[i - 1].endMs)));

// The one blocking case: nothing to show.
const nothing = respond([], REAL_MS);
check("no captions at all → 422 (the only blocking case left)", nothing.status === 422);

console.log(`\n✅ ALL ${passed} DESYNC-GUARD CHECKS PASSED`);

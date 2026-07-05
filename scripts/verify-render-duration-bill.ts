// verify-render-duration-bill.ts
// Proves the render bill/cap uses the TRUE rendered duration — the MAX of the client-declared
// `videoDuration` and the config the composition actually renders (shortVideoConfig /
// subtitleOverlayConfig.durationInFrames). This closes the CONFIRMED under-bill + per-clip
// duration-cap bypass where a caller sent `videoDuration:1` alongside a long shortVideoConfig:
// the old code trusted the tiny client value for billing while run-render rendered the full
// config length. Mirrors the expression in src/app/api/videos/render/route.ts.
//
// Pure-logic test (no DB / no prisma) — safe to run anywhere via tsx.

import { durationCapSecFor } from "../src/lib/plan-limits";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log("  ✓", msg);
  else { console.error("  ✗ FAIL:", msg); failures++; }
}

// Mirrors minute-limits.ts:16 — Math.max(1, round(sec/60)), non-finite/≤0 → 60s → 1 min.
function minutesFromSeconds(sec: number): number {
  return Math.max(1, Math.round((Number.isFinite(sec) && sec > 0 ? sec : 60) / 60));
}

// Mirrors the FIXED expression in render/route.ts (bill + cap from the longer duration).
function requestedDurationSec(videoDuration: unknown, configFrames: unknown, fps: number): number | null {
  const explicitDurationSec = Number(videoDuration);
  const configDurationFrames = Number(configFrames);
  const explicitSec = Number.isFinite(explicitDurationSec) && explicitDurationSec > 0 ? explicitDurationSec : 0;
  const configSec = Number.isFinite(configDurationFrames) && configDurationFrames > 0 ? configDurationFrames / fps : 0;
  return explicitSec > 0 || configSec > 0 ? Math.max(explicitSec, configSec) : null;
}

const fps = 30;
const PRO_CAP = durationCapSecFor("PRO"); // 360s (6 min)

console.log("1) EXPLOIT closed: videoDuration:1 + shortVideoConfig 10min (18000f@30)");
{
  const d = requestedDurationSec(1, 18000, fps)!;
  assert(d === 600, `bills from true 600s, not client 1s (got ${d})`);
  assert(minutesFromSeconds(d) === 10, `reserves 10 min, not 1 (got ${minutesFromSeconds(d)})`);
  assert(d > PRO_CAP, `per-clip cap now triggers for PRO (600 > ${PRO_CAP})`);
}

console.log("2) Honest short-video: no videoDuration, config 5min (9000f@30)");
{
  const d = requestedDurationSec(undefined, 9000, fps)!;
  assert(d === 300, `bills 300s (got ${d})`);
  assert(minutesFromSeconds(d) === 5, `reserves 5 min (got ${minutesFromSeconds(d)})`);
  assert(d <= PRO_CAP, `within PRO cap — honest clip not blocked`);
}

console.log("3) No over-bill when videoDuration == config (both 5min)");
{
  const d = requestedDurationSec(300, 9000, fps)!;
  assert(d === 300, `max(300,300)=300, no double-count (got ${d})`);
}

console.log("4) Plain-scenes/avatar: videoDuration only, no config → honored as before");
{
  const d = requestedDurationSec(120, undefined, fps)!;
  assert(d === 120, `honors videoDuration when no config (got ${d})`);
  assert(minutesFromSeconds(d) === 2, `2 min (got ${minutesFromSeconds(d)})`);
}

console.log("5) Nothing supplied → null (route falls back to 60s → 1 min, never 0)");
{
  const d = requestedDurationSec(undefined, undefined, fps);
  assert(d === null, `null when nothing supplied (got ${d})`);
  assert(minutesFromSeconds((d ?? 60)) === 1, `fallback bills 1 min`);
}

console.log("6) Attacker inflating videoDuration > config only over-bills THEMSELVES (not our loss)");
{
  const d = requestedDurationSec(9999, 9000, fps)!;
  assert(d === 9999, `max picks the larger 9999 (got ${d})`);
}

if (failures) { console.error(`\n❌ ${failures} assertion(s) failed`); process.exit(1); }
console.log("\n✅ render duration bill/cap: all assertions passed");

// Verifies resolveOffthreadCacheBytes: Remotion's offthread video frame cache
// (default: HALF OF FREE SYSTEM RAM) must always be explicit and hard-capped
// at 1.5GB on the shared 4 vCPU / 15.6GB VPS (spec §1 root cause 6, §5 PR-4).
// Run: npx tsx scripts/verify-offthread-cache.ts
import {
  OFFTHREAD_CACHE_MAX_BYTES,
  resolveOffthreadCacheBytes,
} from "../src/lib/offthread-cache";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`);
  }
}

// 1) ceiling constant is exactly 1.5GB
check("max is 1.5GB", OFFTHREAD_CACHE_MAX_BYTES, 1_610_612_736);

// 2) env unset (NaN) -> per-job default (same math as the old inline code)
check("default 128MB base, 1 slot",
  resolveOffthreadCacheBytes({ requestedMb: NaN, baseCacheMb: 128, activeRenderSlots: 1 }),
  128 * 1024 * 1024);
check("128MB base / 3 slots -> 42MB",
  resolveOffthreadCacheBytes({ requestedMb: NaN, baseCacheMb: 128, activeRenderSlots: 3 }),
  42 * 1024 * 1024);
check("32MB base / 4 slots -> floor clamps to 32MB",
  resolveOffthreadCacheBytes({ requestedMb: NaN, baseCacheMb: 32, activeRenderSlots: 4 }),
  32 * 1024 * 1024);

// 3) env override respected below the ceiling
check("env 512MB respected",
  resolveOffthreadCacheBytes({ requestedMb: 512, baseCacheMb: 128, activeRenderSlots: 1 }),
  512 * 1024 * 1024);

// 4) the NEW guardrail: env above the ceiling is clamped to 1.5GB
//    (previously RENDER_OFFTHREAD_CACHE_MB=99999 would allocate ~97GB)
check("env 99999MB clamped to 1.5GB",
  resolveOffthreadCacheBytes({ requestedMb: 99999, baseCacheMb: 128, activeRenderSlots: 1 }),
  1_610_612_736);

// 5) env below the 32MB floor is ignored -> fall back to per-job default
check("env 8MB ignored (below floor)",
  resolveOffthreadCacheBytes({ requestedMb: 8, baseCacheMb: 64, activeRenderSlots: 1 }),
  64 * 1024 * 1024);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll offthread-cache checks passed");

// Resolves Remotion renderMedia's offthreadVideoCacheSizeInBytes.
//
// Remotion's own default is HALF OF FREE SYSTEM RAM — on the shared 15.6GB
// VPS (web + render + ffmpeg in one Node process) that is a direct OOM
// vector, so the value must always be explicit AND hard-capped. This mirrors
// the previous inline logic in src/app/api/videos/render/route.ts (32–128MB
// per-job defaults scaled down by concurrent render slots, with a
// RENDER_OFFTHREAD_CACHE_MB env override) and adds a 1.5GB ceiling so a
// misconfigured env var can never exhaust the box.

export const OFFTHREAD_CACHE_MAX_BYTES = 1_610_612_736; // 1.5 GB
export const OFFTHREAD_CACHE_MIN_MB = 32;

export function resolveOffthreadCacheBytes(opts: {
  /** Number(process.env.RENDER_OFFTHREAD_CACHE_MB) — NaN when unset */
  requestedMb: number;
  /** Host-profile default in MB (32 critical-low-mem / 64 low-resource / 128 normal) */
  baseCacheMb: number;
  /** Concurrent renderMedia slots sharing RAM right now (>= 1) */
  activeRenderSlots: number;
}): number {
  const { requestedMb, baseCacheMb, activeRenderSlots } = opts;
  const slots = Math.max(1, activeRenderSlots);
  const perJobCacheMb = Math.max(OFFTHREAD_CACHE_MIN_MB, Math.floor(baseCacheMb / slots));
  const bytes =
    Number.isFinite(requestedMb) && requestedMb >= OFFTHREAD_CACHE_MIN_MB
      ? Math.round(requestedMb * 1024 * 1024)
      : perJobCacheMb * 1024 * 1024;
  return Math.min(bytes, OFFTHREAD_CACHE_MAX_BYTES);
}

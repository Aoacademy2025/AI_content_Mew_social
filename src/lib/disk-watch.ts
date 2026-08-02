import fs from "fs";
import path from "path";
import { getStorageHealth, type StorageHealth } from "@/lib/storage-health";

// Render leftovers that nothing uses once a render has finished. media-cleanup
// only sweeps these when run with --includeTmp (which the cron does NOT set), so
// they can pile up in /tmp if a Chromium/ffmpeg child crashes mid-render.
export const TMP_ORPHAN_PREFIXES = [
  "puppeteer_dev_chrome_profile-",
  "react-motion-render",
  "remotion-",
];
const TMP_DIR = "/tmp";
const TMP_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h — no active render touches these after 12h
const NEXT_OLD_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — keep a fresh rollback build around

export type SweepItem = { path: string; sizeMb: number };
export type SweepResult = { freedMb: number; items: SweepItem[] };

export type DiskWatchResult = {
  health: StorageHealth;
  swapGb: number;
  threshold: number;
  overThreshold: boolean;
  swept: SweepResult;
};

/** Invalid configuration must never silently disable the low-disk alarm. */
export function normalizeDiskThreshold(value: unknown): number {
  const parsed = Number(value ?? 80);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 80;
}

/** Best-effort recursive size in MB; symlinks and unreadable entries count as 0. */
export function entrySizeMb(target: string): number {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size / 1048576;
    if (st.isDirectory()) {
      let total = 0;
      for (const child of fs.readdirSync(target)) total += entrySizeMb(path.join(target, child));
      return total;
    }
  } catch {
    /* unreadable — ignore */
  }
  return 0;
}

/**
 * Delete entries in `dir` whose name starts with one of `prefixes` and whose
 * mtime is older than `maxAgeMs`. Pure-ish (params injected) so it can be tested
 * against a throwaway directory. Never follows symlinks; individual failures are
 * swallowed so one stuck file can't abort the sweep.
 */
export function sweepOrphans(
  dir: string,
  prefixes: string[],
  maxAgeMs: number,
  now: number,
): SweepResult {
  const items: SweepItem[] = [];
  let freedMb = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { freedMb: 0, items };
  }
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue; // too fresh — may belong to an active render
      const sizeMb = Math.round(entrySizeMb(full));
      fs.rmSync(full, { recursive: true, force: true });
      freedMb += sizeMb;
      items.push({ path: full, sizeMb });
    } catch {
      /* skip entries we can't stat/remove */
    }
  }
  return { freedMb, items };
}

/** Remove a stale `.next.old` rollback build (only when older than 24h). */
function sweepNextOld(cwd: string, now: number): SweepResult {
  const target = path.join(cwd, ".next.old");
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return { freedMb: 0, items: [] };
    if (now - st.mtimeMs < NEXT_OLD_MAX_AGE_MS) return { freedMb: 0, items: [] };
    const sizeMb = Math.round(entrySizeMb(target));
    fs.rmSync(target, { recursive: true, force: true });
    return { freedMb: sizeMb, items: [{ path: target, sizeMb }] };
  } catch {
    return { freedMb: 0, items: [] };
  }
}

/** Total configured swap in GB (df counts swapfiles as used disk). */
export function readSwapGb(): number {
  try {
    const lines = fs.readFileSync("/proc/swaps", "utf8").trim().split("\n").slice(1);
    let kb = 0;
    for (const line of lines) {
      const size = Number(line.trim().split(/\s+/)[2]);
      if (Number.isFinite(size)) kb += size;
    }
    return Math.round((kb / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * One disk-watch pass: sweep safe junk, then read disk pressure. The `.next.old`
 * rollback build is only swept when already over threshold (emergency reclaim);
 * stale /tmp render orphans are always swept (low risk, otherwise unmanaged).
 */
export async function runDiskWatch(opts?: {
  cwd?: string;
  threshold?: number;
  now?: number;
}): Promise<DiskWatchResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const threshold = normalizeDiskThreshold(opts?.threshold ?? process.env.DISK_ALERT_THRESHOLD);
  const now = opts?.now ?? Date.now();

  const pre = await getStorageHealth(cwd);
  const over = pre.disk.usedPercent >= threshold;

  const tmp = sweepOrphans(TMP_DIR, TMP_ORPHAN_PREFIXES, TMP_MAX_AGE_MS, now);
  const nextOld = over ? sweepNextOld(cwd, now) : { freedMb: 0, items: [] };
  const swept: SweepResult = {
    freedMb: tmp.freedMb + nextOld.freedMb,
    items: [...tmp.items, ...nextOld.items],
  };

  // Re-read only if the sweep actually freed something (du is the expensive part).
  const health = swept.freedMb > 0 ? await getStorageHealth(cwd) : pre;

  return {
    health,
    swapGb: readSwapGb(),
    threshold,
    overThreshold: health.disk.usedPercent >= threshold,
    swept,
  };
}

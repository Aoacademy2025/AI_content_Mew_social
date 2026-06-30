import fs from "fs";
import path from "path";

const STATIC_ASSETS = ["watermark.png"] as const;

function copyIfChanged(source: string, target: string) {
  if (!fs.existsSync(source)) {
    try {
      fs.rmSync(target, { force: true });
    } catch {}
    return;
  }

  const sourceStat = fs.statSync(source);
  const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (targetStat && targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
    return;
  }

  fs.copyFileSync(source, target);
  try {
    fs.utimesSync(target, sourceStat.atime, sourceStat.mtime);
  } catch {}
}

export function prepareRemotionBundlePublicDir(cwd = process.cwd()): string {
  const base = path.join(cwd, ".tmp", "remotion-public");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {}

  for (const asset of STATIC_ASSETS) {
    try {
      copyIfChanged(path.join(cwd, "public", asset), path.join(base, asset));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[render] unable to prepare Remotion static asset ${asset}: ${message}`);
    }
  }

  return base;
}

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type StoragePressure = "ok" | "warning" | "high" | "critical";

export type StorageHealth = {
  checkedAt: string;
  status: StoragePressure;
  thresholds: {
    warning: number;
    high: number;
    critical: number;
  };
  disk: {
    mount: string;
    filesystem: string;
    totalGb: number;
    usedGb: number;
    availableGb: number;
    usedPercent: number;
  };
  directories: Array<{
    key: string;
    label: string;
    path: string;
    exists: boolean;
    sizeMb: number;
    sizeGb: number;
  }>;
};

const THRESHOLDS = {
  warning: 75,
  high: 85,
  critical: 90,
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function kbToGb(kb: number): number {
  return round1(kb / 1024 / 1024);
}

function pressureFor(usedPercent: number): StoragePressure {
  if (usedPercent >= THRESHOLDS.critical) return "critical";
  if (usedPercent >= THRESHOLDS.high) return "high";
  if (usedPercent >= THRESHOLDS.warning) return "warning";
  return "ok";
}

async function readDisk(mount: string) {
  const { stdout } = await execFileAsync("df", ["-kP", mount], { timeout: 5000 });
  const lines = stdout.trim().split("\n");
  const row = lines[lines.length - 1]?.trim().split(/\s+/);

  if (!row || row.length < 6) {
    throw new Error(`Cannot parse df output for ${mount}`);
  }

  const totalKb = Number(row[1]);
  const usedKb = Number(row[2]);
  const availableKb = Number(row[3]);
  const usedPercent = Number(row[4].replace("%", ""));

  if (![totalKb, usedKb, availableKb, usedPercent].every(Number.isFinite)) {
    throw new Error(`Invalid df output for ${mount}`);
  }

  return {
    mount: row.slice(5).join(" "),
    filesystem: row[0],
    totalGb: kbToGb(totalKb),
    usedGb: kbToGb(usedKb),
    availableGb: kbToGb(availableKb),
    usedPercent,
  };
}

async function duMb(targetPath: string): Promise<number> {
  if (!fs.existsSync(targetPath)) return 0;
  const { stdout } = await execFileAsync("du", ["-sk", targetPath], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const kb = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
}

export async function getStorageHealth(cwd = process.cwd()): Promise<StorageHealth> {
  const mount = process.env.STORAGE_HEALTH_MOUNT || "/";
  const disk = await readDisk(mount);
  const directoriesToCheck = [
    { key: "renders", label: "Customer renders", path: path.join(cwd, "public", "renders") },
    { key: "stocks", label: "Stock cache", path: path.join(cwd, "stocks") },
    { key: "tmp", label: "Render temp", path: path.join(cwd, ".tmp") },
    { key: "music", label: "Music library", path: path.join(cwd, "public", "music") },
  ];

  const directories = await Promise.all(
    directoriesToCheck.map(async (dir) => {
      const exists = fs.existsSync(dir.path);
      const sizeMb = exists ? await duMb(dir.path) : 0;
      return {
        ...dir,
        exists,
        sizeMb,
        sizeGb: round1(sizeMb / 1024),
      };
    }),
  );

  return {
    checkedAt: new Date().toISOString(),
    status: pressureFor(disk.usedPercent),
    thresholds: THRESHOLDS,
    disk,
    directories,
  };
}

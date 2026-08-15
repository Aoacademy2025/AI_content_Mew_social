import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

const disable = process.argv.includes("--disable");
const desired = {
  AI_STUDIO_Z_IMAGE_ROUTE: disable ? "disabled" : "custom",
  RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID: "e10knh9zjtr2pl",
  RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH: "config/ai-workflows/z-image-turbo.json",
  RUNPOD_OMNIVOICE_ENDPOINT_ID: "0t5ta1alo5nzqo",
  AI_IMAGE_Z_IMAGE_TURBO_ESTIMATED_COST_USD_MICROS: "10000",
  AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED: "0",
} as const;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
}

const envPath = path.resolve(argument("env-file") || ".env");
const apply = process.argv.includes("--apply");
const restartPm2 = process.argv.includes("--restart-pm2");
if (restartPm2 && !apply) {
  throw new Error("--restart-pm2 requires --apply");
}
if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) {
  throw new Error(`Environment file not found: ${envPath}`);
}

const original = fs.readFileSync(envPath, "utf8");
const lines = original.split(/\r?\n/);
const seen = new Set<string>();
const updated = lines.map((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match || !(match[1] in desired)) return line;
  const key = match[1] as keyof typeof desired;
  if (seen.has(key)) throw new Error(`Duplicate ${key} entries in ${envPath}`);
  seen.add(key);
  return `${key}=${desired[key]}`;
});
for (const [key, value] of Object.entries(desired)) {
  if (!seen.has(key)) updated.push(`${key}=${value}`);
}
const next = `${updated.join("\n").replace(/\n+$/u, "")}\n`;
console.log(JSON.stringify({
  mode: apply ? (disable ? "disable-apply" : "apply") : (disable ? "disable-dry-run" : "dry-run"),
  envPath,
  desired,
  changed: next !== original,
}));
if (!apply) process.exit(0);

if (next !== original) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/u, "Z");
  const backupPath = `${envPath}.pre-hero-image-custom-${timestamp}`;
  const temporaryPath = `${envPath}.hero-image-custom.tmp`;
  const mode = fs.statSync(envPath).mode;
  fs.copyFileSync(envPath, backupPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.writeFileSync(temporaryPath, next, { encoding: "utf8", mode });
    fs.renameSync(temporaryPath, envPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  console.log(JSON.stringify({ event: "configured", envPath, backupPath }));
}

if (restartPm2) {
  const desiredProcessNames = ["ai-content", "mcp-video-worker"];
  const childEnv = { ...process.env, ...dotenv.parse(next) };
  const restarted = spawnSync(
    "pm2",
    ["restart", ...desiredProcessNames, "--update-env"],
    { cwd: path.dirname(envPath), env: childEnv, encoding: "utf8" },
  );
  if (restarted.status !== 0) {
    throw new Error(`PM2 restart failed: ${(restarted.stderr || restarted.stdout || "").trim().slice(0, 500)}`);
  }
  const listed = spawnSync("pm2", ["jlist"], {
    cwd: path.dirname(envPath),
    env: childEnv,
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error("PM2 process verification failed");
  const processes = JSON.parse(listed.stdout) as Array<{
    name?: string;
    pm2_env?: Record<string, unknown>;
  }>;
  for (const name of desiredProcessNames) {
    const processInfo = processes.find((item) => item.name === name);
    if (!processInfo || processInfo.pm2_env?.status !== "online") {
      throw new Error(`PM2 process ${name} is not online after environment refresh`);
    }
    for (const [key, value] of Object.entries(desired)) {
      if (processInfo.pm2_env?.[key] !== value) {
        throw new Error(`PM2 process ${name} did not load ${key}`);
      }
    }
  }
  console.log(JSON.stringify({
    event: "pm2-refreshed",
    processes: desiredProcessNames,
    route: desired.AI_STUDIO_Z_IMAGE_ROUTE,
  }));
}

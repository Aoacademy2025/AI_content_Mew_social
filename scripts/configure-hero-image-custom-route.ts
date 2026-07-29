import fs from "node:fs";
import path from "node:path";

const desired = {
  AI_STUDIO_Z_IMAGE_ROUTE: "custom",
  RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID: "0c6eadcsuhuhor",
  RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH: "config/ai-workflows/z-image-turbo.json",
  AI_IMAGE_Z_IMAGE_TURBO_ESTIMATED_COST_USD_MICROS: "50000",
  AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED: "0",
} as const;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
}

const envPath = path.resolve(argument("env-file") || ".env");
const apply = process.argv.includes("--apply");
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
  mode: apply ? "apply" : "dry-run",
  envPath,
  desired,
  changed: next !== original,
}));
if (!apply || next === original) process.exit(0);

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

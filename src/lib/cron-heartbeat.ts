import fs from "fs";
import path from "path";

// STAB-2: per-cron liveness heartbeat. Each cron route writes/touches
// <HEARTBEAT_DIR>/<name> at the END of its successful run. The OS-level watchdog
// (scripts/ops-watchdog.sh, run from root crontab — NOT pm2) checks each file's mtime
// against the cron's expected interval to detect a dead/stopped cron independently of
// PM2. Default dir matches the prod app root; override with HEARTBEAT_DIR.
function heartbeatDir(): string {
  return process.env.HEARTBEAT_DIR || "/var/www/ai-content/.cron-heartbeat";
}

/**
 * Touch the heartbeat file for a successful cron run. Best-effort and never throws — a
 * heartbeat-write failure (bad permissions, full disk) must not fail the cron's real work,
 * so callers put this AFTER the work completes and do not await/guard it beyond this.
 * `name` is a fixed per-route slug (not user input); still validated to keep the write
 * contained to a single file inside HEARTBEAT_DIR.
 */
export function writeCronHeartbeat(name: string): void {
  try {
    if (!/^[a-z0-9-]+$/.test(name)) {
      console.error(`[cron-heartbeat] refusing invalid heartbeat name: ${name}`);
      return;
    }
    const dir = heartbeatDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `${new Date().toISOString()}\n`);
  } catch (e) {
    console.error(`[cron-heartbeat] failed to write heartbeat for ${name}:`, e);
  }
}

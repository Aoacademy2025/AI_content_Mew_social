// Constant-time string compare — edge-runtime safe (no Node crypto), avoids
// leaking a secret (e.g. CRON_SECRET, session token) via comparison timing.
// Shared by src/middleware.ts (edge runtime) and the cron routes under
// src/app/api/cron/** (nodejs runtime) — keep this dependency-free so it
// works unchanged in both.
export function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

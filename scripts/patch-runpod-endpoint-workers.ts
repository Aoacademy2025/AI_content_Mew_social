// Safety-first, single-purpose RunPod endpoint workersMax patcher.
// Used to free one worker-quota slot for T2 (hv-emotion) by temporarily
// zeroing an explicitly-approved obsolete staging endpoint (and to revert
// that later). Refuses to touch production or any endpoint not passed
// --endpoint, asserts pre-conditions, and zero queued/in-progress jobs
// before mutating, then re-reads to confirm.
//
// Direction-aware precondition (fixed 2026-07-25 — the revert path 0 -> 1
// was previously unreachable because the expected-current value was
// hardcoded to 1): the expected *current* workersMax is inferred from the
// requested target, since this script only ever flips a single endpoint
// between exactly two values, 0 and 1.
//   --workers-max 0  =>  expected current workersMax = 1  (the "free a slot" direction)
//   --workers-max 1  =>  expected current workersMax = 0  (the "revert" direction)
// Any other --workers-max value is rejected outright (see WORKERS_MAX
// ALLOWED check below) rather than trying to guess an expected-current
// value for it — that keeps the assertion unambiguous and fail-safe.
//
// Usage:
//   npx tsx scripts/patch-runpod-endpoint-workers.ts --endpoint <id> --workers-max <n>
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const REST_BASE = "https://rest.runpod.io/v1";
const QUEUE_BASE = "https://api.runpod.ai/v2";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

// Hardcoded denylist — these are never valid targets for this script, no
// matter what --endpoint is passed.
const DENYLIST = new Set([
  "txvrmtzfc8au3b", // production
  "xbn9a1ynd6byeu", // v1, old-prod/rollback reference
  "zcqf6wc1e848v0", // v5, kept intact as the pre-v11 fallback reference
]);

// The only two workersMax values this script is approved to set. Each maps
// to the workersMax the endpoint must currently have for the mutation to be
// allowed (see the direction-aware precondition note in the header comment).
const ALLOWED_TARGET_TO_EXPECTED_CURRENT: Record<number, number> = {
  0: 1,
  1: 0,
};

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const endpointId = arg("endpoint")?.trim();
const workersMaxRaw = arg("workers-max")?.trim();

if (!endpointId) throw new Error("Usage: --endpoint <id> --workers-max <n>");
if (workersMaxRaw === undefined) throw new Error("Usage: --endpoint <id> --workers-max <n>");
const workersMax = Number(workersMaxRaw);
if (!Number.isInteger(workersMax) || workersMax < 0) {
  throw new Error("--workers-max must be a non-negative integer");
}
if (!(workersMax in ALLOWED_TARGET_TO_EXPECTED_CURRENT)) {
  throw new Error(`--workers-max must be one of: ${Object.keys(ALLOWED_TARGET_TO_EXPECTED_CURRENT).join(", ")}`);
}
const expectedCurrentWorkersMax = ALLOWED_TARGET_TO_EXPECTED_CURRENT[workersMax];

if (DENYLIST.has(endpointId)) {
  throw new Error(`Refusing to touch denylisted endpoint ${endpointId}`);
}

type Endpoint = {
  id: string;
  name: string;
  workersMax: number;
  workersMin: number;
};

type Health = {
  jobs: { completed: number; failed: number; inProgress: number; inQueue: number; retried: number };
  workers: { idle: number; initializing: number; ready: number; running: number; throttled: number; unhealthy: number };
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const source = await response.text();
  let body: unknown;
  try {
    body = source ? JSON.parse(source) : null;
  } catch {
    throw new Error(`${url} returned non-JSON status ${response.status}: ${source.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `${url} failed with status ${response.status}: ${JSON.stringify(body)}`;
    throw new Error(message);
  }
  return body as T;
}

async function main() {
  const before = await jsonRequest<Endpoint>(`${REST_BASE}/endpoints/${encodeURIComponent(endpointId!)}`);
  console.log(JSON.stringify({ event: "before", id: before.id, name: before.name, workersMax: before.workersMax, workersMin: before.workersMin }));

  if (before.workersMax !== expectedCurrentWorkersMax) {
    throw new Error(
      `Refusing to patch: current workersMax=${before.workersMax}, expected ${expectedCurrentWorkersMax} — endpoint state does not match what was approved`,
    );
  }

  const health = await jsonRequest<Health>(`${QUEUE_BASE}/${encodeURIComponent(endpointId!)}/health`);
  console.log(JSON.stringify({ event: "health", id: endpointId, jobs: health.jobs, workers: health.workers }));
  if (health.jobs.inQueue !== 0 || health.jobs.inProgress !== 0) {
    throw new Error(
      `Refusing to patch: endpoint has ${health.jobs.inQueue} queued / ${health.jobs.inProgress} in-progress jobs`,
    );
  }

  const patched = await jsonRequest<Endpoint>(`${REST_BASE}/endpoints/${encodeURIComponent(endpointId!)}`, {
    method: "PATCH",
    body: JSON.stringify({ workersMax }),
  });
  console.log(JSON.stringify({ event: "patched", id: patched.id, workersMax: patched.workersMax }));

  const after = await jsonRequest<Endpoint>(`${REST_BASE}/endpoints/${encodeURIComponent(endpointId!)}`);
  console.log(JSON.stringify({ event: "after", id: after.id, name: after.name, workersMax: after.workersMax, workersMin: after.workersMin }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "patch failed");
  process.exit(1);
});

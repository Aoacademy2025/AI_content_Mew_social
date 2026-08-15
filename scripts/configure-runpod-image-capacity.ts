import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

type Endpoint = {
  id: string;
  name: string;
  templateId: string;
  flashboot: boolean;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  gpuTypeIds: string[];
};

type EndpointHealth = {
  jobs?: {
    inQueue?: number;
    inProgress?: number;
  };
  workers?: {
    idle?: number;
    running?: number;
  };
};

const rollback = process.argv.includes("--rollback");
const productionWorkersMax = 2;
const desiredWorkersMax = rollback ? 1 : productionWorkersMax;
const desiredIdleTimeout = 5;

// The immutable BF16 worker needs at least 48 GB VRAM. Keep low-cost 48 GB
// cards first, then add datacenter fallbacks so scale-to-zero does not depend
// on one scarce hardware generation.
const desiredGpuTypeIds = [
  "NVIDIA A40",
  "NVIDIA RTX A6000",
  "NVIDIA L40",
  "NVIDIA RTX 6000 Ada Generation",
  "NVIDIA L40S",
  "NVIDIA A100 80GB PCIe",
  "NVIDIA A100-SXM4-80GB",
  "NVIDIA H100 PCIe",
  "NVIDIA H100 80GB HBM3",
  "NVIDIA H100 NVL",
];

const apiKey = process.env.RUNPOD_API_KEY?.trim();
const endpointId = process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID?.trim();
const apply = process.argv.includes("--apply");
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");
if (!endpointId) throw new Error("RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID is required");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://rest.runpod.io/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const source = await response.text();
  let body: unknown;
  try {
    body = source ? JSON.parse(source) : null;
  } catch {
    throw new Error(`RunPod returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    const reason = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`RunPod endpoint request failed: ${reason}`);
  }
  return body as T;
}

async function endpointHealth(): Promise<EndpointHealth> {
  const response = await fetch(
    `https://api.runpod.ai/v2/${encodeURIComponent(endpointId!)}/health`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const source = await response.text();
  let body: unknown;
  try {
    body = source ? JSON.parse(source) : null;
  } catch {
    throw new Error(`RunPod health returned non-JSON status ${response.status}`);
  }
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`RunPod endpoint health failed (${response.status})`);
  }
  return body as EndpointHealth;
}

function sameValues(actual: string[], expected: string[]): boolean {
  const actualSet = new Set(actual);
  return actualSet.size === expected.length
    && expected.every((value) => actualSet.has(value));
}

async function main() {
  const before = await request<Endpoint>(`/endpoints/${encodeURIComponent(endpointId!)}`);
  if (before.id !== endpointId || !/z-image/i.test(before.name)) {
    throw new Error("Refusing to mutate an unexpected RunPod endpoint");
  }
  if (
    before.workersMin !== 0
    || ![1, desiredWorkersMax].includes(before.workersMax)
    || before.idleTimeout !== desiredIdleTimeout
    || !before.flashboot
  ) {
    throw new Error("Capacity patch requires scale-to-zero, workersMax=1|2, idleTimeout=5, and FlashBoot");
  }

  const health = await endpointHealth();
  const queued = Math.max(0, Math.floor(Number(health.jobs?.inQueue) || 0));
  const inProgress = Math.max(0, Math.floor(Number(health.jobs?.inProgress) || 0));
  const changed = before.workersMax !== desiredWorkersMax
    || !sameValues(before.gpuTypeIds, desiredGpuTypeIds);
  console.log(JSON.stringify({
    mode: apply
      ? rollback ? "rollback-apply" : "apply"
      : rollback ? "rollback-dry-run" : "dry-run",
    endpoint: { id: before.id, name: before.name, templateId: before.templateId },
    beforeWorkersMax: before.workersMax,
    desiredWorkersMax,
    idleTimeout: before.idleTimeout,
    health: {
      queued,
      inProgress,
      idleWorkers: Math.max(0, Math.floor(Number(health.workers?.idle) || 0)),
      runningWorkers: Math.max(0, Math.floor(Number(health.workers?.running) || 0)),
    },
    beforeGpuTypeIds: before.gpuTypeIds,
    desiredGpuTypeIds,
    changed,
  }));
  if (!apply || !changed) return;
  if (queued > 0 || inProgress > 0) {
    throw new Error("Refusing to change RunPod image capacity while jobs are queued or in progress");
  }

  await request<Endpoint>(`/endpoints/${encodeURIComponent(endpointId!)}`, {
    method: "PATCH",
    body: JSON.stringify({
      gpuTypeIds: desiredGpuTypeIds,
      workersMin: 0,
      workersMax: desiredWorkersMax,
      idleTimeout: desiredIdleTimeout,
      flashboot: true,
    }),
  });
  const after = await request<Endpoint>(`/endpoints/${encodeURIComponent(endpointId!)}`);
  if (
    after.templateId !== before.templateId
    || after.workersMin !== 0
    || after.workersMax !== desiredWorkersMax
    || after.idleTimeout !== desiredIdleTimeout
    || !after.flashboot
    || !sameValues(after.gpuTypeIds, desiredGpuTypeIds)
  ) {
    throw new Error("RunPod endpoint did not preserve the guarded capacity contract");
  }
  console.log(JSON.stringify({
    event: "configured",
    endpoint: { id: after.id, name: after.name, templateId: after.templateId },
    gpuTypeIds: after.gpuTypeIds,
    workersMin: after.workersMin,
    workersMax: after.workersMax,
    idleTimeout: after.idleTimeout,
    flashboot: after.flashboot,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "RunPod image capacity configuration failed");
  process.exit(1);
});

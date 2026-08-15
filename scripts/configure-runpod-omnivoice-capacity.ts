import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

type Endpoint = {
  id: string;
  name: string;
  templateId: string;
  flashboot: boolean;
  workersMin: number;
  workersMax: number;
  gpuTypeIds: string[];
};

const desiredGpuTypeIds = [
  "NVIDIA RTX A4000",
  "NVIDIA RTX A4500",
  "NVIDIA RTX 4000 Ada Generation",
  "NVIDIA RTX 2000 Ada Generation",
  "NVIDIA L4",
  "NVIDIA GeForce RTX 3090",
  "NVIDIA A40",
  "NVIDIA RTX A6000",
  "NVIDIA GeForce RTX 4090",
];

const apiKey = process.env.RUNPOD_API_KEY?.trim();
const endpointId = process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID?.trim();
const apply = process.argv.includes("--apply");
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");
if (!endpointId) throw new Error("RUNPOD_OMNIVOICE_ENDPOINT_ID is required");

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

function sameValues(actual: string[], expected: string[]): boolean {
  const actualSet = new Set(actual);
  return actualSet.size === expected.length
    && expected.every((value) => actualSet.has(value));
}

async function main() {
  const before = await request<Endpoint>(`/endpoints/${encodeURIComponent(endpointId!)}`);
  if (before.id !== endpointId || !/omnivoice/i.test(before.name)) {
    throw new Error("Refusing to mutate an unexpected RunPod endpoint");
  }
  if (before.workersMin !== 0 || before.workersMax !== 1 || !before.flashboot) {
    throw new Error("Capacity patch requires scale-to-zero, workersMax=1, and FlashBoot");
  }

  const changed = !sameValues(before.gpuTypeIds, desiredGpuTypeIds);
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    endpoint: { id: before.id, name: before.name, templateId: before.templateId },
    beforeGpuTypeIds: before.gpuTypeIds,
    desiredGpuTypeIds,
    changed,
  }));
  if (!apply || !changed) return;

  await request<Endpoint>(`/endpoints/${encodeURIComponent(endpointId!)}`, {
    method: "PATCH",
    body: JSON.stringify({ gpuTypeIds: desiredGpuTypeIds }),
  });
  const after = await request<Endpoint>(`/endpoints/${encodeURIComponent(endpointId!)}`);
  if (
    after.templateId !== before.templateId
    || after.workersMin !== 0
    || after.workersMax !== 1
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
    flashboot: after.flashboot,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "RunPod OmniVoice capacity configuration failed");
  process.exit(1);
});

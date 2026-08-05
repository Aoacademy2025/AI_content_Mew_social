// T2 (hv-emotion) — create the NEW v12 staging template + endpoint for the
// class_temperature contract worker. Never touches production (txvrmtzfc8au3b)
// or any existing staging template/endpoint: it refuses to run if a resource
// named NAME already exists, and only ever creates (POST), never PATCH/DELETE.
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const API_BASE = "https://rest.runpod.io/v1";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const IMAGE = "ghcr.io/mewic/heroai-omnivoice:staging-20260724-v12-temp-2ace232f";
// Existing read:packages-only auth for ghcr.io/mewic/*, documented in
// docs/ops/runpod-ai-staging.md ("heroai-ghcr-readonly-staging-v1"). Reusing a
// read-only credential resource does not touch any existing endpoint.
const REGISTRY_AUTH_ID = "cmrusznvj000q25gsb3hdtjmk";
const NAME = "hv-emotion-v12-omnivoice-staging";
// Nine-GPU fallback pool from docs/audits/2026-07-24-hero-voice-v11-durable-queue-audit.md
const NINE_GPU_POOL = [
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

async function runpod<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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
    throw new Error(`Runpod ${path} returned non-JSON status ${response.status}: ${source.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `Runpod ${path} failed with status ${response.status}: ${JSON.stringify(body)}`;
    throw new Error(message);
  }
  return body as T;
}

async function main() {
  const templates = await runpod<Array<{ id: string; name: string; imageName: string }>>(
    "/templates?includeEndpointBoundTemplates=true",
  );
  const existingTemplate = templates.find((item) => item.name === NAME);
  if (existingTemplate && existingTemplate.imageName !== IMAGE) {
    throw new Error(
      `Refusing to reuse template ${existingTemplate.id} named ${NAME}: it points at a different image (${existingTemplate.imageName}) than expected (${IMAGE})`,
    );
  }

  const endpoints = await runpod<Array<{ id: string; name: string; templateId: string }>>("/endpoints");
  const existingEndpoint = endpoints.find((item) => item.name === NAME);
  if (existingEndpoint) {
    throw new Error(
      `Refusing to reuse/mutate existing endpoint ${existingEndpoint.id} named ${NAME} — hard constraint is NEW template+endpoint only`,
    );
  }

  let template: { id: string; name: string; imageName: string };
  if (existingTemplate) {
    template = existingTemplate;
    console.log(JSON.stringify({ event: "template-reused", id: template.id, name: template.name, imageName: template.imageName }));
  } else {
    template = await runpod<{ id: string; name: string; imageName: string }>("/templates", {
      method: "POST",
      body: JSON.stringify({
        imageName: IMAGE,
        name: NAME,
        category: "NVIDIA",
        containerDiskInGb: 20,
        containerRegistryAuthId: REGISTRY_AUTH_ID,
        dockerEntrypoint: [],
        dockerStartCmd: [],
        env: {},
        isPublic: false,
        isServerless: true,
        ports: [],
        readme: "T2 hv-emotion staging worker: v12 adds optional class_temperature. Scale-to-zero only, never production.",
        volumeInGb: 0,
        volumeMountPath: "/workspace",
      }),
    });
    console.log(JSON.stringify({ event: "template-created", id: template.id, name: template.name, imageName: template.imageName }));
  }

  const endpoint = await runpod<{ id: string; name: string; templateId: string }>("/endpoints", {
    method: "POST",
    body: JSON.stringify({
      templateId: template.id,
      name: NAME,
      computeType: "GPU",
      executionTimeoutMs: 600_000,
      flashboot: true,
      gpuCount: 1,
      gpuTypeIds: NINE_GPU_POOL,
      idleTimeout: 60,
      minCudaVersion: "12.1",
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
      workersMax: 1,
      workersMin: 0,
    }),
  });
  console.log(JSON.stringify({ event: "endpoint-created", id: endpoint.id, name: endpoint.name, templateId: endpoint.templateId }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "provisioning failed");
  process.exit(1);
});

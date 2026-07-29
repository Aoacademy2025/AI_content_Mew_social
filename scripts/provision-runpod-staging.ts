import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const API_BASE = "https://rest.runpod.io/v1";
const apply = process.argv.includes("--apply");

type TemplateSpec = {
  imageName: string;
  name: string;
  category: "NVIDIA";
  containerDiskInGb: number;
  containerRegistryAuthId?: string;
  dockerEntrypoint: string[];
  dockerStartCmd: string[];
  env: Record<string, string>;
  isPublic: false;
  isServerless: true;
  ports: string[];
  readme: string;
  volumeInGb: 0;
  volumeMountPath: "/workspace";
};

type EndpointSpec = {
  name: string;
  computeType: "GPU";
  executionTimeoutMs: number;
  flashboot: true;
  gpuCount: 1;
  gpuTypeIds: string[];
  idleTimeout: 5;
  minCudaVersion: "12.1" | "12.6";
  scalerType: "QUEUE_DELAY";
  scalerValue: 4;
  workersMax: 1;
  workersMin: 0;
};

type WorkerSpec = {
  key: "omnivoice" | "z-image";
  template: TemplateSpec;
  endpoint: EndpointSpec;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function workerSpecs(): WorkerSpec[] {
  const registryAuthId = process.env.RUNPOD_CONTAINER_REGISTRY_AUTH_ID?.trim();
  const registry = registryAuthId ? { containerRegistryAuthId: registryAuthId } : {};
  return [
    {
      key: "omnivoice",
      template: {
        imageName: requiredEnv("RUNPOD_OMNIVOICE_IMAGE"),
        name: "heroai-omnivoice-staging-v1",
        category: "NVIDIA",
        containerDiskInGb: 20,
        ...registry,
        dockerEntrypoint: [],
        dockerStartCmd: [],
        env: {},
        isPublic: false,
        isServerless: true,
        ports: [],
        readme: "Internal HERO AI OmniVoice staging worker. Scale-to-zero only.",
        volumeInGb: 0,
        volumeMountPath: "/workspace",
      },
      endpoint: {
        name: "heroai-omnivoice-staging-v1",
        computeType: "GPU",
        executionTimeoutMs: 600_000,
        flashboot: true,
        gpuCount: 1,
        gpuTypeIds: [
          "NVIDIA RTX A4000",
          "NVIDIA RTX A4500",
          "NVIDIA RTX 4000 Ada Generation",
        ],
        idleTimeout: 5,
        minCudaVersion: "12.1",
        scalerType: "QUEUE_DELAY",
        scalerValue: 4,
        workersMax: 1,
        workersMin: 0,
      },
    },
    {
      key: "z-image",
      template: {
        imageName: requiredEnv("RUNPOD_Z_IMAGE_IMAGE"),
        name: "heroai-z-image-turbo-production-v2",
        category: "NVIDIA",
        // The verified private image is 28.17 GB compressed. Reserve enough
        // space for layer extraction plus ComfyUI's runtime files.
        containerDiskInGb: 70,
        ...registry,
        dockerEntrypoint: [],
        dockerStartCmd: [],
        // The private BF16 image is ~28 GB compressed and a fresh host needs
        // longer than RunPod's default seven-minute initialization window.
        env: { RUNPOD_INIT_TIMEOUT: "800" },
        isPublic: false,
        isServerless: true,
        ports: [],
        readme: "Internal HERO AI Z-Image Turbo BF16 production worker. Scale-to-zero only.",
        volumeInGb: 0,
        volumeMountPath: "/workspace",
      },
      endpoint: {
        name: "heroai-z-image-turbo-production-v3",
        computeType: "GPU",
        executionTimeoutMs: 600_000,
        flashboot: true,
        gpuCount: 1,
        // Use the cost-effective 48 GB class for the BF16 baseline so the first
        // benchmark is deterministic. Test 24 GB/quantized variants later.
        // Keep a cost-effective 48 GB option first, then span newer inference
        // and 80 GB datacenter pools so production does not depend on one
        // scarce hardware generation.
        gpuTypeIds: ["NVIDIA A40", "NVIDIA L40S", "NVIDIA A100 80GB PCIe"],
        idleTimeout: 5,
        minCudaVersion: "12.6",
        scalerType: "QUEUE_DELAY",
        scalerValue: 4,
        workersMax: 1,
        workersMin: 0,
      },
    },
  ];
}

function apiKey(): string {
  return requiredEnv("RUNPOD_API_KEY");
}

async function runpod<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
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
    throw new Error(`Runpod ${path} returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `Runpod ${path} failed with status ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

async function main() {
  const specs = workerSpecs();
  if (!apply) {
    console.log(JSON.stringify({
      mode: "plan",
      warning: "No Runpod resources were created. Re-run with --apply after both immutable images are pushed.",
      workers: specs,
    }, null, 2));
    return;
  }

  const templates = await runpod<Array<{ id: string; name: string; imageName: string }>>(
    "/templates?includeEndpointBoundTemplates=true",
  );
  const endpoints = await runpod<Array<{ id: string; name: string; templateId: string }>>(
    "/endpoints",
  );
  const result: Array<{ key: string; templateId: string; endpointId: string; reused: boolean }> = [];

  for (const spec of specs) {
    let template = templates.find((item) => item.name === spec.template.name);
    if (template && template.imageName !== spec.template.imageName) {
      throw new Error(
        `Template ${template.name} already exists with a different image; use a new immutable staging version name`,
      );
    }
    let reused = Boolean(template);
    if (!template) {
      template = await runpod<{ id: string; name: string; imageName: string }>("/templates", {
        method: "POST",
        body: JSON.stringify(spec.template),
      });
      templates.push(template);
    }

    let endpoint = endpoints.find((item) => item.name === spec.endpoint.name);
    if (endpoint && endpoint.templateId !== template.id) {
      throw new Error(
        `Endpoint ${endpoint.name} already exists with a different template; refusing an in-place staging mutation`,
      );
    }
    reused = reused && Boolean(endpoint);
    if (!endpoint) {
      endpoint = await runpod<{ id: string; name: string; templateId: string }>("/endpoints", {
        method: "POST",
        body: JSON.stringify({ templateId: template.id, ...spec.endpoint }),
      });
      endpoints.push(endpoint);
    }
    result.push({ key: spec.key, templateId: template.id, endpointId: endpoint.id, reused });
  }

  console.log(JSON.stringify({ mode: "apply", workers: result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runpod staging provisioning failed");
  process.exit(1);
});

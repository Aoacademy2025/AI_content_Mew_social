import "server-only";

import fs from "node:fs";
import path from "node:path";
import type { AiImageModelDefinition } from "@/lib/ai-image-policy";
import {
  publicZImageProviderInput,
  type RunpodComfyImageInput,
  type RunpodImageOutput,
  type RunpodJobResponse,
} from "@/lib/runpod-image-contract";

export { firstRunpodImage } from "@/lib/runpod-image-contract";
export type {
  RunpodComfyImageInput,
  RunpodImageInput,
  RunpodImageOutput,
  RunpodJobResponse,
} from "@/lib/runpod-image-contract";

const RUNPOD_API_BASE = "https://api.runpod.ai/v2";

export class RunpodConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunpodConfigError";
  }
}

function apiKey(): string {
  const value = (process.env.RUNPOD_API_KEY ?? "").trim();
  if (!value) throw new RunpodConfigError("RUNPOD_API_KEY is missing");
  return value;
}

export type RunpodImageModelConfig =
  | { protocol: "comfy-workflow"; endpointId: string; workflowPath: string; route: "runpod-custom" }
  | { protocol: "public-z-image"; endpointId: string; route: "runpod-public" };

export function runpodImageModelConfig(model: AiImageModelDefinition): RunpodImageModelConfig | null {
  if (model.provider !== "runpod" || !model.runpodProtocol || !model.endpointEnv) return null;
  if (process.env.AI_STUDIO_IMAGE_ENABLED !== "1" || process.env.CREDITS_LIVE !== "1") return null;
  if (!(process.env.RUNPOD_API_KEY ?? "").trim()) return null;
  const explicitEndpointId = (process.env[model.endpointEnv] ?? "").trim();
  const useCustomZImage = model.id === "z-image-turbo"
    && process.env.AI_STUDIO_Z_IMAGE_ROUTE === "custom";
  const allowPublicZImage = model.id !== "z-image-turbo"
    || process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED === "1";
  const endpointId = model.id === "z-image-turbo" && !useCustomZImage
    ? (model.endpointDefault ?? "").trim()
    : explicitEndpointId || (model.endpointDefault ?? "").trim();
  if (!endpointId) return null;
  if (model.runpodProtocol === "public-z-image") {
    // The public endpoint is the production-safe default. A custom endpoint is
    // reachable only through an explicit canary route flag, so copying a staging
    // endpoint id into production cannot silently change COGS or cold-start risk.
    if (useCustomZImage) {
      if (!explicitEndpointId || explicitEndpointId === model.endpointDefault) return null;
      const workflowValue = model.workflowEnv ? (process.env[model.workflowEnv] ?? "").trim() : "";
      if (!workflowValue) return null;
      const workflowPath = path.isAbsolute(workflowValue)
        ? workflowValue
        : path.resolve(process.cwd(), workflowValue);
      if (!fs.existsSync(workflowPath)) return null;
      return { protocol: "comfy-workflow", endpointId, workflowPath, route: "runpod-custom" };
    }
    // The public Z-Image endpoint is quarantined after its nested WaveSpeed
    // credential incident. Recovery must be an explicit, separately reviewed
    // opt-in; a missing/custom-route typo fails closed.
    if (!allowPublicZImage) return null;
    return { protocol: "public-z-image", endpointId, route: "runpod-public" };
  }
  if (!model.workflowEnv) return null;
  const workflowPath = (process.env[model.workflowEnv] ?? "").trim();
  if (!workflowPath) return null;
  const resolvedWorkflowPath = path.isAbsolute(workflowPath)
    ? workflowPath
    : path.resolve(process.cwd(), workflowPath);
  if (!fs.existsSync(resolvedWorkflowPath)) return null;
  return { protocol: "comfy-workflow", endpointId, workflowPath: resolvedWorkflowPath, route: "runpod-custom" };
}

function replaceWorkflowTokens(value: unknown, replacements: Record<string, string | number>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceWorkflowTokens(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceWorkflowTokens(item, replacements)]));
  }
  if (typeof value !== "string") return value;

  for (const [token, replacement] of Object.entries(replacements)) {
    if (value === token && typeof replacement === "number") return replacement;
  }
  return Object.entries(replacements).reduce(
    (text, [token, replacement]) => text.split(token).join(String(replacement)),
    value,
  );
}

/** Load an allowlisted server-owned ComfyUI API workflow and inject only known
 * scalar tokens. Customers can never submit nodes, filenames or custom code. */
export function buildComfyWorkflow(
  workflowPath: string,
  input: RunpodComfyImageInput,
): Record<string, unknown> {
  const resolved = path.isAbsolute(workflowPath) ? workflowPath : path.resolve(process.cwd(), workflowPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new RunpodConfigError(
      `Cannot load ComfyUI workflow ${resolved}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunpodConfigError(`ComfyUI workflow ${resolved} must be a JSON object`);
  }
  const workflow = replaceWorkflowTokens(parsed, {
    "{{PROMPT}}": input.prompt,
    "{{NEGATIVE_PROMPT}}": input.negativePrompt,
    "{{WIDTH}}": input.width,
    "{{HEIGHT}}": input.height,
    "{{SEED}}": input.seed,
  }) as Record<string, unknown>;
  if (JSON.stringify(workflow).includes("{{")) {
    throw new RunpodConfigError(`ComfyUI workflow ${resolved} contains unresolved template tokens`);
  }
  return workflow;
}

async function runpodFetch(endpointId: string, operation: string, init?: RequestInit): Promise<RunpodJobResponse> {
  const response = await fetch(`${RUNPOD_API_BASE}/${encodeURIComponent(endpointId)}/${operation}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data: RunpodJobResponse;
  try {
    data = JSON.parse(text) as RunpodJobResponse;
  } catch {
    throw new Error(`Runpod returned non-JSON status ${response.status}`);
  }
  if (!response.ok) throw new Error(data.error || `Runpod request failed (${response.status})`);
  return data;
}

export type PreparedRunpodImageJob = {
  endpointId: string;
  payload: Record<string, unknown>;
};

/** Build the complete provider request before credits are reserved. Comfy models
 * load an allowlisted workflow; the official Z-Image public endpoint accepts a
 * fixed scalar-only request and keeps its safety checker enabled. */
export function prepareRunpodImageJob(
  config: RunpodImageModelConfig,
  input: RunpodComfyImageInput,
): PreparedRunpodImageJob {
  const providerInput = config.protocol === "comfy-workflow"
    ? { workflow: buildComfyWorkflow(config.workflowPath, input) }
    // The public endpoint has no negative-prompt channel (proven 2026-08-10, see
    // `publicZImageProviderInput`), so the request is narrowed here, in the open,
    // to the fields it actually delivers. The caller's negative prompt is not
    // passed to a function that appears to accept it and then discards it.
    : publicZImageProviderInput({
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      seed: input.seed,
    });
  return { endpointId: config.endpointId, payload: { input: providerInput } };
}

export async function submitRunpodImageJob(prepared: PreparedRunpodImageJob) {
  const result = await runpodFetch(prepared.endpointId, "run", {
    method: "POST",
    body: JSON.stringify(prepared.payload),
  });
  if (!result.id) throw new Error("Runpod accepted the request without a job id");
  return { providerJobId: result.id, status: result.status ?? "IN_QUEUE" };
}

export function getRunpodJob(endpointId: string, providerJobId: string) {
  return runpodFetch(endpointId, `status/${encodeURIComponent(providerJobId)}`);
}

export type RunpodEndpointHealth = {
  jobs: {
    completed: number;
    failed: number;
    inProgress: number;
    inQueue: number;
    retried: number;
  };
  workers: {
    idle: number;
    initializing: number;
    ready: number;
    running: number;
    throttled: number;
    unhealthy: number;
  };
};

export async function getRunpodEndpointHealth(
  endpointId: string,
): Promise<RunpodEndpointHealth> {
  const result = await runpodFetch(endpointId, "health") as RunpodJobResponse & {
    jobs?: Partial<RunpodEndpointHealth["jobs"]>;
    workers?: Partial<RunpodEndpointHealth["workers"]>;
  };
  const number = (value: unknown) => Number.isFinite(Number(value))
    ? Math.max(0, Math.floor(Number(value)))
    : 0;
  return {
    jobs: {
      completed: number(result.jobs?.completed),
      failed: number(result.jobs?.failed),
      inProgress: number(result.jobs?.inProgress),
      inQueue: number(result.jobs?.inQueue),
      retried: number(result.jobs?.retried),
    },
    workers: {
      idle: number(result.workers?.idle),
      initializing: number(result.workers?.initializing),
      ready: number(result.workers?.ready),
      running: number(result.workers?.running),
      throttled: number(result.workers?.throttled),
      unhealthy: number(result.workers?.unhealthy),
    },
  };
}

export async function cancelRunpodImageJob(endpointId: string, providerJobId: string): Promise<boolean> {
  try {
    const result = await runpodFetch(
      endpointId,
      `cancel/${encodeURIComponent(providerJobId)}`,
      { method: "POST" },
    );
    return result.status === "CANCELLED";
  } catch (error) {
    console.warn(
      `[runpod-image] cancel failed for ${providerJobId}:`,
      error instanceof Error ? error.message : "request failed",
    );
    return false;
  }
}

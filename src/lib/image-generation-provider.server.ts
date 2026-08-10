import "server-only";

import path from "node:path";
import type {
  AiImageAspectRatio,
  AiImageModelDefinition,
  AiImageProvider,
} from "@/lib/ai-image-policy";
import {
  isAiImageQuoteCostSafe,
  quoteAiImageModel,
  type AiImageCostPolicy,
  type AiImageQuote,
} from "@/lib/ai-image-cost-policy";
import { kieCreateTask, kieGetTask } from "@/lib/kie-client";
import { tryConsumeKieImageRate } from "@/lib/kie-image-guards";
import {
  firstRunpodImage,
  getRunpodJob,
  prepareRunpodImageJob,
  runpodImageModelConfig,
  submitRunpodImageJob,
  type PreparedRunpodImageJob,
  type RunpodComfyImageInput,
  type RunpodImageOutput,
} from "@/lib/runpod-serverless";

export type ImageProviderRoute = "runpod-public" | "runpod-custom" | "kie-market";

export type ImageOfferAvailability = {
  available: boolean;
  quote: AiImageQuote;
  provider: AiImageProvider;
  providerModel: string;
  providerRoute: ImageProviderRoute;
  providerEndpoint: string;
  unavailableCode?: "NOT_CONFIGURED" | "COST_POLICY_BLOCKED";
};

type PreparedKieImageJob = {
  model: string;
  input: Record<string, unknown>;
};

export type PreparedImageGeneration = ImageOfferAvailability & {
  available: true;
  request:
    | { provider: "runpod"; value: PreparedRunpodImageJob }
    | { provider: "kie"; value: PreparedKieImageJob };
};

export type ImageGenerationAttemptRef = {
  provider: string;
  providerModel: string;
  providerRoute: string;
  providerEndpoint: string | null;
  providerJobId: string;
};

export type ImageProviderSnapshot = {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  image?: RunpodImageOutput | { filename: string; type: "external_url"; data: string };
  error?: string;
  delayTimeMs?: number;
  executionTimeMs?: number;
  providerReportedCostUsdMicros?: number;
  providerReportedCredits?: number;
};

export class ImageGenerationConfigError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "COST_POLICY_BLOCKED" | "RATE_LIMITED" = "NOT_CONFIGURED",
  ) {
    super(message);
    this.name = "ImageGenerationConfigError";
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function costPolicy(): AiImageCostPolicy {
  return {
    usdThbRate: positiveNumber(process.env.AI_IMAGE_COST_USD_THB_RATE, 36),
    minGrossMarginBps: nonNegativeInteger(process.env.AI_IMAGE_MIN_GROSS_MARGIN_BPS, 3_000),
  };
}

function kieToken(): string {
  const token = (process.env.KIE_API_KEY ?? "").trim();
  if (!token) throw new ImageGenerationConfigError("KIE_API_KEY is missing");
  return token;
}

function customRouteEstimate(model: AiImageModelDefinition): number {
  const envName = `AI_IMAGE_${model.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ESTIMATED_COST_USD_MICROS`;
  // Measured real COGS on the RunPod custom route is ~5,200 µUSD/image (≈฿0.19/รูป,
  // see docs/research/2026-08-07-runpod-custom-billing.md). 10,000 gives ~2x headroom
  // while staying inside the 2cr cost-safety budget (38,888 µUSD, see
  // src/lib/ai-image-cost-policy.ts). Override per-model via AI_IMAGE_<MODEL>_ESTIMATED_COST_USD_MICROS.
  return nonNegativeInteger(process.env[envName], model.id === "z-image-turbo" ? 10_000 : model.estimatedCostUsdMicros);
}

function buildKieInput(
  model: AiImageModelDefinition,
  input: RunpodComfyImageInput & { aspectRatio: AiImageAspectRatio },
): PreparedKieImageJob {
  return {
    model: model.providerModel,
    input: {
      // Positive prompt only: the kie.ai text-to-image task has no
      // negative-prompt parameter, which is why every `kie` model is declared
      // `negativePromptDelivery: "ignored"` in `ai-image-policy.ts`.
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      // The retail offer is specifically priced as the 1K product. Never let a
      // provider-side default silently move this request to a higher-cost tier.
      resolution: "1K",
    },
  };
}

/** Resolve the provider route and retail quote without submitting work. This is
 * the single interface used by the catalog and submission route, so availability,
 * displayed credits and the charged amount cannot drift apart. */
export function describeImageOffer(model: AiImageModelDefinition): ImageOfferAvailability {
  let configured = false;
  let providerRoute: ImageProviderRoute = model.provider === "kie" ? "kie-market" : "runpod-custom";
  let providerEndpoint = model.provider === "kie" ? "kie-market" : "";
  let estimatedCostUsdMicros = model.estimatedCostUsdMicros;

  if (model.provider === "kie") {
    configured = process.env.AI_STUDIO_IMAGE_ENABLED === "1"
      && process.env.CREDITS_LIVE === "1"
      && process.env.MANAGED_KIE === "1"
      && Boolean((process.env.KIE_API_KEY ?? "").trim());
  } else {
    const config = runpodImageModelConfig(model);
    configured = Boolean(config);
    if (config) {
      providerRoute = config.route;
      providerEndpoint = config.endpointId;
      estimatedCostUsdMicros = config.route === "runpod-public"
        ? model.estimatedCostUsdMicros
        : customRouteEstimate(model);
    }
  }

  const quoteModel = providerRoute === "runpod-custom" && model.customCreditCostKey
    ? { ...model, creditCostKey: model.customCreditCostKey }
    : model;
  const quote = quoteAiImageModel(quoteModel, estimatedCostUsdMicros, costPolicy());
  if (!configured) {
    return {
      available: false,
      quote,
      provider: model.provider,
      providerModel: model.providerModel,
      providerRoute,
      providerEndpoint,
      unavailableCode: "NOT_CONFIGURED",
    };
  }
  if (!isAiImageQuoteCostSafe(quote)) {
    return {
      available: false,
      quote,
      provider: model.provider,
      providerModel: model.providerModel,
      providerRoute,
      providerEndpoint,
      unavailableCode: "COST_POLICY_BLOCKED",
    };
  }
  return {
    available: true,
    quote,
    provider: model.provider,
    providerModel: model.providerModel,
    providerRoute,
    providerEndpoint,
  };
}

export function prepareImageGeneration(
  model: AiImageModelDefinition,
  input: RunpodComfyImageInput & { aspectRatio: AiImageAspectRatio },
): PreparedImageGeneration {
  const offer = describeImageOffer(model);
  if (!offer.available) {
    throw new ImageGenerationConfigError(
      offer.unavailableCode === "COST_POLICY_BLOCKED"
        ? `${model.label} ถูกปิดเพราะต้นทุน provider เกินเพดานราคาที่แจ้ง`
        : `${model.label} ยังไม่ได้เชื่อม provider`,
      offer.unavailableCode ?? "NOT_CONFIGURED",
    );
  }

  if (model.provider === "kie") {
    return { ...offer, available: true, request: { provider: "kie", value: buildKieInput(model, input) } };
  }
  const config = runpodImageModelConfig(model);
  if (!config) throw new ImageGenerationConfigError(`${model.label} ยังไม่ได้เชื่อม Runpod`);
  return {
    ...offer,
    available: true,
    request: { provider: "runpod", value: prepareRunpodImageJob(config, input) },
  };
}

export async function submitPreparedImageGeneration(
  prepared: PreparedImageGeneration,
  userId: string,
): Promise<{ providerJobId: string; status: "IN_QUEUE" | "IN_PROGRESS" }> {
  if (prepared.request.provider === "runpod") {
    const submitted = await submitRunpodImageJob(prepared.request.value);
    return {
      providerJobId: submitted.providerJobId,
      status: submitted.status === "IN_PROGRESS" ? "IN_PROGRESS" : "IN_QUEUE",
    };
  }
  if (!tryConsumeKieImageRate(userId)) {
    throw new ImageGenerationConfigError("ใช้โควตาสร้างภาพสำรองครบแล้ว กรุณาลองใหม่ภายหลัง", "RATE_LIMITED");
  }
  const providerJobId = await kieCreateTask(
    prepared.request.value.model,
    prepared.request.value.input,
    kieToken(),
  );
  return { providerJobId, status: "IN_QUEUE" };
}

export async function pollImageGenerationAttempt(attempt: ImageGenerationAttemptRef): Promise<ImageProviderSnapshot> {
  if (attempt.provider === "runpod") {
    if (!attempt.providerEndpoint) throw new ImageGenerationConfigError("Runpod endpoint was not recorded");
    const result = await getRunpodJob(attempt.providerEndpoint, attempt.providerJobId);
    if (result.status === "COMPLETED") {
      const reportedCost = typeof result.output?.cost === "number" && Number.isFinite(result.output.cost)
        ? Math.max(0, Math.round(result.output.cost * 1_000_000))
        : undefined;
      return {
        status: "COMPLETED",
        image: firstRunpodImage(result),
        delayTimeMs: typeof result.delayTime === "number" ? Math.round(result.delayTime) : undefined,
        executionTimeMs: typeof result.executionTime === "number" ? Math.round(result.executionTime) : undefined,
        providerReportedCostUsdMicros: reportedCost,
      };
    }
    return {
      status: result.status ?? "IN_QUEUE",
      error: result.error,
      delayTimeMs: typeof result.delayTime === "number" ? Math.round(result.delayTime) : undefined,
      executionTimeMs: typeof result.executionTime === "number" ? Math.round(result.executionTime) : undefined,
    };
  }

  if (attempt.provider === "kie") {
    const snapshot = await kieGetTask(attempt.providerJobId, kieToken());
    if (snapshot.state === "success") {
      const filename = (() => {
        try { return path.basename(new URL(snapshot.resultUrl!).pathname) || "kie-image.png"; }
        catch { return "kie-image.png"; }
      })();
      return {
        status: "COMPLETED",
        image: { filename, type: "external_url", data: snapshot.resultUrl! },
        executionTimeMs: snapshot.executionTimeMs,
        providerReportedCredits: snapshot.creditsConsumed,
      };
    }
    if (snapshot.state === "fail") return { status: "FAILED", error: snapshot.failMessage || "kie.ai task failed" };
    return { status: snapshot.state === "generating" ? "IN_PROGRESS" : "IN_QUEUE" };
  }

  throw new ImageGenerationConfigError(`Unsupported image provider: ${attempt.provider}`);
}

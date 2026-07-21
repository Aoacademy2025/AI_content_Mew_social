export const AI_IMAGE_MODEL_IDS = [
  "z-image-turbo",
  "gpt-image-2",
  "flux2-klein-4b",
  "hidream-o1",
] as const;

export type AiImageModelId = (typeof AI_IMAGE_MODEL_IDS)[number];
export type AiImageAspectRatio = "1:1" | "4:5" | "9:16" | "16:9";
export type AiImageStyle = "photoreal" | "cinematic" | "editorial" | "illustration" | "product";
export type AiImageProvider = "runpod" | "kie";
export type AiImageEngine = "runpod" | "cloud";

export type AiImageModelDefinition = {
  id: AiImageModelId;
  label: string;
  description: string;
  creditCostKey: "image-open-fast-1k" | "image-open-quality-1k" | "image-gpt-1k";
  engine: AiImageEngine;
  provider: AiImageProvider;
  providerModel: string;
  estimatedCostUsdMicros: number;
  runpodProtocol?: "comfy-workflow" | "public-z-image";
  endpointEnv?: string;
  endpointDefault?: string;
  workflowEnv?: string;
};

export const AI_IMAGE_MODELS: readonly AiImageModelDefinition[] = [
  {
    id: "z-image-turbo",
    label: "Realistic · Z-Image Turbo",
    description: "ภาพคน สินค้า อาหาร และฉากสมจริง",
    creditCostKey: "image-open-fast-1k",
    engine: "runpod",
    provider: "runpod",
    providerModel: "z-image-turbo",
    estimatedCostUsdMicros: 5_000,
    runpodProtocol: "public-z-image",
    endpointEnv: "RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID",
    endpointDefault: "z-image-turbo",
    workflowEnv: "RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH",
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2 · 1K",
    description: "โมเดล Cloud API แยกจาก RunPod AI และคิดราคาเป็นงานของตัวเอง",
    creditCostKey: "image-gpt-1k",
    engine: "cloud",
    provider: "kie",
    providerModel: "gpt-image-2-text-to-image",
    estimatedCostUsdMicros: 30_000,
  },
  {
    id: "flux2-klein-4b",
    label: "Fast · FLUX.2 Klein",
    description: "เร็ว เหมาะกับภาพประกอบและการลองหลายแบบ",
    creditCostKey: "image-open-fast-1k",
    engine: "runpod",
    provider: "runpod",
    providerModel: "flux2-klein-4b",
    // Conservative until this custom worker has real billing samples.
    estimatedCostUsdMicros: 50_000,
    runpodProtocol: "comfy-workflow",
    endpointEnv: "RUNPOD_IMAGE_FLUX2_ENDPOINT_ID",
    workflowEnv: "RUNPOD_IMAGE_FLUX2_WORKFLOW_PATH",
  },
  {
    id: "hidream-o1",
    label: "Quality · HiDream O1",
    description: "รายละเอียดสูงและทำตามองค์ประกอบซับซ้อนได้ดี",
    creditCostKey: "image-open-quality-1k",
    engine: "runpod",
    provider: "runpod",
    providerModel: "hidream-o1",
    // Conservative until this custom worker has real billing samples.
    estimatedCostUsdMicros: 80_000,
    runpodProtocol: "comfy-workflow",
    endpointEnv: "RUNPOD_IMAGE_HIDREAM_ENDPOINT_ID",
    workflowEnv: "RUNPOD_IMAGE_HIDREAM_WORKFLOW_PATH",
  },
] as const;

const STYLE_PROMPT: Record<AiImageStyle, string> = {
  photoreal: "photorealistic commercial photography, natural materials, believable lighting",
  cinematic: "cinematic film still, deliberate composition, dimensional lighting",
  editorial: "refined editorial photography, art-directed composition, premium magazine aesthetic",
  illustration: "polished contemporary illustration, expressive shapes, rich tactile detail",
  product: "premium product photography, controlled studio lighting, clean art direction",
};

const ASPECT_SIZE: Record<AiImageAspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:5": { width: 1024, height: 1280 },
  "9:16": { width: 768, height: 1344 },
  "16:9": { width: 1344, height: 768 },
};

export function isAiImageModelId(value: unknown): value is AiImageModelId {
  return typeof value === "string" && (AI_IMAGE_MODEL_IDS as readonly string[]).includes(value);
}

export function isAiImageEngine(value: unknown): value is AiImageEngine {
  return value === "runpod" || value === "cloud";
}

export function isAiImageAspectRatio(value: unknown): value is AiImageAspectRatio {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ASPECT_SIZE, value);
}

export function isAiImageStyle(value: unknown): value is AiImageStyle {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STYLE_PROMPT, value);
}

export function dimensionsForAspectRatio(aspectRatio: AiImageAspectRatio) {
  return ASPECT_SIZE[aspectRatio];
}

/**
 * Customer prompts never reach a provider verbatim. Every request receives the
 * same artwork-only invariant so neither Thai nor English copy is intentionally
 * painted into the result. This is a generation guard, not an OCR guarantee.
 */
export function buildArtworkOnlyPrompt(prompt: string, style: AiImageStyle): {
  positive: string;
  negative: string;
} {
  const subject = prompt.replace(/\s+/g, " ").trim().slice(0, 1_500);
  const positive = [
    subject,
    STYLE_PROMPT[style],
    "standalone visual artwork with no written language anywhere in the image",
    "leave any signage, screens, labels, packaging, clothing and background surfaces completely blank",
  ].filter(Boolean).join(". ") + ".";

  const negative = [
    "text", "letters", "words", "typography", "caption", "subtitle", "headline",
    "logo", "watermark", "signature", "numbers", "symbols", "signage", "label",
    "Thai writing", "English writing", "Chinese writing", "Japanese writing",
  ].join(", ");

  return { positive, negative };
}

export function previewGenerationInput(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 180);
}

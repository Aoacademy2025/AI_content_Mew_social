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
export type AiImageCreditCostKey =
  | "image-open-fast-1k"
  | "image-open-custom-1k"
  | "image-open-quality-1k"
  | "image-gpt-1k";

export type AiImageModelDefinition = {
  id: AiImageModelId;
  label: string;
  description: string;
  creditCostKey: AiImageCreditCostKey;
  customCreditCostKey?: AiImageCreditCostKey;
  engine: AiImageEngine;
  provider: AiImageProvider;
  providerModel: string;
  estimatedCostUsdMicros: number;
  /**
   * Whether a negative prompt reaches the model on any route this model can be
   * configured onto. A provider fact, not a policy — it exists so no feature
   * rests a guarantee on a channel that is not there.
   *
   * - `ignored` — no configured route for this model reads a negative prompt.
   *   A caller may still compute one (it stays meaningful for engines that do
   *   consume it), but nothing on this route delivers it.
   * - `workflow-defined` — the `comfy-workflow` protocol substitutes
   *   `{{NEGATIVE_PROMPT}}`, so delivery is a property of the server-owned
   *   workflow file named by `workflowEnv`.
   */
  negativePromptDelivery: "ignored" | "workflow-defined";
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
    customCreditCostKey: "image-open-custom-1k",
    engine: "runpod",
    provider: "runpod",
    providerModel: "z-image-turbo",
    estimatedCostUsdMicros: 5_000,
    // Positive-only on BOTH of its routes, verified separately for each:
    //   · public endpoint — the same seed and prompt submitted with no field,
    //     with `negative_prompt` and with `negativePrompt` returned byte-identical
    //     images and no rejection or warning, with the subjects the negative text
    //     asked to remove still in frame
    //     (`artifacts/runpod-negative-prompt-probe-2026-08-10/report.md`);
    //   · custom endpoint — `config/ai-workflows/z-image-turbo.json` runs at
    //     `cfg: 1` and feeds `ConditioningZeroOut` into the sampler's negative
    //     input, so it carries no `{{NEGATIVE_PROMPT}}` token by design.
    // This is the model behind Hero AI Image and the Brand Visual System, so no
    // text-free claim anywhere in the product may rest on a negative prompt.
    negativePromptDelivery: "ignored",
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
    // The kie.ai text-to-image task takes a positive prompt, an aspect ratio and
    // a resolution tier; there is no negative-prompt parameter to send one to
    // (`buildKieInput` in image-generation-provider.server.ts).
    negativePromptDelivery: "ignored",
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
    negativePromptDelivery: "workflow-defined",
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
    negativePromptDelivery: "workflow-defined",
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
 * Customer prompts never reach a provider verbatim. Every request is wrapped in
 * the same output-shape contract — one frame, one moment, one camera view — so a
 * freeform prompt cannot come back as a collage, a storyboard sheet or a grid of
 * variations.
 *
 * It is NOT a text guard, and must never be described as one. Per ADR 0007
 * English text is permitted, as are characters intrinsic to a depicted object (a
 * banknote denomination, a coin face, a price tag). The clauses that used to sit
 * here — "standalone language-free visual artwork" and "all signage, labels,
 * packaging, clothing and background surfaces are blank and unmarked" — were
 * written as anti-text guardrails but read to a diffusion model as art
 * direction: blank clothing flattens the clothes, blank packaging flattens the
 * products, unlabeled controls flatten the screens. That is the same defect
 * ADR 0006 fixed in the Brand Visual compiler, and it was live here on the same
 * day. Nothing may be added back to `positive` that names a thing a model could
 * draw; the only channel that legitimately narrows scene content is the Visual
 * Beat request layer that asks for the scene in the first place.
 *
 * The returned `negative` reaches the model only on a model whose
 * `negativePromptDelivery` is `workflow-defined` and whose server-owned workflow
 * substitutes `{{NEGATIVE_PROMPT}}`. On every `ignored` model — which includes
 * `z-image-turbo`, the model behind Hero AI Image — it is computed and never
 * delivered. It is kept, not deleted, because it is real for the engines that do
 * consume it; nothing may treat it as enforcement.
 */
export function buildArtworkOnlyPrompt(
  prompt: string,
  style: AiImageStyle,
): {
  positive: string;
  negative: string;
} {
  const subject = prompt.replace(/\s+/g, " ").trim().slice(0, 1_500);
  // Z-Image is positive-only on both of its routes — the public endpoint accepts
  // a negative-prompt field and ignores it (proven byte-for-byte on 2026-08-10,
  // `artifacts/runpod-negative-prompt-probe-2026-08-10/`), and the custom
  // workflow zeroes its negative conditioning. So the positive prompt is the
  // only channel that reaches this model at all, and every clause in it is
  // something the model will try to render. Only three things earn a place:
  // the output-shape contract, the caller's own subject, and the rendering
  // style. Describe the wanted composition without naming unwanted layouts:
  // diffusion text encoders may otherwise treat a negated concept as a positive
  // cue.
  const singleFrameGuard = [
    "ONE UNIFIED EDGE-TO-EDGE FULL-CANVAS IMAGE",
    "depict exactly one moment from exactly one camera view",
    "use one spatially continuous scene across the entire canvas",
    "keep a consistent subject, setting, lighting and perspective throughout the canvas",
  ].join(", ");
  const positive = [
    singleFrameGuard,
    subject,
    STYLE_PROMPT[style],
  ].filter(Boolean).join(". ") + ".";

  // Aligned with ADR 0007. This list no longer bans text as such: `text`,
  // `letters`, `words`, `typography`, `numbers`, `symbols`, `signage`, `label`
  // and `English writing` are gone, because English is allowed and
  // object-intrinsic characters are part of the object. What remains is the two
  // things a generated frame must still never invent — a mark that impersonates
  // the deterministic overlay layers (subtitle, headline, logo, brand mark), and
  // a multi-frame layout.
  //
  // `Thai writing` stays per ADR 0007: the model renders authentic-looking Thai
  // that spells nothing, which a Thai viewer reads as broken. `Chinese writing`
  // and `Japanese writing` stay on the same reasoning — the non-Latin garbling
  // is the same failure mode — but ADR 0007 speaks only about Thai and English,
  // so that pair is a conservative default awaiting confirmation, not a decided
  // policy.
  const negative = [
    "collage", "triptych", "diptych", "contact sheet", "storyboard", "split screen",
    "grid", "sequence", "repeated scene", "multiple views", "panels", "panel borders",
    "caption", "subtitle", "headline", "logo", "watermark", "signature", "brand name",
    "Thai writing", "Chinese writing", "Japanese writing",
  ].join(", ");

  return { positive, negative };
}

export function previewGenerationInput(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 180);
}

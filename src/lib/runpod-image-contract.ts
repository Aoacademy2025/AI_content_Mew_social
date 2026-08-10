export type RunpodImageOutput = {
  filename: string;
  type: "base64" | "s3_url" | "temporary_url";
  data: string;
};

export type RunpodJobResponse = {
  id?: string;
  status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  output?: {
    images?: RunpodImageOutput[];
    image_url?: string;
    result?: string;
    cost?: number;
    errors?: string[];
    [key: string]: unknown;
  };
  error?: string;
  delayTime?: number;
  executionTime?: number;
  jobs?: {
    completed?: number;
    failed?: number;
    inProgress?: number;
    inQueue?: number;
    retried?: number;
  };
  workers?: {
    idle?: number;
    running?: number;
  };
};

/** The scalar request shared by every RunPod image protocol. A negative prompt
 * is deliberately not part of it: only one protocol can carry one. */
export type RunpodImageInput = {
  prompt: string;
  width: number;
  height: number;
  seed: number;
};

/** The `comfy-workflow` protocol's input. It is the only protocol with a channel
 * for a negative prompt — `buildComfyWorkflow` substitutes `{{NEGATIVE_PROMPT}}`
 * into a server-owned workflow — so whether the value reaches the model is a
 * property of that workflow file. It does for `flux2-klein-4b` and `hidream-o1`;
 * it does not for `config/ai-workflows/z-image-turbo.json`, which zeroes the
 * negative conditioning (`ConditioningZeroOut`, `cfg: 1`) and carries no such
 * token by design — see the check in `scripts/verify-ai-studio.ts`. */
export type RunpodComfyImageInput = RunpodImageInput & {
  negativePrompt: string;
};

/**
 * The official public Z-Image endpoint's complete request.
 *
 * It has no negative-prompt channel. On 2026-08-10 the live endpoint was sent
 * the same seed and positive prompt three ways — no field, `negative_prompt`,
 * `negativePrompt` — and accepted all three without a rejection or a warning,
 * returning byte-identical images with the subjects the negative text asked to
 * remove still in frame (`artifacts/runpod-negative-prompt-probe-2026-08-10/`).
 * The parameter type therefore carries no negative prompt at all: there is
 * nothing here to deliver it to, and a field accepted and silently dropped
 * reads as a guarantee.
 */
export function publicZImageProviderInput(input: RunpodImageInput): Record<string, unknown> {
  const size = input.width === input.height
    ? "1024*1024"
    : input.height > input.width
      ? input.height / input.width >= 1.6 ? "720*1280" : "768*1024"
      : input.width / input.height >= 1.6 ? "1280*720" : "1024*768";
  return {
    prompt: input.prompt,
    size,
    seed: input.seed,
    output_format: "png",
    enable_safety_checker: true,
  };
}

export function firstRunpodImage(result: RunpodJobResponse): RunpodImageOutput {
  const image = result.output?.images?.[0];
  if (image?.data && (image.type === "base64" || image.type === "s3_url")) return image;
  // Runpod's Z-Image public endpoint currently returns `output.result` in live
  // traffic, while its model/reference docs show `output.image_url`. Accept both
  // provider-owned shapes and normalize them before durable storage.
  const temporaryUrl = result.output?.image_url ?? result.output?.result;
  if (typeof temporaryUrl === "string" && temporaryUrl.trim()) {
    let filename = "runpod-image.png";
    try {
      filename = new URL(temporaryUrl).pathname.split("/").filter(Boolean).at(-1) || filename;
    } catch {}
    return { filename, type: "temporary_url", data: temporaryUrl };
  }
  const providerError = result.output?.errors?.join("; ") || result.error;
  throw new Error(providerError || "Runpod job completed without an image");
}

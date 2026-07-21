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
};

export type RunpodImageInput = {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
};

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

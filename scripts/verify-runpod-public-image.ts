import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  firstRunpodImage,
  publicZImageProviderInput,
} from "../src/lib/runpod-image-contract";
import { AI_IMAGE_MODELS } from "../src/lib/ai-image-policy";

const portrait = publicZImageProviderInput({
  prompt: "A coffee shop owner in soft morning light.",
  width: 768,
  height: 1344,
  seed: 42,
});
assert.deepEqual(portrait, {
  prompt: "A coffee shop owner in soft morning light.",
  size: "720*1280",
  seed: 42,
  output_format: "png",
  enable_safety_checker: true,
});

assert.equal(publicZImageProviderInput({ prompt: "x", width: 1024, height: 1024, seed: 1 }).size, "1024*1024");
assert.equal(publicZImageProviderInput({ prompt: "x", width: 1344, height: 768, seed: 1 }).size, "1280*720");

/** The public Z-Image endpoint has no negative-prompt channel: on 2026-08-10 the
 * same seed and prompt were submitted with no field, with `negative_prompt` and
 * with `negativePrompt`, and all three returned byte-identical images with the
 * subjects the negative text asked to remove still in frame
 * (`artifacts/runpod-negative-prompt-probe-2026-08-10/`). The request contract
 * must therefore carry no negative prompt at all — a field accepted and silently
 * dropped is what let a text-free guarantee rest on a no-op for months. */
assert.deepEqual(
  Object.keys(publicZImageProviderInput({ prompt: "x", width: 1024, height: 1024, seed: 1 })).sort(),
  ["enable_safety_checker", "output_format", "prompt", "seed", "size"],
  "the public Z-Image payload is exactly these five fields; a sixth would be an unreviewed provider change",
);

const contractSource = readFileSync("src/lib/runpod-image-contract.ts", "utf8");
const baseInputType = /export type RunpodImageInput = \{([\s\S]*?)\};/.exec(contractSource)?.[1] ?? "";
assert.ok(baseInputType, "RunpodImageInput must remain the shared scalar request type");
assert.doesNotMatch(
  baseInputType,
  /negativePrompt/,
  "the input type the public Z-Image builder accepts must not name a negative prompt it cannot deliver",
);
assert.match(
  contractSource,
  /export type RunpodComfyImageInput = RunpodImageInput & \{[\s\S]*?negativePrompt: string;/,
  "the negative prompt stays modelled on the one protocol that can carry it, rather than being deleted",
);
assert.match(
  contractSource,
  /artifacts\/runpod-negative-prompt-probe-2026-08-10/,
  "the positive-only contract cites the probe that established it",
);

const serverlessSource = readFileSync("src/lib/runpod-serverless.ts", "utf8");
assert.match(
  serverlessSource,
  /"\{\{NEGATIVE_PROMPT\}\}": input\.negativePrompt/,
  "the comfy-workflow protocol still delivers a negative prompt for the engines that consume one",
);
assert.match(
  serverlessSource,
  /publicZImageProviderInput\(\{\s*prompt: input\.prompt,\s*width: input\.width,\s*height: input\.height,\s*seed: input\.seed,\s*\}\)/,
  "the public route narrows the request in the open instead of handing a negative prompt to a function that discards it",
);

/** Whether a negative prompt reaches the model is a provider fact each model must
 * state, so no future feature can assume a channel that is not there. */
const zImage = AI_IMAGE_MODELS.find((model) => model.id === "z-image-turbo")!;
assert.equal(
  zImage.negativePromptDelivery,
  "ignored",
  "z-image-turbo is positive-only on both its public endpoint and its custom workflow",
);
assert.equal(
  AI_IMAGE_MODELS.find((model) => model.id === "gpt-image-2")!.negativePromptDelivery,
  "ignored",
  "the kie.ai text-to-image task has no negative-prompt parameter",
);
for (const model of AI_IMAGE_MODELS) {
  if (model.negativePromptDelivery !== "workflow-defined") continue;
  assert.equal(
    model.runpodProtocol,
    "comfy-workflow",
    `${model.id} may only claim workflow-defined delivery on the protocol that substitutes the token`,
  );
}

/** The custom Z-Image workflow is the second half of the "ignored" claim: it runs
 * at cfg 1 with the negative conditioning zeroed, so it carries no token to
 * substitute even though its protocol has one. */
const zImageWorkflow = readFileSync("config/ai-workflows/z-image-turbo.json", "utf8");
assert.doesNotMatch(
  zImageWorkflow,
  /\{\{NEGATIVE_PROMPT\}\}/,
  "the custom Z-Image workflow must stay positive-only",
);
assert.match(zImageWorkflow, /"ConditioningZeroOut"/);
assert.match(zImageWorkflow, /"cfg": 1/);

assert.deepEqual(
  firstRunpodImage({ status: "COMPLETED", output: { image_url: "https://image.runpod.ai/job/output.png", cost: 0.005 } }),
  { filename: "output.png", type: "temporary_url", data: "https://image.runpod.ai/job/output.png" },
);
assert.deepEqual(
  firstRunpodImage({ status: "COMPLETED", output: { result: "https://image.runpod.ai/z-image-turbo/job/result.png", cost: 0.005 } }),
  { filename: "result.png", type: "temporary_url", data: "https://image.runpod.ai/z-image-turbo/job/result.png" },
);
assert.deepEqual(
  firstRunpodImage({ status: "COMPLETED", output: { images: [{ filename: "owned.webp", type: "s3_url", data: "https://assets.example.com/owned.webp" }] } }),
  { filename: "owned.webp", type: "s3_url", data: "https://assets.example.com/owned.webp" },
);
assert.throws(
  () => firstRunpodImage({ status: "COMPLETED", output: { errors: ["no image"] } }),
  /no image/,
);

console.log("Runpod public image contract checks passed.");

import assert from "node:assert/strict";
import {
  firstRunpodImage,
  publicZImageProviderInput,
} from "../src/lib/runpod-image-contract";

const portrait = publicZImageProviderInput({
  prompt: "A Thai coffee shop owner in soft morning light, no writing anywhere.",
  negativePrompt: "text, logo, watermark",
  width: 768,
  height: 1344,
  seed: 42,
});
assert.deepEqual(portrait, {
  prompt: "A Thai coffee shop owner in soft morning light, no writing anywhere.",
  size: "720*1280",
  seed: 42,
  output_format: "png",
  enable_safety_checker: true,
});

assert.equal(publicZImageProviderInput({ prompt: "x", negativePrompt: "", width: 1024, height: 1024, seed: 1 }).size, "1024*1024");
assert.equal(publicZImageProviderInput({ prompt: "x", negativePrompt: "", width: 1344, height: 768, seed: 1 }).size, "1280*720");

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

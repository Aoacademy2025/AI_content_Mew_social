# HERO AI Z-Image Turbo Runpod worker

Custom queue-based Runpod Serverless image worker for the internal HERO AI staging
path. It layers the official Z-Image Turbo BF16 bundle onto the official Runpod
ComfyUI worker and preserves the worker's v5+ `output.images[]` contract.

## Pinned supply chain

- `runpod/worker-comfyui:5.8.6-base`, pinned to the Linux AMD64 manifest digest.
- Runpod worker source commit `066a11c49cfe6357902d1b2d8bc8d86bc55128b0`.
- Comfy-Org Z-Image model revision `d24c4cf2a0cd98a42f23467e27e3d76ee9438b8e`.
- Every model file is verified against the SHA-256 and byte size in
  `model-manifest.json`.
- The upstream Runpod worker is AGPL-3.0-only. The original Z-Image Turbo model is
  Apache-2.0. Keep the image private while distribution obligations are reviewed.

The three model files total 20,690,152,836 bytes before the worker base and OCI
layer overhead. BF16 is intentional for the first quality benchmark; quantized
variants should be evaluated only after the baseline is recorded.

## Application workflow

The allowlisted API workflow is `config/ai-workflows/z-image-turbo.json`. HERO AI
injects only prompt, negative prompt, width, height and seed scalar values. The
browser never supplies a workflow or model filename.

The workflow mirrors the official ComfyUI Z-Image Turbo template: eight steps,
CFG 1, `res_multistep`, `simple`, AuraFlow shift 3, and zeroed negative
conditioning. The server folds its negative constraints into the positive prompt
so the model receives the no-text rules without an unnecessary second text-encoder
pass.

## Build and endpoint

```bash
docker buildx build --platform linux/amd64 \
  -t <private-registry>/heroai-z-image-turbo:<immutable-tag> .
```

For the staging endpoint use queue `/run`, Flex workers, `workersMin=0`,
`workersMax=1`, FlashBoot, and one 24 GB-or-larger GPU. Keep S3 output disabled for
the first one-image smoke only if the base64 payload remains under Runpod's 10 MB
async limit; configure application-owned S3 output before broader testing.

Do not connect this endpoint to the public Video Editor until cold/warm latency,
cost, no-text quality, failure refunds and owned output storage pass staging.

# AI Studio rollout: Runpod image generation + OmniVoice

Date: 2026-07-21

## What is implemented

- `/ai-studio` is an internal-test workbench only. It is absent from public navigation
  and returns 404 for accounts outside `src/lib/internal-ai-access.ts`.
- The customer-facing product surface is Video Editor: Hero Voice, AI Image and
  AutoMix stay visible but disabled with `เร็ว ๆ นี้` until public launch.
- Editor generation currently accepts the voice and visual source before submit, then runs
  one preview job without a mid-pipeline pause: TTS → TTS-timed captions/windows → keywords →
  AI Image/AutoMix or stock visuals → config → base render → optional avatar composite.
  The finished preview then opens the post editor; export is a separate durable job that
  burns the edited overlays and saves the final video. Internal testers can replace, upload
  or regenerate individual scene visuals and batch-apply a free b-roll re-render.
- Image generation has two explicit AI Engines. RunPod AI contains Runpod Public Z-Image
  and custom ComfyUI models; Cloud API contains provider-hosted models such as GPT Image 2.
  They have separate model lists, prices and jobs and never act as fallbacks for each other.
- Every external image submission is stored in `AiGenerationAttempt` with the exact provider,
  model, route, endpoint, quote version, estimated COGS and provider job ID. One image job has
  one selected Engine and one attempt. Failure ends under that Engine's refund rules.
- Every image prompt is augmented on the server to prohibit text, letters, logos, labels, signage, and watermarks in any language.
- Image credits are atomically reserved before Runpod submission and refunded to the original granted/purchased buckets on submission, provider, timeout, or output-storage failure.
- OmniVoice no longer treats 500 characters as the whole-clip ceiling. The package duration is authoritative: Free 2 minutes, Pro 6 minutes, Business 10 minutes. Long scripts are split into worker-safe chunks and concatenated.
- AI Studio results are recorded in `AiGenerationJob`; completed images also enter the existing `GeneratedImage` gallery table.

## Required application environment

```dotenv
CREDITS_LIVE=1
AI_STUDIO_IMAGE_ENABLED=1
RUNPOD_API_KEY=...

RUNPOD_IMAGE_FLUX2_ENDPOINT_ID=...
RUNPOD_IMAGE_FLUX2_WORKFLOW_PATH=config/ai-workflows/flux2-klein-4b.json

# Z-Image Turbo uses Runpod's official public endpoint for the first staging proof.
# This is the fail-safe default even if a custom endpoint ID is present.
AI_STUDIO_Z_IMAGE_ROUTE=public

# To canary the custom Z-Image ComfyUI worker, explicitly switch the route and set
# both values. A non-default endpoint ID alone never changes customer traffic.
# AI_STUDIO_Z_IMAGE_ROUTE=custom
RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID=...
RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH=config/ai-workflows/z-image-turbo.json
AI_IMAGE_Z_IMAGE_TURBO_ESTIMATED_COST_USD_MICROS=50000

# Separate Cloud API Engine. Requests are pinned to GPT Image 2 1K.
# These values never change or back up a RunPod AI job.
MANAGED_KIE=1
KIE_API_KEY=...

# Optional planning overrides. Defaults shown here: ฿36/USD and 30% minimum margin.
AI_IMAGE_COST_USD_THB_RATE=36
AI_IMAGE_MIN_GROSS_MARGIN_BPS=3000

# Optional custom ComfyUI models. A model stays visible-but-disabled until both
# endpoint and workflow values exist.
RUNPOD_IMAGE_HIDREAM_ENDPOINT_ID=...
RUNPOD_IMAGE_HIDREAM_WORKFLOW_PATH=config/ai-workflows/hidream-o1.json

OMNIVOICE_ENABLED=1
OMNIVOICE_ALLOWED_USER_IDS=*
OMNIVOICE_URL=https://...
OMNIVOICE_API_KEY=...
OMNIVOICE_MAX_CHUNK_CHARS=450
OMNIVOICE_REQUEST_BUDGET_MS=540000
```

Runpod output storage should use the worker's S3-compatible output configuration. The application also accepts worker v5+ base64 output. Base64 is written to local `public/renders` during development. On the production VPS, either configure Runpod S3, `BLOB_READ_WRITE_TOKEN`, or explicitly set `AI_STUDIO_ALLOW_LOCAL_OUTPUTS=1` to use the existing local renders disk.

For the customer route, Z-Image Turbo uses Runpod's official Public Endpoint over
async `/run` + `/status`. Its temporary `image.runpod.ai` output is downloaded into
application-owned storage immediately instead of persisting the seven-day provider URL.
Run `npm run check:runpod-readiness` before spending provider credits. The command checks
both technical configuration and the model's COGS envelope without printing secrets.

The catalog and submit route resolve the same immutable offer. Credits are reserved only
after the provider request is fully prepared. Polling uses the provider endpoint recorded
on the attempt rather than re-reading routing flags, so an environment change cannot move
an in-flight job. The customer selects RunPod AI or Cloud API before selecting a model;
the API rejects a model that does not belong to the submitted Engine. A failed RunPod AI
job refunds and stops without offering or submitting a Cloud API model.

## ComfyUI workflow contract

Export each workflow using **Workflow → Export (API)**. Keep the JSON server-side at the configured path and replace the relevant scalar values with these exact tokens:

```text
{{PROMPT}}
{{NEGATIVE_PROMPT}}
{{WIDTH}}
{{HEIGHT}}
{{SEED}}
```

The application recursively replaces only those five tokens. Any unresolved `{{...}}` token blocks the request before credits are charged. Customers cannot upload workflow JSON, custom nodes, checkpoint paths, or executable code.

The workflow must finish with a normal ComfyUI image output node so `runpod/worker-comfyui` v5+ returns `output.images[]`. Pin the worker image version instead of deploying `latest`. The official worker repository is AGPL-3.0; review distribution obligations before publishing a modified worker image.

## Custom Runpod endpoint settings

- PoC: `workersMin = 0`, `workersMax = 1`
- Use one endpoint for the first winning model; do not load all checkpoints into one sparse worker.
- First bake-off: FLUX.2 Klein 4B vs Z-Image-Turbo. Add HiDream only if reference/detail quality justifies a separate endpoint.
- Configure flash boot and cached/container-baked model weights where possible.
- Use queue-based `/run`; the browser polls the durable HERO AI job, never Runpod directly.

## Deployment

The production deployment already runs `prisma db push`; this adds `AiGenerationJob`,
`AiGenerationAttempt` and their indexes before restart. Do not enable image traffic against
an application instance until the schema push has succeeded.

```bash
npm run verify:ai-studio
npm run verify:omnivoice
npx tsc --noEmit
npm run build
```

Do not enable `AI_STUDIO_IMAGE_ENABLED=1` until at least one provider route,
output-storage path, model license and moderation policy have been validated in staging.
A server-owned exported workflow is additionally required for every custom ComfyUI route.

Current local readiness on 2026-07-21 is RunPod AI 1/3 and Cloud API 0/1. Public Z-Image
passes at USD 0.005 estimated COGS. Cloud GPT Image 2 passes its independent 3-credit cost
guard but remains unavailable because the local Kie management flag/server key are absent.
The custom worker's conservative USD 0.050 estimate exceeds the 2-credit COGS budget and
therefore remains blocked even when technically configured.

Do not deploy, create a paid Runpod endpoint, or change production flags without a
fresh explicit approval. Local/internal-beta access does not authorize production rollout.

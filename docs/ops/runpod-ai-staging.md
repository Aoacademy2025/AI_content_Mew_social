# Runpod AI image staging

This runbook validates one real image provider without changing the public Video Editor
or production feature flags. The first staging model was Runpod's official Z-Image Turbo
Public Endpoint. Following the 2026-07-29 nested WaveSpeed credential incident, Hero
Video is pinned to the isolated custom Serverless endpoint; the public endpoint is no
longer an eligible Hero Video route.

## Safety boundary

- Internal AI tester accounts only.
- Keep `workersMin=0` for any later custom endpoint.
- Do not commit `RUNPOD_API_KEY`.
- Do not copy staging flags into `deploy/.env.production` during this validation.
- Z-Image temporary output URLs must be downloaded to owned storage immediately.

## Local environment

Set these values in the local process or untracked `.env`:

```dotenv
RUNPOD_API_KEY=...
CREDITS_LIVE=1
AI_STUDIO_IMAGE_ENABLED=1
```

`RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID` is optional and defaults to `z-image-turbo`.
Local development stores downloaded images in `public/renders`. Staging or production
must provide `BLOB_READ_WRITE_TOKEN` or an explicitly approved durable storage path.

## Readiness gate

```bash
npm run check:runpod-readiness
npm run verify:ai-studio
npx tsc --noEmit
```

The readiness command never prints secret values. Continue only when
`offer z-image-turbo` reports `PASS`. A provider may be technically configured
but still report `BLOCK` when its estimated COGS exceeds the quoted credit budget.

## Smoke acceptance

Use one internal account and one English 9:16 prompt first. Record:

- HERO AI job ID and Runpod provider job ID.
- Queue delay and execution time.
- Provider-reported cost.
- Final stored URL belongs to application-owned storage, not `image.runpod.ai`.
- Credit reservation settles once on success.
- A controlled provider submission failure refunds the exact reservation once.

The official Z-Image endpoint accepts async `/run` and `/status`, keeps its safety checker
enabled, and currently documents a cost of USD 0.005 per generated image. Provider output
URLs expire after seven days, which is why application storage is part of acceptance.

## After the smoke test

The approved customer policy is:

- RunPod AI and Cloud API are separate AI Engines selected before the model.
- Runpod Public Z-Image Turbo remains a separate 2-credit contract, but is quarantined
  unless `AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED=1`; Hero Video rejects it regardless.
- Hero Video uses the isolated custom Z-Image worker at 3 credits/image. It requires
  `AI_STUDIO_Z_IMAGE_ROUTE=custom`, the explicit endpoint/workflow settings, a passing
  cost guard, and a successful live smoke before traffic is enabled.
- GPT Image 2 1K is a 3-credit model inside the separate Cloud API Engine, not a
  RunPod backup.
- One HERO AI image job has one selected Engine and exactly one external provider
  attempt. Failure ends and refunds that job; the system never crosses Engines.

## Smoke result — 2026-07-21

The first real Z-Image Turbo async job completed successfully:

- Queue delay: 137 ms
- Execution time: 9,950 ms
- Provider-reported cost: USD 0.005
- Output: PNG, 720×1280, 855,284 bytes
- Storage: downloaded from the temporary provider URL into local `public/renders`
- Custom Runpod endpoints at test time: 0

Live traffic returned the temporary URL as `output.result`, although the current model
documentation shows `output.image_url`. The application now accepts both shapes and
normalizes them before storage.

Visual review: the portrait composition and subject were usable, but a small menu/card in
the scene contained illegible generated writing despite the artwork-only prompt. This run
therefore validates account/API/queue/storage integration, not the production no-text
quality bar or the custom ComfyUI worker.

## Custom worker preparation — 2026-07-21

Two separate private queue-worker images are now published and their scale-to-zero
staging endpoints are provisioned. No production route is enabled.

- OmniVoice: `services/omnivoice-runpod` pins the audited source/model revisions and
  serves the three existing stock voices. The Linux AMD64 image runs as UID 10001 and
  passed model, voice, import and contract checksum checks. The verified private image is
  `ghcr.io/mewic/heroai-omnivoice:staging-20260721-346bb75-c5fdb5c` with registry digest
  `sha256:decd00cc9ade9bc34b09eec3a6036e80b416f3f2c3a9530d4cfeca7e0ab7b1e2`.
- AI image: `services/comfyui-z-image-runpod` pins Runpod worker-comfyui 5.8.6 and the
  official Z-Image Turbo BF16 model bundle. Its three model files total
  20,690,152,836 bytes. `config/ai-workflows/z-image-turbo.json` mirrors the official
  eight-step ComfyUI workflow and contains only the five server-owned scalar tokens. The
  verified private image is
  `ghcr.io/mewic/heroai-z-image-turbo:staging-20260721-bf16-d24c4cf` with registry digest
  `sha256:79b55eb182e41a255d71d6dd2602d6e4aa5b259b5e94d76dec7705b46ee05618`.
- `scripts/provision-runpod-staging.ts` produces an idempotent plan by default and only
  creates resources with `--apply`. Both endpoint specs use Flex workers,
  `workersMin=0`, `workersMax=1`, FlashBoot and a five-second idle timeout.

The remaining deployment dependency is a read-only credential for Runpod to pull the two
private packages. Publishing used the local GitHub CLI authorization; do not store that
write-capable credential in Runpod. Create a classic GitHub package token with only
`read:packages`:

```dotenv
GHCR_USERNAME=mewic
GHCR_PULL_TOKEN=... # read:packages only, stored in Runpod registry auth
```

Do not paste either token into chat or commit it. After both immutable image tags are
pushed, set `RUNPOD_OMNIVOICE_IMAGE`, `RUNPOD_Z_IMAGE_IMAGE` and the resulting
`RUNPOD_CONTAINER_REGISTRY_AUTH_ID`, inspect the dry-run plan, then use:

```bash
npm run provision:runpod-staging -- --apply
```

The Z-Image BF16 endpoint intentionally starts on the 48 GB A40/A6000 class for a stable
quality baseline. Current Runpod Serverless pricing lists that class around USD 1.22/hour,
billed per second while starting/running; the worker still scales to zero. Quantized and
24 GB variants come only after the BF16 result is recorded.

The verified private Z-Image image contains 30 registry layers totaling 28,168,330,207
compressed bytes. Its staging template therefore reserves 70 GB of container disk for
layer extraction and ComfyUI runtime files rather than relying on the earlier 50 GB estimate.

Provisioned staging resources (2026-07-21):

- OmniVoice template `u7pyxacp1a`, endpoint `xbn9a1ynd6byeu`.
- Z-Image template `cdi0oruo2b`, endpoint `0c6eadcsuhuhor`.
- Both use registry auth `cmrusznvj000q25gsb3hdtjmk`, `workersMin=0`, `workersMax=1`,
  and FlashBoot.
- Z-Image accepts the 48 GB GPU fallback order `NVIDIA A40`, `NVIDIA RTX A6000`, then
  `NVIDIA L40S` to cover both cost-effective Ampere pools before the faster fallback.
- OmniVoice smoke passed with delay 17,584 ms, execution 759 ms, and a valid 24 kHz
  mono PCM WAV (138,284 bytes).
- Z-Image smoke job `b1cfa851-37c7-4681-ae4b-625e11924bd2-e1` completed. It spent about
  54m56s waiting for the scarce 48 GB pool, then executed in about 11.1s. The billing
  audit window contained two custom-worker records totaling USD 0.0469449223 across
  138,526 billed milliseconds. Treat that as a canary-window observation, not a stable
  per-image price.

## Customer route and cost guard — 2026-07-21

The application now resolves one immutable `quote → reserve → provider attempt → settle`
plan before charging credits. The catalog uses the same resolver as submission, so a model
cannot display one price and run a different provider route.

Default planning assumptions are one credit = THB 1, USD/THB = 36 and minimum gross margin
30%. These produce the following guardrail:

| Offer | Customer price | Provider estimate | Maximum COGS | State |
| --- | ---: | ---: | ---: | --- |
| Runpod Public Z-Image | 2 credits | USD 0.005 | USD 0.038888 | enabled |
| Custom Z-Image / Hero Video | 3 credits | USD 0.050 conservative | USD 0.058333 | cost-safe; live smoke required |
| Cloud API · GPT Image 2 1K | 3 credits | USD 0.030 | USD 0.058333 | cost-safe, configuration required |

The public Z price comes from Runpod's
[Public Endpoint model reference](https://docs.runpod.io/public-endpoints/reference).
Kie requests are pinned to `resolution: 1K`; their
[GPT Image 2 contract](https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image)
supports all four product aspect ratios. Provider result URLs are copied immediately into
owned storage.

Readiness output is configuration-only and says so explicitly. A passing configuration
check must never be treated as proof that the provider can generate. Before switching
Hero traffic, run `smoke:runpod-custom-staging -- z-image`, record the terminal provider
job and cost, and only then change the production route.

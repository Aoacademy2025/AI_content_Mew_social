# Image-generation alternatives to Z-Image Turbo

Date: 2026-08-18 (Asia/Bangkok)

Scope: primary sources only. No paid generation was run. Prices are public list
prices before tax, currency conversion, retries, moderation failures, storage,
network egress, or idle/cold-start cost.

## Executive conclusion

The 1/18 strict pass result (17/18 strict failures) from the focused V11 probe is
mostly a mismatch between a
strict deterministic acceptance gate and what a stochastic text-to-image model
can reliably promise. It is not evidence that the 17 images are broadly unusable.
Every strict failure was triggered by an exact count, contact point, ownership,
direction, or action detail; several frames still communicated the intended
scene. The public research literature likewise identifies spatial relations and
attribute binding as persistent text-to-image weaknesses, even as general image
quality improves ([GenEval paper](https://arxiv.org/abs/2310.11513)).

This is also not exclusively a Z-Image defect. The Z-Image authors report strong
fine-grained alignment overall, and their official model card describes Turbo as
an eight-step distilled model with high visual quality but low diversity
([technical report](https://arxiv.org/abs/2511.22699),
[model card](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)). A model change can
raise the probability of correct composition, but no official source promises
deterministic counts or relational binding.

Recommended split:

1. Keep Z-Image as the inexpensive default, but change the product gate from
   “every Hard Scene Fact must be literal” to “the intended story is legible and
   there is no material anatomy, safety, identity, or brand defect.” Preserve
   strictness only where the detail changes the meaning.
2. Test **P-Image T2I** as the first operational challenger. RunPod exposes it
   at the same flat **$0.005/image** as Z, including custom portrait dimensions,
   so it can use the project's existing RunPod account and submit/poll pattern.
   Its quality claims are first-party marketing rather than a published
   compositional benchmark, so it needs a direct local A/B.
3. Test `Qwen/Qwen-Image` as the benchmark-led low-cost challenger. At the
   project's 768 × 1344 portrait size, its published Together price is about
   **$0.00599/image**, essentially the same cost band. Official benchmark
   evidence makes it the most relevant cheap candidate for counts and relations,
   but it requires a new provider adapter and the evidence is not a guarantee.
4. For user-provided reference images, start with **P-Image Edit** on RunPod. It
   accepts one to five image URLs and costs **$0.01/output**, only 2× Z. Keep
   **FLUX.2 [klein] 4B** as the stronger-documented fallback: up to four
   references from roughly **$0.015–$0.016** with one small reference.
5. Keep **HiDream-O1-Image** as the higher-control self-hosted candidate for
   subject identity/IP consistency. Its official implementation supports
   multi-reference personalization, layout boxes, and skeleton conditioning,
   and its self-reported compositional benchmarks are strong. There is no
   official per-image hosted price to compare, so it should not be promoted
   until real RunPod billing is measured.

## What the local evidence actually says

The project has two different acceptance questions:

- **Strict relational gate:** did the image contain exactly the requested count
  and exact source-to-target relationship?
- **Creator usefulness:** does the frame communicate the intended beat and look
  good enough in a video where it is visible briefly?

The current review answered only the first. Examples include two bags instead of
one shared bag, a serum drop suspended just above a fingertip, extra empty chairs
in an otherwise empty evidence room, or boats moving laterally rather than
toward the horizon. Those are valid strict failures, but they are not all equal
product failures. The additional disembodied hand in the horror frame is a real
quality defect; an extra lamp in a coherent empty room is likely not, if Mew's
desired threshold is overall usefulness.

There is still a generation-strategy component. Simple Editorial Story produced
the one shared bag correctly, and Cinematic Horror established the intended
door/lamp relation before inventing an extra hand. This shows the relationships
are possible, but not reliable enough to treat a single stochastic sample as a
database constraint.

The repo's verified cost baseline is:

- RunPod public Z-Image: **$0.005/image**, approximately **฿0.18** at the
  project's current default 35 THB/USD working rate
  ([local production cost research](./2026-08-07-hero-ai-image-prod-stats.md),
  [local quality gate](../quality-gates/2026-08-09-brand-visual-system.md)).
- The focused benchmark generated at 720 × 1280; normal project 9:16 output is
  768 × 1344 (`src/lib/ai-image-policy.ts`).

## Low-cost text-to-image candidates

Together defines one megapixel as `width × height / 1,000,000` for its listed
per-MP pricing. The 768 × 1344 project portrait is therefore 1.032192 MP.
Published model availability and prices come from Together's current
[serverless catalog](https://docs.together.ai/docs/serverless/models) and
[pricing page](https://www.together.ai/pricing).

| Candidate | Mode exposed by cited API | Official list price | Approx. 768 × 1344 output | Reference image on that endpoint | Evidence and caveat | License / commercial note |
| --- | --- | ---: | ---: | --- | --- | --- |
| Current Z-Image Turbo | Text-to-image locally; provider also offers single-image img2img | $0.005/image measured locally | $0.005 | The official endpoint accepts one input image plus `strength`, but the project does not expose it; this is not documented as multi-reference identity locking | Strong inexpensive photorealism; local strict relational pass was 1/18 | Official weights are Apache 2.0; current use is through RunPod |
| **P-Image T2I** (`p-image`) | Text-to-image | **$0.005/image** | **$0.005** (about ฿0.18) | No; use the separate Edit endpoint | RunPod and Pruna describe automatic prompt enhancement, sub-second generation, prompt adherence, diversity, and text rendering, but publish no standardized count/relation score. Best operationally cheap challenger, not a proven winner | Proprietary hosted model; the model page does not state an open-weights license or special commercial-output grant, so RunPod/Pruna service terms must be accepted and checked before production |
| **Qwen Image** (`Qwen/Qwen-Image`) | Text-to-image | **$0.0058/MP** | **$0.00599** (about ฿0.21) | No verified reference parameter for this Together model | Qwen's paper reports strong generation/editing benchmarks; HiDream's published comparison scores Qwen above Z on count and relation. Hosted revision still needs verification | Qwen-Image is Apache 2.0; Together says the customer owns input/output subject to third-party model terms |
| HiDream-I1-Full | Text-to-image | $0.009/MP | $0.00929 (about ฿0.33) | Not verified in Together's reference-image compatibility docs | Official I1 results report GenEval 0.83 overall/0.79 counting and DPG relation 93.74. This is an interesting quality canary, not an exactness guarantee | Model/code MIT; self-hosting also loads Meta Llama 3.1 and therefore requires accepting that separate license |
| FLUX.1 Schnell | Text-to-image | $0.0027/MP at default 4 steps | $0.00279 (about ฿0.10) | No in Together's compatibility table | Useful cheapest control. There is no official evidence found that it should beat Z on the project's relational failures | Apache 2.0 weights |

Sources for model-specific claims:

- [RunPod's Z-Image Turbo endpoint documentation](https://docs.runpod.io/public-endpoints/models/z-image-turbo)
  lists the flat $0.005 output price and optional single `image` input with a
  `strength` control. The current project request contract sends text only.
- [RunPod's current public-endpoint catalog](https://docs.runpod.io/public-endpoints/reference)
  lists P-Image T2I at $0.005/output and P-Image Edit at $0.01/output.
  [Pruna's P-Image documentation](https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-image.html)
  documents custom dimensions from 256–1440 in multiples of 16, including the
  project's 720 × 1280 and 768 × 1344 sizes. Its prompt-adherence and quality
  statements are vendor claims, not independent eval results.
- [Qwen-Image technical report](https://arxiv.org/abs/2508.02324) and
  [official repository/model history](https://github.com/QwenLM/Qwen-Image).
  The newer `Qwen-Image-2512` and `Qwen-Image-2.0` claims must not be silently
  attributed to Together's cheaper `Qwen/Qwen-Image` endpoint; they are distinct
  model identifiers.
- [HiDream-I1 official repository, benchmarks, and MIT license](https://github.com/HiDream-ai/HiDream-I1).
- [Together image parameter and compatibility documentation](https://docs.together.ai/docs/inference/images/parameters).
- [Together terms](https://www.together.ai/terms-of-service) state that, as
  between customer and Together, the customer owns content/output, but
  third-party model terms still govern. Together also documents optional Zero
  Data Retention and says inputs/outputs are not stored by default
  ([privacy documentation](https://docs.together.ai/docs/privacy-and-security)).

### Relevant official benchmark signals

The following numbers are from the **HiDream-O1 authors' own evaluation**, not
an independent HERO AI test. They are useful for candidate selection, but may
carry author/evaluator bias. They do at least target the same failure classes as
the local probe
([official HiDream-O1 repository](https://github.com/HiDream-ai/HiDream-O1-Image)).

| Model | GenEval overall | Count | Position | Attribute binding | DPG overall | DPG relation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Z-Image Turbo | 0.82 | 0.77 | 0.65 | 0.68 | 84.86 | 92.16 |
| Qwen Image | 0.87 | **0.89** | 0.76 | 0.77 | 88.32 | **94.31** |
| HiDream-O1-Image | **0.90** | 0.79 | **0.93** | **0.78** | **89.83** | 92.88 |

This supports two bounded hypotheses for a paid A/B:

- Qwen Image may improve the duplicate-object and count failures at nearly the
  same API cost.
- HiDream-O1 may improve placement and dense-prompt adherence, but its serving
  cost is not yet known.

It does **not** support saying either model will perfectly render “exactly one
shared bag held by two women” or “one drop visibly touching one fingertip.”

## Models that accept the user's own reference image

### 1. P-Image Edit — recommended first API probe

RunPod's public `p-image-edit` endpoint costs **$0.01 per completed output** and
accepts an `images` array containing one to five image URLs, plus a text edit
instruction and `9:16` or `match_input_image` output ratio. RunPod describes it
for complex compositions, style transfer, and targeted edits
([official endpoint reference](https://docs.runpod.io/public-endpoints/models/p-image-edit)).
The response includes the exact provider-reported cost. Output URLs expire after
seven days, so the app must download and persist the result immediately.

This is the smallest integration jump because the app already has RunPod auth,
job IDs, polling, and provider-cost handling. It is still a separate request
contract and must not be routed through the scalar-only Z endpoint. No official
standardized identity-preservation or relational benchmark was found, and the
endpoint page does not state special commercial licensing terms. Treat it as a
candidate to measure, not a guaranteed identity lock; confirm the governing
RunPod/Pruna terms before exposing it commercially.

### 2. FLUX.2 [klein] 4B — reference fallback with clearer model licensing

The direct Black Forest Labs API exposes `POST /v1/flux-2-klein-4b` and supports
text-to-image, prompt editing, and up to four reference images. It accepts
64 × 64 through 4 MP dimensions in multiples of 16
([Klein API guide](https://help.bfl.ai/articles/7592221790-how-do-i-generate-quickly-with-flux-2-klein),
[FLUX.2 overview](https://docs.bfl.ai/flux_2/flux2_overview)). The project sizes
720 × 1280 and 768 × 1344 are both multiples of 16.

Pricing is **$0.014 for the first output MP**, then $0.001 for each additional
output MP; reference inputs add $0.001/MP
([official pricing](https://bfl.ai/pricing?category=flux.2)). For one roughly
1 MP input reference and the project's portrait output, budget
**$0.015–$0.016/image**. The range is intentional: BFL's current pricing pages
are internally inconsistent about whether `1 MP` is 1,000,000 pixels or
1024 × 1024 before rounding, and 768 × 1344 falls on opposite sides of that
boundary. The dashboard calculator should be treated as authoritative before a
paid run.

The 4B weights are Apache 2.0 and BFL states its API includes commercial rights
without a separate model license
([model/license overview](https://help.bfl.ai/articles/7655484417-what-flux-models-are-available),
[commercial API guidance](https://help.bfl.ai/articles/9272590838-self-serve-dev-license-overview-pricing)).

Privacy caveat: BFL's API terms grant BFL a license to use inputs and outputs to
operate, improve, and train its services
([FLUX API terms](https://bfl.ai/legal/flux-api-service-terms)). Do not send
confidential unreleased brand assets or real-person reference photos without a
deliberate data-policy decision and the necessary rights/consents. Self-hosting
the Apache-licensed 4B model avoids that specific API data path.

### 3. HiDream-O1-Image — recommended self-hosted high-control candidate

The official 8B model supports:

- single-reference instruction editing;
- multi-reference subject-driven personalization (the official example passes
  ten subject images);
- optional skeleton and layout-box conditioning; and
- native output up to 2048 × 2048.

The code and model are MIT licensed
([official repository and examples](https://github.com/HiDream-ai/HiDream-O1-Image)).
This makes it especially relevant for preserving a person, mascot, product, or
recurring visual subject across scenes. The same official source reports higher
overall GenEval and DPG scores than Z-Image, but this is self-evaluation and does
not establish product-level reliability.

There is no official public per-image hosted API price in the sources reviewed.
The repo already contains a `hidream-o1` model definition with a conservative
$0.08 estimate pending real custom-worker billing; that is a local guard value,
not a verified provider price. Treat COGS, cold start, and throughput as unknown
until a small approved RunPod measurement exists.

### 4. Qwen-Image-Edit-2511 — open-weight reference alternative, price unknown

Qwen's official repository supports multiple input images and documents improved
consistency for `Qwen-Image-Edit-2511`; the project is Apache 2.0
([official repository](https://github.com/QwenLM/Qwen-Image)). This is a viable
self-hosted research candidate if Qwen Image wins the text-to-image A/B. It is
not the same endpoint as Together's $0.0058/MP `Qwen/Qwen-Image`, and no official
low-cost hosted price for the Edit-2511 endpoint was verified. Do not attach the
$0.0058 price to its reference-image mode.

### Models not recommended for this decision

- `gpt-image-1-mini` appears to match Z at $0.005 for low-quality 1024-square
  output and accepts image inputs, but OpenAI's current catalog marks it
  deprecated. It should not be a new production dependency
  ([official model/pricing page](https://developers.openai.com/api/docs/models/gpt-image-1-mini),
  [current model catalog](https://developers.openai.com/api/docs/models/all)).
- FLUX.2 [dev] is listed by Together at $0.0154/image and accepts reference
  images, but the published open-weight license is non-commercial and Together's
  terms say third-party model terms govern. The direct BFL API does not offer a
  hosted [dev] endpoint. Use direct BFL Klein 4B or obtain written licensing
  confirmation instead
  ([Together reference-image support](https://docs.together.ai/docs/inference/images/reference-images),
  [BFL FLUX dev license](https://github.com/black-forest-labs/flux2/blob/main/model_licenses/LICENSE-FLUX-DEV)).

## Fit with the current provider architecture

The product already allowlists `flux2-klein-4b` and `hidream-o1`, but only as
RunPod custom Comfy workflows. That is useful scaffolding, not finished
reference-image support:

- `src/lib/ai-image-policy.ts` contains both model IDs and conservative cost
  placeholders.
- `src/lib/runpod-serverless.ts` currently substitutes only prompt, negative
  prompt, width, height, and seed into a server-owned workflow.
- There is no reference-image upload, hash, URL/object key, workflow token, or
  provider request field in the current generation contract.
- Together and direct BFL would each require a new provider adapter; self-hosted
  Klein/O1 would require a reference-aware, server-owned workflow and safe media
  lifecycle.

Therefore no current model switch in the UI can truthfully claim “use my image
as reference” without product/code work. This research makes no such change.

## Proposed acceptance policy and smallest useful experiment

### Pragmatic visual gate

Fail the frame when any of these is true:

- the intended subject/action/story is no longer understandable;
- anatomy is visibly broken or an extra person/body part is distracting;
- a medical, legal, crime, identity, or product claim changes materially;
- a protected person's identity, logo, or product must be exact and is not;
- the frame is a collage/multi-panel when one scene is required; or
- visible gibberish, watermarking, or unusable composition harms the final video.

Allow with a warning when the frame remains coherent and only a non-material
background count, prop quantity, hand position, or movement direction differs.
This matches Mew's stated “ภาพรวมโอเค” threshold better than the present
database-like gate.

### Paid A/B to request separately (not authorized or run here)

Use four of the hardest prompts: shared bag, serum drop/fingertip, empty evidence
room, and door/lamp. Generate one sample per prompt with:

1. Z-Image Turbo (control);
2. P-Image T2I on RunPod; and
3. Qwen Image on Together.

At list price, 12 portrait images would cost approximately:

- Z: 4 × $0.005 = $0.020;
- P-Image: 4 × $0.005 = $0.020;
- Qwen: 4 × $0.00599 = $0.024;
- total: **about $0.064 (about ฿2.24)** before retries/tax at the project's
  current default 35 THB/USD rate.

Separately, test three owned reference assets with P-Image Edit: a person or
mascot, a product, and a style board. Budget **$0.03 total**. If it fails
identity/product recognition, repeat those same three once with FLUX.2 Klein 4B
for **$0.045–$0.048**. Score identity/product recognition, intended scene,
artifact rate, and overall usefulness—not pixel-perfect reconstruction.

Do not run the 120-image matrix to answer this model-selection question. A small
cross-model probe directly measures whether a model change improves Mew's real
acceptance threshold before the provider architecture or cost policy changes.

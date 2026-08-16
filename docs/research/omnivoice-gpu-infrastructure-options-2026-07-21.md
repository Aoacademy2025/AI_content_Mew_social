# OmniVoice GPU infrastructure options

Date checked: 2026-07-21 (Asia/Bangkok)

## Decision

Do not migrate the full application merely to obtain GPU inference. Keep the frontend, API, database, and non-voice rendering on the existing application host, and extract only OmniVoice into an asynchronous GPU worker behind a provider-neutral adapter.

Recommended sequence:

1. Use **Google Cloud Run GPU in Singapore** as the production-oriented PoC. It has an explicit nearby GPU region, NVIDIA L4 24 GB, custom containers, scale-to-zero, and regional storage of Cloud Run customer data.
2. Run the same image on **Runpod Serverless** as the low-cost benchmark. It has per-second Flex workers and a built-in job queue, but the published Serverless region list currently has Japan and Australia rather than Thailand or Singapore.
3. Keep **AWS Malaysia G6 plus AWS Batch or SageMaker Async** as the enterprise/consolidation option if AWS contracts, IAM/VPC integration, or support are worth the additional implementation complexity. AWS Thailand currently has no accelerated-computing family.

Do not begin with A100/H100 or a 24/7 GPU VM. Start with one 16-24 GB inference GPU and move up only if measured peak VRAM or throughput requires it.

## Why GPU is technically plausible

This recommendation assumes the worker uses, or is compatible with, the official `k2-fsa/OmniVoice` implementation. The official project documents CUDA inference with `float16`, long-form generation that automatically chunks text with near-constant VRAM, and batch inference across multiple GPUs. It also states that more diffusion steps improve quality but slow generation. The exact production worker, model revision, CUDA/PyTorch versions, model license, and peak VRAM must be confirmed before purchasing capacity.

Sources: [OmniVoice project and CUDA example](https://github.com/k2-fsa/OmniVoice), [generation parameters and long-form chunking](https://github.com/k2-fsa/OmniVoice/blob/master/docs/generation-parameters.md).

## Provider comparison

| Provider | Useful starting hardware | Scale-to-zero and billing | Location/data concern | Assessment |
|---|---|---|---|---|
| Google Cloud Run GPU | NVIDIA L4 24 GB; minimum 4 vCPU/16 GiB | Yes. Platform GPU instance starts in about 5 seconds before application/model loading. GPU workers may be retained idle for up to 10 minutes. | L4 is explicitly available in Singapore; Cloud Run customer data associated with the resource is stored in the selected region. | Best production-oriented PoC for Thai users. |
| Runpod Serverless | A4000 16 GB or L4/A5000 class 24 GB | Flex workers scale to zero, bill per second from start through execution and idle timeout, and have a built-in queue. Default idle timeout is 5 seconds. | Published Serverless region IDs currently include Japan and Australia, not Thailand/Singapore. Use Secure Cloud and confirm the actual assigned region and contract before production voice data. | Best cheap performance/cost benchmark. |
| AWS EC2 G6 / Batch / SageMaker Async | G6 NVIDIA L4 24 GB in Malaysia | Plain EC2 is billed while running. Batch can scale a managed queue to zero; SageMaker Async can queue long jobs and scale endpoints to zero. | AWS Thailand currently lists no accelerated-computing families; Malaysia lists G6/Gr6. | Good if AWS governance/support is strategic; more complex and not the fastest PoC. |
| Modal | T4/L4/A10 | Per-second and scale-to-zero | Region pinning adds 1.5x for broad or 1.75x for narrow regions. Inputs route through Virginia by default; payloads above 2 MiB use US-East object storage even with alternate routing. | Excellent developer experience, weaker locality/economics for this workload. |
| Hugging Face Inference Endpoints | T4/L4 | Billed by minute while initializing/running; can scale to zero | During cold start the endpoint returns HTTP 502 and has no built-in queue. Region/GPU combinations must be checked in the dashboard. | Convenient model hosting, but its cold-start behavior requires a queue/retry layer. |
| Replicate private deployment | T4 or L40S | Private models generally bill setup, idle, and active time | Less control over regional placement; expensive for a private always-warm model. | Useful for a very quick API demo, not the first production choice. |

Primary sources: [Cloud Run GPU support](https://docs.cloud.google.com/run/docs/configuring/services/gpu), [Cloud Run regions and data location](https://docs.cloud.google.com/run/docs/locations), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Run autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling), [Runpod Serverless pricing](https://docs.runpod.io/serverless/pricing), [Runpod worker lifecycle](https://docs.runpod.io/serverless/workers/overview), [Runpod endpoint regions](https://docs.runpod.io/api-reference/endpoints/POST/endpoints), [Runpod security](https://docs.runpod.io/references/security-and-compliance), [AWS EC2 regional availability](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-regions.html), [AWS G6](https://aws.amazon.com/ec2/instance-types/g6/), [SageMaker Async](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference.html), [SageMaker scale-to-zero](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference-autoscale.html), [Modal pricing](https://modal.com/pricing), [Modal regions](https://modal.com/docs/guide/region-selection), [Hugging Face pricing](https://huggingface.co/docs/inference-endpoints/pricing), [Hugging Face autoscaling](https://huggingface.co/docs/inference-endpoints/autoscaling), [Replicate pricing](https://replicate.com/pricing).

## Comparable headline cost

USD values exclude network, storage, tax, and support. THB illustrations use 33 THB/USD and are not exchange-rate quotes.

- **Cloud Run L4 Singapore, minimum 4 vCPU/16 GiB:** GPU `$0.0001867/s` + CPU `$0.000072/s` + memory `$0.000032/s` = about **$1.0465/hour** or **฿34.5 per active hour**. Ten billable minutes are about **$0.174/฿5.76**.
- **Runpod Flex L4/A5000/3090 category:** the current pricing document lists **$0.00019/s = $0.684/hour**, or about **฿22.6 per active hour**. Ten billable minutes are about **$0.114/฿3.76**. Runpod's June 2026 pricing update separately lists A4000 at `$0.00020/s` and A5000 at `$0.00026/s`; confirm the chosen SKU's console rate before the PoC.
- **AWS Malaysia `g6.xlarge`:** one L4, 4 vCPU/16 GiB, currently **$1.0138/hour** in the official Malaysia EC2 price file, about **$740/฿24,400 per 730-hour month** if left on continuously. Batch/SageMaker pricing and startup behavior are separate and must be estimated from the final design.
- **Hugging Face L4:** official list price is **$0.70/hour on GCP or $0.80/hour on AWS**, billed by the minute while initializing/running.
- **Modal L4:** GPU alone is **$0.7992/hour**, before CPU/RAM and the region multiplier.

The true cost of a three-minute clip cannot be calculated from the hourly GPU rate alone:

`clip cost = (cold start + model load + inference + idle grace) × total rate + storage/network`

For example, if the entire billable session were 60 seconds, Cloud Run's minimum L4 configuration would cost about `$0.0174` (฿0.58) and Runpod's listed L4 category about `$0.0114` (฿0.38). These are arithmetic examples, not OmniVoice benchmarks.

## PoC design

Use a provider-neutral asynchronous flow:

`Frontend/API on current host -> create voice job -> queue -> GPU worker -> private object storage -> callback/status -> signed result URL`

The user should not hold one synchronous HTTP connection open for a 6- or 10-minute package. A GPU worker can start only when a queued job arrives and scale to zero when idle, but cold start and model loading are part of latency and usually part of billing.

Benchmark the same immutable container and model commit on Cloud Run L4 and Runpod A4000/L4 with:

- Thai scripts targeting 30 seconds, 2 minutes, 6 minutes, and 10 minutes of output;
- cold and warm runs;
- concurrency 1, 2, and 4;
- the current `num_step` plus any higher setting that passes the required voice-quality bar;
- peak VRAM, startup/model-load time, inference time, real-time factor, p50/p95 latency, failure rate, output duration, Thai pronunciation/prosody, voice consistency across chunks, and total billed cost per generated audio minute.

Run at least three repetitions per case and do not remove the current character guard until long-form chunking, timeout handling, retries, and package quotas pass the test. Use synthetic or consented voices for vendor comparison; disable prompt/audio logging, encrypt object storage, use short-lived signed URLs, and set automatic deletion/lifecycle rules.

## Go/no-go gate

Proceed to a limited canary only when:

- the exact worker is confirmed CUDA-compatible;
- a 10-minute target can complete reliably through the async path;
- GPU produces a material improvement over the current CPU real-time factor at acceptable Thai quality;
- cost per generated minute still fits Free/Pro/Business unit economics including cold starts;
- the chosen region, DPA/subprocessors, retention, encryption, and voice-consent controls are accepted; and
- switching the provider adapter back to the current worker remains possible.


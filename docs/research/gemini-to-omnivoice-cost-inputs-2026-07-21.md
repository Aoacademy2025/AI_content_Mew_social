# Gemini TTS → OmniVoice GPU: verified cost inputs

Date: 2026-07-21 (Asia/Bangkok)

## Executive findings

- The application uses `gemini-2.5-flash-preview-tts` first, with `gemini-3.1-flash-tts-preview` and `gemini-2.5-pro-preview-tts` as fallbacks ([route source](../../src/app/api/videos/tts-gemini/route.ts)). These are synchronous `generateContent` requests, not Batch requests.
- Google's current Gemini-TTS price for 2.5 Flash is **$0.50/M text-input tokens + $10/M audio-output tokens**. Google currently states that Gemini-TTS audio uses **25 tokens/second**, making the audio-output component **$0.015 per generated audio minute**. The two $20/M output fallbacks cost **$0.030/audio minute**. Source: [Google Cloud Text-to-Speech pricing](https://cloud.google.com/text-to-speech/pricing) and [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing).
- The strongest direct usage proxy stored in production is **821.94 managed AI-audio minutes across 113 users' current rolling usage windows**. This includes Gemini TTS plus any managed transcription, so it is not a strict calendar-month TTS total. A separate calendar 30-day query found **817 charged render minutes** across 1,215 charged clips; that is all voice providers and rounded render billing, not exact Gemini output duration.
- At 821.94 minutes, pricing every minute as primary Gemini 2.5 Flash output gives an upper proxy of **$12.33 / ฿431.52**, before the small text-input component. The application's internal all-in rate is **฿0.70 per managed minute**, or **฿575.36** for 821.94 minutes; this rate intentionally includes more than TTS output ([cost-rate source](../../src/lib/cost-rates.ts)).
- OmniVoice GPU cost is not a fixed cost per audio minute. It is `audio minutes × effective RTF × GPU hourly rate / 60`, where effective RTF must include render time, model startup, idle timeout, retries, and discarded work. A benchmark is required before treating any one monthly figure as a forecast.

## Production snapshot (read-only)

Production SQLite was queried read-only at approximately 2026-07-21 12:35 Asia/Bangkok. No user-identifying fields were selected.

| Signal | Observed value | Interpretation |
|---|---:|---|
| `SUM(User.aiAudioMinutesUsed)` | 821.94 min | Exact counter values in users' individual rolling windows; Gemini TTS + managed transcription |
| Users with non-zero AI audio | 113 | Users contributing to the 821.94-minute counter |
| `ChargedClip`, last 30 days | 1,215 clips / 817 min | Calendar-window render billing; all TTS providers, rounded minutes |
| Gemini `VideoJob`, last 30 days | 338 total; 253 done, 73 failed, 12 canceled | Background-job count, not audio duration |
| `gemini_key_mode` events, last 30 days | 860 managed route invocations | Includes preview/cache paths; not equivalent to paid generations |
| Users with non-zero package limits | 581 | Includes current non-zero entitlements in the database |
| Sum of package minute limits | 10,835 min | Theoretical one-pass monthly render allocation if every entitlement were fully used |
| Hidden AI-audio ceiling at default 2× | 21,670 min | Maximum TTS + transcription counter capacity if every entitlement consumed its full guard |

The 821.94-minute figure is close to the separate 817 charged-minute total, which makes it a reasonable base-volume proxy, but it must not be described as an exact Gemini invoice. The code currently discards Gemini `usageMetadata`, so historic token-accurate spend requires Google Billing Export. The response parser retains PCM, sample rate, and model only ([route source](../../src/app/api/videos/tts-gemini/route.ts)).

The retained application logs cover roughly five days. Within those logs there were 355 successful chunk calls to the primary 2.5 Flash model and one chunk call to the 3.1 Flash fallback. This supports using the 2.5 Flash price as the base case; chunk counts are not clip counts.

## Current Gemini cost

For output audio duration `M` minutes:

```text
Gemini 2.5 Flash output USD = M × 25 token/s × 60 s/min × $10 / 1,000,000
                             = M × $0.015

Gemini fallback output USD  = M × 25 token/s × 60 s/min × $20 / 1,000,000
                             = M × $0.030

Total invoice cost          = output cost + actual text-input tokens × input rate
```

### 25-versus-32-token sensitivity

Google's current Cloud Text-to-Speech pricing page explicitly applies **25 audio tokens/second** to the Gemini-TTS SKUs, so this report uses $0.015/min for 2.5 Flash and $0.030/min for the $20/M-token fallbacks. A generic Gemini tokenization page and older 2.5-era references have also described audio as **32 tokens/second**. If the actual API billing metadata shows 32 output tokens/second, the corresponding conservative rates are:

- 2.5 Flash: `32 × 60 × $10 / 1,000,000 = $0.0192/audio minute`.
- 3.1 Flash or 2.5 Pro fallback: `32 × 60 × $20 / 1,000,000 = $0.0384/audio minute`.

At 821.94 minutes, that 32-token sensitivity is **$15.78 / ฿552.34** for 2.5 Flash or **$31.56 / ฿1,104.69** if every minute fell through to a $20/M-token model. Google Billing Export or retained response `usageMetadata` should decide which accounting basis matches the real invoice; duration alone cannot resolve the discrepancy.

At the production proxy volume and `฿35/USD` (the repository's configured fallback FX rate):

| Pricing case | USD/month proxy | THB/month proxy |
|---|---:|---:|
| Primary 2.5 Flash, 821.94 min | $12.33 | ฿431.52 |
| All minutes served by $20/M-token fallback | $24.66 | ฿863.04 |
| Internal all-in COGS rate, ฿0.70/min | — | ฿575.36 |

The input-token charge is normally small relative to output audio but cannot be reconstructed exactly because the app does not store token metadata. Transcription minutes inside `aiAudioMinutesUsed` are also cheaper than treating all 821.94 minutes as TTS output, so the primary-output calculation is a conservative usage proxy rather than an invoice reconciliation.

## GPU provider rates

### Runpod Serverless Flex — L4/A5000/3090 category

- Flex rate: **$0.00019/second = $0.684/hour**.
- Flex workers scale to zero and are billed from worker start until fully stopped, including startup/model loading, execution, and idle timeout. The default idle timeout is five seconds.
- Storage is additional: container disk approximately $0.10/GB-month and network volume $0.07/GB-month below 1 TB.
- Sources: [Runpod Serverless pricing](https://docs.runpod.io/serverless/pricing), [Runpod worker lifecycle](https://docs.runpod.io/serverless/workers/overview).

```text
Runpod USD = total billed worker seconds × $0.00019 + storage/network
```

### Google Cloud Run GPU — L4 Singapore, non-zonal

- Singapore `asia-southeast1` supports NVIDIA L4.
- L4 minimum configuration: 4 vCPU and 16 GiB.
- Singapore non-zonal rate used here:
  - GPU: $0.0001867/second
  - 4 vCPU: 4 × $0.000018/second
  - 16 GiB: 16 × $0.000002/second
  - total: **$0.0002907/second = $1.04652/hour**
- GPU requires instance-based billing. `min-instances=0` can scale to zero, but the complete billable instance lifecycle includes startup and any retained idle time.
- Sources: [Cloud Run GPU configuration and regions](https://docs.cloud.google.com/run/docs/configuring/services/gpu), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Run autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling).

```text
Cloud Run USD = total billed instance-lifecycle seconds × $0.0002907 + storage/egress/logging
```

### AWS EC2 Malaysia — `g6.xlarge`

- `g6.xlarge`: one NVIDIA L4 24 GB, 4 vCPU, 16 GiB.
- Malaysia on-demand Linux rate: **$1.0138/hour**.
- Linux on-demand has per-second billing with a 60-second minimum; EC2 does not automatically scale itself to zero per request.
- 730 hours continuously running: **$740.07 / ฿25,902.59 per month**, before EBS, data transfer, IPv4, logs, and tax.
- Sources: [AWS G6 specifications](https://aws.amazon.com/ec2/instance-types/g6/), [AWS official Malaysia EC2 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-5/index.json), [EC2 on-demand billing](https://aws.amazon.com/ec2/pricing/on-demand/), [regional instance-family availability](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-regions.html).

## GPU sensitivity at the current 821.94-minute volume

`RTF = GPU render seconds / generated audio seconds`. These rows exclude cold-start/idle/storage/network overhead.

| Effective warm RTF | Runpod L4 | Cloud Run L4 SG | AWS g6.xlarge, active time only |
|---:|---:|---:|---:|
| 0.25 | $2.34 / ฿81.99 | $3.58 / ฿125.44 | $3.47 / ฿121.52 |
| 0.50 | $4.69 / ฿163.98 | $7.17 / ฿250.88 | $6.94 / ฿243.04 |
| 1.00 | $9.37 / ฿327.95 | $14.34 / ฿501.77 | $13.89 / ฿486.08 |

Raw-compute break-even against primary Gemini's $0.015/audio minute, before overhead:

- Runpod L4: effective RTF below approximately **1.316**.
- Cloud Run minimum L4: effective RTF below approximately **0.860**.
- AWS g6.xlarge: effective RTF below approximately **0.888**, only if the instance is started/stopped around work. At current volume, 24/7 AWS is not cost-competitive.

## Capacity sensitivity

These rows deliberately separate volume from performance. They still exclude startup, idle, retries, storage, and network.

| Monthly audio volume | Gemini 2.5 Flash | Runpod, RTF 0.5 | Cloud Run, RTF 0.5 | AWS active time, RTF 0.5 |
|---:|---:|---:|---:|---:|
| 821.94 min (current rolling proxy) | $12.33 / ฿431.52 | $4.69 / ฿163.98 | $7.17 / ฿250.88 | $6.94 / ฿243.04 |
| 10,835 min (all package minutes used once) | $162.53 / ฿5,688.38 | $61.76 / ฿2,161.58 | $94.49 / ฿3,307.22 | $91.54 / ฿3,203.82 |
| 21,670 min (all users hit 2× audio ceiling) | $325.05 / ฿11,376.75 | $123.52 / ฿4,323.17 | $188.98 / ฿6,614.44 | $183.08 / ฿6,407.64 |

For a conservative performance sensitivity at RTF 1.0, double each RTF-0.5 GPU amount in the table. For a well-optimized RTF 0.25, halve it.

## Cold-start warning

At serverless scale-to-zero, the main unknown is not the warm GPU price; it is how many separate billed worker sessions occur. If `N` uncached sessions each add `C` seconds of startup/idle overhead:

```text
Runpod overhead USD   = N × C × $0.00019
Cloud Run overhead USD = N × C × $0.0002907
```

The 860 `gemini_key_mode` events are only an upper-bound activity signal because that event fires before the preview-cache check. They must not be substituted for `N`. The PoC should log real worker start, model-ready, synthesis-start/end, idle-stop, output duration, and served model/step count.

## Recommended interpretation

1. Use **821.94 audio minutes** as the current-volume proxy and **10,835 / 21,670 minutes** as package-capacity stress tests.
2. Do not select a single Best/Base/Worst OmniVoice bill until the same container is benchmarked on the candidate L4. Report warm RTF and effective RTF including cold overhead separately.
3. For decision-making, a defensible provisional band at current volume is RTF 0.25–1.0: Runpod **฿82–328 raw compute**, Cloud Run **฿125–502 raw compute**, plus cold/start/idle/storage/network.
4. Gemini is already inexpensive at this usage level (roughly **฿432 output cost**, or **฿575 under the product's internal all-in rate**). The financial case for OmniVoice is therefore secondary to custom voices, control, privacy, stability, and differentiation until volume rises materially.
5. Add Gemini `usageMetadata` and served-model logging, and add equivalent GPU lifecycle metrics during the PoC. Without those fields, neither provider can be reconciled to the invoice exactly from the app database.

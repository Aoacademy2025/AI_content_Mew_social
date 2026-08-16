# AWS OmniVoice + frontend PoC assessment — 2026-07-21

## Decision

Run the first PoC by moving **only the OmniVoice audio worker** from Hostinger KVM2 to an On-Demand EC2 instance in AWS Thailand. Keep the production Next.js application, SQLite database, and video render workers on KVM8 during this test.

Separating the frontend is not required to answer the immediate question: “Can more predictable AWS CPU remove the 500-character OmniVoice ceiling at an acceptable cost?” Moving both components at once adds database, media-sharing, routing, and rollback variables and makes the result harder to interpret.

The 500-character limit is not a video-render or S3 limit. It is an application/capacity guard:

- `src/lib/omnivoice.ts:54-59` records the KVM2 benchmark at approximately 3.8× realtime, limits inference to four steps, defaults to 500 characters, hard-clamps the environment setting to at most 1,000 characters, and gives the upstream request 240 seconds.
- `src/app/api/videos/tts-omnivoice/route.ts:32,209-223` rejects the entire script before chunking and has a 300-second route ceiling.
- The accepted integration plan says KVM2 is intentionally limited to one active synthesis plus two pending requests and short scripts (`docs/plans/2026-07-20-omnivoice-integration.md:24-26`).

Therefore a faster EC2 instance may justify raising the limit to 1,000 characters without changing the current configuration contract, but scripts over 1,000 characters require an application change. Reliably supporting multi-thousand-character scripts will probably also require an asynchronous synthesis job rather than keeping one HTTP request open for up to five minutes.

## Recommended PoC topology

```text
User -> existing KVM8 Next.js/API -> HTTPS -> OmniVoice EC2 Thailand
                    |                            |
                    |<----- WAV/base64 ----------|
                    |
                    +-> existing local SQLite + local video render workers
```

- Start with `c7i.xlarge` (4 vCPU, 8 GiB) in `ap-southeast-7`, one 80 GB gp3 volume, and one public IPv4 address.
- Restrict the EC2 security group/proxy to HTTPS from the fixed KVM8 public IP, retain the API key and existing allowlist, and keep port 8000 private/loopback.
- Keep the current app behavior: the worker returns WAV data in JSON and the KVM8 route writes it to `public/renders` (`src/app/api/videos/tts-omnivoice/route.ts:51-82,132-138`). S3 is not needed to test inference capacity.
- If `c7i.xlarge` misses the target, resize the same instance to `c7i.2xlarge` (8 vCPU, 16 GiB) and repeat exactly the same corpus.
- Use On-Demand and stop the EC2 instance when the benchmark window ends. Do not buy a Savings Plan for a PoC.

Test 10 representative Thai scripts at 500 and 1,000 characters through the application, then test 2,000 and 4,000 characters directly against an isolated worker build to establish the future architecture. Record generation time, generated-audio duration, realtime factor, peak RAM, CPU utilization, queue rejection, and audio quality at four steps. A practical go/no-go criterion is that 1,000 characters complete comfortably inside the current 240-second upstream budget under two simultaneous requests; otherwise the synchronous application path is still unsafe.

## Current AWS Thailand prices

The following are Linux/Shared/On-Demand rates from AWS's current `ap-southeast-7` price list, version `20260721012550`. Monthly examples use 730 hours and an illustrative THB 33.3/USD; tax and support are excluded. [Official EC2 Thailand price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-7/index.json), [Bank of Thailand exchange rates](https://www.bot.or.th/en/statistics/exchange-rate.html)

| Component | Exact AWS rate | 730-hour example | Approx. THB |
|---|---:|---:|---:|
| `c7i.xlarge`, 4 vCPU / 8 GiB | $0.17494/hour | $127.71 | ฿4,252 |
| `c7i.2xlarge`, 8 vCPU / 16 GiB | $0.34988/hour | $255.41 | ฿8,505 |
| `t3.medium`, 2 vCPU / 4 GiB (optional web PoC) | $0.04750/hour | $34.68 | ฿1,155 |
| gp3 EBS | $0.0864/GB-month | 80 GB = $6.91 | ฿230 |
| EBS snapshot data | $0.045/GB-month | 40 GB = $1.80 | ฿60 |
| Public IPv4 | $0.005/hour/address | $3.65/address | ฿122 |

The minimal 24/7 OmniVoice PoC is therefore:

- `c7i.xlarge` + 80 GB gp3 + one public IPv4: **$138.27/month, about ฿4,604** before tax, logs, and internet egress.
- `c7i.2xlarge` + the same storage/IP: **$265.97/month, about ฿8,857**.
- If run for only one seven-day benchmark window, compute is approximately $29.39 (`c7i.xlarge`) or $58.78 (`c7i.2xlarge`), plus prorated EBS/IP.

AWS Thailand currently lists no accelerated-computing instance families, while Malaysia lists G6/Gr6. GPU should not be assumed to work because the OmniVoice worker/model source is not in this repository and CUDA compatibility could not be verified. If the owner confirms CUDA support, a separate Malaysia GPU benchmark is possible; current `g6.xlarge` (one NVIDIA L4, 4 vCPU, 16 GiB) is $1.0138/hour, about $740/month at 730 hours, so it only wins if throughput improves dramatically or the instance starts only while jobs are queued. [AWS instance types by Region](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-regions.html), [official EC2 Malaysia price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-5/index.json)

## S3 Thailand price and examples

Current S3 Standard rates in Thailand, price-list version `20260720184843`, are: [Official S3 Thailand price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-7/index.json)

| Item | Exact AWS rate | Example |
|---|---:|---:|
| First 50 TB of S3 Standard storage | $0.0225/GB-month | 10 GB $0.23; 100 GB $2.25; 160 GB $3.60; 1 TiB $23.04 |
| PUT/COPY/POST/LIST | $0.0045 per 1,000 requests | 100,000 uploads/lists = $0.45 |
| GET and other requests | $0.0036 per 10,000 requests | 1,000,000 downloads = $0.36 |
| Internet egress, first 10 TB | $0.108/GB | after the account-wide 100 GB/month free allowance |

Illustrative egress totals, assuming the account has no other AWS egress: 500 GB downloaded to users/KVM8 in a month costs approximately `(500 - 100) × $0.108 = $43.20`; 1,000 GB costs approximately $97.20. AWS aggregates the 100 GB free allowance across eligible services and Regions. [AWS EC2 data-transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/)

S3 transfer directly to EC2 in the same AWS Region is free. EC2-to-EC2 traffic in the same Availability Zone over private IP is free; cross-AZ traffic is generally $0.01/GB in each direction. Avoid a NAT Gateway in the PoC because it adds hourly and per-GB processing charges. [AWS regional data-transfer rules](https://aws.amazon.com/ec2/pricing/on-demand-backup/), [AWS VPC pricing](https://aws.amazon.com/vpc/pricing/)

For OmniVoice alone, S3 is not the meaningful cost driver: even 160 GB is only $3.60/month. EC2 compute and whether the worker can finish long scripts inside the time budget dominate the decision. S3 becomes necessary when frontend/API and render workers live on different machines and need shared audio/video objects.

## Why not separate the frontend in the first test

This repository is a Next.js monolith rather than a static frontend:

- API routes, authentication, quota reservation, orchestration, and OmniVoice proxying run in the same application.
- Prisma uses SQLite (`prisma/schema.prisma:5-7`), and KVM8 render workers read the same local database path (`ecosystem.config.js:229-266`).
- OmniVoice WAV files and other rendered assets are written to local disk, not shared object storage.

Putting an AWS “frontend” in front of KVM8 without changing these seams either leaves almost all real work on KVM8 or creates two incompatible local filesystems/databases. A proper second-stage split requires one of these designs:

1. Keep KVM8 as the authoritative API/SQLite/render service and move only static/marketing pages to AWS; or
2. Move the web/API control plane to AWS, migrate SQLite to shared PostgreSQL, move media to S3, and make KVM8 a stateless render worker that downloads inputs/uploads outputs with signed URLs.

Design 2 is a valid scaling architecture, but it is a migration project, not the smallest OmniVoice capacity PoC. If it is tested later, a low-traffic `t3.medium` web instance plus `c7i.xlarge` OmniVoice, 110 GB total gp3, two IPv4 addresses, and 100 GB S3 is roughly **$181.44/month (about ฿6,042)** before PostgreSQL, egress, load balancing, logs, support, and tax. The database/media refactor is the larger cost and risk.

## Go/no-go after the benchmark

Proceed to a wider AWS OmniVoice canary only if the selected instance:

- handles at least 1,000-character scripts inside the existing 240-second budget with acceptable four-step audio quality;
- remains stable under the intended concurrent/pending request envelope;
- has a measured cost per generated audio minute that fits the plan margin; and
- can be rolled back to KVM2/Gemini/ElevenLabs without moving the production database or renderer.

If CPU scaling is poor, do not keep buying larger CPU instances blindly. First obtain the OmniVoice worker/model source and profile whether inference is single-threaded, whether model warm-up dominates, and whether CUDA is supported. That evidence determines whether the next test should be a larger C7i instance, multiple small workers behind a queue, or a Malaysia GPU instance.

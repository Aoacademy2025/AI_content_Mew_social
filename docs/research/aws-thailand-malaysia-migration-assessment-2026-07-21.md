# AWS Thailand/Malaysia migration assessment for Hero AI

Date checked: 2026-07-21 (Asia/Bangkok)  
Scope: official AWS documentation and the current AWS Price List Bulk API, plus the repository's own infrastructure notes. Prices are public On-Demand USD rates, before tax, credits, negotiated discounts, or commitments. This is a technical and commercial assessment, not legal advice.

## Executive decision

**AWS is technically suitable for Hero AI, but a full migration is not justified by this proposal alone. Do not approve an immediate lift-and-shift or a 1/3-year commitment yet.**

The better decision is:

1. keep the current Hostinger production system as the primary system while monitoring the already-isolated render queues;
2. ask AWS for a complete architecture and shareable AWS Pricing Calculator estimate, not only four unit-price tables;
3. run a benchmark/canary in the Thailand Region with real Remotion/Chromium/ffmpeg jobs and 30 days of representative traffic;
4. migrate components only when their existing constraint is measurable: object storage/CDN when local disk or bandwidth is the constraint, managed PostgreSQL when SQLite or multi-host access is the constraint, and elastic render workers when CPU concurrency is the constraint;
5. prefer Thailand over Malaysia for a Thai-first workload when the exact required services/features are available and measured performance is acceptable. The quoted Malaysia and Thailand rates are identical, so Malaysia provides no price advantage in this sheet.

The proposal's main claim — Malaysia/Thailand are generally 10–15% cheaper than Singapore for the listed SKUs — is substantially correct. However, it is not a total-cost comparison, and one data-transfer row is wrong. More importantly, none of the proposed EC2 `large` instances matches the current production server's 8 vCPU/32 GB capacity.

## Current workload context

The repository documents the effective production environment as one Hostinger KVM 8 Ubuntu VPS with 8 vCPU/32 GB RAM/400 GB NVMe storage, PM2/Nginx, Prisma SQLite, and CPU-only local Remotion + headless Chromium + ffmpeg rendering (`ecosystem.config.js:8-17`, `prisma/schema.prisma:5-7`). The current PM2 configuration isolates two durable render workers from the web process (`ecosystem.config.js:205-266`). The latest seven-day launch audit recorded a 98.4% RenderJob success rate, approximately 4-second p95 VideoJob queue wait, roughly 20 videos/hour, 229 GB free disk, 26 GB free RAM, and no crash loops (`docs/audits/2026-07-16-pre-launch-audit.md:7-15`). It also identifies a real durability gap: the database backup currently remains on the same VPS because no remote rsync target is configured (`docs/audits/2026-07-16-pre-launch-audit.md:31-39`).

The existing scale plan recommends architecture-first scaling: isolate/queue rendering, then vertical scaling, then multi-worker/multi-box infrastructure, PostgreSQL only when write contention or multi-box access requires it, and S3/R2 when disk or bandwidth becomes the limiter (`docs/scale-upgrade-plan.md:28-48`).

That context makes a generic server-price discount insufficient. A migration needs to prove one or more concrete outcomes: better render throughput, isolation of web traffic from rendering, an acceptable recovery objective, lower total cost at measured utilization, or a data-location requirement.

## Region facts

| Region | API code | Availability Zones | Account status | Relevant fact |
|---|---:|---:|---|---|
| Singapore | `ap-southeast-1` | 3 | Enabled by default | Established regional option; the quoted baseline |
| Malaysia | `ap-southeast-5` | 3 | Opt-in required | Same quoted prices as Thailand for every line in the proposal |
| Thailand | `ap-southeast-7` | 3 | Opt-in required | Generally available since 7 January 2025; AWS describes it as its first infrastructure Region in Thailand |

Sources: [AWS Regions table](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html), [Thailand Region launch](https://aws.amazon.com/blogs/aws/announcing-the-new-aws-asia-pacific-thailand-region/), [AWS Availability Zone guidance](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions-availability-zones.html).

All three Regions have three AZs, but that does **not** make a one-instance design highly available. AWS recommends deploying applications in multiple AZs because one zonal resource can be unavailable if its AZ fails. The proposal prices one EC2 instance and Single-AZ RDS only; it therefore prices single points of failure, not a production HA architecture. [AWS Region/AZ guidance](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions-availability-zones.html)

Newer Regions are opt-in and service/feature availability can differ. AWS's own Region-selection method says to confirm compliance, check the Regional Services List for every required feature, calculate full workload cost, and test latency from actual end-user locations. [AWS Well-Architected Region-selection guidance](https://docs.aws.amazon.com/wellarchitected/latest/framework/sus_sus_region_a2.html)

## Verification of the AWS sales sheet

### Method

The figures below were extracted from AWS's official regional `current` JSON price lists on 2026-07-21. AWS documents that the `current` URL points to the latest service price list and that tiered prices must be read by SKU and range. [AWS Price List manual-download documentation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html), [finding On-Demand and tiered prices](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/finding-prices-in-service-price-list-files.html)

Price-list versions/publication timestamps used:

- EC2: version `20260721012550`, published `2026-07-21T01:25:50Z`
- RDS: version `20260717221112`, published `2026-07-17T22:11:12Z`
- S3: version `20260720184843`, published `2026-07-20T18:48:43Z`
- AWS Data Transfer: version `20260720184645`, published `2026-07-20T18:46:45Z`

### EC2 Linux, Shared tenancy, On-Demand

| Instance | Specs | Singapore | Malaysia | Thailand | Sheet verdict |
|---|---:|---:|---:|---:|---|
| `t3.large` | 2 vCPU / 8 GiB | $0.1056/h | $0.0950/h | $0.0950/h | Correct |
| `m6i.large` | 2 vCPU / 8 GiB | $0.1200/h | $0.1020/h | $0.1020/h | Correct |
| `c6i.large` | 2 vCPU / 4 GiB | $0.0980/h | $0.0833/h | $0.0833/h | Correct |
| `r6i.large` | 2 vCPU / 16 GiB | $0.1520/h | $0.1292/h | $0.1292/h | Correct |

Official price files: EC2 [Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-1/index.json), [Malaysia](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-5/index.json), [Thailand](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-7/index.json).

**Capacity mismatch:** the current VPS is 8 vCPU/32 GB. Every `large` option above has only 2 vCPU and less memory. The closest paper match in the quoted family is `m6i.2xlarge` at 8 vCPU/32 GiB, currently $0.480/h in Singapore and $0.408/h in Malaysia/Thailand. At AWS's standard 730-hour estimate, compute alone is $350.40/month or $297.84/month respectively. These are still not performance guarantees; the real render workload must be benchmarked.

A `t3.large` is particularly risky as the default render machine. T3 is burstable: its baseline is 30% CPU, and sustained use above baseline can incur surplus-credit charges in Unlimited mode. AWS says fixed-performance instances should be compared at the breakeven utilization and gives an example where a continuously bursting T3 can cost about 1.5 times an equivalent M5. Hero AI's rendering is a sustained CPU workload, so T3 should be accepted only after a credit/cost benchmark, not because its headline hourly rate is the lowest. [AWS T3 Unlimited-mode guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html)

### RDS PostgreSQL, Single-AZ, On-Demand compute

| Instance | Singapore | Malaysia | Thailand | Sheet verdict |
|---|---:|---:|---:|---|
| `db.t3.large` | $0.224/h | $0.202/h | $0.202/h | Correct |
| `db.m6i.large` | $0.247/h | $0.210/h | $0.210/h | Correct |
| `db.r6i.large` | $0.300/h | $0.255/h | $0.255/h | Correct |

Official price files: RDS [Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-southeast-1/index.json), [Malaysia](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-southeast-5/index.json), [Thailand](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-southeast-7/index.json).

These are **compute-only Single-AZ** prices. RDS bills storage, provisioned IOPS where applicable, backup/snapshot storage, and data transfer separately. [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/)

For perspective, `db.t3.large` in Thailand is $0.202/h Single-AZ and $0.404/h one-standby Multi-AZ. `db.m6i.large` is $153.30/month for Single-AZ compute, while its one-standby Multi-AZ compute is $306.60/month, before storage. Current gp3 PostgreSQL storage is $0.124/GB-month Single-AZ and $0.248/GB-month for one-standby Multi-AZ in Thailand. Multi-AZ creates a synchronous standby in another AZ and provides automatic infrastructure failover; a normal one-standby deployment does not use that standby for reads. [RDS Multi-AZ documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)

Hero AI currently uses SQLite. Moving to RDS PostgreSQL is a database replatform, not a server relocation: it requires schema/client migration, data conversion, testing, cutover, rollback, and ongoing DB cost. It should be tied to an actual need such as multi-host access or measured SQLite contention.

### S3 Standard storage

| Monthly storage tier | Singapore | Malaysia | Thailand | Sheet verdict |
|---|---:|---:|---:|---|
| First 50 TB | $0.0250/GB-month | $0.0225 | $0.0225 | Correct |
| Next 450 TB | $0.0240 | $0.0216 | $0.0216 | Correct |
| Over 500 TB | $0.0230 | $0.0207 | $0.0207 | Correct |

Official price files: S3 [Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-1/index.json), [Malaysia](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-5/index.json), [Thailand](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-7/index.json).

The table covers only stored GB-month. S3 also charges by request type, retrieval/transition where applicable, data transfer, and some storage classes have minimum-duration charges. [S3 pricing and request/storage-class caveats](https://aws.amazon.com/s3/pricing/)

### Data transfer out to the internet

AWS currently includes 100 GB/month of internet egress free, aggregated across eligible AWS services and Regions rather than per Region. [EC2 data-transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/)

After that global free allowance, the current regional tiers are:

| Monthly tier | Singapore | Malaysia | Thailand | Sheet verdict |
|---|---:|---:|---:|---|
| First 10 TB | **$0.1200/GB** | **$0.1080** | **$0.1080** | **Sheet is wrong: it shows $0.100/$0.090** |
| Next 40 TB | $0.0850 | $0.0765 | $0.0765 | Correct |
| Next 100 TB | $0.0820 | $0.0738 | $0.0738 | Correct |
| Over 150 TB | $0.0800 | $0.0720 | $0.0720 | Correct |

Official AWS Data Transfer price files: [Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-southeast-1/index.json), [Malaysia](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-southeast-5/index.json), [Thailand](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-southeast-7/index.json).

For a video product, this correction matters: the first paid egress tier is likely the relevant tier, while the cheaper higher-volume tiers may never be reached. Cross-AZ, cross-Region, NAT Gateway, load-balancer, and other network processing flows can also create separate charges and must be shown in an architecture-specific estimate.

## Costs missing from the sales sheet

At minimum, a comparable production estimate must include:

- **EC2 storage and backup:** EBS is not included in the instance hourly rate. Current gp3 storage is $0.096/GB-month in Singapore and $0.0864 in Malaysia/Thailand; Thailand EBS snapshot storage is $0.045/GB-month. Performance above the included 3,000 IOPS and 125 MB/s is extra. [EBS pricing](https://aws.amazon.com/ebs/pricing/), [official Thailand EC2/EBS price file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-7/index.json)
- **Public IP/networking:** each in-use or idle public IPv4 address is $0.005/hour. NAT Gateway adds a gateway-hour charge, per-GB processing, and standard transfer charges. [Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/)
- **Database:** RDS storage, backups/snapshots, data transfer, and Multi-AZ if production recovery requirements demand it. [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/)
- **Object storage use:** S3 requests, lifecycle transitions/retrievals, and internet egress, not only GB-month. [S3 pricing](https://aws.amazon.com/s3/pricing/)
- **Operations:** load balancer, CloudWatch logs/metrics/alarms, snapshots/backups, DNS, secrets/KMS where used, WAF where used, and the selected AWS Support plan.
- **Commercial assumptions:** applicable taxes, foreign-exchange exposure, expiring promotional credits, migration/professional-service charges, and the duration/upfront payment of any Savings Plan or Reserved Instance.

A useful parity-sized lower-bound illustration, not a production quote: one Thailand `m6i.2xlarge` running 730 hours ($297.84) + 400 GB gp3 ($34.56) + one public IPv4 ($3.65) + an illustrative 160 GB snapshot ($7.20) is already **$343.25/month** (about THB 11,430 at roughly THB 33.3/USD), before egress, S3 requests, observability, support, tax, or HA. Hostinger currently lists KVM 8 at THB 1,529/month on renewal, with 8 vCPU, 32 GB RAM, 400 GB NVMe, and 32 TB bandwidth. This makes the AWS lower bound about 7.5 times the public Hostinger renewal price before the omitted AWS items; actual CPU performance still requires a workload benchmark. [Hostinger Thailand VPS pricing](https://www.hostinger.com/th/vps-hosting), [Bank of Thailand exchange rates](https://www.bot.or.th/en/statistics/exchange-rate.html)

AWS's calculator documentation warns that estimates only include the usage specified, and its EC2 workflow explicitly asks for EBS, monitoring, transfer, Elastic IP, and additional costs. It also says Support must be explicitly added and tax is not included. [AWS workload-estimate caveat](https://docs.aws.amazon.com/cost-management/latest/userguide/pc-workload-estimate.html), [EC2 estimate inputs](https://docs.aws.amazon.com/pricing-calculator/latest/userguide/ec2-estimates.html), [Pricing Calculator assumptions](https://aws.amazon.com/aws-cost-management/aws-pricing-calculator/faqs/)

## Suitability for Hero AI

### Where AWS fits well

- Elastic, separate render workers can isolate CPU-heavy video work from the web application and scale with queue depth.
- Self-hosted Remotion workers can run on EC2 in Thailand, but Remotion's current Lambda region list includes Singapore and Malaysia, not Thailand. A Remotion Lambda burst path would therefore currently need a supported Region or a future support change. [Remotion Lambda region selection](https://www.remotion.dev/docs/lambda/region-selection)
- S3 plus a CDN is a natural destination when the existing host's media disk or delivery bandwidth becomes a demonstrated constraint.
- RDS PostgreSQL is useful once multi-host access, managed backups/failover, or SQLite write contention justifies the replatform cost.
- Multiple AZs make a genuinely redundant design possible; managed services can reduce some infrastructure work.
- Thailand can keep selected AWS-hosted customer content in the AWS Thailand Region and place compute/storage closer to Thai users.

### Where AWS does not automatically solve the problem

- Moving the current monolith to one EC2 instance preserves the same single-host failure and render/web contention pattern.
- A low-priced `t3.large` can be worse for sustained rendering because it is burstable and has half the current vCPU count.
- Putting EC2/RDS/S3 in Thailand does not by itself keep all application data in Thailand. Hero AI calls non-AWS providers for auth, payment, AI, avatar, speech, and stock media; each external data flow must be assessed separately. AWS also identifies a small set of its own services, including CloudFront, where cross-location transfer can be an essential function. [AWS privacy features and transfer exceptions](https://aws.amazon.com/compliance/privacy-features/)
- AWS does not take over application security. Under the shared-responsibility model, AWS secures the underlying cloud; for EC2, the customer still owns guest-OS patching, application software, security groups, IAM/access, data classification, encryption choices, and monitoring. [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

## Thailand data location, latency, and security

- AWS says customers choose the Region where customer content is stored and that AWS will not move or replicate it outside chosen Regions without agreement, subject to service operation and legal exceptions. A Thailand-only EC2/RDS/S3 design therefore supports a Thailand data-location objective. [AWS Data Privacy FAQ](https://aws.amazon.com/compliance/data-privacy-faq/)
- This is not, by itself, a conclusion that the whole product complies with Thai privacy law. AWS explicitly recommends consulting legal counsel for legal data-protection questions, and the product's third-party data flows remain in scope.
- Thailand should be expected to reduce geographic distance for Thai users, but AWS's own process says to **test** actual latency rather than infer it from the Region name. Run upload, API, asset-download, and render-to-download tests from the real user networks. [AWS Region-selection guidance](https://docs.aws.amazon.com/wellarchitected/latest/framework/sus_sus_region_a2.html)
- CloudFront has multiple edge locations in Thailand, so static/video delivery can be tested independently from moving the entire origin. The Thailand launch announcement reports six CloudFront edge locations in the country. [AWS Thailand Region launch](https://aws.amazon.com/blogs/aws/announcing-the-new-aws-asia-pacific-thailand-region/)

## Recommended decision gate and pilot

AWS recommends an assess–mobilize–migrate process and a TCO-backed business case rather than selecting a target from unit prices. [AWS migration strategy overview](https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-migration/overview.html) Its right-sizing guidance likewise says to understand actual utilization patterns before migration. [AWS right-size-before-migrating guidance](https://docs.aws.amazon.com/whitepapers/latest/cost-optimization-right-sizing/right-size-before-migrating.html)

Ask the AWS team to deliver these before approval:

1. A shareable/exportable AWS Pricing Calculator estimate for **three scenarios**: single-AZ pilot, production HA, and expected 12-month scale. Include every service and usage assumption.
2. An architecture diagram showing EC2 count/type, AZ placement, load balancer, EBS size/performance, S3 lifecycle/CDN path, database topology, backups, NAT/public IPs, observability, and security boundary.
3. A current Regional Services List check for every exact service and feature in Thailand, including quotas/capacity for the chosen instance types.
4. Measured current baselines: p50/p95 render time, CPU, RAM, disk I/O, storage growth, monthly egress, peak concurrent jobs, request rate, downtime, and current all-in Hostinger cost.
5. A 2–4 week Thailand canary using representative long/short videos and simultaneous web traffic. Compare render duration, failure rate, web p95 latency, queue time, and cost per completed video.
6. RPO/RTO and failure tests: kill a render worker, stop an EC2 instance, simulate AZ/database failover where applicable, and demonstrate restore from backup.
7. A database migration plan only if PostgreSQL is in scope: schema/data conversion, dual-write or downtime approach, validation, cutover, and rollback.
8. Written commercial terms: credits, when they expire, support level, partner/professional-service fees, and any 1/3-year commitment. Keep the pilot On-Demand.

## Final go/no-go

- **Immediate full migration based on this sheet:** **NO-GO.** It is not an architecture or TCO, contains one material price error, and compares undersized EC2 options with the existing server.
- **Thailand-region pilot on On-Demand:** **GO.** Benchmark fixed-performance `m6i`/`c6i`-class compute sized to the workload; do not lead with T3 for rendering.
- **Malaysia instead of Thailand:** **NO advantage shown.** Prices in this proposal are identical; choose it only if a required service/feature/capacity or measured end-to-end performance is better.
- **Singapore:** keep as a valid fallback when a required feature/capacity is unavailable in Thailand, but its listed unit prices are higher.
- **Phased adoption:** **GO when triggered by evidence.** Object storage/CDN, render-worker compute, and PostgreSQL should each be separate decisions with separate rollback paths.

The practical recommendation is: **AWS can be part of Hero AI's scale architecture, but it should not replace the current VPS until a Thailand canary demonstrates a better reliability/performance/cost outcome with a complete bill.**

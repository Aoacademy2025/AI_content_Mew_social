# RunPod Serverless payload-retention audit for voice-clone canary

Observed **2026-09-04**. This refresh uses current public first-party RunPod documentation, legal terms, official RunPod source, and a sanitized authenticated account readback. It made no write/job request, changed no RunPod resource, read no payload/log content, and submitted no audio.

## Direct verdict

**The public evidence is not sufficient to close the plan's strict human-audio gate, even for Mew's private personal 10-second canary.** Mew's ownership and explicit consent materially address the customer-side voice-rights question, but they do not establish that the Standard DPA is binding on this account, prove deletion from backups, guarantee that payloads never enter provider/framework logs, or prove binding data-center placement.

The remaining provider-side gate is now limited to:

1. evidence that the published Standard DPA was executed for the account;
2. written RunPod answers covering backup retention/deletion propagation, payload exposure in platform/framework logs, and the exact processing/data-center boundary; and
3. readback of the dedicated canary endpoint's effective configuration before submission.

Until these are recorded, a synthetic/non-human canary is supported; a human reference remains **NO-GO under this plan**. This is a project gate assessment, not a legal opinion.

## Supported by current first-party evidence

### Contract and processing

- RunPod publishes a Standard DPA with a PandaDoc execution link. The DPA becomes binding only after the customer completes and submits the required information. Custom/bespoke agreements are reserved for customers committing at least USD 3,000/month; lower-spend users are directed to standard terms and the published Standard DPA. [Standard DPA](https://www.runpod.io/legal/data-processing-agreement), [RunPod help: standard vs custom agreements](https://contact.runpod.io/hc/en-us/articles/50120688006163-How-to-Find-HIPAA-GDPR-Compliant-GPUs-on-Runpod-and-Understand-BAA-Policy)
- The Terms require the user to own or hold the necessary rights, consents, releases, and permissions for submitted content. They grant RunPod a service-operation license and allow aggregated/anonymized use to improve its services. The DPA says it prevails over conflicting agreement terms and bars own-purpose processing of Customer Personal Data, but separately excludes Performance Data from those protections. [Terms of Service](https://www.runpod.io/legal/terms-of-service), [Standard DPA §§3, 17–18](https://www.runpod.io/legal/data-processing-agreement)
- Under the DPA, biometric data is special-category data when processed to uniquely identify a person. The customer must document an Article 9(2) or equivalent basis and notify RunPod in writing before adding new special-category data. RunPod's Privacy Policy says users who submit sensitive information must consent to its processing. [Standard DPA §§2–5](https://www.runpod.io/legal/data-processing-agreement), [Privacy Policy](https://www.runpod.io/legal/privacy-policy)

### Job, result, log, and worker lifecycle

- A request's `input` is packaged as a job. `policy.ttl` covers queueing and execution and causes job data to be deleted regardless of state at expiry. Default TTL is 24 hours; supported range is 10 seconds to 7 days. `executionTimeout` separately limits active processing: default 600 seconds, range 5 seconds to 7 days. [Send requests](https://docs.runpod.io/serverless/endpoints/send-requests), [Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations)
- RunPod documents result retention of 1 minute after `/runsync` completion and 30 minutes after asynchronous `/run`; endpoint settings say results are permanently deleted after expiry. The docs describe result retention as separate from TTL, so they do not unambiguously state which timer wins when a short TTL expires first. [Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations), [Operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference)
- There is no documented per-job delete operation. Cancel stops work but is not described as erasure; retry reuses the original input. [Operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference)
- RunPod now expressly says deleting an endpoint permanently removes its configuration, logs, and job history. This is strong endpoint-scope cleanup evidence, but the statement does not mention backups or a completion SLA. [Endpoint overview](https://docs.runpod.io/serverless/endpoints/overview)
- Centralized endpoint logs are retained 90 days; worker-local logs disappear when a worker terminates. [Write logs](https://docs.runpod.io/serverless/development/write-logs)
- In official `runpod==1.10.1` source, the default `RunPodLogger` level is `DEBUG`, and the job runner logs handler/generator/return output at DEBUG. A generated base64 WAV can therefore enter the 90-day endpoint log unless the deployed endpoint explicitly overrides the level. [v1.10.1 logger](https://github.com/runpod/runpod-python/blob/v1.10.1/runpod/serverless/modules/rp_logger.py), [v1.10.1 job runner](https://github.com/runpod/runpod-python/blob/v1.10.1/runpod/serverless/modules/rp_job.py)
- Container disk is the default handler storage and is temporary. However, FlashBoot is enabled by default and retains worker state after spin-down. Returning `refresh_worker: true` is documented to clear worker logs and wipe worker state after completion. [Storage options](https://docs.runpod.io/serverless/storage/overview), [Endpoint settings — FlashBoot](https://docs.runpod.io/serverless/endpoints/endpoint-configurations), [Handler worker refresh](https://docs.runpod.io/serverless/workers/handler-functions)

### Placement and optional copies

- Endpoint settings can restrict workers to selected data centers, and the endpoint API exposes `dataCenterIds`. The DPA says Serverless deployments can be isolated to selected compliant data centers, but elsewhere promises only reasonable efforts toward a geographically proximate server and notes worldwide hosting including the United States. [Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations), [Endpoint API](https://docs.runpod.io/api-reference/endpoints/POST/endpoints), [Standard DPA §4 and Attachment 1](https://www.runpod.io/legal/data-processing-agreement)
- A webhook is opt-in. RunPod's first-party, live-verified guide says its callback contains the full job, including input and output. `s3Config` is explicitly supplied per request and requires worker logic. Network volumes must be attached and retain data independently of workers; absent persistent storage, handler files use temporary container disk. [Send requests](https://docs.runpod.io/serverless/endpoints/send-requests), [official webhook guide](https://github.com/runpod/runpod-plugins-official/blob/main/plugins/runpod/skills/runpod/golden-paths/16-serverless-webhooks.md), [Storage options](https://docs.runpod.io/serverless/storage/overview), [Network volumes](https://docs.runpod.io/storage/network-volumes)

## Fresh read-only account readback

At 2026-09-04 21:02 ICT, the existing repository credential successfully read
the RunPod REST endpoint, template, and endpoint-billing collections. The
account had 12 endpoints and 11 templates, but zero endpoint or template names
matched the Hero Voice canary naming boundary. No dedicated baseline/candidate
staging resource therefore exists to read back or run. The existing endpoint
objects did not expose `dataCenterIds`, so current placement could not be
proven from the account response. Only collection counts, response field names,
and the zero-canary result were emitted; no IDs, names, logs, payloads, audio,
or credential values were printed. No mutation endpoint was called.

## Exact evidence still missing

| Gate | Supported | Unknown / required evidence |
| --- | --- | --- |
| DPA | A self-service Standard DPA exists. | Whether it has been executed for Mew's account; whether RunPod considers an individual processing her own voice within the listed data-subject scope. |
| Lawful processing | Mew states she owns and consents to use of her own voice. | Whether this purpose is biometric unique identification or which Thai-law basis applies; if special-category, evidence of the DPA's required written notice. |
| Input/result deletion | TTL deletes job data; result expiry permanently deletes results; endpoint deletion removes logs/history. | Backup/snapshot/replica retention, deletion propagation time, deletion evidence, legal/security hold behavior, and the ambiguous TTL/result-retention interaction. |
| Logs | Endpoint logs are 90 days; worker logs end with the worker. | Provider guarantee that raw input/audio/output never enters framework, error, abuse/security, request-history, or Performance Data logs. |
| Placement | `dataCenterIds` is configurable and readable. | Effective IDs for the dedicated endpoint and a binding boundary for control plane, support access, subprocessors, backups, replicas, and failover. |
| Optional persistence | Webhook, S3, and network volume can be omitted. | Effective endpoint/request readback; provider-side retention of supplied S3 credentials and outbound-network deny/allowlist controls are not publicly specified. |

## Minimum evidence needed to close the gate

1. Archive the completed Standard DPA execution confirmation for the account.
2. Record Mew as the consenting voice owner, the private evaluation purpose, the single 10-second reference, deletion target, and no sharing/publication; decide whether special-category notice applies.
3. Ask RunPod in writing:
   - whether raw job input/output can enter any platform/framework/security/Performance Data log when application logs are payload-free;
   - the maximum backup/snapshot/replica retention and deletion propagation after TTL, result expiry, DPA deletion request, and endpoint deletion; and
   - the exact data-center/control-plane/support/subprocessor/backup/failover boundary.
4. Before submission, read back a dedicated disposable endpoint with approved `dataCenterIds`, `workersMin=0`, `workersMax=1`, bounded timeout, FlashBoot disabled, no network volume, `RUNPOD_LOG_LEVEL=INFO` or stricter, payload-free errors/logs, and no exposed ports.
5. Submit once without `webhook` or `s3Config`, use explicit `policy.executionTimeout` and `policy.ttl`, never retry, retrieve once, request worker refresh, then delete the dedicated endpoint after capturing required evidence.

Public evidence now supports a **low-retention technical design**. It does not prove end-to-end deletion from backups, security/Performance Data, or cross-region replicas. Personal/private use changes purpose and consent; it does not change those provider-side facts.

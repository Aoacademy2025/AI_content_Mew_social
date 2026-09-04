# RunPod Serverless payload-retention audit for voice-clone canary

Observed **2026-09-03 19:46 UTC / 2026-09-04 02:46 ICT**. Sources are current official RunPod documentation/legal terms, the official RunPod Python SDK tag used by the worker, sanitized read-only RunPod endpoint/health responses, and the deployed application worker source. No job was submitted, canceled, retried, purged, or deleted; no log or payload content was read.

## Direct verdict

**NO-GO for sending a real person's voice reference until the team has a binding DPA/legal basis and RunPod gives written answers for input-copy, backup, request-history, and deletion propagation.** The platform documents short job/result visibility windows, but exposes no documented per-job erase API and does not promise cryptographic/immediate erasure of every payload copy.

A tightly controlled, explicitly consented employee/synthetic canary can be considered only after the application sends an explicit job policy, DEBUG remains off, payload-free logging is verified, no webhook/network volume/external object storage is used, and a named operator performs the post-job checks below.

## What RunPod documents

### Queue job and result lifetime

- A queue job contains the submitted `input` object. `policy.ttl` is the total job lifespan from submission across queue and execution: default **86,400,000 ms (24 h)**, minimum **10 s**, maximum **7 d**. At TTL expiry the job is deleted and `/status` returns 404. `executionTimeout` is separate and controls active execution only. [Send API requests — execution policies](https://docs.runpod.io/serverless/endpoints/send-requests#execution-policies)
- Completed result retention is fixed and documented separately: **30 minutes for asynchronous `/run`** and **1 minute for `/runsync`**. The documentation does not say that `policy.ttl` shortens this completed-result window. [Send API requests — result retention](https://docs.runpod.io/serverless/endpoints/send-requests#result-retention)
- The current Hero Voice client uses asynchronous `/run` and sends no `policy`, so it receives the default 24-hour job TTL. Its clone input embeds `ref_audio_b64`, reference transcript, and synthesis text in the RunPod JSON input; its result embeds generated WAV audio as base64. [client source](../../src/lib/omnivoice.ts), [handler source](../../services/omnivoice-runpod/handler.py)
- RunPod does **not** document a separate retention duration for original input after completion, failed-job input, queue internals, backups, or request-history data. `/retry` explicitly reuses the original input and removes the previous output, proving that original input remains available while a failed/timed-out job is retryable; the exact storage/deletion boundary is not published. [Operation reference — retry](https://docs.runpod.io/serverless/endpoints/operation-reference#retry)

Base64 is encoding, not privacy protection. The reference remains personal audio inside the job input. RunPod's DPA states encryption in transit and at rest, but that does not eliminate retention or authorized-access risk. [RunPod DPA — technical measures](https://www.runpod.io/legal/data-processing-agreement)

### Delete, cancel, and purge controls

The documented queue operations are `/run`, `/runsync`, `/status`, `/stream`, `/cancel`, `/retry`, `/purge-queue`, and `/health`; there is **no documented per-job delete/purge operation**. [Operation overview](https://docs.runpod.io/serverless/endpoints/send-requests#operation-overview)

- `/cancel/{jobId}` stops an in-progress job or removes it from waiting, but RunPod does not describe cancellation as input/output erasure. [Cancel](https://docs.runpod.io/serverless/endpoints/operation-reference#cancel)
- `/purge-queue` removes **all pending** jobs; jobs already running continue. It is not a per-job tool and carries collateral risk on a shared endpoint. It gives no log/backup deletion guarantee. [Purge queue](https://docs.runpod.io/serverless/endpoints/operation-reference#purge-queue)
- Deleting a Serverless endpoint is a resource-level destructive operation. Official documentation does not say it immediately erases prior job payloads, centralized logs, backups, or performance data, so it must not be used as an assumed erasure mechanism. [runpodctl Serverless reference](https://docs.runpod.io/runpodctl/reference/runpodctl-serverless#delete-an-endpoint)

No cancel, purge, retry, or endpoint-delete call was made in this audit.

### Logs and worker-local copies

- Centralized **endpoint logs are retained 90 days** and contain worker stdout, stderr, lifecycle messages, and SDK logs. Worker-local logs are temporary and removed when a worker terminates. [Monitor logs](https://docs.runpod.io/serverless/development/logs)
- Worker refresh can stop the worker after a job and wipe worker state/local logs, but it does not erase already centralized endpoint logs or the control-plane job/result. [Handler controls — worker refresh](https://docs.runpod.io/serverless/workers/handler-functions#worker-refresh)
- The official SDK version pinned by Hero Voice is `runpod==1.10.1`. At DEBUG it logs the full handler output and final result object; for this worker that would include generated `audio_base64`. It does not normally log the fetched input object. [official SDK `rp_job.py` v1.10.1](https://github.com/runpod/runpod-python/blob/v1.10.1/runpod/serverless/modules/rp_job.py), [official SDK logger](https://github.com/runpod/runpod-python/blob/v1.10.1/runpod/serverless/modules/rp_logger.py)
- Hero Voice's own handler logs only job ID, mode, timing, duration, version, device, and stock-voice count. It converts the submitted reference to a temporary WAV and unlinks it in `finally`; it does not request worker refresh. File unlinking and later worker termination reduce exposure but are not a documented cryptographic-erasure guarantee. [handler source](../../services/omnivoice-runpod/handler.py)

## Fresh read-only live verification

At **2026-09-03 19:45 UTC**, sanitized API reads of clone-capable endpoint `tkwkf5utqwt9ni` established:

- `/health`: queue 0, in-progress 0, running 0, idle 1, ready 1, throttled 0, unhealthy 0; cumulative 52 completed / 1 failed.
- Effective SDK debug level is **not DEBUG** and is INFO-or-stricter; only this derived boolean was emitted.
- Endpoint metadata exposes `networkVolumeId=""`: no network volume is attached.
- The endpoint response exposed no region/data-center restriction field. Therefore residency/compliance placement is **not verifiable from this API response**.

The health endpoint verifies current aggregate queue/worker state, not deletion of any specific input. [Health operation](https://docs.runpod.io/serverless/endpoints/operation-reference#health)

## Privacy/legal constraints

- A voice reference is personal data and may be special-category biometric data depending on purpose and jurisdiction. RunPod's DPA requires a documented legal basis and prior written notice before adding new special-category data to processing scope. It becomes binding only after its stated execution process. [RunPod DPA](https://www.runpod.io/legal/data-processing-agreement)
- Under the DPA, RunPod deletes or returns Customer Personal Data **upon customer request**, except where law requires retention. That is a contractual request path, not a self-service immediate-delete API. The same DPA allows separate Performance Data processing for billing, audit, security, fraud, and service improvement; Performance Data is excluded from its Customer Personal Data terms. [RunPod DPA §§12, 18](https://www.runpod.io/legal/data-processing-agreement)
- The public privacy policy gives no fixed general personal-data retention period; it permits retention for purpose, legal/accounting/reporting, claims, or fraud needs, followed by deletion, anonymization, or isolation. [Privacy policy — retention](https://www.runpod.io/legal/privacy-policy#retention)
- RunPod says Serverless deployments can be constrained to suitable data centers, while customers are responsible for selecting compliant placement. The current endpoint's read-only response did not prove such a constraint. [Security and compliance](https://docs.runpod.io/references/security-and-compliance), [DPA data-center controls](https://www.runpod.io/legal/data-processing-agreement)

## What can be configured or verified

| Phase | Can configure/verify | Cannot guarantee from self-service evidence |
| --- | --- | --- |
| Before canary | Put explicit `policy.executionTimeout` and `policy.ttl` in every `/run`; choose the smallest TTL supported by measured queue+cold-start+execution time. Keep `/run` for durable job IDs. Confirm DEBUG off, no webhook, no `s3Config`, no network volume, queue empty, one private endpoint, limited credential/access, consent and DPA. Ask RunPod to confirm data center and deletion semantics in writing. | A TTL shorter than the fixed 30-minute async result window; exact input retention; backup deletion; operator/support access; residency from the current endpoint response; binding DPA status from API. |
| During canary | Record only endpoint/job ID and timestamps; poll `/status`; monitor `/health`; cancel only if needed. Do not log input/output, retry, stream, download logs, or use console request forms. | Cancel as erasure; absence of hidden copies; no physical remnants after temp-file unlink. |
| After canary | Verify terminal status, app-side reference/result deletion, queue and in-progress counts return to zero, scale-to-zero worker terminates, status becomes 404 after documented retention, and centralized logs filtered by job ID contain metadata only. Request DPA deletion confirmation if required. | A 404 proves only API unavailability, not deletion from 90-day logs, backups, security/performance records, or legal holds. Worker termination does not delete centralized logs. |

## Actionable canary gate

1. **Contract/legal:** execute the DPA; document consent/purpose/retention; decide whether the use is special-category biometric processing and notify RunPod if required. Obtain written answers for input/request-history/backup deletion and data-center placement.
2. **Client:** add an explicit top-level `policy` to Hero Voice `/run`. Its `executionTimeout` must cover the endpoint's 600-second cap; set `ttl` only after measured worst-case queue+cold-start evidence. A 900,000 ms TTL is reasonable only if staging proves five minutes of queue headroom is sufficient. Do not treat TTL as shortening the 30-minute result window.
3. **Logging:** keep the live SDK at INFO-or-stricter; prohibit payloads and returned base64 in stdout/stderr/errors; never enable DEBUG for a voice canary. Retain no external logs or network volume.
4. **Subject/data:** use one explicitly consenting team member or non-person synthetic reference, the minimum 3–15-second clip, minimal transcript/text, and no names or identifiers in payload fields.
5. **Operation:** wait for `/health` queue/in-progress zero; submit exactly once; never retry; retrieve once; then verify app deletion, queue drain, worker termination, payload-free job-filtered logs, and eventual `/status` 404. Do not call global `/purge-queue` on a shared endpoint.

Until gates 1–4 are complete, **do not send a human voice reference to RunPod**.

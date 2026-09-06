# RunPod Hero Voice live-state audit

Observed: **2026-09-04 01:49–01:52 ICT** (2026-09-03 18:49–18:52Z)
Repository: application `main`/HEAD `8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb`
Scope: read-only RunPod control-plane, queue health, GHCR metadata, application source and runbooks. No resource was created, updated, restarted, scaled, or deleted; no inference request was submitted; no job input/output, user identifier, or secret value was read into this report.

## Verdict

**NO-GO for calling voice cloning live, calling any endpoint clone-only, or planning a production merge/cutover from RunPod state alone.** A clone-capable contract-v2 endpoint exists, but RunPod has **two** OmniVoice endpoints with `workersMax=1`; checked-in deployment tooling names the older endpoint, while no checked-in file names the newer one. RunPod account data cannot prove which ID the production Hostinger PM2 processes currently use or whether `OMNIVOICE_ENABLED` and `HERO_VOICE_CLONING_ENABLED` are enabled.

The newer endpoint is a valid infrastructure candidate, not a clone-only service: its image contains the contract-v2 clone handler **and all 48 stock voices**. No separate clone-only template, endpoint, or image exists in the inspected account/package.

## Live account inventory

RunPod `GET /endpoints`, `GET /templates?includeEndpointBoundTemplates=true`, endpoint details, and queue `/health` were queried with the existing local credential. The official API defines these as read operations; `/health` returns queue and worker counts. [RunPod endpoint API](https://docs.runpod.io/api-reference/endpoints/GET/endpoints), [template API](https://docs.runpod.io/api-reference/templates/GET/templates), [queue operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference).

All nine matching endpoints are queue-based GPU endpoints with one GPU per worker, `QUEUE_DELAY=4`, CUDA minimum 12.1, FlashBoot enabled, no network volume (`networkVolumeId=""`), and a 20 GB container disk. All have `workersMin=0`; therefore none is configured as a continuously billed active worker. RunPod documents Flex workers as scale-to-zero and a throttled worker as temporarily unavailable/not billed. [worker states](https://docs.runpod.io/serverless/workers/overview), [endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations).

| Endpoint | Template / image | Created UTC | Capacity and timeout | Health snapshot at 18:49:42Z |
| --- | --- | --- | --- | --- |
| `0t5ta1alo5nzqo` `heroai-omnivoice-production-v12-authfix` | `12m7gs1797`; `staging-20260723-v11-all32-amd64-68a4123f` | 2026-07-29 18:50:42 | **0–1**, idle 60 s, execution **180 s**, 9 GPU types | queue 0, in-progress 0; 46 completed / 4 failed; health reported idle 1, ready 1 |
| `tkwkf5utqwt9ni` `heroai-omnivoice-production-v13-hero-voice-v2` | `v7cygounjd`; `staging-20260824-v13-hero-voice-v2-amd64-565d0e6-f51eb32` | 2026-08-24 09:02:41 | **0–1**, idle 60 s, execution **600 s**, 9 GPU types | queue 0, in-progress 0; 52 completed / 1 failed; throttled 1 |
| `cmqzzcfxsinwtd` quality-floor staging | `9yk7mb3i95`; v3 quality-floor | 2026-07-22 17:42:21 | 0–0, 60 s, 600 s, 3 GPU types | 5 / 0; no workers |
| `d66lniwmhsjt51` emotion/dynamic-reference staging | `ij8vpp52nf`; v13 dynref | 2026-07-24 17:10:24 | 0–0, 60 s, 600 s, 9 GPU types | 535 / 0; no workers |
| `k69fz253b59st4` v9 staging | `cb4kazlwbj`; v9 lazy-slim | 2026-07-23 01:19:26 | 0–0, 60 s, 600 s, 9 GPU types | 22 / 0; no workers |
| `txvrmtzfc8au3b` v11 staging/former production | `jnzhscxted`; same v11 image as `0t5...` | 2026-07-23 15:35:18 | 0–0, 60 s, 600 s, 9 GPU types | 29 / 1; no workers |
| `xbn9a1ynd6byeu` v1 staging | `u7pyxacp1a`; initial three-voice image | 2026-07-21 15:23:52 | 0–0, idle 5 s, 600 s, 3 GPU types | 16 / 1; no workers |
| `xl6hhpijenyj3e` v8 48-voice staging | `tzkr5atq74`; v8 image | 2026-07-22 20:12:36 | 0–0, 60 s, 600 s, 9 GPU types | 4 / 0; no workers |
| `zcqf6wc1e848v0` v5 staging | `la4az7i8ay`; v5 image | 2026-07-22 18:15:05 | 0–0, 60 s, 600 s, 9 GPU types | 9 / 0; no workers |

The configured nine-GPU list on both enabled endpoints is: `NVIDIA RTX A4000`, `RTX A4500`, `RTX 4000 Ada Generation`, `RTX 2000 Ada Generation`, `L4`, `GeForce RTX 3090`, `A40`, `RTX A6000`, and `GeForce RTX 4090`. The most recent REST worker records were both `EXITED`; the account did not expose a currently allocated GPU model. The older endpoint's last recorded start was 2026-08-27 05:13:54Z (31 GB RAM, 6 vCPU, historical worker rate $0.24/h); the newer endpoint's was 2026-08-29 21:12:27Z (62 GB RAM, 12 vCPU, $0.25/h). Those records and `/health` counters prove prior use, not current application routing or a current charge.

RunPod's documented queue API does not provide a general job-list operation; `/status/{job_id}` requires a known ID and async results are retained for only 30 minutes. Consequently only non-sensitive aggregate counters and worker lifecycle metadata were collected. No job payload or result was queried. [request operations and retention](https://docs.runpod.io/serverless/endpoints/send-requests), [job states](https://docs.runpod.io/serverless/endpoints/job-states).

## Templates, registry, storage, and image identity

The two enabled templates use registry-auth identity **`cms6euknu003npi42luhxaa4t`**; only the identity ID was recorded. Their sole operator-configured template environment name is `RUNPOD_INIT_TIMEOUT`; the worker records also contain RunPod-injected variable names (`RUNPOD_AI_API_ID`, `RUNPOD_AI_API_KEY`, `RUNPOD_DEBUG_LEVEL`, `RUNPOD_ENDPOINT_ID`, `RUNPOD_ENDPOINT_SECRET`, `RUNPOD_GPU_SIZE`, `RUNPOD_INIT_TIMEOUT`, `RUNPOD_PING_INTERVAL`, and webhook variables). Values were not printed or retained.

Both templates have no persistent/network volume. `volumeInGb` is absent/null in the template API and 0 in worker records. This is correct for the app-owned one-shot clone design: RunPod receives reference bytes per job and does not own a durable user-voice library. Application-main instead expects persistent private reference storage on the Hostinger filesystem. [clone rollout](../ops/hero-voice-clone-rollout.md).

GHCR's package API and OCI distribution API resolved the live tags read-only:

| Template | Mutable tag currently resolves to OCI index | Linux/amd64 manifest | Built |
| --- | --- | --- | --- |
| `v7cygounjd` | `sha256:317f75b64a43e81a639033e95c9b3778bda8a2d87af27a8b55e9dd435dea2857` | `sha256:0f3d3527d639f6f16b62cfeef9af27bff7f4aea18281fdf47670707a3b760eb5` | 2026-08-24 08:47:50Z |
| `12m7gs1797` | `sha256:98d3a3ac7f4f022bf98329cfeb5ca093a163717d0291c15a7de9581eae4164a1` | `sha256:cecd83256f71115598e5d5b20b06239e6260580fa9462d552bb096ab278228a3` | 2026-07-23 15:33:14Z |

RunPod templates reference tags, **not `@sha256` digests**. The current mapping is observable, but a tag can be repointed without changing the template string. The OCI configs expose only base Ubuntu/NVIDIA labels; they do not record the Hero repository/source revision, SBOM, or provenance attestation. GHCR attestation verification could not be completed with the available registry authentication, so attestation status is unknown—not proven absent.

The v13 Docker source itself has useful immutable pins: PyTorch base digest `sha256:ac7c...b257126`, OmniVoice source `346bb75330980a236540d61a0808d00767c0973b`, model revision `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`, main model SHA-256 `730839...cf6aa`, and direct Python versions. [current Dockerfile](../../services/omnivoice-runpod/Dockerfile). The container still lacks a checked-in SBOM/transitive lock and does not checksum every model artifact separately.

## Which endpoint could be production?

There is conflicting first-party evidence:

- Historical operations docs identify `0t5ta1alo5nzqo` as the auth-fixed production endpoint, and checked-in `scripts/configure-hero-image-custom-route.ts` still writes that ID to `RUNPOD_OMNIVOICE_ENDPOINT_ID`. [RunPod staging runbook](../ops/runpod-ai-staging.md), [route configurator](../../scripts/configure-hero-image-custom-route.ts).
- The live account names `tkwkf5utqwt9ni` “production-v13-hero-voice-v2”; it was created 11 minutes after its GHCR image and has processed requests. No checked-in application/runbook file contains this endpoint ID.
- Both have `workersMax=1`, and both show historical jobs. Account state therefore proves both are callable, not which is consumed by Hostinger.

**Production routing is unknown until the running PM2 environments are read back.** File contents or endpoint names are insufficient because app code reads `RUNPOD_OMNIVOICE_ENDPOINT_ID` at runtime and persists the chosen endpoint into each accepted durable job. [provider config](../../src/lib/omnivoice.ts), [durable pinning](../../src/lib/hero-voice-generation.server.ts).

## Clone capability and source drift

### New v13 endpoint

The image tag names upstream baseline `565d0e6` and application build commit `f51eb32fff83d2ad88516b806e4ce61b626bde5f`. That worker tree is byte-for-byte identical to application merge commit `25916594ea3c05edc361a8f96d36eb1a11622d9d` and remains unchanged at current main. Its handler advertises `hero-voice-ai-v2-565d0e6`, parses `{contract_version:2, mode:"clone", ref_audio_b64, ref_text, text, ...}`, performs one-shot clone ranking, and returns the versioned v2 WAV response. Application commit `e212c92d32c33c6cb5b4fc1651255bfcf0c6afd3` later added the protected storage/UI/durable clone lifecycle without changing worker files. Therefore **the v13 image supports current-main clone mode contract v2**. [worker migration](https://github.com/Aoacademy2025/AI_content_Mew_social/commit/24fc72d99576da94bd93bf8827f7d5e351609c0d), [clone integration](https://github.com/Aoacademy2025/AI_content_Mew_social/commit/e212c92d32c33c6cb5b4fc1651255bfcf0c6afd3).

It is **not clone-only**. The image copies `assets/voices/`, validates exactly `voice_01`–`voice_48`, starts with `TTS_VOICE_IDS=""`, and `ENGINE.load()` registers the stock catalog before the worker becomes ready. The same handler accepts `mode:"tts"`. The account has no alternate image/template whose name or inspected config indicates a stock-free clone worker.

### Older v11 endpoint

The v11 source/runbook identifies worker contract `heroai-omnivoice-runpod-v6-all-voices-32`, Thai stock TTS at 32 steps. It predates the imported Hero Voice v2 worker. No first-party artifact inspected proves that it accepts contract-v2 clone requests; treat it as stock-only. It also has a material configuration drift: live `executionTimeoutMs=180000`, while current provisioning and v13 use 600000 and the durable application default budget is longer. [v11 audit](../audits/2026-07-24-hero-voice-v11-durable-queue-audit.md).

### Team branch and public upstream

Neither later code line is in the v13 live image:

- `origin/dev_waow` tip `f9701fd3e19ade21d5c5f96c88943472d771082b` adds/reworks Thai/Lao catalogs, eight Lao files, normalization/ASR/enhancement/watermark paths, and combined UI. It is not represented by the live tag/digest.
- Public `Aoacademy2025/Hero-Voice-Ai/main` tip `f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37` is six commits beyond the live image's `565d0e6` baseline. It likewise is not deployed on either enabled template. [source audit](2026-09-04-hero-voice-ai-source-audit.md).

Thus the live v13 candidate aligns with **application main's current worker**, not the later team-branch/upstream voice/catalog/UI changes.

## Drift, legacy resources, and exposure

1. **Routing ambiguity:** two production-named endpoints can each allocate one GPU. If different callers still reference both, the account can run two voice GPUs concurrently. `workersMin=0` limits idle exposure, but `workersMax=1` on both doubles the intended single-worker cap across the product boundary.
2. **Legacy endpoint remains enabled:** `0t5...` is not parked and uses the old v11 image and a 180-second execution limit. The other seven historical voice endpoints are safely parked at 0/0 but remain as legacy control-plane objects.
3. **Mutable deployment reference:** both enabled templates use tags rather than the observed OCI digest. There is no verifiable source/SBOM/provenance attestation attached to the template.
4. **Registry identity debt:** both enabled templates share `cms6...`; the July runbook says this credential should be replaced by a dedicated read-only `packages:read` token. Current scope/owner/expiry cannot be derived from its ID.
5. **No clone-only isolation:** v13 bundles all stock reference WAVs and exposes stock TTS in the same handler. This carries the stock-audio license/provenance blocker even if the UI hides stock voices.
6. **Capacity condition:** at the snapshot, v13 reported one throttled worker and no queue. Official RunPod documentation defines throttled as temporarily unavailable due to host resource constraints. This is an availability signal, not evidence of a broken image or a current charge.
7. **Live application state absent:** RunPod cannot prove deployed app commit, schema, feature flags, storage directory ownership, clone consent/UI exposure, or whether a background worker loaded the same environment.

## Read-only reproduction (sanitized)

Do not print raw responses: endpoint objects can contain account user IDs, worker environment values, registry references, and network information. Map only approved fields and environment **names**.

```bash
# Inventory; sanitize before display.
curl -fsS 'https://rest.runpod.io/v1/endpoints?includeTemplate=true&includeWorkers=true' \
  -H 'Authorization: Bearer $RUNPOD_API_KEY'
curl -fsS 'https://rest.runpod.io/v1/templates?includeEndpointBoundTemplates=true' \
  -H 'Authorization: Bearer $RUNPOD_API_KEY'

# Read-only queue/worker aggregate; never call /run or /runsync in an audit.
curl -fsS 'https://api.runpod.ai/v2/<ENDPOINT_ID>/health' \
  -H 'Authorization: Bearer $RUNPOD_API_KEY'

# GHCR package metadata; select only digest/tags/timestamps.
gh api '/users/mewic/packages/container/heroai-omnivoice/versions?per_page=100'
```

## Data required before a correct merge/rollout plan

1. Sanitized Hostinger readback from **every** voice-consuming PM2 process: deployed Git commit/build ID and values of `OMNIVOICE_BACKEND`, `RUNPOD_OMNIVOICE_ENDPOINT_ID`, `OMNIVOICE_ENABLED`, and `HERO_VOICE_CLONING_ENABLED`; report only allowlist presence/count, never IDs.
2. Read-only proof that the `UserVoice` schema exists and `USER_VOICE_STORAGE_DIR` resolves to a persistent owner-only directory outside `public/`; include retention/backup deletion policy, not any user/audio rows.
3. An explicit decision identifying one canonical endpoint. Only after queues and persisted jobs referencing the legacy endpoint are accounted for should a separate approved operation park it.
4. Pin the chosen template to `@sha256:317f...` or an equivalently immutable newly built image; publish SBOM, dependency lock, model-file hashes, and signed provenance/source revision.
5. Verify registry-auth identity `cms6...` is dedicated read-only GHCR access and has a rotation owner/expiry.
6. Resolve the OmniVoice model, wrapper, and bundled stock/reference-audio commercial rights from the companion source audit.
7. For the requested clone-only product slice, build a distinct stock-free handler/image and independent stock-off application gate. Do not merge `dev_waow` or public upstream wholesale.
8. After all gates, run a separately approved, budgeted clone canary; this audit deliberately submitted none.

Until items 1–7 are supplied, the safe merge plan is **no merge and no endpoint switch**: preserve current main's hardened v2 app contract, treat `tkw...` as a staging candidate, and do not infer production from resource names.

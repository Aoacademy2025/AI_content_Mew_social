# Hero Voice Clone Mew-first canary

## Goal

Deliver a reviewable feature-branch PR and a private, non-production RunPod canary that determines whether the team's combined clone-quality candidate is **acceptable and non-inferior** to the audited v13 baseline for Mew's own Thai voice. The evidence ends with a locked and then revealed 18-pair blind review in AI Studio, objective quality/cost/privacy readback, and Mew's explicit voice-approval gate.

A tie-heavy pass is evidence of acceptability/non-inferiority under the predeclared gate; it is **not** proof that the candidate improves quality. This plan does not merge the PR, deploy production, enable customers, test another person's voice, or add clone use to Video Editor, Story Film, or MCP.

## Evidence baseline

- The application already contains the hardened v2 clone lifecycle, but production has no stored `UserVoice`, no observed v13 clone job, and split-brain endpoint routing. See [source audit](../research/2026-09-04-hero-voice-ai-source-audit.md), [RunPod live audit](../research/2026-09-04-runpod-hero-voice-live-audit.md), and [production readback](../research/2026-09-04-hostinger-hero-voice-prod-readback.md).
- RunPod necessarily receives reference and generated audio inside a provider job. Its documented job/result/log lifecycle does not supply proof of immediate erasure, so real human audio has a separate processor/legal gate. See [RunPod payload-retention audit](../research/2026-09-04-runpod-serverless-payload-retention.md).
- Demucs and AudioSeal experiment behavior, immutable pins, sample-rate conversions, thresholds, and license gaps come from [primary-source enhancement/watermark research](../research/2026-09-04-clone-enhancement-watermark-primary-sources.md), not the comparison wrapper.
- `origin/dev_waow` and `Aoacademy2025/Hero-Voice-Ai/main` are evidence sources, not merge candidates. Clone existed before the recent team commits; stock-voice assets also changed. The claim “only clone was added” is false.
- The canary boundary and retention decision are recorded in [ADR 0060](../adr/0060-isolate-hero-voice-clone-canary.md). Use the domain terms in `CONTEXT.md`.
- The Mew-owned source pointer remains only in ignored `.tmp/hero-voice-clone-canary-reference.json`. Never copy its Drive identifier, content hash, reference bytes, generated voice audio, blind reveal key, or raw score sheet into Git, PR/CI artifacts, application logs, or a public URL.

## Fixed contracts

### Access policy and endpoint response matrix

One pure server policy owns the canary:

```text
isHeroVoiceCloneCanaryUser(actor) =
  HERO_VOICE_CLONING_ENABLED == "1"
  AND isInternalAiTester(actor)
  AND isOmniVoiceUserAllowed(actor) through OMNIVOICE_ALLOWED_USER_IDS
```

`role === "ADMIN"`, an email/domain wildcard, a browser flag, and knowledge of a route or identifier never grant access. `isInternalAiTester` and the existing ID allowlist are independent requirements. Suspended, deleted, or missing actors fail closed.

| Surface | Unauthenticated | Authenticated but policy denied | Policy allowed | Canary behavior |
|---|---:|---:|---:|---|
| AI Studio catalog / clone tab | `401` | `404` | `200` | Show clone only; do not advertise stock Hero Voice |
| `POST/GET /api/omnivoice/user-voices` | `401` | `404` | normal validation/`2xx` | This existing lifecycle path is AI Studio-owned during the canary even though its URL is not nested under `/api/ai-studio` |
| `GET/DELETE /api/omnivoice/user-voices/[id]` | `401` | `404` | owner result or owner-scoped `404`/`409` | Cross-account and nonexistent IDs are indistinguishable |
| `POST /api/ai-studio/voices` | `401` | `404` | accepted only for owned `user_*` ID | Stock IDs and non-owned IDs fail; no admin bypass |
| AI Studio clone job/status/review/audio routes | `401` | `404` | owner-scoped result | `Cache-Control: private, no-store`; opaque IDs only |
| `/api/omnivoice/voices` stock catalog | existing behavior | existing behavior | existing behavior | No canary access expansion or clone capability |
| Video Editor, Story Film, MCP | existing behavior | existing behavior | existing behavior | No clone routing or UI change |

Every clone-capable route and the durable generation function call the same policy. Tests enumerate the route inventory so a newly added clone route fails CI until classified.

### Provider identity and immutable job snapshot

The production-shaped application clone resolver is singular by design and accepts exactly these deployment inputs:

- `RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID`
- `RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST`
- `RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION`
- `RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256`
- `RUNPOD_API_KEY`

Before the first paid submission, a direct RunPod REST readback must prove that the named staging endpoint's template resolves to the expected immutable OCI digest. A mismatched or mutable image blocks the run.

Before provider submission, the application snapshots on both the durable job and the attempt: endpoint ID, `contract_version: 3`, `worker_kind: "clone-only"`, image digest, source revision, model-manifest hash, `experiment_profile`, `normalizer_version`, synthesis parameters, and a generated attempt ID. These live in a versioned allowlisted `inputJson` shape. They never contain reference bytes, a reference path, the reference transcript, base64, raw user identifier, secret, or provider credential. Poll/resume reads only this persisted snapshot; an environment change cannot migrate a job.

The 44-slot harness has three compile-time-discriminated runners over exactly two staging endpoints; it never rewrites the application resolver or points it at the baseline:

| Runner | Slots/path | Immutable identity and accepted response |
|---|---|---|
| `BaselineV13Direct` | 18 final baseline slots; harness calls the private audited-v13 staging endpoint directly | Dedicated baseline endpoint/template bound to audited OCI index/amd64 digest; request is exact contract-v2 clone `{contract_version:2,mode:"clone",ref_audio_b64,ref_text,text,speed,num_step,mixed_language:true}`. Accept only `contract_version:2`, `mode:"clone"`, `worker_version:"hero-voice-ai-v2-565d0e6"`, `catalog_version:"hero-voice-ai-v2-2026-08-24"`, valid finite `similarity_score`, and valid WAV metadata/audio. |
| `CandidateExperimentV3Direct` | 8 ablation slots; harness calls the candidate staging endpoint directly | Candidate endpoint/template/digest plus contract/source/model manifest. Accept only the exact contract-v3 success envelope and requested `control-v1` or matching single-delta profile. |
| `CandidateAiStudioV3` | 18 final candidate slots, including counted smoke; harness calls authenticated local AI Studio canary submit-by-slot route, which invokes the normal durable generation boundary | Same candidate endpoint/digest identity as the experiment runner; only `combined-quality-v1`. The route accepts an opaque predeclared slot ID—not endpoint/profile/text/seed—and loads the immutable server-side slot manifest. Shared policy, ownership, reservation, durable snapshot, poll, validation, and settlement all run normally. |

The local submit-by-slot route is enabled only when `NODE_ENV !== "production"`, the server is bound to loopback, `HERO_VOICE_CANARY_EXECUTION_MODE=1`, the authenticated actor passes shared policy and owns the reference, and the exact one-use submit HMAC defined below is valid. Otherwise it is `404`. Browser clients cannot choose a provider, endpoint, profile, text, seed, or normalizer. The harness supplies Mew's authenticated loopback session out of band; cookies/tokens never enter the ledger or Git.

Every direct harness slot snapshots runner kind, endpoint/template/image identities, request contract, expected response identity, profile, text hash, reference hash, seed support/value, and cost reservation in the append-only private ledger before dispatch. Every application slot additionally carries the durable job/attempt snapshot and settlement contract. Thus “every paid slot is pinned” does not falsely imply that baseline/ablation direct calls create application credit records.

For every slot, the client constructs one exact RunPod outer body `{input:<workerInput>,policy:{executionTimeout:540000,ttl:900000}}` as UTF-8 JCS bytes, computes private `wireRequestSha256`, and then feeds **that same immutable byte buffer** to both the verifier and `fetch`; it never rebuilds the body after commitment. Before dispatch, a strict duplicate-key-rejecting JSON parser parses those exact bytes and requires only the exact outer keys/values and runner-specific exact worker-input keys. It strictly decodes `ref_audio_b64`, hashes decoded audio and UTF-8 ref/final text, and derives the semantic descriptor from the parsed buffer—not a parallel request object. The descriptor replaces sensitive values with hashes and includes contract/mode, common settings, and every arm-specific field. The client compares it to the frozen slot manifest, then durably commits descriptor + wire hash in the HMAC-chained SQLite ledger before passing the already-verified buffer to `fetch`. Raw bytes/base64 are not persisted. Pair creation verifies the ledger HMAC and compares the authenticated parsed-buffer-derived descriptor to the frozen manifest/other arm; it does not pretend to reparse bytes that were deliberately not retained. Tests mutate each serializer/mapping field and prove pre-dispatch rejection.

`matchedSettings` is deliberately limited to `{speed,numStep,mixedLanguage,outputRate,outputChannels,outputSubtype}`. Seed support/value, profile, guidance, ranking, endpoint, contract, and worker identity remain explicit arm-specific experimental fields and are never claimed equal across v2/v3. The common settings hash is SHA-256 of UTF-8 JCS bytes. Audited v13 does not echo input text/settings; equality is proved by re-deriving both final-arm descriptors from the exact committed outbound byte hashes/buffers before dispatch and pair creation, plus validating every field the immutable v2 response does return. Contract v3 receives and must echo `request_commitment_sha256` and `matched_settings_sha256`; the worker recomputes the request commitment over JCS `{contractVersion,mode,refAudioSha256,refTextSha256,textSha256,speed,numStep,mixedLanguage,seed,experimentProfile,normalizerVersion}`. Pair creation rejects any parsed-buffer/descriptor/manifest mismatch, missing v3 echo, or output format disagreement.

The RunPod provider request is the explicit boundary exception: it necessarily contains `ref_audio_b64`, `ref_text`, and later returns generated audio. Only after the human-data gate below passes may the request be sent with:

```json
{"policy":{"executionTimeout":540000,"ttl":900000}}
```

The worker and caller remain at INFO-or-stricter payload-free logging. DEBUG is forbidden. No webhook, S3 output, network volume, or application persistence may copy the provider payload. A later `/status` `404` is recorded only as provider job unavailability; it must not be described as proof of deletion from RunPod logs, backups, performance records, or legal holds.

### Terminal failure and settlement matrix

All clone failures preserve the reference and set `retryable: false`. Terminal poll handling and reservation settlement are idempotent and happen at most once.

| Condition | Durable job/attempt | Reservation | Client status | Retry/fallback |
|---|---|---|---|---|
| unauthenticated/policy denied/voice not owned | none created | none | matrix above | none |
| clone config missing or identity config incomplete | none created | none | `503 CLONE_CONFIG_UNAVAILABLE` | none |
| reservation rejected | job `failed`; attempt `planned` then `failed` | release if created | terminal failure | none |
| `/run` explicitly rejected | job and attempt `failed` | release/refund exactly once | terminal failure | none |
| `/run` transport outcome unknown after dispatch | job and attempt `failed_unknown_submit`; entire paid run becomes terminal `NO-GO` | application reservation releases/refunds once, but cost ledger permanently commits the full 660-second upper bound | terminal failure | never resubmit; dispatch no later slot |
| timeout | job/attempt `failed_timeout` | release/refund exactly once | terminal failure | none |
| owner cancel | job/attempt `canceled` | release/refund exactly once | terminal canceled | none |
| known job: three consecutive poll transport failures (2/5/10-second backoff, each 20-second request timeout) | job/attempt `failed_poll_unavailable` | release/refund exactly once; external ledger keeps 660-second reserve | `503 CLONE_POLL_UNAVAILABLE` | one cancel attempt, then no generation retry |
| known job: malformed/unknown poll status or payload | job/attempt `failed_provider_status` | release/refund exactly once; external ledger keeps 660-second reserve | `502 CLONE_PROVIDER_STATUS_INVALID` | one cancel attempt, then none |
| known job: `/status` `404` or disappearance before valid terminal output | job/attempt `failed_provider_missing` | release/refund exactly once; external ledger keeps 660-second reserve | `502 CLONE_PROVIDER_JOB_MISSING` | one cancel attempt, then none; never call this deletion proof |
| cancel request rejected/unknown for a known job | retain original primary job/attempt failure; set orthogonal `cancelDisposition:"rejected_or_unknown"` | application release/refund once; external ledger keeps 660-second reserve through observation | original failure plus cancel disposition | none; drain/force-park |
| endpoint/contract/build/model/profile identity mismatch | job/attempt `failed_identity` | release/refund exactly once | terminal failure | none |
| malformed envelope, invalid WAV, empty audio, or oversize output | job/attempt `failed_output` | release/refund exactly once | terminal failure | none |
| valid terminal audio | job/attempt `completed` | settle exactly once | completed | none |

No row falls back to stock Hero Voice, shared v13, Gemini, Hostinger, another RunPod endpoint, or another voice. A canceled or failed attempt may be inspected, but automated and manual-in-place retry are disabled; a separately authorized future experiment would require a new plan and ledger.

An unknown submission or known job with unreadable state may still be live and billable. The harness stops the complete run, keeps that slot's full conservative cost reserved, makes no further `/run` call, attempts cancel once only when a job ID exists, and records cancel result in the orthogonal disposition without replacing primary job state. It immediately sends the force-park mutation `workersMin=0, workersMax=0`, then polls aggregate endpoint health/readback every 10 seconds. The final observation deadline is exactly 660 seconds after the durable pre-dispatch timestamp; the first park request must occur no later than timestamp +600 seconds, leaving its full 60-second grace inside the reserve. If empty/parked readback cannot be confirmed, retain primary job state, set canonical `runState:"aborted_no_go"`, and set only the orthogonal `parkDisposition:"unconfirmed"`; dispatch stays permanently disabled and the report records unresolved provider/billing disposition. A `/status` `404` or health/park readback is never described as provider erasure.

Preflight requires written/provider evidence that the 540-second execution limit plus 60-second idle window and 60-second forced-park grace cap billable worker time at 660 seconds even without a usable job status; otherwise no paid run. Crash tests prove restart cannot dispatch another slot after any unknown/unreadable/cancel/park condition. Application credits and the external cost ledger are deliberately separate: releasing an unusable user reservation never erases the possible RunPod charge.

### Reproducible experiment profiles

All four ablation pairs use the same candidate image, GPU class, pinned OmniVoice source/checkpoint, 24 kHz mono PCM16 output, `speed: 1`, `num_step: 32`, three internal synthesis candidates, `temperature: 0.8`, and a recorded 31-bit seed shared within each pair. Non-enhancement controls preserve audited-v13 reference preprocessing without peak normalization; the named team enhancement treatment includes both Demucs cleanup and peak `0.95` normalization. The final comparison intentionally uses the audited-v13 baseline image versus the candidate image. It holds text/speed/steps/output class constant, but v13 cannot accept a seed; that fixed limitation and the distinct repeat design are declared below and pair order remains randomized.

The candidate image contains a faithful `control-v1` adapter so every single-delta ablation shares hardware, image, dependency, serialization, and evaluator conditions. Before ablation, parity fixtures must show that `control-v1` matches audited v13 request normalization, prompt path, generation parameters, selection rule, output format, and error behavior. Any unavoidable mismatch is listed; a material mismatch blocks causal interpretation and paid ablation.

| Profile | Exact pipeline delta from `control-v1` | Predeclared ablation script |
|---|---|---:|
| `control-v1` | Application-provided `speechText`; no Demucs; guidance `2.5`; best of three by maximum speaker cosine; no watermark | paired control for every row |
| `reference-enhancement-v1` | Demucs code `e976d93ecc3865e5757426930257e200846a520a`, exact signature `955717e8`, pinned checkpoint hash, and hash-pinned metadata-only torchaudio compatibility patch; `shifts=0`, `split=true`, `overlap=0.25`, `segment=7`; take the in-memory 44.1 kHz stereo `vocals` stem, mean-downmix to mono, apply the team's peak `0.95` enhancement policy, then resample once to 24 kHz; fail closed | script 1 |
| `text-normalization-v1` | Use the pinned team deterministic dictionary/transliteration and Thai number/currency normalizer; Gemini/network rewrite disabled; the harness computes and records final `speechText`, the worker performs no hidden rewrite | script 3; script 2 is covered by golden number/currency fixtures and the final matrix |
| `guidance-ranking-v1` | Guidance `2.0`; rank the same three candidates by `speaker_cosine + 0.15 * pitch_similarity_normalized`; pitch uses pinned `librosa.pyin` over `C2:C6`; invalid/unvoiced pitch fails the profile | script 5 |
| `watermark-v1` | AudioSeal `0.2.0`, official source `e63a8a0e5cdf7bb797159c92ba15961557fe9bd2`, model revision `3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba`, locally hash-verified 16-bit generator/detector; convert final output to mono 16 kHz, embed fixed manifest message at `alpha=1.0`, then resample to 24 kHz; detection reconverts to mono 16 kHz with frame/message thresholds `0.5`, and reference-positive iff `detect_fraction > 0.5`; preserve duration and fail closed | script 4 |
| `combined-quality-v1` | team `speechText` → pinned deterministic Demucs reference path → OmniVoice prompt → three candidates at guidance `2.0` → similarity/pitch ranking → validate 24 kHz PCM16; **no AudioSeal**, so the final blind arms are both unwatermarked | all six final scripts |

The entire immutable slot manifest is canonicalized and hashed before payment. Ablation pair seeds are respectively `20260901`, `20260902`, `20260903`, and `20260904`. Final repeat seeds are `104729`, `130363`, and `155921`, reused for scripts 1–6 in repeat order. Candidate contract-v3 slots carry those explicit seeds. Audited v13 contract v2 has no seed field, so baseline slot manifests record `seedSupport:"unsupported-v2"` and `seed:null`; the three baseline calls are distinct stochastic repetitions but cannot be paired-randomness matches. That limitation is shown in the review report and no causal claim relies on final pair seed equality.

Before payment, the manifest also stores for each of the six scripts: the literal UTF-8 source text, source SHA-256, the literal deterministic team-normalized final `speechText`, its SHA-256, normalizer name/version/source revision, and a settings SHA-256 over JCS canonical `{speed,numStep,mixedLanguage,outputRate,outputChannels,outputSubtype}`. The same final `speechText` bytes and settings are sent to audited-v13 baseline and `combined-quality-v1` candidate for each `scriptId`; canonical CER uses those exact bytes as expected text. Normalization benefit is therefore measured only in its single-delta ablation/golden fixtures, while the final 18 pairs isolate the remaining clone-audio pipeline at matched text. Any post-freeze string, hash, normalizer, or settings change invalidates the manifest and requires a new approval before payment.

The eight ablation jobs are exactly four two-output pairs: one `control-v1` and one corresponding single-delta profile for the predeclared script and shared seed. They are exploratory fault-isolation evidence, not statistical proof. Before the final phase, every ablation output must be a valid/playable mono 24 kHz PCM16 WAV and have raw canonical CER ≤0.10. In addition:

- enhancement treatment must report the exact Demucs pins/parameters, a nonempty `vocals` stem, a treatment reference hash different from the canonical input, and output reference duration within one 24 kHz sample of control after the shared normalization/resample policy;
- normalization treatment must return the predeclared normalized `speechText` and normalizer version byte-for-byte, with golden number/currency/transliteration fixtures already green;
- guidance/ranking treatment must expose three candidate hashes/scores and select exactly the index obtained by an independent recomputation of the declared formula;
- watermark control must have `detect_fraction <= 0.5`; watermark treatment must have `detect_fraction > 0.5`, the fixed message/threshold/alpha identities, and delivered duration within one 24 kHz sample of its pre-embed master.

The official AudioSeal `>0.5` clip rule is a fixed experiment reference, not a Thai-calibrated operating point or a guaranteed false-positive rate; production use needs a separate calibration/held-out set. No profile may silently degrade or skip a requested stage. Any failed predicate stops before the 36 final jobs.

Watermarking is a safety/provenance ablation, not part of the voice-quality blind candidate. All 36 final files are deliberately unwatermarked. Before opening review, the pinned detector must classify both sides of every pair negative (`detect_fraction <= 0.5`); if either side is positive, the pair could leak arm identity and the entire review remains closed/`NO-GO`. AudioSeal production adoption requires a separate calibration and a design that applies the same disclosure/provenance policy across compared outputs.

### Paid ledger and cost breaker

The run-level state machine is `planned → running_ablation → running_baseline → running_candidate → reviewable`, with terminal alternatives `aborted_no_go` and `completed_no_go`. Restart may resume only a known provider job ID or the next untouched slot from a nonterminal state; it may never reopen a terminal state.

| Slot/preflight outcome | Run action | Later dispatches |
|---|---|---|
| policy/data/license/identity/rate/budget/privacy preflight fails before `/run` | `aborted_no_go` | none |
| transport-unknown submit | reserve full 660-second cost; `aborted_no_go`; observe/drain/park | none |
| known job reaches poll-unavailable, malformed/unknown status, `/status` `404`/missing, or cancel-unconfirmed | release application reservation once, keep full external reserve, `aborted_no_go`, observe then force-park | none |
| endpoint cannot be confirmed empty/parked by the 660-second deadline | retain prior job result; `runState:"aborted_no_go"`, `parkDisposition:"unconfirmed"`; record unresolved disposition | none, including after restart |
| known provider rejection/`FAILED`/`TIMED_OUT`/`CANCELLED`, owner cancel, endpoint identity mismatch, settlement failure, malformed envelope, invalid/empty/oversize WAV, stage/predicate failure, privacy leak, or final watermark-detector side channel | settle per slot table; `aborted_no_go`; cancel only known current canary job if still active, then drain/park | none |
| ablation WAV has CER `>0.10` | ablation predicate failure; `aborted_no_go`; park | none |
| final-baseline WAV is valid but CER `>0.10` | record diagnostic baseline intelligibility failure | continue while safety/cost breakers pass; baseline has no CER promotion threshold |
| first final-candidate WAV with CER `>0.10` | record the one permitted candidate quality failure | continue while safety/cost breakers pass |
| second final-candidate WAV with CER `>0.10` | candidate can no longer reach `17/18`; `aborted_no_go`; park | none |
| 44 provider-accepted jobs yield 44 valid WAVs but candidate CER passes `<17/18` or another objective gate fails | `completed_no_go`; no blind review | none |
| 44 provider-accepted jobs yield 44 valid WAVs, candidate CER passes `>=17/18`, both final arms detector-negative, and all other gates pass | `reviewable` | none; review only |
| post-review score/critical-flag gate fails | terminal `completed_no_go` | no generation |

Thus every technical/provider/safety failure is an enumerated abort breaker. CER continuation depends exactly on phase/arm and remaining mathematical eligibility. Tests cover dispatch/restart count for every table row.

The dry-run creates exactly 44 immutable slot IDs before payment:

- 8 ablation submissions: four `control-v1`/single-delta pairs.
- 18 audited-v13 baseline submissions: six scripts × three repeats.
- 18 `combined-quality-v1` candidate submissions: six scripts × three repeats.

`final.candidate.script-01.repeat-01` is also the end-to-end smoke. It is job slot 27 in the prebuilt ledger (after eight ablation and eighteen baseline slots), not a 45th request. The harness starts that counted candidate slot first within the final phase, validates it, then continues the remaining candidate slots. A slot consumes one unit of the 44 ceiling when its durable `dispatch_intent` is written, even if the process crashes before the network write can be proven. No retry or replacement slot exists. A missing/unknown/invalid final output makes the complete final pack unavailable and the run `NO-GO`.

A **reviewable completed evidence run** has exactly 44 distinct `dispatch_intent` records, 44 provider-accepted job IDs, 44 valid terminal outputs (8+18+18), zero provider rejections, and zero transport-unknown slots. Fewer intents or accepted jobs are valid only for an early terminal `aborted_no_go`; an aborted run can never satisfy the acceptance gate. More than 44 ceiling-consumed slots is forbidden.

The ledger is an owner-scoped append-only `CanaryLedgerRecord` table in the same marked SQLite. Each record HMAC is over UTF-8 JCS `{version:1,runId,sequence,previousRecordHmac,record}` with the per-run ledger key; sequence starts at 1 and the initial previous HMAC is 64 zeroes. One `synchronous=FULL` SQLite transaction inserts the next record and updates the run's sequence/head HMAC; triggers reject update/delete outside the explicit review-close/account-delete coordinator. Verification rejects gaps, reordering, mutation, or truncation. The ledger durably commits `dispatch_intent` before the network call, then appends exactly one of: `provider_accepted(jobId)`, `provider_rejected`, or `transport_unknown`. On restart, a known job ID is reconciled; an intent without authoritative provider response is permanently `transport_unknown`, consumes a ceiling slot/full reserve, aborts, and is never resubmitted. It is not relabeled “sent” or “not sent.” At most one canary request may be in flight.

The final report has two orthogonal exact partitions and conservation checks. Submission partition: `planned_slots = not_started + provider_rejected + transport_unknown + provider_accepted`, and `dispatch_intents = provider_rejected + transport_unknown + provider_accepted`. Accepted-outcome partition: `provider_accepted = valid_completed + provider_terminal_failed + accepted_outcome_unknown + application_validation_failed`. `accepted_outcome_unknown` contains accepted jobs whose final provider result cannot be learned because poll/status/cancel evidence failed; it is not mislabeled provider failure. The report also gives `possible_provider_received` interval `[provider_accepted + provider_rejected, provider_accepted + provider_rejected + transport_unknown]` and never invents an exact submitted count.

Primary job/attempt outcome is append-only and never overwritten. `cancelDisposition` is orthogonal (`not_requested|confirmed|rejected_or_unknown`) and `parkDisposition` is run-level (`not_required|confirmed|unconfirmed`). A poll/status failure remains its original job state even when cancel is unconfirmed; park-unconfirmed changes only the run disposition. Crash reconciliation preserves these fields and equations. The smoke is identified solely by immutable slot ID, consumes at most one ceiling unit, and appears in exactly one submission category and—if accepted—one accepted-outcome category.

Before `--apply`, select exactly one GPU type for both endpoints and freeze its official rate as integer USD micros per billed second with authoritative source/account readback timestamp. Reserve 660 billed seconds per possible submission: 540 seconds execution, 60 seconds startup/idle, and 60 seconds forced-park grace. Define `non_gpu_reserve_micros` as the rounded-up sum of every marginal external charge from candidate/baseline/evaluator image publication and endpoint creation through forced parking: endpoint/control-plane base time, registry storage and worst-case 44 cold-pull egress, provider storage/network volume, build service, and any fixed fee. A component may be zero only with an authoritative pricing/account readback; local owned-hardware work is listed separately as zero marginal external charge. Ongoing registry storage is allowed only if account readback proves zero marginal cost within an included quota; otherwise paid execution blocks until a separately approved bounded deletion/retention action exists. The preflight requires:

```text
44 * 660 * rate_usd_per_second + non_gpu_reserve_usd <= 10 USD
```

Before every dispatch, require:

```text
committed_upper_bound =
  measured_or_reserved_cost_of_submitted_slots
  + 660 * rate_usd_per_second * remaining_mandatory_slots
  + remaining_non_gpu_reserve_usd
  <= 10 USD
```

All arithmetic uses integer micros and rounds up per component. The cost interval begins before the first marginal image upload/endpoint creation and ends only after both endpoints read back parked and all nonzero-retention resources reach their predeclared bounded cleanup point. Queue/startup/observation time is assumed billable unless authoritative evidence proves otherwise. If any component or unknown-submit tail cannot be bounded, the rate changes, or continuing would leave insufficient budget for every remaining mandatory slot, stop before submission and mark `NO-GO`. The job ceiling remains 44 and the absolute cost ceiling remains US$10.

### Canonical Thai CER

The evaluator is a separate offline, CPU-only `linux/arm64` OCI image run without emulation on this Apple-silicon Mac. No other architecture is permitted for this canary. Before payment, record its immutable OCI index/arm64 digest, digest-pinned base image, fully hash-locked Python/transitive dependencies, FFmpeg package/build identity and binary SHA-256, and source revision in the slot manifest. It includes:

- package: `openai-whisper==20250625`
- model: local `large-v3-turbo.pt`
- model SHA-256: `aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a`
- no model/package/network download at runtime; network-blocked cold start must pass
- exact conversion argv: `ffmpeg -nostdin -hide_banner -loglevel error -threads 1 -i INPUT -map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le -f s16le -fflags +bitexact -flags:a +bitexact -map_metadata -1 OUTPUT.pcm`
- the evaluator reads little-endian signed 16-bit PCM, converts deterministically to float32 by division by `32768.0`, and passes the array—not a path—to Whisper so no hidden second decoder runs
- decoder: language `th`, task `transcribe`, temperature `0`, beam size `5`, `condition_on_previous_text=false`, `fp16=false`
- device/runtime: CPU only; `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, PyTorch intra/inter-op threads `1`, seed `0`, deterministic algorithms enabled, and no CUDA/MPS

Expected text is the exact final `speechText` sent to synthesis, not the display caption. Normalize expected and recognized text with Unicode NFC then `casefold`; retain only Unicode categories Letter, Mark, and Number, removing whitespace and all other characters. Compute Levenshtein distance over Unicode code points divided by normalized expected length. Empty normalized expected text is a fixture/configuration error; empty actual text is CER `1.0`. Compare the raw, unrounded value to `0.10`. Golden fixtures cover Thai marks, punctuation, Arabic/Thai digits, English product names, currency, empty actual, and invalid empty expected.

The scoring-runtime fingerprint is JCS/SHA-256 over: host architecture and CPU brand, container platform and `uname -m`, emulation-disabled readback, CPU-flags hash, container-runtime version, libc version, FFmpeg version/binary hash, Python version, dependency-lock hash, PyTorch build-config hash, NumPy/BLAS config hash, model hash, evaluator image digest, thread variables, and determinism settings.

There are exactly two scoring batches: `ablation-8` before any final dispatch and `final-36` after final generation. For **each** batch, on the actual scoring Mac/container, run the fixed non-sensitive WAV fixture in three fresh processes immediately before scoring and require byte-identical JCS transcript/CER hashes; freeze a new `evaluatorBatchId` plus runtime fingerprint; score the declared 8 or 36 files without host/container restart; then rerun the three-process fixture immediately and require identical hashes/fingerprint. Any architecture/runtime mismatch, restart, fingerprint drift, non-identical fixture result, extra/missing file, or cross-batch result reuse blocks the decision. Every CER record carries batch kind/ID, fingerprint hash, image/model/FFmpeg hashes, input audio hash, expected-text hash, and raw result. Thus the ablation CER payment gate and final 17/18 gate have the same reproducibility standard.

All 18 baseline and all 18 candidate final WAV files must exist, parse, and be playable before blind review. At least 17/18 candidate outputs must have raw CER ≤10%; nevertheless, any missing or invalid final file blocks creation of the 18-pair pack. The denominator never shrinks below 18.

### Private review store, lock, and reveal

The review and counted AI Studio jobs run only in one local Next.js application built from the feature worktree and bound to `127.0.0.1`. One named non-production SQLite file under `HERO_VOICE_CANARY_ROOT` contains the application user, reference, credit/reservation/job/attempt, and `ReviewRun` rows so account deletion is a single database transaction—not a cross-database promise. `DATABASE_URL`, `HERO_VOICE_CANARY_ROOT`, and `USER_VOICE_STORAGE_DIR` must be explicit absolute canary paths outside the repository, production paths, and every web/static root. Startup resolves realpaths, requires owner-only non-symlink paths (`0700` directories, `0600` files), and rejects path escape or a database containing any non-canary marker.

Authentication uses a non-production Clerk test instance only: test-key prefixes, issuer/JWKS host allowlist, and a canary audience are validated at startup; live/production keys or issuer are rejected. After Mew authenticates, a bootstrap command creates exactly one local canary user bound to that test subject with an isolated finite canary credit balance. It does not copy a production user row, balance, subscription, credential, or asset. External billing/webhooks are disabled. The immutable run manifest records only database/storage realpath hashes, canary schema/marker, auth issuer/audience and key fingerprints, credit-policy version, and startup readback—never DSNs, keys, cookies, raw subject, or user ID. The counted smoke cannot start unless these non-production bindings pass.

`HERO_VOICE_CANARY_REVIEW_KEY` is 32 random IKM bytes supplied as unpadded base64url out of band and never persisted in the database/repo. Key derivation is HKDF-SHA-256 per RFC 5869: root salt is `SHA-256(UTF8("hero-voice-canary/v1/root-salt"))`; HKDF-Extract uses that 32-byte salt and IKM. HKDF-Expand produces 32-byte keys. Owner info is exact UTF-8 `hero-voice-canary/v1/owner-hmac`. Per-run reveal, score, ledger, and submit info are respectively UTF-8 `hero-voice-canary/v1/reveal-aes-256-gcm`, `hero-voice-canary/v1/score-hmac-sha256`, `hero-voice-canary/v1/ledger-hmac-sha256`, or `hero-voice-canary/v1/submit-hmac-sha256`, followed by one zero byte and UTF-8 `runId`. HMACs are HMAC-SHA-256 serialized as 64 lowercase hex. AES-256-GCM uses a 96-bit random nonce and 128-bit tag; envelope ciphertext excludes its separately stored tag.

Owner-HMAC input is the exact UTF-8 JCS bytes of `{version:1,authIssuer,authSubject}` where both strings are byte-for-byte verified JWT claims—no trim, case-fold, or Unicode normalization. Account deletion receives the same verified issuer/subject before deleting the local user and recomputes the stable HMAC.

Loopback submit authentication uses the per-run submit key over exact UTF-8 JCS `{version:1,runId,slotId,revision,slotManifestSha256,submitNonce,issuedAtMs,expiresAtMs}`. `submitNonce` is a random 128-bit unpadded-base64url value frozen per slot; expiry is exactly five minutes after issue. The server checks canonical bytes, 64-lowercase-hex HMAC in constant time, loopback/auth/policy/ownership, manifest/revision, and clock window, then atomically marks the nonce used in the same SQLite transaction that creates the durable job/reservation. Replay, expiry, mismatch, or a second use returns owner-scoped `404` and creates no job/charge.

The private run store persists only: opaque random `runId`; HMAC of owner ID (not raw ID/email); random pair/audio tokens; allowlisted basenames; run state/revision; 18 side choices and `flagsBySide`; encrypted reveal ciphertext/nonce/tag; locked score-sheet HMAC; sanitized metrics and audio. Writes use temp file → file `fsync` → atomic rename → directory `fsync`. Mutations require `If-Match` revision to prevent lost updates.

At run creation, the harness builds an RFC 8785 JSON Canonicalization Scheme reveal plaintext with exactly:

```json
{
  "version": 1,
  "experimentId": "opaque-public-id",
  "slotManifestSha256": "...",
  "pairs": [
    {
      "pairId": "...",
      "comparisonKey": "script-01/repeat-01",
      "scriptId": "script-01",
      "repeatId": "repeat-01",
      "speechTextSha256": "...",
      "settingsSha256": "...",
      "A": {"arm": "baseline-v13", "slotId": "...", "audioSha256": "..."},
      "B": {"arm": "combined-quality-v1", "slotId": "...", "audioSha256": "..."}
    }
  ]
}
```

There must be 18 unique pair IDs and comparison keys. Each pair must join the baseline and candidate slots for the same predeclared `scriptId` + `repeatId`; both slots must match the pair's literal final `speechText` hash and synthesis-settings hash. Randomization changes only pair presentation order and whether baseline is side A or B. Every final slot/audio hash must appear exactly once and no ablation slot may appear. These predicates run at creation, lock, and reveal.

The canonical plaintext is AES-256-GCM encrypted with a random 96-bit nonce and 128-bit tag. AAD is the exact UTF-8 JCS byte string of `{version:1,experimentId,runId,slotManifestSha256}`. The private ciphertext envelope is exactly `{version:1,alg:"A256GCM",aadSha256,nonce,ciphertext,tag}`; `aadSha256` is 64 lowercase hex, while nonce/ciphertext/tag are unpadded RFC 4648 base64url strings and ciphertext excludes the tag. Its serialized bytes are UTF-8 RFC 8785 JCS with no BOM or trailing newline. `revealCiphertextSha256` is 64 lowercase hex SHA-256 of those exact bytes.

Before review opens, freeze the remote authority as GitHub repository `Aoacademy2025/AI_content_Mew_social`, canonical HTTPS URL `https://github.com/Aoacademy2025/AI_content_Mew_social.git`, its GitHub repository database/node ID read through the authenticated API, and ref `refs/heads/mewic/hero-voice-clone-prod-audit`; an origin URL/host/repository-ID mismatch blocks review. Write exactly one non-sensitive file at `docs/research/hero-voice-clone-canary/reveal-commitments/<experimentId>.json`. Its entire Git blob is the no-newline UTF-8 JCS bytes of exactly `{"version":1,"experimentId":"<opaque-public-id>","revealCiphertextSha256":"<64-lowercase-hex>"}`—no extra fields.

Commit and push it only to that ref. Read the ref's commit SHA back from the expected GitHub repository API, fetch that exact commit from the canonical remote, resolve `<commit>:<path>` to its blob object, read the blob bytes, and verify them byte-equal the expected commitment. The private store records repository database/node ID and canonical URL, ref, commit SHA, repository object-format-qualified blob OID, path, and SHA-256 of blob bytes. Lock/reveal requery the same repository ID and verify that recorded commit+blob as the immutable authority, not the moving branch head; any mismatch blocks review. The ciphertext itself, nonce/tag, mapping, pair IDs, slot IDs, and audio hashes remain private. Randomized encryption makes the public digest resistant to brute-forcing the finite side mapping.

Routes are:

```text
GET  /api/ai-studio/voice-clone-canary/runs/[runId]
GET  /api/ai-studio/voice-clone-canary/runs/[runId]/audio/[token]
PUT  /api/ai-studio/voice-clone-canary/runs/[runId]/scores/[pairId]
POST /api/ai-studio/voice-clone-canary/runs/[runId]/lock
POST /api/ai-studio/voice-clone-canary/runs/[runId]/reveal
POST /api/ai-studio/voice-clone-canary/runs/[runId]/close
```

The score body is exactly `{choice:"A"|"B"|"tie", flagsBySide:{A:string[],B:string[]}}`, with flag values restricted to `wrong_identity`, `missing_text`, `severe_distortion`, and `privacy_anomaly`. Lock requires exactly 18 complete condition-matched pair records and verifies the exact ciphertext-envelope bytes/digest against the commitment at the recorded remote Git object. It writes an HMAC over JCS canonical `{version,experimentId,slotManifestSha256,revealCiphertextSha256,scores}` and makes scores immutable. Reveal is allowed only from `locked`: verify the recorded Git object/commitment and locked HMAC, reserialize and verify the envelope digest, verify AAD hash, decrypt, then validate the exact condition-matched bijection/schema against frozen slots/audio hashes. No new commitment may be pushed after review enters `reviewing`; tests compare the recorded Git object ID. State transitions are one-way: `collecting → reviewing → locked → revealed → closed`.

Authenticated owner `close` requires `If-Match` and normally follows `revealed`; it triggers the crash-recoverable review-artifact quarantine/delete protocol and emits a sanitized receipt. The approved direct-output lifecycle continuation also permits `collecting → closed` for a never-dispatched `planned` run, or a terminal `aborted_no_go`/`completed_no_go` run with confirmed parking. These early closes require no in-flight slot or active application job, never fabricate listening aggregates, and retain the same sanitized `ReviewRun` row. They do not permit skipping lock/reveal on an open blind review (`preparing`, `reviewing`, or `locked`); an active or unconfirmed-park run cannot use this path. An account-hard-delete system call may force-close owner-HMAC-matched runs from any state using the same protocol. Before lock, the API/DOM/source maps/network payloads/filenames/order/timing-visible metadata contain no endpoint, arm, digest, profile, provider job ID, or reveal information. Another otherwise eligible user receives owner-scoped `404`.

### Privacy inventory, teardown, and deletion recovery

Before human audio, tests seed unique synthetic sentinels in reference bytes, transcript, raw user ID, secret, filesystem path, and fake base64. A finite scanner checks: Git diff and tracked files; `.next`; application and worker logs; exception messages; local SQLite rows; durable `inputJson` and attempt records; telemetry export; pre-lock API payloads/DOM/source maps; build/provenance/SBOM manifests; and PR/CI artifact manifests. Each public/API schema has an explicit allowlist so an added field fails tests. A human also inspects RunPod endpoint logs after the canary because provider-side logs cannot be proven by the local scanner.

The provider request payload is documented as the one required external copy after the RunPod gate; the privacy claim is therefore “no application/PR/public/log copy and bounded provider handling,” never “RunPod receives no audio.”

Immediately after generation—before listening/reveal—the two staging endpoints are drained and parked at `workersMin=0` with no running workers; templates/digests and private audio stay available only as needed for review. INFO-only logging is re-read. Eventual provider `/status` unavailability is recorded without claiming cryptographic erasure.

Application-controlled generated canary WAVs, encrypted reveal, and raw score sheet remain in the private review store only until Mew separately closes the evaluation. Closing performs an idempotent quarantine/delete and writes a sanitized receipt; only aggregate sanitized findings may enter Git. The receipt/final report separately states the provider-side retention/deletion disposition established by the written RunPod gate and never claims provider erasure without independent evidence. The approved application reference is different: it persists until authenticated owner deletion or account hard-delete, as requested.

Owner voice deletion, owner review-close, and account hard-delete use `DeletionTransaction` and `DeletionArtifact` tables in the same marked canary SQLite database; there is no second database or authoritative filesystem journal. A coordinator lock serializes mutations. Transaction A commits a `planned` row with operation kind, intended terminal outcome, temporary scope linkage, and artifact rows containing only opaque storage keys/expected hashes before the first move. `synchronous=FULL` makes that commit the durable intent boundary; the deterministic quarantine path derives from transaction/artifact IDs.

The coordinator then moves each file and commits that artifact's progress in SQLite. A crash after a move but before its progress transaction is recoverable because startup checks both planned source and deterministic quarantine target. After every planned artifact is present in quarantine and directories are `fsync`ed, Transaction B performs the exact application row mutations below, sets `db_committed`, links the sanitized receipt, and atomically scrubs temporary user/voice/run scope linkage where the authoritative row is deleted. Only then are quarantine files unlinked. Transaction C marks `done` after absence readback. No API reports close/delete success until `done` and no unresolved intent remains.

Each operation has one authoritative terminal outcome:

- **single-voice delete:** delete the `UserVoice` row and reference bytes; retain only an unlinked sanitized transaction receipt with transaction ID, opaque artifact hashes, timestamps, and outcome—no user/owner/voice identifier;
- **owner review close:** retain the canary-database `ReviewRun` row with `state:"closed"`, revision, sanitized aggregates, and receipt ID, but clear owner-accessible raw scores/mapping; delete the application-controlled WAVs, private ledger, and reveal ciphertext;
- **account hard-delete:** in one SQLite transaction delete the canary application user, all `UserVoice`/job/attempt/credit rows, and every owner-HMAC-matched `ReviewRun` row, then delete all their application-controlled files; retain only the same unlinked sanitized transaction receipt.

If Transaction B fails/rolls back, restore files and mark the intent rolled back; if it commits, never restore—finish unlink/Transaction C. Reconciliation inspects operation kind and exactly one authority in that database: voice-row existence for single delete, `ReviewRun.state` for owner close, or canary-user existence for account delete. It never uses original filenames. The invariants are respectively: no voice row/bytes; retained closed sanitized run with no private artifacts; or no user/voice/review/job/credit rows and no application-controlled bytes. Account hard-delete computes owner HMAC before Transaction A and includes all matched runs from any state. `PRAGMA foreign_keys=ON`, chosen WAL/rollback mode, `synchronous=FULL`, commit, and readback are fixed/tested. At process startup the coordinator reconciles every nonterminal deletion transaction before auth bootstrap, generation, review mutation, or another delete/close; failure keeps the application read-only. Tests crash before/after Transactions A/B/C, each move, each progress commit, and each unlink, and prove no second DB/auth/storage authority plus no successful response with an unresolved intent. Single-voice delete preserves `409 USER_VOICE_IN_USE` while an active job exists.

## Task 1 — Enforce one AI Studio clone-canary policy

**Files:** `src/lib/omnivoice-policy.ts`, `src/lib/internal-ai-access.ts` (reuse only), AI Studio catalog/voice routes and UI, `/api/omnivoice/user-voices/**`, policy verifier/tests, `docs/ops/hero-voice-clone-rollout.md`.

**Interface:** implement `isHeroVoiceCloneCanaryUser(actor)` and the exact response matrix above.

- [ ] Replace every clone-specific `ADMIN` check with the shared three-way intersection; inventory every route and internal generation entry point.
- [ ] Render the AI Studio clone tab/catalog only for the allowed account, with stock Hero Voice withheld from this canary surface.
- [ ] Accept only an owned `user_*` voice from `POST /api/ai-studio/voices`; recheck policy and ownership inside durable generation.
- [ ] Preserve stock `/api/omnivoice/voices`, Video Editor, Story Film, and MCP behavior.
- [ ] Test flag/internal/ID/admin/suspended/missing matrices, `401`/`404` behavior, owner isolation, direct-route calls, and route-inventory completeness.
- [ ] Replace obsolete admin-only rollout text with ADR 0060 and state that production remains out of scope.

## Task 2 — Pin identity and make settlement terminal

**Files:** `src/lib/omnivoice.ts`, `src/lib/hero-voice-generation.server.ts`, existing durable job/attempt/credit modules and schema/migration only where necessary, AI Studio job status, runtime verifiers, env documentation, rollout docs.

**Interface:** a deep `heroVoiceCloneConfig()` resolver, versioned snapshot schema, provider identity validation, and the terminal matrix above.

- [ ] Resolve clone vs stock before provider config; clone uses only the five clone inputs and stock continues using only `RUNPOD_OMNIVOICE_ENDPOINT_ID`.
- [ ] Persist endpoint/build/model/profile/normalizer snapshot on job and attempt before dispatch; resume uses only the snapshot.
- [ ] Implement the three typed runner schemas without letting baseline/ablation direct runners reuse or weaken the application clone resolver; validate each exact v2/v3 response identity.
- [ ] Send explicit RunPod `executionTimeout` and TTL policy, but only after Task 6's human-data gate.
- [ ] Reject wrong worker/contract/digest/source/model/profile and every malformed audio result terminally.
- [ ] Implement idempotent at-most-once reservation release/settle for every table row; on unknown dispatch retain the full external cost reserve, terminate the complete run, drain/park without any later dispatch, and disable automated/in-place retry/fallback.
- [ ] Prove no reference data enters durable state, response schema, telemetry, logs, or exceptions.
- [ ] Test crash/resume at reservation, pre-dispatch, unknown-dispatch, accepted-job poll transport exhaustion, malformed/unknown poll state, status `404`, cancel-unconfirmed, park-unconfirmed, validation, and settlement boundaries; assert both conservation equations and non-overwriting job/cancel/park precedence.

## Task 3 — Build the clone-only contract-v3 service

**Files:** new `services/omnivoice-clone-runpod/{Dockerfile,README.md,UPSTREAM.md,MODEL_MANIFEST.json,requirements.lock,contract.py,handler.py,pipeline.py,test_contract.py}` plus narrow stage modules and build verifiers; no edits to stock voice assets.

**Request:**

```json
{
  "contract_version": 3,
  "mode": "clone",
  "ref_audio_b64": "...",
  "ref_text": "...",
  "text": "...",
  "speed": 1,
  "num_step": 32,
  "mixed_language": true,
  "seed": 1,
  "experiment_profile": "combined-quality-v1",
  "normalizer_version": "...",
  "request_commitment_sha256": "...",
  "matched_settings_sha256": "..."
}
```

Strictly validate base64; reference ≤8 MB and decoded duration 5–15 seconds; `ref_text` ≤2,000 characters; `text` ≤800; `speed` 0.3–3.0; `num_step` 4–64; `mixed_language` must be literal `true`; `seed` 0–2,147,483,647; both commitment fields must be 64 lowercase hex and recompute exactly; output mono 24 kHz PCM16 WAV ≤7 MB. Success is one exact versioned envelope containing audio plus contract/worker/image/source/model/profile/normalizer/stage identities, echoed `mixed_language:true`, `request_commitment_sha256`, `matched_settings_sha256`, and sanitized timing. Failure is one exact `{ok:false,error:{code,message}}` envelope with an enum code and non-sensitive message. HTTP/provider success containing `{error}` or a partial stage is invalid. Pair creation rejects any semantic descriptor, v3 echo, or output-format disagreement; v2 proof uses its committed outbound descriptor because that immutable response schema has no request echo.

- [ ] Start from the audited application worker boundary, not a wholesale branch merge. Exclude stock/Lao assets, FastAPI, persistence, credits/auth, preview/Studio HTML, voice design, emotion/age controls, Gemini, and fallback.
- [ ] Implement `control-v1`, four single-delta profiles, and `combined-quality-v1` exactly as fixed above; server enum rejects unknown profiles and every requested optional stage fails closed.
- [ ] Keep the final `speechText` application/harness-owned and report the pinned normalizer version; do not rewrite silently inside the worker.
- [ ] Clean request audio, embeddings, intermediates, and output temp files in `finally`; log identifiers/timings only at INFO, never payload or transcript.
- [ ] Pin base image, system/Python dependencies, source/checkpoint, Demucs, AudioSeal, and every weight by immutable revision/hash. Produce SBOM, source/model manifest, license notices, and a network-blocked cold-import/stage test proving no first-request download.
- [ ] Inspect the final OCI filesystem and layer history for stock/Lao files, model caches outside the manifest, credentials, Git history, and source audio.
- [ ] Mark image/UI internal evaluation only: OmniVoice checkpoint is non-commercial and wrapper/asset rights remain unresolved.
- [ ] Unit-test bounds, envelopes, cleanup, identity, deterministic seeds, `control-v1` parity fixtures, all profiles, combined stage order, watermark sample preservation/detection, and stock-mode/asset absence without a paid GPU.

## Task 4 — Close reference lifecycle and account deletion

**Files:** `src/lib/user-voices.server.ts`, `src/lib/account-hard-delete.server.ts`, existing Clerk hard-delete wiring only if needed, focused storage/account-delete verifiers, rollout docs.

- [ ] Preserve current upload normalization, consent version, 5–15 second duration, 15 MB upload cap, 24 kHz mono PCM16 storage, 10-voice owner limit, non-public realpath checks, `0700` directories, and `0600` files.
- [ ] Keep references indefinitely during the canary; normal expiry/cleanup tasks may not delete them.
- [ ] Prove cross-account list/read/use/delete is an owner-scoped `404` and cannot leak file paths/names.
- [ ] Preserve `409 USER_VOICE_IN_USE` during an active job; terminal failure preserves reference; later owner deletion removes row and bytes.
- [ ] Implement the same-SQLite `DeletionTransaction`/`DeletionArtifact` coordinator, deterministic quarantine, Transactions A/B/C, startup reconciliation, and crash matrix for one-voice delete, review close, and account hard-delete.
- [ ] Include every owner-HMAC-matched private review run in account hard-delete from any review state; require configured review-root/key consistency before claiming account deletion complete.
- [ ] Assert the single terminal row/receipt outcome defined for voice delete, owner review close, and account hard-delete; no path may choose dynamically between retaining and deleting an authoritative row.
- [ ] Verify the success invariant after normal and interrupted deletion and ensure receipts/logs contain only opaque identifiers.

## Task 5 — Build the bounded ledger, evaluator, and blind review

**Files:** canary fixture/schema, benchmark and verification scripts, ignored artifact-root support, private AI Studio review API/UI, focused tests, `package.json`, `docs/ops/hero-voice-clone-canary.md`.

- [ ] Encode these six approved final scripts byte-for-byte:
  1. `วันนี้มิวอยากชวนทุกคนมาดูว่า AI ตัวนี้ช่วยให้เราทำงานเร็วขึ้นได้จริงแค่ไหน`
  2. `วันที่ 4 กันยายน 2026 เวลา 10 นาฬิกา 35 นาที ค่าใช้จ่ายทั้งหมดอยู่ที่ 1,249 บาท`
  3. `OpenAI, Gemini และ RunPod ทำหน้าที่ต่างกัน แต่สามารถเชื่อมต่อกันใน workflow เดียวได้`
  4. `ถ้าเราถามข้อมูลล่าสุด ระบบควรค้นหา ตรวจสอบแหล่งที่มา แล้วค่อยสรุปให้เราเข้าใจง่าย`
  5. `โอ้โห ผลลัพธ์รอบนี้ดีขึ้นชัดเจน แต่ยังต้องฟังคำควบกล้ำและปลายประโยคให้ละเอียดอีกครั้ง`
  6. `เรื่องยากไม่จำเป็นต้องเล่าให้ยาก เพราะเป้าหมายของมิวคือทำให้คนทั่วไปเห็นภาพและนำไปใช้ได้จริง`
- [x] Validate the ignored source pointer out of band as the approved 10-second Mew recording and exact transcript: `ถ้าเราใช้ตัว AI ในสมัยก่อน เวลาเราถามอะไรที่ปัจจุบัน หรือว่า ตอนนี้ เช่น วันนี้ อุณหภูมิเท่าไหร่`.
- [ ] Default to dry-run. Require explicit `--apply`, two read-back immutable staging endpoints, absolute owner-only reference/review paths, expected reference hash out of band, `--max-jobs=44`, and `--budget-usd=10`.
- [ ] Start only with the one marked canary SQLite database, non-production Clerk test issuer/audience/keys, one locally bootstrapped Mew tester, isolated canary credits, disabled external billing/webhooks, and private storage realpaths; reject every production DSN/path/live auth identifier and snapshot only safe fingerprints.
- [ ] Implement the exact owner-HMAC input and domain-separated one-use/expiring submit HMAC; atomically consume nonce with local job/reservation creation and test replay/expiry/race/restart rejection.
- [ ] Freeze literal source/final `speechText`, normalizer identity, hashes, the deliberately limited matched-settings object including `mixedLanguage:true`, settings hashes, arm-specific fields, runner identities, and all 44 slots with the exact seed/support table and four ablation pairs; exact outbound descriptors prove both final arms receive identical final text/matched settings, while v3 additionally echoes both commitment hashes.
- [ ] Enforce one-in-flight append/`fsync` semantics, terminal unknown-dispatch handling, no retry/replacement, and the cost equations above.
- [ ] Implement and crash-test the exact run-level transition table so every technical/safety/provider failure aborts, CER alone may continue, and restart dispatch counts are deterministic.
- [ ] Produce the counted smoke, ablations, and final outputs in the declared order; record only sanitized digests/versions/parameters/timing/cost/audio hash/duration/outcome.
- [ ] Build/pin the `linux/arm64` CPU evaluator through FFmpeg/transitive locks; run separate actual-runtime-fingerprinted `ablation-8` and `final-36` batches with three-process fixtures immediately before/after each uninterrupted batch; require all ablation predicates, all final WAVs valid, and at least 17 candidate CER passes.
- [ ] Create 18 cryptographically randomized condition-matched pairs and the exact bijective JCS reveal manifest; encrypt it into the versioned base64url/JCS envelope and push only its exact-byte digest commitment before review opens.
- [ ] Implement owner-HMAC, HKDF key separation, state/revision/CAS, score schema, Git-object-bound commitment/score HMAC, AES-GCM/AAD verification, condition/bijection validation, authenticated close, account forced-close, and one-way lifecycle.
- [ ] Test source maps, DOM, API/network responses, filenames, ordering, range requests, errors, cache headers, and timing-visible fields for identity leaks; another eligible account receives `404`.

## Task 6 — Clear review/data/license gates and provision immutable staging

**Files:** branch CI/build scripts, canary ops doc, `docs/research/2026-09-04-hero-voice-clone-license-gate.md`, small SBOM/provenance references, no audio/model binary in Git.

- [ ] Run focused verification, Python tests/compile, TypeScript checks, lint, production build, and the relevant full voice/AI Studio verification suite.
- [ ] Complete correctness and security reviews covering policy, IDOR, parsing, path/symlink handling, SSRF/endpoint injection, secrets, logs/telemetry, settlement, blind-store integrity, and deletion recovery; resolve all high/critical findings.
- [ ] Complete privacy sentinel scan and write a field-by-field public/provider data inventory.
- [ ] Freeze the single GPU type/rate, every `non_gpu_reserve_micros` component and interval, 660-second per-slot upper bound, and provider evidence for timeout/idle/forced-park billing; any unknown cost blocks `--apply`.
- [ ] Complete the license gate for OmniVoice, Demucs, AudioSeal, wrapper code, and every embedded model/weight. Missing or incompatible internal-evaluation rights block image publication/use.
- [ ] **Before any Mew audio leaves the Mac**, retain evidence of: a binding RunPod DPA and lawful processing basis; a special-category/biometric-style notice if counsel requires it; written RunPod answers for input, request-history, log, and backup deletion/retention plus data-center placement; explicit TTL/execution policy support; INFO payload-free logging; no webhook/S3/network volume; a restricted canary credential; and Mew's recorded consent/purpose. If any item is absent or unacceptable, execution is blocked and no human audio is submitted.
- [ ] Build/publish `ghcr.io/mewic/heroai-omnivoice-clone:<git-sha>`, capture its OCI digest/SBOM/manifests, and reference the candidate template by digest only. No mutable tag may be used for execution.
  - The final inspection artifact was built from commit `3ba4824fb28a411bc3037a562f133b07dcea05f7`: OCI index `sha256:9c7b9592ce066d94669b030900b499d262160b3d7f3954c13ff3f7b928d664b7`, Linux/amd64 manifest `sha256:8afa2ae52d8fa113692f03740005ffd0f407d775ae5d1a53722ddb20fbd69106`. Digest-bound SPDX/SLSA attestations and the full authenticated OCI scan passed; Trivy reported zero critical/high vulnerabilities. [Exact image, attestation, and CI evidence](../research/2026-09-04-hero-voice-clone-task6-gate.md#immutable-candidate-image-readback) supersedes the earlier `3ae5658f` image. These are historical technical results, not rights clearance: publication while rights were unresolved remains a review finding requiring evidence or an explicit scope decision. No further publication or execution is permitted by this evidence. This item stays unchecked until all applicable gates and a dedicated immutable candidate-template readback pass.
- [ ] Provision two staging-only endpoints: audited v13 baseline digest and candidate digest; names unmistakably include canary/baseline or canary/candidate; exactly one shared fixed GPU type, `workersMin=0`, `workersMax=1`, execution timeout 540 seconds, idle timeout 60 seconds.
- [ ] Read back endpoint/template/digest/GPU/scaling/timeout/queue state plus local canary DB/auth/credit/storage bindings, and prove production endpoint IDs, Hostinger/PM2 env, DNS, database, and deployed files are unchanged.
- [x] Open/update feature-branch PR [#440](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/440) with code/tests/sanitized docs and do not merge it. The PR records `NO-GO`; failed or missing gates continue to prevent paid submission.

## Task 7 — Run the 44-slot canary, hand off, and stop

**Files:** ignored private ledger/audio/review artifacts; sanitized aggregate `docs/research/2026-09-04-hero-voice-clone-canary-results.md`; plan status after the gate.

- [ ] Recheck Task 6 evidence immediately before `--apply`; verify budget/rate/non-GPU reserve, empty queues, immutable identity, one-in-flight, non-production DB/auth/credit bindings, and private review paths.
- [ ] Execute the eight ablation slots. Stop without final submissions if any stage is absent/silent, WAV/CER/watermark validation fails, privacy evidence fails, or the remaining mandatory matrix cannot stay under US$10.
- [ ] Execute all 18 baseline slots, then submit `final.candidate.script-01.repeat-01` as the counted end-to-end AI Studio smoke. Validate ownership, consent, reference retention, dedicated pin, app/job identity, settlement, private playable audio, and privacy inventory before the remaining 17 candidate slots.
- [ ] Complete the remaining candidate slots without retry. If any of the 36 final outputs is missing/unknown/invalid, do not create or present a reduced blind pack; report `NO-GO`.
- [ ] Assert from the append-only ledger that a reviewable run has 44 unique intents, 44 provider-accepted IDs, 44 valid outputs, zero rejection/unknown, and the smoke slot once; otherwise report exact disjoint counters plus the provider-received interval and terminal `NO-GO`.
- [ ] Park both endpoints immediately after generation, require the pinned AudioSeal detector to classify all 36 unwatermarked final files negative, then verify all 18 pairs are metadata- and audio-side-channel-free before handing Mew the authenticated local AI Studio review URL.
- [ ] Let Mew record `A`, `B`, or `เสมอ` and side-specific critical flags. Lock all 18 scores before reveal; verify HMAC; then reveal arm mapping.
- [ ] Apply the **acceptability/non-inferiority** gate: candidate win or tie in at least 15/18; at least 17/18 candidate CER values ≤10%; all 36 files valid; and zero candidate critical flags (`wrong_identity`, `missing_text`, `severe_distortion`, `privacy_anomaly`). Report wins, ties, losses separately and do not label ties as improvement.
- [ ] Report the exact disjoint ledger counters and provider-received interval (never an invented exact “submitted” count), spend/upper bound, latency, CER batch identity, blind choices, critical flags, privacy/security readback, immutable digests, license/RunPod gate status, application-artifact close status, and separately evidenced provider-retention disposition.
- [ ] Result stays `NO-GO` until, after hearing the revealed results, Mew explicitly says **“อนุมัติเสียงมิว”**. That phrase records “Mew voice approved for the private AI Studio canary” only.
- [ ] Stop before merge, production deploy, team voices, public/stock voices, Video Editor, Story Film, or MCP. Close generated audio/reveal/raw-score artifacts only when Mew separately asks to close the evaluation; keep Mew's reference until owner/account deletion.

## Global Constraints

- Work only in the existing Orca worktree on local branch `codex/hero-voice-clone-prod-audit`; preserve unrelated user work. This branch was renamed locally from `mewic/hero-voice-clone-prod-audit` on 2026-09-05 to follow `CLAUDE.md`. PR #440 still uses the original remote branch; remote branch/PR migration is pending credential rotation and must preserve the review history. A PR may be opened, but this plan never merges or deploys production.
- Apply ADR 0060 exactly. Public users keep the current Hero AI Voice teaser and remain server-denied. Stock Hero Voice, Video Editor, Story Film, and MCP acquire no clone behavior.
- Clone access is flag + internal tester + existing user-ID allowlist, with no admin/client bypass. Paid evaluation is Mew's authenticated account and Mew-owned voice only.
- Counted AI Studio jobs use only the loopback app's marked canary SQLite DB, Clerk test issuer, isolated local user/credits, and private canary storage; live auth keys, production DSNs/paths, external billing, and production rows are rejected.
- Clone jobs use only the dedicated clone endpoint; stock jobs use only the stock endpoint. Server-owned selection and immutable per-job pinning are mandatory. No retry or cross-endpoint/provider/voice fallback.
- Do not merge upstream/team branches wholesale. Do not add stock/Lao voices, voice design, emotion/age controls, Gemini fallback, public preview, worker persistence, or worker-side credits/auth.
- Reference and generated audio are sensitive. Keep application-controlled copies owner-only and outside public/Git/PR/CI/application logs/telemetry/durable job JSON. RunPod receives a bounded job payload only after Task 6's hard gate; never claim otherwise or claim provider erasure without evidence.
- The application reference persists until owner deletion; account deletion removes it. Application-controlled generated/review artifacts persist only until Mew closes the evaluation or the account is deleted. Provider retention follows the separately recorded RunPod disposition.
- A reviewable run has exactly 44 ceiling-consumed intents, 44 provider-accepted IDs, and 44 valid outputs, with a US$10 absolute maximum including the 660-second-per-slot GPU reserve and every bounded non-GPU external component through forced parking. Fewer/unknown means an aborted terminal `NO-GO`; more than 44 intents are forbidden. Dry-run first, one in flight, no retry/replacement. The counted smoke is one of the 44.
- Final review always has 18 complete condition-matched randomized pairs or does not open. Only presentation order and A/B orientation are random; labels stay sealed until all choices/flags are locked.
- The numerical gate establishes acceptability/non-inferiority, not superiority. Mew's explicit post-reveal phrase remains mandatory.
- OmniVoice checkpoint commercial use and wrapper/asset rights are unresolved. Everything is internal evaluation only; technical success does not authorize customer/commercial release.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|---|---|---|---|---|
| 1 | AI Studio clone-canary policy | mew-worker-heavy | subagent | — | focused tests/build; Tier-1 correctness + security review |
| 2 | Immutable endpoint/job identity and terminal settlement | mew-worker-heavy | subagent | 1 | migration/runtime/crash tests; Tier-1 correctness + security review |
| 3 | Clone-only contract-v3 worker | mew-worker-heavy | subagent | — | Python/contract/parity/image tests; supply-chain + security review |
| 4 | Reference lifecycle and deletion recovery | mew-worker-heavy | subagent | 1 | storage/ownership/crash tests; Tier-1 correctness + security review |
| 5 | Bounded harness, CER, and blind AI Studio review | mew-worker-heavy | subagent | 2, 3, 4 | dry-run/UI/integrity/privacy tests + production build; Tier-1 review |
| 6 | Whole-branch, processor/legal/license gates, immutable staging | mew-worker-heavy | subagent | 5 | full test/build; adversarial review; written data gate; digest/readback |
| 7 | Paid run, blind gate, private handoff | mew-worker | subagent | 6 | 44-slot/$10 breakers; lock/reveal audit; Mew phrase |

Five frontier waves: `{1,3}` → `{2,4}` → `{5}` → `{6}` → `{7}`. Tasks that share policy/generation files are serialized. Task 3 owns only the new worker service until Task 5 consumes its interface. Each worker is told it is not alone in the codebase, owns only its listed files/responsibility, must preserve others' edits, and cannot perform a later task's external mutation.

## Acceptance Criteria

- [ ] Feature-branch PR exists with all required checks green, no unrelated wholesale branch changes, no sensitive data, no merge, and no production mutation.
- [ ] Exact policy intersection and endpoint response matrix pass; arbitrary admins/public accounts and every non-AI-Studio surface remain denied/unchanged.
- [ ] Every paid slot has a typed immutable runner/endpoint/contract/image/source/model/profile snapshot; application slots additionally have durable job/attempt identity and settlement. Failures follow the terminal matrix with no retry/fallback, and unknown dispatch terminates the run while retaining its full cost reserve.
- [ ] Clone image is stateless, stock-free, network-independent at cold start, manifest/SBOM-pinned, and exact request/response/cleanup/profile contracts pass.
- [ ] Rights and notices for every component are recorded and remain internal-evaluation-only.
- [ ] Mew reference is privately stored with consent, survives failures, rejects cross-account access, persists until owner delete, and is recoverably removed by owner/account delete.
- [ ] Voice delete, review close, and account delete use the same marked SQLite coordinator with Transactions A/B/C; startup resolves every intent first and no success is returned with an unresolved transaction.
- [ ] Privacy sentinel inventory passes, with RunPod provider payload called out honestly and the written RunPod human-data gate complete before submission.
- [ ] Loopback AI Studio fails closed unless marked canary DB/auth/credit/storage bindings pass; no production application record, auth key, billing call, or storage path is touched.
- [ ] Dry-run contains exactly 44 immutable slots with literal frozen final `speechText`, semantic/wire request hashes, deliberately limited matched settings, arm-specific fields, runner/seed support, and proves the 660-second GPU plus fully inventoried non-GPU upper bound ≤US$10.
- [ ] A reviewable paid run has exactly 44 unique intents, 44 provider-accepted IDs, and 44 valid outputs (8+18+18), zero provider rejection/transport unknown, and the smoke exactly once; aborted runs report disjoint exact counters plus a provider-received interval, intents never exceed 44, spend stays ≤US$10, and production is untouched.
- [ ] All 44 slot parameters are frozen before payment; eight ablation outputs pass the exact per-file CER/WAV/stage/watermark predicates before the final phase and are reported as exploratory only.
- [ ] Canonical CER comes from the one digest-pinned non-emulated `linux/arm64` evaluator with matching actual-runtime/pre-post fixtures in separate `ablation-8` and `final-36` batches; all final WAVs are valid, paired arms have identical final text/matched settings, and at least 17/18 candidate outputs have raw CER ≤10%.
- [ ] All 36 final files are deliberately unwatermarked and detector-negative, then the blind store presents 18 leak-free randomized complete pairs matched by script/repeat/final-text/full settings; a pre-review Git commitment at an exact path/commit/blob binds the exact JCS ciphertext-envelope bytes, and the score HMAC binds choices/side flags plus that commitment before authenticated reveal.
- [ ] Candidate wins or ties ≥15/18 with zero candidate critical flags; ties are not reported as improvement.
- [ ] Endpoints are parked immediately after generation; authenticated/CAS close and account deletion recoverably remove all application-controlled review artifacts; sanitized evidence distinguishes that result from RunPod's separately evidenced provider-retention disposition.
- [ ] Status remains `NO-GO` until Mew says “อนุมัติเสียงมิว” after reveal, then records AI Studio-canary approval only and stops before merge/prod/team/editor work.

## Out of scope

- Merging the PR or changing Hostinger/PM2/production RunPod routing. Production needs a fresh explicit cutover/rollback plan and readback.
- Video Editor, Story Film, MCP, public/customer clone access, or any team/customer voice.
- Stock Hero Voice catalog, Thai/Lao asset rollout, voice design, age/tone/emotion controls, or Gemini rewriting/fallback.
- Proving candidate superiority from 18 preference pairs. This plan tests a predeclared acceptability/non-inferiority gate.
- Resolving commercial rights by technical testing. Missing written rights remain a release blocker.
- Deleting the two legacy production endpoints or rotating unrelated registry credentials.

## Status

interviewed 2026-09-04 | approved: 2026-09-04 | executed: blocked at Task 6 (NO-GO) | delivered: -

2026-09-05 approved continuation: local preparation commit `654185e5` fixes
adapter IPC dispositions/canonical-capability transfer and bounded loopback
transport, and adds strict evaluator dependency preparation/installation checks.
Local synthetic suites and a 184-page build pass; canonical execution remains
disabled and the real Task 7 adapter is still absent. Coding is not complete:
parent-owned direct-output lifecycle, actual candidate observations, compatible
hash-domain evidence, evaluator input transfer, and parent-owned absolute
cancellation/parking deadlines remain required. See the updated
[two-axis review and exact remaining seams](reports/2026-09-05-hero-voice-clone-continuation-review.md).
No paid run, human-audio submission, push, merge, or deployment was performed.

Later 2026-09-05 approval, implementation `5991c3c6`: the direct-output lifecycle
seam above is now implemented. All 26 direct slots must deliver bounded WAV
bytes over IPC; the parent validates, journals, and registers the file before
recording completion. Registry files and declared intermediates participate in
owner-close/account-delete recovery, separately from the final blind pack.
The schema migration only adds `CanaryRunOutput`; no live database was changed.
Actual candidate observations, evaluator-input transfer, objective hash-domain
reconciliation, absolute parking controls, and the real adapter/native runtime
remain incomplete. The existing hard gates still prohibit paid/private execution.

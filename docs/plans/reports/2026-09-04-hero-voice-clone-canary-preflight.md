# Pre-flight review — Hero Voice Clone Mew-first canary

**Plan reviewed:** `docs/plans/2026-09-04-hero-voice-clone-canary.md`
**Review scope:** the plan and its embedded Acceptance Criteria only; no source code or conversation history inspected
**Verdict:** **NOT READY FOR APPROVAL**

The plan has a strong safety posture and a useful task dependency graph, but several interfaces and gates are internally contradictory or not objectively executable. The paid run, privacy claims, blind review, and promotion decision cannot all satisfy the Acceptance Criteria as currently written.

## Blockers

### B1 — The smoke generation makes the paid-job ceiling contradictory

Task 5 defines exactly 44 paid submissions: 18 baseline + 8 ablation + 18 combined. Task 7 then requires a Mew-reference upload/preview/**generation** smoke before “the 44-job matrix,” followed by eight ablation jobs and 36 final jobs. If that smoke reaches either private RunPod endpoint, the plan requires 45 paid submissions while both Global Constraints and Acceptance Criteria cap the run at 44. Nothing says the smoke is free, local-only, or one of the 44 predeclared outputs.

This prevents an executor from satisfying both Task 7 and the hard breaker. The plan must explicitly do one of the following: (a) designate the smoke as one identified job already present in the 44-job manifest and reuse its output, (b) require a genuinely non-paid local smoke and state how it exercises endpoint pinning, or (c) change the matrix and cap. All counters must cover smoke, failed, cancelled, timed-out, and manually rerun submissions with one definition of “submission.”

### B2 — The “no audio in job JSON” rule conflicts with the RunPod transport

The worker contract sends `ref_audio_b64` in the request and returns WAV audio in the response. RunPod serverless requests and responses are job payloads. Yet Task 4, Global Constraints, and Acceptance Criteria broadly require reference/audio to be absent from “job JSON.” Worker temp cleanup does not prevent the provider control plane from retaining request or response JSON.

The plan must distinguish application durable job JSON from provider job payloads. If the prohibition includes RunPod payloads, the proposed architecture is impossible and needs a different transport, such as short-lived authenticated object references plus explicit provider-side deletion guarantees. If it excludes provider payloads, the plan must state the provider retention exposure, required RunPod settings, deletion/readback procedure, permitted retention window, and evidence needed for the privacy gate. “Stateless worker” is not evidence that the platform retained nothing.

### B3 — No deployable storage/ownership/locking interface exists for the blind-review UI

The benchmark writes to an ignored local path, while an authenticated AI Studio API is expected to serve those files through a staging/local review URL, record Mew’s choices, freeze/export a “signed” sheet, and later reveal labels. The plan never defines where the benchmark and web application run, how the web process can access the local artifact tree, how a run is registered, where scores and lock state persist, or how an authenticated actor is bound to a specific run. The shared canary policy authorizes a cohort; it is not per-run ownership.

The plan must specify the review-store topology and interface: private storage root/backend, run and pair identifiers, server-side owner binding, route shapes, response allowlist, score schema, per-sample critical flags, state transitions (`collecting -> locked -> revealed`), concurrency/idempotency rules, and the signing mechanism/key/evidence. It must also state how a staging URL is provisioned without changing production. Until then, Tasks 5 and 7 cannot be implemented or security-tested without inventing architecture.

### B4 — The four “hypotheses” are labels, not implementable or isolatable experiments

The worker profiles name reference enhancement, text normalization, guidance/ranking, and watermarking, but do not define algorithms, dependencies/models, parameters, output behavior, or `combined-v1` composition/order. In particular, “guidance/ranking” does not say how many candidates are generated or how they are scored, and “watermarking” has no embed/detect contract or acceptance threshold. The executor would be choosing the experiment rather than implementing an approved one.

Moreover, one candidate profile versus deployed v13 is not an ablation: worker/source/model differences are confounded with the named change. Eight single-profile outputs do not prove the four hypotheses “independently.” The plan must predeclare each profile’s exact transformation/configuration and either add a candidate no-op control or use full-minus-one ablations. It must name the two representative script IDs and state objective pass/stop criteria. If the intent is only exploratory profile sampling, the plan should stop calling it independent hypothesis evaluation.

### B5 — The Thai CER promotion threshold is not reproducible

“A separately pinned offline evaluator” is not a specification. No evaluator name/revision/hash, decoder settings, audio preprocessing, Thai/Latin/number normalization, Unicode normalization, punctuation/space policy, CER algorithm, aggregation rule, or rounding rule is fixed. These choices can materially move a result across the 10% threshold. Empty or failed transcriptions also have no defined score.

The plan must declare a canonical evaluator manifest and exact deterministic scoring procedure before paid execution. The dry-run should include golden text-normalization/CER fixtures with expected values. It must define whether “17/18 … complete and meet CER” means the same 17 outputs satisfy both conditions and how values exactly at 10% and rounding are treated.

### B6 — Allowed failures cannot produce the required 18-pair blind pack or a defined score

The plan permits one missing candidate while still passing the 17/18 candidate completion gate and says that missing candidate counts as a baseline win. It also says a baseline failure makes the pair “non-promotable.” But a missing side is not a playable A/B pair, while the plan simultaneously requires 18 leak-free pairs, 18 frozen choices, and a 15/18 win/tie calculation. No denominator or precedence is defined for a baseline failure, candidate failure, or both failing.

The plan must choose a coherent rule. For example: require both samples for all 18 review pairs and make any missing final sample a run-level `NO-GO`; or define an explicit technical-loss record outside the listening UI and a fixed denominator/scoring table. Baseline completion also needs an explicit threshold. Critical flags must be recorded against A, B, or both, then attributed after reveal; a pair-level flag is insufficient for deciding whether the candidate failed.

### B7 — The claimed “improvement” gate can pass on ties alone

The goal is to determine whether the candidate improves Mew’s voice over v13, but promotion passes when `combined-v1` “wins or ties” at least 15/18. Eighteen ties satisfy that rule without any evidence of improvement. The three repeats of six scripts are also correlated observations, so the threshold is not an inferential proof by itself.

The plan must say whether the gate establishes superiority, non-inferiority, or merely absence of obvious regression. If superiority is intended, predeclare a minimum number/margin of wins and handling of ties. If non-inferiority is intended, change the goal and result language accordingly. This decision must be made before Mew scores the pack.

## High-severity defects

### H1 — Durable endpoint/build pinning lacks a persistence schema and authoritative identity source

`heroVoiceCloneConfig()` accepts only endpoint ID and API key but is also expected to “declare expected clone contract/build metadata.” The source and exact fields for that expectation are absent. The plan requires endpoint persistence on both job and attempt, yet lists no schema/migration or fallback for pre-existing records. It also says poll/resume must use persisted expected metadata, but does not explicitly persist that metadata. Comparing only self-reported response fields is not strong wrong-worker detection.

Define the exact immutable fields and source of truth: endpoint ID, OCI digest, contract version, worker kind, source revision, model/checkpoint hashes, profile/version, and request schema version as applicable. Define which are snapshotted on job versus attempt, the required migration, and the template/endpoint readback used to bind endpoint ID to OCI digest before submission. Poll/resume must compare against the snapshot, not current environment.

### H2 — Baseline/candidate parity and the v13 adapter are unspecified

The candidate requires contract v3 and `experiment_profile`; the audited v13 baseline may use a different request/response contract. The benchmark does not define the baseline adapter, which parameters are held constant (`speed`, `num_step`, preprocessing, sample-rate postprocessing), whether stochastic seed/control exists, or how output validity is normalized. “Minimum verified GPU configuration” also does not ensure both endpoints use comparable hardware/configuration.

Predeclare the baseline digest/config manifest, adapters, exact request parameters, fixed postprocessing, output validity rules, and hardware choice. Otherwise the A/B test can measure harness or deployment differences rather than clone quality.

### H3 — The US$10 breaker has no computable or enforceable cost model

The plan refers to cumulative “measured” cost, “estimated” total spend, and “worst-case next-job cost” without defining the RunPod rate source, billable time fields, currency precision/rounding, queue/cold-start/failure/cancellation billing, or per-endpoint rate. A 600-second timeout is specified, but no formula shows that every remaining planned job can fit the cap. Checking only the next job can still allow an incomplete run whose remaining required jobs cannot fit.

Fix the GPU/rate before apply, define a pessimistic per-job reserve and actual-cost formula, require sequential execution with at most one in-flight job, and gate both the next submission and projected completion of the remaining mandatory matrix. Specify whether the cap is against provider-billed actuals or a conservative upper bound. Cancellation after a submission cannot retroactively guarantee the cap.

### H4 — Reservation settlement and terminal-state behavior are not a test oracle

“Settle/refund existing reservations correctly” delegates the expected business behavior to the executor. It does not define ledger/job/attempt outcomes for missing configuration before reservation, provider rejection, wrong identity, timeout, malformed output, cancellation, or failure after provider execution. “Terminal” and “no retry” alone are insufficient to verify money/quota correctness.

Add a state-transition table with expected job status, attempt status, reservation action, reference retention, user-visible error code/status, and retry eligibility for every listed failure class. Clarify whether failure before reservation creates a durable job/attempt and whether polling an already-terminal job is idempotent.

### H5 — The policy boundary is textually ambiguous

The Acceptance Criteria say “every non-AI-Studio entry point remain denied,” while Tasks 1 and 4 intentionally expose collection/item routes under `/api/omnivoice/user-voices` for authorized upload/list/read/delete. The intended restriction appears to be on clone **generation**, but the literal criterion can mark required lifecycle routes as failures. Likewise, `401`/`404` behavior is specified generally, while cross-account list/read/use/delete does not define whether list returns an empty collection and item/use/delete return `404`.

Scope the denial criterion to generation/submission and provide an endpoint-by-actor response matrix covering catalog, upload, list, item read/delete, AI Studio submit, job read, artifact playback, score write, and reveal. Include owner versus another user who also passes the canary intersection.

### H6 — Sensitive canary artifacts have no retention or teardown lifecycle

Reference retention is specified, but generated clones, manifests, score sheets, reveal keys, staging review records, and local artifact copies have no deletion schedule or owner/account-delete behavior. Task 7 stops with two callable staging endpoints, templates, an authenticated review surface, and sensitive artifacts still present. `workersMin=0` limits idle cost but does not disable use.

Define post-run retention, deletion/quarantine/receipt behavior, account-delete coverage for generated artifacts, endpoint disablement or credential revocation, review-URL closure, and who may preserve the minimum sanitized evidence. The teardown must not delete evidence needed by the PR, but it must not leave an indefinitely callable canary.

### H7 — “Atomic/recoverable” filesystem-plus-database deletion is underspecified

A database cascade and filesystem deletion cannot be literally atomic. “Quarantine/receipt semantics consistent with the existing hard-delete path” does not state ordering, receipt identity, retry/reconciliation behavior, or success conditions, and original filenames are prohibited from logs.

Define the crash matrix and invariant: what happens if quarantine succeeds but DB deletion fails, DB commit succeeds but final unlink fails, or the process dies between steps. Specify receipt fields (using opaque IDs), idempotency, reconciliation command/job, and the evidence that no orphan remains. Also clarify whether owner deletion and account hard-delete share the same mechanism.

### H8 — Negative privacy and blind-leak gates are unbounded and therefore unverifiable

“No data appears in Git, CI artifacts, logs, telemetry or job JSON” and “source maps, DOM, network payloads, filenames, ordering and job metadata cannot reveal” do not identify the systems, artifact roots, log sinks, test fixtures, or pass/fail method. Universal absence cannot be established from an unspecified scan. No synthetic marker strategy is required, and real Mew data should not be injected into CI to test it.

Define a finite audit inventory and automated tests using synthetic sentinel values. Require an allowlisted API schema and assert that endpoint/provider/profile/digest identifiers and reveal mappings never reach pre-lock browser responses. List the Git/CI paths and structured-log sinks scanned, the scan command/report artifact, and the human inspection required for systems that cannot be automated.

## Medium-severity defects

### M1 — Exact profile/response and error schemas are incomplete

The contract names request fields and some response metadata, but not the audio field name/encoding, complete metadata field names/types, error envelope/status conventions, numeric ranges/defaults, WAV validation method, or maximum decoded versus encoded sizes. `normalizer/profile versions` is not an exact schema. Publish a contract fixture/schema with valid and invalid examples so application, harness, and worker implementations cannot drift.

### M2 — Reference approval validation is not fully defined

The SHA-256 proves byte identity only if the hashing stage is specified. State whether it covers the original owner file or normalized 24 kHz PCM16 WAV, the duration tolerance around “10-second,” transcript punctuation/whitespace normalization, channel/sample format checks, and failure behavior. Passing an absolute private path on a command line can leak it through process listings or shell history; require the ignored pointer file or another non-argv secret-input mechanism.

### M3 — Security and Tier-1 review gates lack evidence contracts

The execution table names reviews, but the plan does not prescribe report paths, reviewed commit SHA, severity taxonomy, reviewer independence, re-review after fixes, or proof that final PR head—not an earlier image-building commit—was reviewed. Define the review artifacts and closure rule, and rerun required checks on final PR head after sanitized results are added.

### M4 — Supply-chain absence tests need concrete pass conditions

“No stock/Lao assets” and “no first-request downloads” need an image inspection scope and runtime test. Require an image filesystem inventory/denylist plus license scan, and run the image with outbound network disabled from a cold container while exercising every profile. Record the exact image digest tested. An SBOM alone does not prove model weights are present or that runtime downloads cannot occur.

### M5 — Manual rerun and partial-run resumability are not specified

A manual rerun is said to be a new counted job, but there is no run journal/idempotency rule, stable job ID scheme, resume behavior, or prohibition on resubmitting already completed slots after a harness crash. Define append-only submission records written before network submission, reconciliation against provider IDs, and how dry-run slot IDs map to at most one initial submission plus explicitly authorized reruns within the same 44 cap.

### M6 — Stop criteria for ablations are subjective

Task 7 stops for “objective failures/cost” or silent degradation, but no objective quality threshold beyond CER for finals is assigned to ablation outputs. Define the exact technical checks (contract identity, stage-applied evidence, watermark detector result, audio validity, CER ceiling if any, cost projection) and whether any single failure blocks the final matrix.

## Acceptance Criteria coverage gaps

The following top-level criteria cannot currently be verified deterministically:

| Acceptance criterion | Missing or contradictory oracle |
|---|---|
| Exactly 44 dry-run/paid jobs and no cap breach | Smoke job is outside the stated matrix; cost and submission definitions are absent. |
| No sensitive data in job JSON/logs/telemetry | RunPod necessarily receives base64 in job payloads; audit scope is undefined. |
| Every clone job immutably pinned | Persisted schema and expected build/model identity source are absent. |
| Candidate clone-only/stateless/no downloads | Profile behavior and cold-network-disabled image test are not defined. |
| Reference/account deletion | Cross-system crash invariants and generated-canary artifact deletion are missing. |
| 18 leak-free randomized pairs | Missing outputs are permitted; review storage, owner binding, lock/sign/reveal protocols are absent. |
| Win/tie and CER promotion thresholds | Failure denominator, critical-flag attribution, CER procedure, and superiority versus non-inferiority are undefined. |
| PR green and production untouched | Final-head review/check evidence and concrete production readback inventory are not specified. |

## Minimum changes required before approval

1. Reconcile smoke/matrix counting and define a single append-only paid-submission/cost ledger.
2. Resolve the RunPod job-payload privacy contradiction and document provider retention evidence.
3. Specify the private review-store topology, per-run ownership, score locking/signing, reveal state machine, and staging deployment path.
4. Define each experiment profile and a scientifically valid control/ablation design, including the two script IDs and exact synthesis parameters.
5. Freeze the offline evaluator and Thai CER algorithm with golden fixtures.
6. Replace the missing-output/pair-scoring rules with one complete scoring table and state whether the gate is superiority or non-inferiority.
7. Define durable endpoint/build/model pinning fields and a settlement state machine.
8. Make the cost model, privacy/leak scans, security-review evidence, artifact retention, and endpoint teardown objectively testable.

Once these are embedded in the plan and its Acceptance Criteria, the existing seven-task dependency graph can be reviewed again for approval.

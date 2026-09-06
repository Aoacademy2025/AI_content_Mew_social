# Hero Voice Clone canary harness

Status: Task 6 partial evidence only. The feature branch and private, commit-addressed candidate image have been built and fully OCI-scanned, but no RunPod template/endpoint/job exists for it. Paid execution, real Mew audio, provider job calls, RunPod mutation, deployment, and production data remain prohibited. The canonical `--apply` path is fail-closed until Task 6 supplies independently reviewed evidence for every gate.

## Private inputs

Create `.tmp/hero-voice-clone-canary-reference.json` as a mode-`0600`, Git-ignored, exact JCS file. It contains exactly `version`, a private `sourceUri`, the expected lowercase SHA-256, the exact approved transcript, and `durationMs:10000`. Never paste that file, URI, hash, transcript-bearing pointer, audio, credentials, cookies, reveal key, or raw scores into a command transcript, Git, CI, a PR, or a public URL.

The isolated process must use a single mode-`0600` SQLite file and owner-only paths below one absolute `HERO_VOICE_CANARY_ROOT`; the reference, generated, review, quarantine, and database stores remain outside the checkout and `public/`. Bind Next only to `127.0.0.1`. The Clerk inputs must be test-key/test-issuer values with audience `hero-voice-clone-canary-v1`; bootstrap exactly one local test subject. Stripe/billing/webhook integration stays disabled.

## Dry-run

Set the two read-back endpoint/template/digest identities, exact candidate build/model identities, integer-micro per-second rate, and exact JCS non-GPU component array in the private environment. Then run:

```sh
npm run canary:hero-voice -- --max-jobs=44 --budget-usd=10
```

Only these CLI flags exist: `--apply`, `--max-jobs=44`, and `--budget-usd=10`. Defaults are dry-run, 44 jobs, and US$10. Any different ceiling/budget or unknown/duplicate flag fails. Dry-run prints only a sanitized manifest digest, slot count, counted smoke ID, integer-micro bound, and the known blocker names.

`--apply` additionally requires a private, mode-`0600` Task 6 exact-JCS evidence file and matching `HERO_VOICE_CANARY_TASK6_GATE_SHA256`. The evidence is HMAC-authenticated, manifest-bound, expires within 24 hours, and contains exactly one identity/evidence/predicate digest row for each of the eleven gates. Without it the command fails before any durable mutation. Do not create placeholder evidence.

After valid evidence, `--apply` calls the evidence-gated executable `runHeroVoiceCanaryApply` orchestration boundary and loads only the fixed checked-in `scripts/hero-voice-clone-canary-task7-adapter.ts` seam. It performs the fixed 44-slot flow, permits only one in-flight slot, blocks all work after a failed counted smoke, runs exactly the `ablation-8` and `final-36` evaluator batches, and never retries or replaces a submission. Calling this runner without the same authenticated Task 6 evidence fails before run creation; the current local environment cannot legitimately unlock it, and the Task 7 adapter is intentionally not present in Task 5.

## Fixed execution behavior

- Exact order is 8 ablations, 18 audited baseline slots, then 18 candidate slots. `final.candidate.script-01.repeat-01` is slot 27 and the counted smoke, never a 45th call.
- A dispatch intent and parsed-buffer descriptor are committed to the same-SQLite HMAC chain before the exact prepared Buffer reaches the transport. Direct baseline/experiment slots are claimed by the runner. Candidate AI Studio slots are not preclaimed: generation’s mandatory `beforeDispatch` is their sole intent writer after the one-use nonce, reservation, job, and attempt have committed atomically. Only one slot may be in flight. Rejection, unknown transport, invalid identity/output, or safety failure aborts without retry or replacement.
- During marked execution, ordinary AI Studio voice mutation is disabled. Candidate final jobs enter only through the authenticated loopback submit-by-slot route with a one-use five-minute HMAC capability atomically consumed with reservation/job/attempt creation. The executable client accepts only an explicit `http://127.0.0.1:<port>` origin and sends the parent-process attestation; it never treats Host/forwarded headers as authority.
- Objective evidence is an exact authenticated observed-field contract, not caller booleans: fixed Demucs and AudioSeal source/model/checkpoint/parameter predicates, literal normalizer source/goldens/delta, independently recomputed ranking scores, all 36 manifest/provider/stage/output/detector identities, and the exact parked endpoint identity/readback are verified against the run and Task 3 manifests. Missing, repeated-placeholder, cross-run, cross-profile, or mutated evidence fails closed.
- Canonical CER requires the fail-closed service in `services/hero-voice-cer-evaluator`. Its real `--batch ablation-8` and `--batch final-36` entrypoints enforce the lock, architecture, network, FFmpeg, model, fingerprint, exact inventory, and three fresh-process fixtures. Local synthetic tests are usable now; its non-emulated Linux/arm64 build/runtime remains blocked until Task 6 supplies the base image, complete wheel/FFmpeg locks, model file, and runtime evidence.
- Blind review first parses the complete RIFF chunk graph, enforces the 7,000,000-byte ceiling, and requires exact mono 24 kHz PCM16 framing. Its randomized mapping, ciphertext, digest, and fixed Git target are durably stored as an exact preparation before remote publication. A create-once publication retry reuses the original commit when the path already contains the exact bytes, including after unrelated branch advancement; a changed or multiply-touched path fails closed. All 37 final and 37 deterministic staging paths are then committed to the same SQLite deletion intent before the first audio or reveal byte. Crash reconciliation removes partial staging/final files after create, write, fsync, rename, or CAS failure while retaining the exact preparation for retry. The UI exposes only randomized pair/audio tokens. Lock and reveal reverify the recorded immutable Git commit/blob/path bytes, ciphertext bytes/digest, bijection, score HMAC, and revision. Task 5 provides both a local bare-repo fake and a real exact-repository/ref/path GitHub adapter behind Task 6 evidence and credentials; no real push/readback occurs in Task 5.

Any execution/objective failure before all 44 intents is terminal `aborted_no_go`. `completed_no_go` is reserved for a fully completed 44-slot objective/review decision that fails promotion; neither state retries or replaces a slot.

Closing after reveal invokes Task 4’s crash-recoverable deletion protocol. It deletes review/generated WAVs, reveal bytes, raw scores, nonces, and ledger rows; clears all private run fields/head/sequence; and retains only the closed sanitized aggregate/receipt row. Account hard-delete removes the owner’s entire local canary authority.

## Current mandatory blockers

- Control now preserves audited-v13 reference preprocessing; real GPU/audio parity still requires immutable-image evidence.
- Demucs has a pinned metadata-only torchaudio compatibility patch; the final image passed its full authenticated filesystem/layer scan, while network-blocked cold import/model load and real GPU/audio fixtures remain required.
- No local Docker/Podman or independently attested non-emulated Linux/arm64 Whisper runtime is available.
- The exact Clerk test issuer/audience/two real sessions are not evidenced.
- Script 3 now has a frozen deterministic, local meaningful-delta transform; its independent approval/evidence row is still absent.
- GitHub review-object authority/readback, provider/legal/rate/license and retention evidence remain Task 6 work. Final candidate build commit `3ba4824fb28a411bc3037a562f133b07dcea05f7`, image index `sha256:9c7b9592ce066d94669b030900b499d262160b3d7f3954c13ff3f7b928d664b7`, and Linux/amd64 manifest `sha256:8afa2ae52d8fa113692f03740005ffd0f407d775ae5d1a53722ddb20fbd69106` are inspection evidence only and are not referenced by any RunPod template. Use the [exact final image/attestation readback](../research/2026-09-04-hero-voice-clone-task6-gate.md#immutable-candidate-image-readback); earlier image digests are superseded. Application-route fixes after this build are separate from the pinned worker artifact.
- GitHub CLI credential rotation is still required after its encoded authorization value appeared in a private diagnostic transcript. Confirm revocation and reauthorization without printing credentials before authenticated GitHub/registry operations. Local branch `codex/hero-voice-clone-prod-audit` now follows the naming rule; PR #440 and its remote branch still refer to `mewic/hero-voice-clone-prod-audit` pending that credential gate.
- Existing private-image publication predates rights clearance and remains an unresolved spec finding. The technical scan does not authorize another image publication or execution.
- The local image workflow is now explicitly disabled before registry login/build/push. Credential rotation is still pending, so this freeze and the auth/cache fixes have not reached PR #440's remote branch. See the [continuation review and verification](../plans/reports/2026-09-05-hero-voice-clone-continuation-review.md).

Any one of these keeps the decision `NO-GO` and prevents human audio from leaving the Mac.

# Hero Voice Clone — private canary boundary

Status: internal-evaluation code, plus the ADR 0061 owner-only production opt-in (see the last section). Production rollout, merge, deployment,
customer access, and commercial release are out of scope.

The authoritative boundary is [ADR 0060](../adr/0060-isolate-hero-voice-clone-canary.md).
This document replaces the obsolete admin-only production rollout instructions.
An `ADMIN` role is not a clone entitlement.

## Access policy

Every clone-capable route and the durable clone generation boundary use the
same fail-closed policy:

```text
HERO_VOICE_CLONING_ENABLED == "1"
AND isInternalAiTester(actor)
AND isOmniVoiceUserAllowed(actor) through OMNIVOICE_ALLOWED_USER_IDS
AND actor exists and is not suspended
```

The internal-tester cohort and OmniVoice user-ID allowlist are independent.
An admin role, browser flag, route knowledge, or an email/domain match by itself
does not grant clone access. Unauthenticated API calls return `401`; an
authenticated actor who fails any policy term receives `404`.

## Canary surface

- AI Studio exposes account-owned `user_*` clones only. Its clone catalog,
  upload/list/private preview/delete, submission, and clone-job status all apply
  the shared policy and owner scope.
- `POST /api/ai-studio/voices` refuses stock IDs and another account's clone as
  owner-scoped `404`. Durable generation repeats policy, AI Studio surface, and
  ownership checks before any provider submission.
- Clone responses and private audio use `Cache-Control: private, no-store`.
- `/api/omnivoice/voices` remains the stock catalog. It never joins user clones.
- Video Editor, Story Film, and MCP retain their existing stock Hero Voice
  behavior and gain no clone selection or routing.

Reference audio remains application-controlled private data outside `public/`.
Provider-bound reference handling and generated canary artifacts remain blocked
on the later data/legal, immutable-endpoint, budget, and deletion-recovery gates
in the approved canary plan. No real human audio may be submitted from this
policy task.

## Task 2 immutable application transport

New AI Studio clone jobs resolve their provider only after the server has
classified the owned `user_*` voice as clone mode. The application clone
resolver reads exactly these five deployment inputs:

```dotenv
RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID=<dedicated-candidate-staging-endpoint-id>
RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST=sha256:<64-lowercase-hex>
RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION=8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb
RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256=<64-lowercase-hex>
RUNPOD_API_KEY=<restricted-canary-credential>
```

There is no baseline, legacy, stock, Hostinger, profile, tag, or fallback input
in that resolver. Stock Hero Voice continues to read only
`RUNPOD_OMNIVOICE_ENDPOINT_ID` for its RunPod endpoint. A missing or malformed
clone identity fails before a job or reservation is created with
`503 CLONE_CONFIG_UNAVAILABLE`.

Every accepted clone job and attempt stores an exact-key version-1
`CandidateAiStudioV3` snapshot before its one provider dispatch intent. It pins
the endpoint, contract 3, clone-only worker/build/model identities,
`combined-quality-v1`, normalizer, seed/synthesis/output parameters, commitment
hashes, attempt ID, and `{executionTimeout:540000,ttl:900000}`. Resume and poll
take endpoint and expected response identity only from that snapshot; the only
process value read during resume is the provider credential. The snapshot never
contains reference bytes/base64/path/transcript/name, an account ID, or a
credential. Provider output is accepted only when the exact v3 identity echoes
match and the audio is a nonempty, bounded mono 24 kHz PCM16 WAV. The validator
checks exact profile stage order, candidate count, guidance, temperature, ranking,
reference treatment, sample linkage, and watermark-only evidence. It never equates
the selected 24 kHz float hash with the separately resampled 16 kHz pre-embed hash.
Watermark evidence declares both internal float32 domains, which remain pinned-worker
attestations, and a final `pcm-s16le-mono-24000-wav-data-v1` domain. The application
strictly parses the returned WAV and independently recomputes that final digest over
the exact PCM16 data frames. This does not claim that the application independently
reproduces AudioSeal detection or SciPy resampling.

The provider request is the plan's explicit sensitive boundary and remains
disabled in this task. Task 6 must first record its complete private evidence
digest and the isolated local process must set both:

```dotenv
HERO_VOICE_CANARY_EXECUTION_MODE=1
HERO_VOICE_CANARY_TASK6_GATE_SHA256=<64-lowercase-hex-private-evidence-digest>
```

Production rejects this apply gate even if those variables are present. Do not
set either value as a placeholder and do not interpret the code seam as proof
that the processor/legal/license/readback gate has passed.

Clone failures are terminal and non-retryable. Durable primary states distinguish
unknown submit, timeout, poll unavailable, provider status invalid/missing,
identity mismatch, output invalid, owner cancel, and success. Reservation
release or settlement is claimed in the same SQLite transaction and can happen
at most once. A known unreadable job gets one durably claimed cancel attempt;
`cancelDisposition` is orthogonal and never replaces the primary failure.
Unknown/unreadable/failure states set `externalRunDisposition=abort_required`.
The pure abort directive exposes the 600-second first-park and 660-second final
observation deadlines for Task 5 to consume later. Task 2 does **not** create or
claim an append-only cost ledger, run-level park state, or control-plane park
mutation.

## Task 4 private storage and deletion recovery

The deletion coordinator activates only for the isolated canary process with an
explicit `HERO_VOICE_CANARY_ROOT`. Its database, reference store, generated-audio
store, review store, and deterministic quarantine all resolve beneath that one
owner-only root and outside the checkout, `public/`, and every web/static root:

```dotenv
NODE_ENV=test
HERO_VOICE_CANARY_EXECUTION_MODE=1
HERO_VOICE_CANARY_ROOT=/absolute/private/canary-root
DATABASE_URL=file:/absolute/private/canary-root/canary.sqlite?connection_limit=1
USER_VOICE_STORAGE_DIR=/absolute/private/canary-root/references
HERO_VOICE_CANARY_REVIEW_ROOT=/absolute/private/canary-root/review
HERO_VOICE_CANARY_REVIEW_KEY=<32-random-bytes-unpadded-base64url>
HERO_VOICE_CANARY_AUTH_ISSUER=<exact-verified-test-JWT-issuer>
```

The Task 5 bootstrap must create exactly one `SiteConfig` marker with key
`hero_voice_canary_database_marker` and value `hero-voice-canary-v1`. Missing or
wrong marker, a production process, relative/escaped paths, symlinks, unsafe
permissions, a database outside the root, or inconsistent review configuration
puts canary mutations into sticky read-only mode. Do not place any real key or
path in Git, logs, or reports.

On the first pristine startup, the coordinator also freezes a safe HMAC in the
same database under `hero_voice_canary_storage_binding_v1`. It binds the database,
reference root, review root, and out-of-band review key before any voice/review/
deletion lifecycle row or private file exists. A missing binding is never created
over existing lifecycle data. Every later startup and mutation rechecks it, so a
root or key change before Transaction A fails closed rather than blessing an empty
replacement directory and falsely reporting deletion success.

Startup sets and reads back `foreign_keys=ON`, `journal_mode=WAL`, and
`synchronous=FULL`, then resolves every nonterminal deletion intent before auth
bootstrap or another canary mutation. A failed reconciliation leaves reads
available but blocks upload, generation advancement/cancel, review mutation,
voice deletion, and account deletion until a clean process restart after repair.
There is no filesystem receipt or second database.

Voice delete, owner review close, and account hard-delete share Transactions
A/B/C. A records durable intent and opaque expected hashes before the first
move. Files move to a deterministic transaction/artifact quarantine with
per-file progress and directory `fsync`. B performs the one fixed authoritative
row outcome and scrubs temporary scope links. Quarantine files are unlinked only
after B commits; C marks `done` only after absence readback. A B rollback restores
files and clears deletion claims. Once B commits, recovery never restores them.
No API may return success while any intent is unresolved.

Voice upload uses the same SQLite coordinator before writing its first byte. Its
raw and normalized conversion files use deterministic names beneath
`.voice-upload-staging-v1/<intent-id>/` inside the marked owner-only canary root;
the legacy OS temporary-file converter is never used by the canary. The canary
reads the raw entry through the protected no-follow descriptor layer, sends those
bytes to FFmpeg on stdin, receives raw PCM on stdout, constructs the WAV container
in-process, and creates the normalized entry through the protected storage writer.
FFmpeg never receives or reopens a private source/destination pathname. The
normalized reference rename is durable before one SQLite transaction creates
`UserVoice` and marks the upload committed. Startup removes every deterministic
staging/final file for an uncommitted upload, or keeps the committed reference while
removing staging, then closes the intent. Thus a process crash during raw write,
conversion, final rename, or row commit cannot orphan private bytes. Account deletion
runs only after these intents reconcile and then removes any committed reference normally.

All canary reads, hashes, renames, and unlinks open the final component with
`O_NOFOLLOW`, validate regular-file/owner/`0600` state by `fstat`, and compare
device/inode with the pathname immediately before a path mutation. Directories are
opened no-follow and checked similarly for `fsync`/`rmdir`. Native filesystem errors
are replaced by fixed opaque application errors; private paths and filenames are
not propagated into responses or logs.

Node does not expose POSIX `unlinkat`/`rmdir-at`. Empty-directory cleanup therefore
holds `O_NOFOLLOW` descriptors for both the directory and its parent, revalidates
both device/inode identities immediately before the pathname `rmdir`, revalidates
the held parent after it, and fsyncs that held parent descriptor. Every observed
entry or parent swap fails closed. A same-UID process can still race the final
validation-to-`rmdir` syscall instruction; the canary host must not run an untrusted
same-UID co-tenant, and this residual must not be described as eliminated until a
native directory-relative removal primitive is available.

- Single-voice delete retains only an unlinked sanitized receipt. An atomically
  claimed `UserVoice` closes the generation/delete race: an existing active job
  produces `409 USER_VOICE_IN_USE`; a winning delete claim prevents a new job.
  Terminal failure never removes the reference, and a later delete succeeds.
- Owner review close requires the HMAC owner, `revealed` state, and exact revision.
  It retains one `closed` sanitized `ReviewRun` linked to the receipt and clears
  raw scores, reveal data, ledger sequence/head, and the private artifact manifest.
  The retained aggregate is canonical exact-key numeric JSON only: version 1,
  exactly 18 complete pairs, wins/ties/losses summing to 18, candidate CER passes
  in 0–18, and candidate critical-flag count in 0–72. Missing, malformed, extra,
  string, raw-score, mapping, subject, or transcript-shaped data blocks close
  before Transaction A.
- Account hard-delete requires the exact verified `{authIssuer,authSubject}`
  claims, the configured test issuer, and matching local Clerk subject. It derives
  the owner HMAC via the plan's HKDF/JCS contract before A, includes matched runs
  from every state, and deletes the user, voices, jobs/attempts, `CreditBalance`,
  `CreditLedger`, review rows, references, generated clone files, and review files
  together. Email/admin identity and webhook inference are not substitutes.

References have no expiry and no cleanup task deletes them. Generated/review
artifacts are removed only by review close or account delete. Transaction receipts
contain only opaque transaction/receipt IDs, artifact hashes, timestamps, and the
fixed outcome. The existing production Brand Asset hard-delete flow remains
unchanged when `HERO_VOICE_CANARY_ROOT` is absent; isolated canary accounts with
out-of-scope Brand Assets are rejected rather than mixing authorities.

## Disable and incident handling

Keep `HERO_VOICE_CLONING_ENABLED` unset or set to `0` outside the isolated
canary. Disabling it immediately hides and server-denies clone management,
submission, and polling without changing the stock catalog or other products.
Do not delete references, database rows, or active provider state as an ad-hoc
rollback. Use the coordinator interfaces and require their sanitized `done`
readback before claiming application-side deletion.

## Production: owner account only (ADR 0061)

Production is fail-closed unless the deployment carries the owner-consent
opt-in. The gate resolver returns `owner-consent-production-gate` only when
`HERO_VOICE_CLONE_PRODUCTION=1` and no canary variable
(`HERO_VOICE_CANARY_EXECUTION_MODE`, `HERO_VOICE_CANARY_TASK6_GATE_SHA256`,
`HERO_VOICE_CANARY_ROOT`) is set; any other value, or the two decisions combined,
throws `CLONE_CONFIG_UNAVAILABLE` and AI Studio shows "Hero Voice clone
ยังไม่พร้อมใช้งาน". `scripts/verify-hero-voice-durable.ts` runs the whole clone
state machine a second time under this gate with `NODE_ENV=production` and no
canary variable, so no other production-only closure can hide in the path.

Production `.env` for the owner cutover (the five ADR 0060 inputs plus the opt-in):

```
RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID=<persistent scale-to-zero endpoint>
RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST=sha256:<pinned image digest>
RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION=<approved source revision>
RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256=<sha256 of MODEL_MANIFEST.json>
RUNPOD_API_KEY=<existing>
HERO_VOICE_CLONING_ENABLED=1
HERO_VOICE_CLONE_PRODUCTION=1
HERO_VOICE_ASR_GATE=1
```

Also required and already present for stock Hero Voice: `OMNIVOICE_ENABLED=1`,
`OMNIVOICE_ALLOWED_USER_IDS` (must contain the owner's user id),
`GEMINI_SERVER_KEY` (ASR ears). References live under `USER_VOICE_STORAGE_DIR`
or, when unset, `<cwd>/uploads/user-voices` (mode 700, outside `public/`).
Restart with `pm2 restart ai-content --update-env`.

Endpoint shape: the pinned image with its default entrypoint, env
`HERO_VOICE_CLONE_IMAGE_DIGEST` / `RUNPOD_LOG_LEVEL=INFO` / `HERO_VOICE_EAGER_LOAD=1`,
GPUs A40 / RTX A6000, `workersMin 0`, `workersMax 1`, idle timeout 60 s,
execution timeout ≥ 540 s (the application policy), FlashBoot off, no volume.
First job of a session pays the cold start (2–3 min); keep-warm is deliberately
not used.

Rollback: remove `HERO_VOICE_CLONE_PRODUCTION` from `.env` and restart. Nothing
else changes; the endpoint at zero workers costs nothing and may be deleted
later. Opening the transport to any voice other than the owner's remains a
separate rights decision (ADR 0060 NO-GO still applies to everyone else).

# Editor Attempt Identity Hardening Design

## Scope

This remediation closes four remaining concurrency and crash-recovery gaps without touching browser-Back/history behavior. It adds one nullable, additive `VideoJob` field and does not authorize a production schema operation, deploy, merge, or push.

## Durable idempotency identity

`VideoJob.idempotencyFingerprint` stores a versioned SHA-256 digest of a canonical logical request. The canonical document contains an explicit operation kind (`preview`, `export`, or `broll-rerender`) plus every JSON request field except `idempotencyKey`; object keys are recursively sorted, array order is preserved, and JSON scalar types remain distinct. Including the whole request body is fail-closed for project/source/render/billing mismatches and avoids maintaining a second incomplete field allowlist.

Immediately after authentication and JSON parsing, the jobs POST route validates the optional key and computes the fingerprint. An authenticated exact-key lookup happens before feature, source-state, quota, or in-flight checks. A row replays only when its non-null persisted fingerprint exactly equals the request fingerprint. Exact matches return that job for every status. Legacy null fingerprints and mismatches return 409. User identity remains part of the database lookup, so another user's key cannot replay a row.

Every new editor jobs-route create stores key and fingerprint in the same database insert. A P2002 race performs the same exact fingerprint comparison. Other `createVideoJob` callers remain backward compatible and write a null fingerprint unless they explicitly supply one.

The additive nullable column is compatible with the repository's `prisma db push` deployment pattern. Rollout order is schema addition before application restart. Existing keyed rows remain intentionally non-replayable because their null fingerprint cannot prove request equality.

## Client attempt evidence

An owned create/export attempt captures its project ID, operation kind, request body, idempotency key, expected fingerprint, baseline active preview/export IDs, and baseline per-project storage ID. A project row or storage ID that existed before the attempt is unrelated evidence and cannot release it. Preview and export identities are not interchangeable, and a project replacement cannot adopt or retry an old project's attempt.

POST and authenticated poll responses carry `idempotencyKey` and `idempotencyFingerprint`. The client releases an ambiguous descriptor only when a response matches both values, or when a definitive mismatch response proves the logical request cannot be that row. Mutable quota/in-flight responses retain the descriptor and exact request identity for later retry.

## Archive lifecycle ownership

The editor shell owns a mounted flag and monotonically increasing archive generation. Starting DELETE captures generation, token, and project ID. Unmount increments the generation and clears the token. Every post-await mutation, project invalidation, and navigation requires the component to remain mounted and the captured generation/token/project to remain current. A late DELETE success after unmount is ignored. Existing mounted recovery success and replacement-project suppression remain unchanged.

## Fence crash scavenging

Scavenging streams quarantine directory entries and limits destructive removals—not preserved inspections—to 32 per call. This guarantees later removable entries are not starved by live, malformed, foreign, symlink, or unexpected entries earlier in directory order.

An exact receipt-hash/PID/UUID `.fence` direct child qualifies only when its owner PID is provably dead, it is a private owner-controlled `0700` directory, and stable inode/mode/containment checks pass. Safe non-recursive removals are:

- an empty directory;
- a directory containing only a private `0600` zero-length marker;
- a directory containing only a private `0600` byte prefix of the canonical receipt hash.

A non-prefix partial marker, extra file or child, symlink, foreign identity, live PID, EPERM/unknown liveness, non-private metadata, or unstable identity is preserved fail-closed. Cleanup unlinks only a verified removable marker and then removes only the verified empty directory.

## Verification

Deterministic RED/GREEN coverage exercises preflight replay under changed quota and saturation, every job status, mismatch and cross-user cases, exact/mismatch P2002 races, old resumed jobs, preview/export separation, project replacement, archive unmount, and all early-crash/starvation filesystem shapes. Final verification uses fresh disposable databases and asset roots, schema generation, changed-file TypeScript filtering, diff checks, and an explicit Task 4 unchanged check.

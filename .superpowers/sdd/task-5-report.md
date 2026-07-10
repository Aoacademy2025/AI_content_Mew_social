# Task 5 Report — Reviewed Media Quarantine

## Result

Task 5 replaces direct customer-media deletion with a reviewed, graph-rechecked quarantine flow. Customer files move into unique exclusively claimed `.media-quarantine/<runId>/<area>/` runs. Tmp cleanup remains an explicitly selected, separate direct-cleanup function. Restore and permanent purge are separate operations; purge requires a validated age of more than 24 hours.

Production data was not read or changed. PM2 remains dry-run, no production apply/purge flag was enabled, and Discord configuration/code was neither changed nor printed.

## RED evidence

The verifier was created before production implementation. The first run failed with:

```text
Cannot find module '../src/lib/media-quarantine'
```

Subsequent targeted RED cycles caught and locked these failures before their fixes:

- orphan 14-day boundary, expired/live/null/shared owners, exact record shape, and zero dry-run mutation;
- reviewed-hash mismatch and malformed graph producing zero moves;
- reference and mtime/fingerprint changes after planning;
- traversal and symlink rejection;
- manifest-write rollback, including a concurrent original-path collision;
- restore collision races and rollback collision races;
- purge before 24 hours, changed fingerprints, and references added between purge batches;
- sanitized metrics and failed-graph no-overwrite;
- `.media-quarantine` and `.ops-metrics` ancestor symlink redirection;
- restore availability during an unrelated graph incident;
- deterministic run-ID collision between same-plan/same-millisecond applies;
- manifest timestamp/run-ID tampering;
- stale pre-apply metrics and heartbeat ordering;
- CLI mode/hash gates and incomplete-graph no-heartbeat behavior;
- raw owner/path disclosure in CLI/admin failures;
- missing exact reviewed-manifest artifact;
- apply invalidating its own graph through an in-progress run directory;
- expired project-draft post-apply graph/metrics failure;
- missing project metadata after legitimate mature purge;
- an older purge tombstone masking a newer restored-then-missing lifecycle.

## GREEN implementation

- Stable records contain exactly `key`, `absolutePath`, `sizeBytes`, `mtimeMs`, `effectiveExpiresAt`, `reason`, and `fingerprint`.
- Fingerprints hash only key/size/mtime. The reviewed manifest hash deterministically covers every record field.
- Planning uses the complete reference graph. At least one owner is eligible only when every owner is expired; zero-owner files require strictly more than 14 days.
- Null expiry, `alwaysProtect`, graph/scan/path/stat errors, symlinks, root escapes, active work, and exact boundaries remain protected/fail closed.
- Apply requires the reviewed hash, exclusively claims a unique timestamp/hash/random run, rebuilds the graph per batch, supplies in-flight moved mtimes, revalidates canonical path/stat/fingerprint, and moves customer files into quarantine.
- Atomic final/recovery manifests preserve moved records. A failed manifest write rolls back with atomic no-replace hard links; unresolved collisions preserve the quarantined copy and recovery manifest.
- Restore uses atomic no-replace transfer, validates manifest/path/fingerprint, clears purge intent before move, skips collisions, and remains available during unrelated DB graph errors.
- Purge is separate, older-than-24-hours only, locked per run, graph-rebuilt per bounded batch, and path/stat/fingerprint/references are rechecked immediately before unlink.
- State-hashed purge intents are written atomically before unlink. Valid tombstones keep expired project references classifiable after purge; restored/newer/changed/ambiguous lifecycles override older tombstones and fail closed when unusable.
- Quarantine-aware project fallback accepts only validated manifest state and recomputes expiry from original mtime plus the owner's current plan. Unexpected missing or tampered quarantine state remains a graph error.
- Health metrics contain only the six required sanitized fields and are atomically replaced only from a complete dry-run or fresh post-apply plan.
- Complete dry-runs atomically write mode-0600 `.ops-metrics/media-cleanup-review.json` containing the exact reviewed records and hash. CLI output exposes only the relative artifact label and safe counts/hash; authenticated admin GET may return exact candidates.
- CLI dry-run/apply writes the review/metrics artifacts before heartbeat. Restore, purge, graph failures, artifact failures, metrics failures, and apply failures never advance the heartbeat.
- Admin DELETE requires `{ apply: true, manifestSha256 }`, awaits quarantine, optionally invokes the separate explicit tmp function, writes fresh metrics, and has no restore/purge entry point.

## Verification

Fresh final commands and results:

```text
npx tsx scripts/verify-media-quarantine.ts                 PASS (run 1)
npx tsx scripts/verify-media-quarantine.ts                 PASS (run 2)
npx tsx scripts/verify-media-reference-graph.ts            PASS
npx tsx scripts/verify-media-retention.ts                  PASS
npx tsx scripts/verify-media-cleanup-mode.ts               PASS
DATABASE_URL=file:/tmp/<unique-backfill>.db npx prisma db push --skip-generate  PASS
DATABASE_URL=file:/tmp/<unique-backfill>.db npx tsx scripts/verify-media-expiry-backfill.ts  PASS
DATABASE_URL=file:/tmp/<unique-video-job>.db npx prisma db push --skip-generate  PASS
DATABASE_URL=file:/tmp/<unique-video-job>.db npx tsx scripts/verify-video-job-expiry.ts      PASS
npx tsc --noEmit                                           PASS
git diff --check                                           PASS
```

The independent read-only re-review finished with **Spec PASS / Quality Approved**, with no Critical or Important findings.

## Commit

Exact subject: `feat(media): quarantine cleanup with recheck and restore`

The immutable commit hash is reported in the Task 5 handoff and can be read with `git log -1 --format=%H` after this report is committed.

## Self-review and operational notes

- Customer apply and tmp apply are deliberately separate. The reviewed manifest hash gates customer records only; tmp requires its own explicit flag and candidate list.
- A crash-left `.operation.lock` fails closed and requires validated manual recovery after confirming no restore/purge process owns the run. Automatic stale-lock deletion is intentionally out of scope.
- Some pre-mutation purge failures report through a thrown operation report with a zero-byte operational error rather than a file-sized error; no deletion occurs in those paths.
- The review artifact intentionally contains absolute paths and is mode 0600. Ordinary CLI/admin failure output is allowlisted and does not print paths, URLs, owner IDs, or graph-error arrays.
- `src/lib/media-reference-graph.ts` changed only for the authorized Task 5 integration: explicit workspace roots, owned in-progress run exclusion, validated quarantine metadata, and project expiry reconstruction.
- No production runtime, schema, PM2 apply configuration, or Discord code changed.

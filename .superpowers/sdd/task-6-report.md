# Task 6 Report — Project Preview Media State

## Scope

- Added the exact `ProjectMediaState` response union and a pure state resolver.
- Added fail-closed local render inspection for `/api/renders/` and `/renders/` URLs.
- Added `mediaState` to done VideoJob poll responses without selecting `inputJson`.
- Added `previewMediaState` to owner-scoped EditorProject detail reads only.
- Preserved Task 5 scheduled cleanup dry-run behavior and made no runtime, PM2, cron, Discord, or webhook changes.

## TDD evidence

### RED

Created `scripts/verify-project-media-state.ts` first and ran:

```text
npx tsx scripts/verify-project-media-state.ts
TypeError: resolveProjectMediaState is not a function
exit 1
```

After adding the direct pure-resolver assertions, RED remained the expected missing-feature failure:

```text
TypeError: projectMediaState is not a function
exit 1
```

### GREEN

Implemented the minimum shared state resolver, local filesystem adapter, job-poll response field, and project-detail helper. The verifier then passed:

```text
PASS project media state
exit 0
```

The verifier covers available local media, exact-boundary expiry, missing before expiry, missing after expiry, traversal, encoded traversal, symlink, zero-byte file, non-file path, external URL, legacy null expiry, active export preference, and cross-owner denial.

## Review

Fresh read-only reviewer verdict:

- Spec PASS
- Quality Approved
- Critical: none
- Important: none
- Minor: the verifier does not directly lock the hot-poll response/select shape or the null-export fallback branch. The reviewer confirmed the production implementation is correct; this is a future-regression coverage note only.

## Fresh final verification

Run from the Task 6 final diff before commit:

```text
npx tsx scripts/verify-project-media-state.ts       PASS project media state
npx tsx scripts/verify-media-quarantine.ts          PASS media quarantine
npx tsx scripts/verify-media-reference-graph.ts     PASS media reference graph
npx tsc --noEmit                                    exit 0
git diff --check                                    exit 0
```

The Prisma commands emit the repository's existing Prisma 7 configuration deprecation warning; there are no test failures.

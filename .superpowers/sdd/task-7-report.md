# Task 7 Report — Expired and Missing Preview States

## Scope

- Added `ProjectMediaState` to the Editor v2 job state and propagated it through job polling plus project create/load/reset paths.
- Added an explicit unavailable-preview view for normal expiry, unexpected missing media, and legacy unknown-expiry media.
- Kept completed jobs in phase `done`; media availability is represented independently.
- Added defensive desktop/mobile preview-player error transitions.
- Preserved project draft/script/settings when the user returns to the normal preparation step; the rerender CTA has no submit capability.
- Made no Task 8, production runtime, schema, backfill, PM2, root cron, Discord, or webhook changes.

## TDD evidence

### RED

The verifier was created before production implementation and failed because the view did not exist:

```text
npx tsx scripts/verify-expired-preview-ui.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../ExpiredPreviewView
exit 1
```

Additional behavior was added test-first. Each new assertion failed for the missing production helper before implementation:

```text
TypeError: mediaStateFromJobPoll is not a function
TypeError: pollResponseIsCurrent is not a function
TypeError: prepareExpiredPreviewRerender is not a function
```

### GREEN

The final executable verifier covers:

- Exact expired copy and CTA.
- Rerender callback invocation and reset-job → preparation-step-only behavior.
- Distinct missing and unknown-expiry copy, support code, and support action.
- No video player for every unavailable state.
- Done/non-available view selection without overloading job phase.
- New job-poll state winning over stale project detail.
- Available → missing video-error transition while preserving expired/missing states.
- Generation, job-id, and monotonic request-order rejection for stale polls.
- A response started before video `onError` being unable to undo the missing incident.
- Desktop and mobile preview error wiring.

```text
npx tsx scripts/verify-expired-preview-ui.ts
PASS expired preview UI
exit 0
```

## Review

The fresh read-only reviewer initially found one Important race: overlapping poll responses could arrive out of order and overwrite a newer media state. The fix added generation, active-job, and monotonic applied-request guards, rechecks after both fetch and JSON parsing, explicit invalidation on player error, and a stable ref for the project-detail fallback.

Final reviewer verdict after the fix:

- Spec PASS
- Quality Approved
- Critical: none
- Important: none
- Minor: none

## Fresh final verification

```text
npx tsx scripts/verify-expired-preview-ui.ts    PASS expired preview UI
npx tsx scripts/verify-project-media-state.ts   PASS project media state
npx tsx scripts/verify-media-quarantine.ts      PASS media quarantine
npx tsc --noEmit                                exit 0
git diff --check                                exit 0
```

The project-state verifier emits only the repository's existing Prisma 7 configuration deprecation warning.

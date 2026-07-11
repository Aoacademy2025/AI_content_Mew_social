# Historical Trial Media Expiry Hotfix Design

## Problem

The production dry-run report used each owner's current plan for every legacy null expiry. That is unsafe when a user completed media during the public seven-day PRO trial and later reverted to FREE: the report assigns three days instead of the proven minimum seven days. The reviewed production report demonstrated 42 affected VideoJobs and 26 premature `alreadyExpired` classifications.

## Scope

Use durable `User.trialStartedAt` evidence only. If a legacy Video or completed VideoJob was created/completed in the half-open public-trial window `[trialStartedAt, trialStartedAt + 7 days)`, treat PRO as the minimum historical retention plan. Select the plan with the longer retention between that PRO floor and the current owner plan, so BUSINESS is never shortened. Outside that window, preserve the existing current-plan fallback.

Do not reconstruct payment or coupon history, change schema, mutate production data, merge, deploy, or run backfill apply. The old production report hash remains invalid for application after this behavior changes.

## Considered Approaches

1. **Trial evidence as a retention floor — selected.** Fixes every confirmed production mismatch with one durable timestamp and cannot shorten a current BUSINESS entitlement.
2. **Full entitlement-history reconstruction.** Could use trial, payment, and coupon intervals, but overlap and manual-plan history make this too broad for the confirmed hotfix.
3. **Fourteen days for all legacy rows.** Maximally conservative but discards the reviewed 3/7/14 policy and over-retains all legacy media.

## Data Flow

`discoverMediaExpiryBackfill` selects `user.plan` and `user.trialStartedAt`. `planMediaExpiryBackfill` chooses the normal base timestamp (`finishedAt`, then `updatedAt`, then `createdAt` for VideoJobs; `createdAt` for Videos), resolves the retention plan, computes the expiry, and records the source in the human-readable reason. Hashing, report-first dry-run, hash-gated apply, null-only updates, and file non-deletion remain unchanged.

## Safety and Error Handling

- The trial window is start-inclusive and end-exclusive, matching a seven-day entitlement.
- Invalid non-null trial timestamps fail report construction instead of silently falling back to a shorter plan.
- Historical trial evidence raises FREE to PRO but never lowers PRO or BUSINESS.
- Rows outside the trial window keep the existing current-owner fallback.
- No production operation is part of this PR.

## Verification

Add pure boundary coverage and database-backed discovery coverage for a user who is currently FREE after completing media during a PRO trial. Verify the row uses PRO, receives seven days, and is not prematurely expired. Verify exact trial-end fallback, current BUSINESS preservation, deterministic hashing, dry-run non-mutation, hash-gated apply behavior on temporary SQLite, TypeScript, rollout safety, and diff cleanliness.

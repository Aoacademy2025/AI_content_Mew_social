# Final handoff save-failure fix

Date: 2026-09-17

Base: `ae2d3deb`

## RED

`npx tsx scripts/verify-hero-script-workspace-browser.mts` reproduced the stale continuation: after an active handoff save failed, clicking “ทิ้งแล้วไปต่อ” increased handoff POSTs from one to two. The equivalent non-active library case used the same dialog branch.

The mounted fixture also holds operation A's save, invalidates it through a context change, and starts operation B for the same Script through the opposite entry point. Authorizing continuations by Script ID allowed A to consume B's ownership.

## GREEN

Failed-save handoffs render retry and cancel only. The discard action is also guarded in its continuation handler, while failed New/open/existing-project navigation and pre-generation replacement retain their approved explicit discard behavior.

Pending handoff actions now carry the exact immutable operation object. Execution requires reference identity, validity and an unused posting state; finalization and release affect only that operation. The active and library failed-save cases send no stale POST, and the held-save ABA case produces one POST and one owned navigation.

## Verification

PASS:

- `npx tsx scripts/verify-hero-script-workspace-browser.mts`
- `npx tsc --noEmit --pretty false`
- changed-file ESLint
- `npm run build`
- `git diff --check`

The mounted browser uses fictional local records and provider responses. It performs no production write, authenticated external navigation or billable generation.

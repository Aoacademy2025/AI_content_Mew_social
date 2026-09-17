# Final saved-handoff correctness re-review

Base: `ae2d3deb`  
Head: `d19c1046`

## Verdict

**BLOCK.** The reported stale-discard path is fixed: failed handoff saves expose retry/cancel only, the handler rejects discard, and ordinary New/open/navigation discard behavior remains. Exact operation identity also blocks the covered successful-save ABA continuation.

## Blocking finding

1. **[medium, high confidence] An invalidated handoff’s delayed save failure can still publish a stale dialog over a newer operation.** `requestWorkspaceAction()` unconditionally stores its action when `saveLatest()` returns false (`page.tsx:295-298`), without checking that a handoff action’s operation is still valid and still equals `handoffOperationRef.current`. In the covered ABA sequence, make operation A’s held save fail after a context change creates operation B: A can then show the handoff failure dialog while B is saving or posting. Dismissing that stale dialog calls the unscoped `invalidateHandoff()` (`page.tsx:408-415`), invalidating B; if B’s POST has started, its created project result is discarded and a retry can create another project. Before publishing handoff recovery, require exact live operation identity. Dialog close/retry must also act only on the pending operation object. Add the same-script ABA case with A’s save failing and assert no stale dialog, one POST and one owned navigation.

## Independent verification

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `git diff --check ae2d3deb..d19c1046` — PASS

The passing type/lint/build checks were not repeated.

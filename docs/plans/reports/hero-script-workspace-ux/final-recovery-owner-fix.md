# Final handoff recovery-owner fix

Date: 2026-09-17

Base: `d19c1046`

## RED

The mounted verifier held operation A's save, invalidated A through a context change, started same-script operation B from the opposite entry point, then failed A's save. B reached its held POST, but A published “ข้อความล่าสุดยังอยู่ในหน้านี้” over B (`true !== false`).

## GREEN

`requestWorkspaceAction()` verifies a handoff action's exact operation object before saving, immediately after the awaited save, before publishing recovery UI, and before POST execution. A stale failure returns silently. Save exceptions use the same ownership test.

Dialog close/cancel targets only the pending action's captured operation. Retry first proves that exact operation is still current and valid; stale retry closes without changing the newer owner. POST success, error and final release retain their existing exact-owner checks.

The failure-path ABA fixture now observes no stale A dialog, exactly one POST from B, and one valid B navigation.

## Verification

PASS:

- `npx tsx scripts/verify-hero-script-workspace-browser.mts`
- `npx tsc --noEmit --pretty false`
- changed-file ESLint
- `npm run build`
- `git diff --check`

The mounted browser uses fictional local data and provider responses. No production write, customer data, external authenticated navigation or billable generation was used.

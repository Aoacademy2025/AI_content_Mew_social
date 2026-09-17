# Hero Script workspace — final race fix

Date: 2026-09-17

Branch: `mew/hero-script-workspace-ux`

Scope: final correctness/security blockers only.

## RED

Command: `npx tsx scripts/verify-hero-script-workspace-browser.mts`

The mounted fixture reproduced all three findings before the fix:

- New persisted `Snapshot when New began` but discarded `Latest edit while New awaited save`.
- Active existing-project navigation changed route while its latest save was held.
- A handoff response owned by the prior Script navigated away after New replaced the workspace.

Additional failing scenarios covered record open/create while a later edit was pending, a failed follow-up save, library existing-project navigation, and generation/regeneration crossing handoff.

## GREEN

`saveLatest()` now drains serialized writes until the current visible snapshot is committed. Its callback reports the committed snapshot, so a newer visible edit never appears saved prematurely. A failure on the follow-up write leaves the newest text mounted and blocks New, record open and handoff.

Existing-project actions from both the active editor and library pass through the page's existing save/discard guard and perform zero handoff POSTs. Handoff invalidates older generation/regeneration work, locks conflicting editor controls during its POST, and finalizes only when its exact Script draft still owns the workspace. Stale success, error and finalizers cannot mutate, toast or navigate.

## Verification

All passed on the final code:

- `npx tsx scripts/verify-hero-script-workspace-browser.mts`
- `npx tsx scripts/verify-hero-script-workspace.ts`
- `npm run verify:hero-script-library`
- `npm run verify:hero-script` — 531 checks plus access regression
- `npm run verify:brand-library-ui`
- `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-brand-profile-library.ts`
- `npm run verify:admin-number-mapc-definition` — 23 checks
- changed-file `npx eslint ...`
- `npx tsc --noEmit --pretty false`
- `npm run build`
- `git diff --check`

## Limitations

The browser verifier mounts the real client page and compiled production CSS with local fictional API/provider stubs. It does not exercise Clerk, real server navigation, customer data or billable generation. Owner/access boundaries remain covered by the isolated SQLite and existing access regressions recorded above.

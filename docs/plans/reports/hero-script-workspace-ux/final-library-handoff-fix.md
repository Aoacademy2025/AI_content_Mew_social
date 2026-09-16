# Final library handoff fix

Date: 2026-09-17

Commit base: `9d4293c5`

## RED

`npx tsx scripts/verify-hero-script-workspace-browser.mts` timed out waiting for the save-failure preservation dialog. A non-active library create posted and navigated without saving the mounted writer. The added mounted cases also exposed separate editor/library POST owners.

## GREEN

All send/create entry points now acquire one page-owned operation token. The page applies the existing save/discard guard before any POST, captures the initiating workspace, and alone handles the response and navigation. New/open/context replacement invalidates result ownership while retaining the in-flight POST gate until settlement, so stale success/error/finalizers cannot navigate and a second editor/library click cannot create another project.

Mounted coverage proves:

- non-active library create drains edits made after the first save begins;
- latest-save failure preserves text and sends no POST;
- pre-generation topic/Hook cancel sends no POST and explicit discard sends one;
- editor→library and library→editor competition sends one POST and only its owner navigates;
- New/open during a held POST rejects its result and cannot start a second POST.

## Verification

PASS:

- `npx tsx scripts/verify-hero-script-workspace-browser.mts`
- `npx tsx scripts/verify-hero-script-workspace.ts`
- `npm run verify:hero-script-library`
- `npm run verify:hero-script` — 531 checks plus access regression
- changed-file ESLint
- `npx tsc --noEmit --pretty false`
- `npm run build`
- `git diff --check`

The mounted browser seam uses the real client page and compiled CSS with fictional local API/provider responses. It does not use Clerk, customer data, production writes or billable generation; isolated access tests cover owner and paid-equivalent gates.

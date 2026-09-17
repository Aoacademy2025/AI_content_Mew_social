# Hero Script workspace — integrated QA

Date: 2026-09-17
Branch: `mew/hero-script-workspace-ux`
Scope: isolated local fixture and SQLite only; no customer data, provider request, production write, or deployment.

## Result

PASS. The mounted fixture uses the actual Hero Script page, locked-preview component, compiled `src/app/globals.css`, and a measured dashboard allocation (64px top navigation, 240px desktop sidebar, 64px mobile bottom tabs). It is not an authenticated end-to-end route test: Clerk, server navigation and API access are locally stubbed. The authoritative access/owner checks ran separately against isolated SQLite.

## Browser evidence

- 20 fictional profiles and exactly 500 fictional scripts loaded. At 1366×768 the topic input was asserted within the initial viewport, including the dashboard allocation; desktop and 320px document widths did not overflow.
- At 390×844, the workflow exercised Thai search beyond the old 50-row boundary, 20-row pagination, combined brand/status request, row opening, save-before-handoff, explicit recent recovery, sent-project navigation, explicit create-new, profile legacy/published behavior, empty/no-match/error/retry states, and locked preview.
- Delayed-response coverage edits the Script again after an awaited save begins and proves New, record open and create-new drain through that latest snapshot. A failed follow-up save preserves the latest text and blocks replacement/handoff without showing it as saved.
- Both existing-project entry points use the same save/discard guard and still send zero handoff POSTs. Held generation, section regeneration and handoff responses cannot mutate or navigate away from a replacement workspace; stale failures stay silent.
- Keyboard used Tab/Enter/typeahead for tabs, brand filter, Thai search, row opening and the main send action. Chromium headless focused the native status select but did not apply Arrow/Alt+Arrow/Space selection; the combined status request was therefore exercised with Puppeteer's native select API and is recorded as a harness limitation, not keyboard proof.
- Fictional captures: `hero-script-workspace-desktop.png`, `hero-script-workspace-mobile.png`, and `hero-script-locked-preview-mobile.png` in `docs/plans/reports/hero-script-workspace-ux/fixtures/`.

## Fix found during QA

RED: after a genuine empty library response, a later failed refresh displayed both “โหลดคลังสคริปต์ไม่สำเร็จ” and the false-empty “ยังไม่มีสคริปต์.” The new browser assertion failed. `ScriptHistory` now suppresses list/empty content while an error is present; the mounted browser check is green.

## Final race correction

RED: the mounted verifier reproduced three release blockers: New discarded an edit typed after its first save request began, existing-project navigation bypassed a held save, and a held handoff navigated away from a replacement workspace. GREEN: serialized saves drain through the current visible snapshot, project navigation uses the page guard, and generation/regeneration/handoff responses validate the initiating workspace before finalization.

## Final library handoff correction

RED: creating an Editor project from a non-active library row skipped the mounted writer's pending save/brief confirmation and used a separate POST owner. GREEN: every editor and library create action now enters one page-owned operation. The mounted verifier proves latest-save drain and failure preservation, brief cancel/discard, one POST for editor↔library competition, first-owner navigation, and a retained POST gate after New/open invalidates response ownership.

## Final save-prerequisite correction

RED: the failed-save handoff dialog still exposed “ทิ้งแล้วไปต่อ,” which posted stale saved text. GREEN: active and library handoff failures now offer retry/cancel only, while New/open/navigation keep their approved discard path. Pending handoffs carry immutable operation identity, preventing an invalidated held-save continuation from consuming a newer same-script token.

## Final recovery-owner correction

RED: invalidated operation A could publish its delayed save-failure dialog after same-script operation B became current. GREEN: recovery publication, close, cancel and retry all require A's exact live operation object. The held-save failure ABA fixture proves no stale dialog, one POST and B's valid navigation.

## Commands rerun after the final correction

| Command | Status |
| --- | --- |
| `npx tsx scripts/verify-hero-script-workspace.ts` | PASS |
| `npx tsx scripts/verify-hero-script-workspace-browser.mts` | PASS |
| `npm run verify:hero-script-library` | PASS |
| `npm run verify:hero-script` | PASS; includes access regression |
| `npm run verify:brand-library-ui` | PASS |
| `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-brand-profile-library.ts` | PASS |
| `npm run verify:admin-number-mapc-definition` | PASS (23 checks) |
| `npx eslint scripts/verify-hero-script-workspace-browser.mts src/app/(dashboard)/hero-script/_components/ScriptEditorStep.tsx src/app/(dashboard)/hero-script/_components/ScriptHistory.tsx src/app/(dashboard)/hero-script/page.tsx` | PASS |
| `npx tsc --noEmit --pretty false` | PASS |
| `npm run build` | PASS; optimized build completed and emitted `.next/BUILD_ID` |

The initial direct profile command lacked the repository's required server-only loader and failed before exercising tests; the listed registered command is the passing, valid invocation. Prisma printed only its existing configuration deprecation notices.

`verify:hero-script-workspace` now registers the two workspace checks in `package.json`; CI runs that command after the existing Hero Script launch suite.

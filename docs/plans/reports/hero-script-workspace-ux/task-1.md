# Task 1 — focused writing surface and retained workspace

## Delivered

- Added the Thai writing/library tab shell. The writing pane uses `hidden`, not conditional rendering, so the topic, selected Hook, draft and editor save owner stay mounted while the library is visible.
- Stored only explicit profile/duration and guide-open preferences under account-scoped browser keys. A remembered profile must still be in the returned profile list and duration must be 30/60/90; invalid values fall back to `ไม่ใช้โปรไฟล์` and 60 seconds.
- Replaced the always-expanded brand list with a searchable, keyboard/touch-accessible selector. Profile create/edit/delete stays behind `จัดการโปรไฟล์` and retains the existing form and confirmation flows.
- A versioned-profile PUT response now preserves its read-only message and routes through its supplied `manageUrl` (`/brands`), rather than attempting an implicit mutable update.
- Collapsed the optional guide by default and remembered an explicit per-account guide preference.

## Red → green evidence

The first run of `npx tsx scripts/verify-hero-script-workspace.ts` failed with `MODULE_NOT_FOUND` for `hero-script-workspace-state`; the test existed before its implementation.

After adding the state seam, the same command passes. It covers fictional local data only:

- a library tab change preserves topic, selected Hook and draft values;
- a valid revision-0 profile and duration restore for the matching account;
- another account cannot inherit those preferences;
- unavailable profile and invalid duration fall back safely.

Task 3 owns further expansion of this script for integrated restore/save/handoff races. Its current test does not claim to test those boundaries.

## Checks

- `npx eslint src/app/(dashboard)/hero-script/page.tsx src/app/(dashboard)/hero-script/_components/BrandProfilePanel.tsx src/app/(dashboard)/hero-script/_components/HeroScriptQuickStart.tsx src/app/(dashboard)/hero-script/_components/hero-script-workspace-state.ts`
- `npx tsc --noEmit`
- `npx tsx scripts/verify-hero-script-workspace.ts`
- `npm run verify:hero-script` — 531 Hero Script checks plus paid-equivalent access check passed.
- `git diff --check`

## Responsive and browser verification

The tab and setup layouts use wrapping/grid breakpoints, 44px-or-larger actionable controls, a 16px selector/topic surface, and bounded selector scrolling. At desktop width the compact header, collapsed guide and setup row leave the topic above the 768px fold; at 390px the setup changes to one column without a horizontal page row.

I attempted the approved in-app browser binding through the browser-control runtime. It returned exactly `No browser is available`. No live production route was opened. Local Chrome and the repository's installed Puppeteer are available, but the real `/hero-script` route is authentication-gated and the existing history interface is being replaced by Tasks 2–3. Task 4 should run the repository's isolated browser-fixture approach against the integrated surface at 1366×768 and 390×844, including actual tab clicks with retained topic/Hook/draft values.

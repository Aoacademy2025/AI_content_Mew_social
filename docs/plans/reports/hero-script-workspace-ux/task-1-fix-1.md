# Task 1 — fix round 1

## Fixed

- Preference hydration now runs once per account and only before an explicit workspace change. Topic/profile/duration/Hook/draft changes and restoring a record mark the workspace authoritative, so a delayed profile response cannot replace that context.
- Hook is revealed only after a non-empty topic; the full editor is revealed only after a selected Hook. The topic remains editable, so completed context can be revisited without a forced wizard.
- Added an isolated mounted-client Puppeteer harness. It bundles the actual `HeroScriptPage` with esbuild, stubs Next/Clerk/client telemetry and only local fixture APIs, and never opens the protected production route.

## Red → green

The harness asserts that Hook/full-script controls are absent before their prerequisites; that condition fails against the pre-fix always-mounted page. The same mounted fixture then drives topic entry, Hook selection, script generation and body edit, switches both tabs, and verifies exact topic/Hook/draft values remain. It also delays profiles beyond an explicit 30-second choice, verifies guide persistence, sees revision-0/published fixture controls, and checks 390px horizontal overflow.

## Commands

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `npx tsc --noEmit` — exit 0
- `git diff --check` — exit 0

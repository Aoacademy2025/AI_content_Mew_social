# Task 1 — fix round 2

`changeTopic()` now invalidates any Hook whose context no longer matches synchronously. Clearing/changing topic therefore hides the Hook path, but keeps the draft and editor mounted; the surface says the draft remains and asks for a new Hook before further generation.

The mounted Puppeteer fixture first reproduced the stale progression assertion after clearing topic, then passed after the fix. It clears/re-enters topic, chooses a new Hook, verifies edited draft retention across keyboard-activated tabs, saves all legacy revision-0 profile fields (niche, audience, tone, banned words, CTA, notes), and verifies a published profile’s 409 routes to its `manageUrl`.

Checks:

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `npx tsc --noEmit` — exit 0
- `git diff --check` — exit 0

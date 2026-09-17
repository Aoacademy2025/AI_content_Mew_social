# Hero Script workspace release

## CI repair review

- PR: #512
- Repair commit: `d9b7f22b`
- CI run `35194376931` failed only in `verify:hero-script-launch`: its static check required the retired literal `5 ขั้นตอน`.
- `HeroScriptQuickStart` still declares five step objects and links `/docs/hero-script`. The repair changes only `scripts/verify-hero-script-launch-assets.ts` to count those five declarations.
- RED: the failed GitHub workflow. GREEN: `npx tsx scripts/verify-hero-script-launch-assets.ts`, `npm run verify:hero-script-launch`, `npm run verify:hero-script-workspace`, and `npx tsc --noEmit --pretty false` locally.
- No production/runtime/schema behavior changed. Independent scoped review and fresh CI passed before merge; see the release result below.

## Release result

- PR: https://github.com/Aoacademy2025/AI_content_Mew_social/pull/512
- Feature head before merge: `671eeec7`; merged main SHA and deployed SHA: `53fe52dd49084daab2cad8fbd178f35b06a7aca5`.
- PR CI: run `35195485402` green. Main CI: run `35196571904` green.
- CI repairs: `d9b7f22b` makes the launch contract check the retained five step declarations; `671eeec7` enables the repository-standard Puppeteer no-sandbox flags only under `CI`. Both received independent scoped PASS reviews.
- Deploy: documented low-heap profile; CI recheck green; initial and final render-drain checks each found `VideoJob=0`, `RenderJob=0`; Prisma reported the live schema already in sync; staged build compiled and passed TypeScript; atomic swap and PM2 health passed; maintenance and drain were released.
- Production: BUILD_ID `GACOeysdhWVQ3yAlMHVsg`; local/public health and current static manifest each `200`; unauthenticated `/hero-script` redirects `307`, unauthenticated `/api/scripts/library` returns `401`; web, video-worker, both render workers and Story Film worker online. Sanitized new-process log window: zero errors, Hero Script mentions, or uncaught/unhandled patterns.
- Provider live-smoke was intentionally not run because it makes billable provider requests.

## Authenticated browser smoke

- Actual signed-in Chrome on production SHA `53fe52dd`: initial writer was blank; the two workspace tabs loaded; at 1366×768 the topic input was visible at `top=666.5`, `bottom=710.5`, `scrollY=0`, with no horizontal overflow.
- Library loaded without error. Functional status filtering with native `selectOption("draft")`, fictional no-match search, and write/library switching passed; search/status and a transient fictional topic persisted across the tab switch.
- At 390×844 and 320×844, writer/topic and library search/filter controls fit with no horizontal overflow.
- Native status-select keyboard automation (`ArrowDown`/`Enter`, `Space`/`ArrowDown`/`Enter`) did not change the value. This is an explicit automation limitation, not a keyboard-pass claim; `selectOption` passed.
- No generation, save, record-open, handoff, delete, customer mutation, customer text, or screenshots were used. Inputs were cleared by reload; blank writer rechecked; viewport reset; user Chrome tab retained.

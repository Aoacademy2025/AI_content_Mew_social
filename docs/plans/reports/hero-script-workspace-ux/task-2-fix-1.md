# Task 2 fix round 1

Date: 2026-09-17

## Fixed blockers

- `GET /api/scripts/library` now adds `brandOptions: Array<{ id, name }>` for owner-scoped Brand Profiles referenced by the owner's Scripts. The one extra bounded metadata query includes archived profiles for historical filtering, returns no editable fields, and does not change `/api/brand-profiles` or new-creation selector behavior.
- `ScriptLibrary` consumes those read-only options instead of the active-profile endpoint, so a historical brand remains filterable when none of its rows is on the visible page.
- An applied library response now clears a previous request error, preventing a successful `refreshKey` reload from retaining the failure alert.

## RED/GREEN evidence

- RED: the 500-row SQLite verifier failed because `brandOptions` was absent while the archived brand's only script was outside page 1.
- GREEN: page 1 excludes that script but contains its `{ id, name }` filter option; the foreign account's referenced brand never appears.
- GREEN mounted behavior: the real `ScriptLibrary` first receives HTTP 500, then succeeds after `refreshKey` changes. The failure alert disappears, the archived option appears despite the visible row having no brand, selecting it requests `brandProfileId=archived-brand`, and rapid search input waits for the debounce.

## Query cost and verification

Each library request adds one bounded owner-scoped BrandProfile metadata query to the existing count/page transaction. Project availability remains one batched lookup only when the current page has links; there is no per-row query.

- `npm run verify:hero-script-library` — PASS, including SQLite and mounted Chromium behavior.
- Scoped ESLint, TypeScript, and `git diff --check` — PASS.

The shared approved plan's response contract was updated in the worktree with the additive `brandOptions` field and its read-only historical-filter rationale. No production data, providers, schema, creation semantics, or deployment were touched.

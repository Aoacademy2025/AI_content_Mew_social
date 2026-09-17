# Task 2 — Whole-library search and paginated list

Date: 2026-09-17
Scope: Task 2 only; no page-shell, prompt/model, schema, production-data, or deployment changes.

## Outcome

- Added authenticated `GET /api/scripts/library` with the existing `requireHeroScriptUser()` gate before validation and data access.
- Added an owner-scoped Prisma service for trimmed topic search, brand/status filters, stable `updatedAt DESC, id DESC` offset pagination, matching item/count predicates, and one batched owner-scoped Editor-project lookup per page.
- The API returns only summary metadata. Hook/body/CTA, provider data, and customer identities are absent.
- Added the named `ScriptLibrary` export while preserving the legacy `ScriptHistory` export and `onRestore` contract for Task 3 integration.
- Added responsive search/filter rows, 20-row pagination, truthful loading/error/empty states, deletion confirmation, owned existing-project links, a 300 ms search debounce, and request sequencing that rejects stale successes and failures.
- Added `npm run verify:hero-script-library`.

## TDD evidence

The behavioral verifier was introduced against the approved seams before implementation. Observed RED stages were:

1. Missing `hero-script-library.server` module.
2. Duplicate singleton parameters accepted instead of rejected.
3. Missing `/api/scripts/library` route.
4. Missing `loadLatestScriptLibraryPage` client race boundary.

Each stage then went GREEN before the next slice. The verifier uses a fresh temporary SQLite database and fictional fixtures only.

## Scale and security evidence

The fixed fixture contains 500 owned scripts with equal timestamps, draft/sent and branded/no-brand rows, plus a foreign account, brand, script, and project.

- All 25 pages contain 20 distinct owned rows: 500 unique IDs, zero foreign IDs.
- Search finds `owned-0042`, which is below the former newest-50 window.
- Combined sent + Brand A filtering returns the fixed total of 84 and a fixed page-2 ID sequence.
- Draft + no-brand filtering returns the fixed total of 84 and the expected final four IDs.
- A foreign brand ID returns zero items and zero total.
- An owned row containing a foreign project ID returns `editorProjectId: null` and `editorProjectAvailable: false`; an owned project remains available.
- Anonymous malformed input returns 401 and a locked account returns 403, showing the existing admission gate precedes library validation/data responses.
- Search length, enums, zero/negative/fractional integers, page size above 20, unsafe offset overflow, empty brand IDs, and duplicate singleton parameters return 400.
- GET leaves Script and EditorProject counts unchanged.
- Two controlled response-order races prove an older success and an older failure cannot replace the newer query result.

## Verification

- `npm run verify:hero-script-library` — PASS.
- `npm run verify:hero-script` — PASS, 531 checks plus paid-equivalent access check.
- `npx tsc --noEmit --pretty false` — PASS.
- Scoped ESLint for the new route, service, verifier, and component — PASS after retaining a targeted suppression on the unchanged temporary legacy `ScriptHistory` effect.
- `git diff --check` — PASS.

## Handoff boundaries

Task 3 still owns page integration, full-detail restore, recent-draft recovery, save-safe transitions, and the explicit create-new Editor action. Task 4 owns the real-browser scale/mobile/access pass and the complete branch build. No live database, provider, production write, deployment, or customer action was used.

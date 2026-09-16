# Task 2 fix round 1 review

## PASS

Both prior blockers are resolved. The service returns only `{ id, name }` brand options from profiles owned by the caller and referenced by that caller’s scripts, including archived history; foreign metadata cannot enter the response. `ScriptLibrary` consumes that response rather than the active-creation profile endpoint, so historical brands remain filterable beyond the visible page.

An applied response now clears prior error state. The mounted Chromium check proves 500 → `refreshKey` success removes the failure alert, renders the archived option, sends its owner-scoped filter, and respects debounce.

No regression found in query validation, owner predicates, stable paging, summary-only payloads, or batched project availability.

## Verification

`npm run verify:hero-script-library`, scoped ESLint, TypeScript, and `git diff --check` passed.

# Task 2 review

## Blockers

- **Medium — archived owned brands cannot be filtered.** `GET /api/brand-profiles` excludes `archivedAt` rows, and `ScriptLibrary` builds options only from that response plus the current page. Archiving retains historical Script relations, so an archived brand whose rows are beyond page 1 cannot be selected despite the API supporting it. This breaks full-library combined brand filtering. Supply bounded historical filter names and add a fixture.
- **Medium — a successful background refresh leaves a false failure alert.** The list effect sets `error` on failure but never clears it on an applied response. A later `refreshKey` success updates rows while “โหลดคลังสคริปต์ไม่สำเร็จ” remains. Clear it on success and cover failure → refresh success.

## Advisories

- The component test renders only initial static markup; add a mounted debounce/filter/error-state test.

## Verification

`npm run verify:hero-script-library`, scoped ESLint, TypeScript, and `git diff --check` passed.

# Task 2 review package

Base: d1b052d7
Head: 9e3dd720
Worker report: task-2.md

```
9e3dd720 feat(hero-script): add searchable script library
```
```
 .../reports/hero-script-workspace-ux/task-2.md     |  51 +++
 package.json                                       |   1 +
 scripts/verify-hero-script-library.ts              | 298 +++++++++++++++++
 .../hero-script/_components/ScriptHistory.tsx      | 366 ++++++++++++++++++++-
 src/app/api/scripts/library/route.ts               |  22 ++
 src/lib/hero-script-library.server.ts              | 151 +++++++++
 6 files changed, 887 insertions(+), 2 deletions(-)
```
```
docs/plans/reports/hero-script-workspace-ux/task-2.md
package.json
scripts/verify-hero-script-library.ts
src/app/(dashboard)/hero-script/_components/ScriptHistory.tsx
src/app/api/scripts/library/route.ts
src/lib/hero-script-library.server.ts
```

## Global Constraints (verbatim)

- Two tabs: “เขียนสคริปต์” and “คลังสคริปต์”. Initial page is new writing with last explicitly selected brand/duration and an explicit recent-draft shortcut.
- 20-brand/500-script usability acceptance; full-library server search, not client filtering of the latest 50 records.
- Retain draft, setup and Hook state across tab changes; preserve latest text across save/restore/handoff races and never report unsaved text as saved.
- Opening an existing project creates no new project; creating another requires the explicit create-new action.
- Preserve all current access/paid-equivalent gates, owner boundaries, plan caps, legacy profile behavior, published revision rules and existing deletion confirmations.
- No change to models/prompts, length enforcement, duplicate-Hook logic, pricing, quota policy, MAPC definition, rendering, production data or database schema.
- Reuse existing components, theme tokens and dependencies. No new state-management, search, table, modal or test framework without a demonstrated blocking need.
- Essential text readable at normal scale; keyboard and touch access; no hover-only essential actions; no clipped controls or horizontal page scrolling on mobile.
- Written spec means behavioral failing test first for logic changes, even small ones. Visual CSS-only adjustments are checked in browser; source-string assertions do not substitute for race, ownership or pagination tests.
- No raw customer text in evidence, analytics, screenshots or fixtures. Use fictional local data and provider mocks; do not generate billable content as a UI test.
- No production writes, SSH execution, deploy, customer messages or issue mutations are authorized by this implementation plan. The completed investigation's read-only permission is not a deployment permission.

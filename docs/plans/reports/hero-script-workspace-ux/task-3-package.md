# Task 3 review package

Base: 63dad99b
Head: ef9ab4f7
Report: task-3.md
```
ef9ab4f7 feat(hero-script): integrate safe workspace recovery
```
```
 .../reports/hero-script-workspace-ux/task-3.md     |  34 ++
 scripts/verify-hero-script-workspace-browser.mts   | 341 ++++++++++++++++++---
 scripts/verify-hero-script-workspace.ts            |  28 +-
 .../hero-script/_components/ScriptEditorStep.tsx   | 159 +++++++---
 .../hero-script/_components/ScriptHistory.tsx      | 194 +++---------
 .../_components/hero-script-workspace-state.ts     |  33 ++
 src/app/(dashboard)/hero-script/page.tsx           | 292 ++++++++++++++----
 src/app/api/scripts/[id]/route.ts                  |   9 +-
 8 files changed, 789 insertions(+), 301 deletions(-)
```
```
docs/plans/reports/hero-script-workspace-ux/task-3.md
scripts/verify-hero-script-workspace-browser.mts
scripts/verify-hero-script-workspace.ts
src/app/(dashboard)/hero-script/_components/ScriptEditorStep.tsx
src/app/(dashboard)/hero-script/_components/ScriptHistory.tsx
src/app/(dashboard)/hero-script/_components/hero-script-workspace-state.ts
src/app/(dashboard)/hero-script/page.tsx
src/app/api/scripts/[id]/route.ts
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

# Task 1 fix round 1 review package

Base: 9e3dd720
Head: 92bddd8d
Report: task-1-fix-1.md
```
92bddd8d fix(hero-script): retain writing context during hydration
```
```
 .../hero-script-workspace-ux/task-1-fix-1.md       | 17 ++++++
 scripts/verify-hero-script-workspace-browser.mts   | 70 ++++++++++++++++++++++
 src/app/(dashboard)/hero-script/page.tsx           | 36 +++++++++--
 3 files changed, 119 insertions(+), 4 deletions(-)
```
```
docs/plans/reports/hero-script-workspace-ux/task-1-fix-1.md
scripts/verify-hero-script-workspace-browser.mts
src/app/(dashboard)/hero-script/page.tsx
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

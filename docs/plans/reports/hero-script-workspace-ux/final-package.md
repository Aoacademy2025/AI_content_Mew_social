# Final branch and Task 4 review package

Branch baseline: 8e7089f3
Head: edb2fd09
Task 4 diff: 0ca3d4c8..edb2fd09
Task 4 report: task-4.md
Full QA: ../2026-09-17-hero-script-workspace-qa.md
```
edb2fd09 test: verify hero script workspace scale journey
0ca3d4c8 fix(hero-script): reject stale generation replies
ef9ab4f7 feat(hero-script): integrate safe workspace recovery
63dad99b docs: record Hero Script workspace execution gates
b1da15f0 fix(hero-script): invalidate stale hooks
311c7558 fix(hero-script): keep historical library filters
92bddd8d fix(hero-script): retain writing context during hydration
9e3dd720 feat(hero-script): add searchable script library
d1b052d7 feat(hero-script): focus writing workspace
```
```
 .github/workflows/ci.yml                           |   3 +
 docs/plans/2026-09-17-hero-script-workspace-ux.md  | 210 ++++++
 ...2026-09-17-hero-script-workspace-plan-review.md |  31 +
 .../reports/2026-09-17-hero-script-workspace-qa.md |  39 +
 .../acceptance-evidence.md                         |  19 +
 .../fixtures/hero-script-locked-preview-mobile.png | Bin 0 -> 57685 bytes
 .../fixtures/hero-script-workspace-desktop.png     | Bin 0 -> 43421 bytes
 .../fixtures/hero-script-workspace-mobile.png      | Bin 0 -> 39421 bytes
 .../hero-script-workspace-ux/global-constraints.md |  12 +
 .../reports/hero-script-workspace-ux/progress.md   |  52 ++
 .../hero-script-workspace-ux/qa-environment.md     |   9 +
 .../task-1-fix-1-package.md                        |  33 +
 .../task-1-fix-1-review.md                         |  19 +
 .../hero-script-workspace-ux/task-1-fix-1.md       |  17 +
 .../task-1-fix-2-package.md                        |  37 +
 .../task-1-fix-2-review.md                         |  22 +
 .../hero-script-workspace-ux/task-1-fix-2.md       |  11 +
 .../hero-script-workspace-ux/task-1-package.md     |  41 ++
 .../hero-script-workspace-ux/task-1-review.md      |  29 +
 .../reports/hero-script-workspace-ux/task-1.md     |  36 +
 .../task-2-fix-1-package.md                        |  35 +
 .../task-2-fix-1-review.md                         |  13 +
 .../hero-script-workspace-ux/task-2-fix-1.md       |  24 +
 .../hero-script-workspace-ux/task-2-package.md     |  40 ++
 .../hero-script-workspace-ux/task-2-review.md      |  14 +
 .../reports/hero-script-workspace-ux/task-2.md     |  51 ++
 .../hero-script-workspace-ux/task-3-fix-1.md       |  34 +
 .../reports/hero-script-workspace-ux/task-3.md     |  34 +
 .../reports/hero-script-workspace-ux/task-4.md     |   5 +
 outputs/hero-script-workspace-concept.html         | 404 +++++++++++
 package.json                                       |   2 +
 scripts/verify-hero-script-library.ts              | 462 ++++++++++++
 scripts/verify-hero-script-workspace-browser.mts   | 789 +++++++++++++++++++++
 scripts/verify-hero-script-workspace.ts            |  68 ++
 .../hero-script/_components/BrandProfilePanel.tsx  | 140 ++--
 .../_components/HeroScriptQuickStart.tsx           |  19 +-
 .../hero-script/_components/ScriptEditorStep.tsx   | 207 ++++--
 .../hero-script/_components/ScriptHistory.tsx      | 424 ++++++++---
 .../hero-script/_components/TopicStep.tsx          |   2 +-
 .../_components/hero-script-workspace-state.ts     | 100 +++
 src/app/(dashboard)/hero-script/page.tsx           | 397 ++++++++---
 src/app/api/scripts/[id]/route.ts                  |   9 +-
 src/app/api/scripts/library/route.ts               |  22 +
 src/lib/hero-script-library.server.ts              | 166 +++++
 44 files changed, 3769 insertions(+), 312 deletions(-)
```
```
.github/workflows/ci.yml
docs/plans/2026-09-17-hero-script-workspace-ux.md
docs/plans/reports/2026-09-17-hero-script-workspace-plan-review.md
docs/plans/reports/2026-09-17-hero-script-workspace-qa.md
docs/plans/reports/hero-script-workspace-ux/acceptance-evidence.md
docs/plans/reports/hero-script-workspace-ux/fixtures/hero-script-locked-preview-mobile.png
docs/plans/reports/hero-script-workspace-ux/fixtures/hero-script-workspace-desktop.png
docs/plans/reports/hero-script-workspace-ux/fixtures/hero-script-workspace-mobile.png
docs/plans/reports/hero-script-workspace-ux/global-constraints.md
docs/plans/reports/hero-script-workspace-ux/progress.md
docs/plans/reports/hero-script-workspace-ux/qa-environment.md
docs/plans/reports/hero-script-workspace-ux/task-1-fix-1-package.md
docs/plans/reports/hero-script-workspace-ux/task-1-fix-1-review.md
docs/plans/reports/hero-script-workspace-ux/task-1-fix-1.md
docs/plans/reports/hero-script-workspace-ux/task-1-fix-2-package.md
docs/plans/reports/hero-script-workspace-ux/task-1-fix-2-review.md
docs/plans/reports/hero-script-workspace-ux/task-1-fix-2.md
docs/plans/reports/hero-script-workspace-ux/task-1-package.md
docs/plans/reports/hero-script-workspace-ux/task-1-review.md
docs/plans/reports/hero-script-workspace-ux/task-1.md
docs/plans/reports/hero-script-workspace-ux/task-2-fix-1-package.md
docs/plans/reports/hero-script-workspace-ux/task-2-fix-1-review.md
docs/plans/reports/hero-script-workspace-ux/task-2-fix-1.md
docs/plans/reports/hero-script-workspace-ux/task-2-package.md
docs/plans/reports/hero-script-workspace-ux/task-2-review.md
docs/plans/reports/hero-script-workspace-ux/task-2.md
docs/plans/reports/hero-script-workspace-ux/task-3-fix-1.md
docs/plans/reports/hero-script-workspace-ux/task-3.md
docs/plans/reports/hero-script-workspace-ux/task-4.md
outputs/hero-script-workspace-concept.html
package.json
scripts/verify-hero-script-library.ts
scripts/verify-hero-script-workspace-browser.mts
scripts/verify-hero-script-workspace.ts
src/app/(dashboard)/hero-script/_components/BrandProfilePanel.tsx
src/app/(dashboard)/hero-script/_components/HeroScriptQuickStart.tsx
src/app/(dashboard)/hero-script/_components/ScriptEditorStep.tsx
src/app/(dashboard)/hero-script/_components/ScriptHistory.tsx
src/app/(dashboard)/hero-script/_components/TopicStep.tsx
src/app/(dashboard)/hero-script/_components/hero-script-workspace-state.ts
src/app/(dashboard)/hero-script/page.tsx
src/app/api/scripts/[id]/route.ts
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

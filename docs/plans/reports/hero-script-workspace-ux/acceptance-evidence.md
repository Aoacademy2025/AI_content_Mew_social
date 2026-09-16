# Final acceptance evidence index

Fill with observed results only. Pending is not passing.

| Criteria | Required evidence | Status |
| --- | --- | --- |
| AC1 | 1366×768 initial topic bounding box, 20-brand fixture | PASS — real-theme mounted page with dashboard allocation asserts the topic box is inside the viewport; desktop screenshot captured. |
| AC2 | mounted workspace preservation across tabs during edit/request/save | PASS — mounted browser retains edits and saves while hidden; delayed generation/regen ownership checks pass. |
| AC3 | account preferences, unavailable brand fallback, blank landing, explicit recent restore | PASS — workspace verifier and mounted browser confirm account scope/fallback, blank landing and explicit full-detail recovery. |
| AC4 | isolated SQLite 500-row search, combined filters, stable page/count behavior | PASS — isolated SQLite verifier and 500-row mounted browser page/search/filter evidence. |
| AC5 | summary payload omissions, bounded pages, full detail request, stale-selection rejection | PASS — library verifier excludes bodies and browser asserts 20 rows, detail-on-open and latest-only restore. |
| AC6 | revision-0 editable fields + published read-only/manageUrl fixture | PASS — mounted legacy edit and published `/brands` routing; profile service regression passes. |
| AC7 | open-existing zero POST, save-before-create, one pending request, failure blocks handoff | PASS — mounted delayed responses prove latest-snapshot draining for New/open/create, follow-up save failure preservation, guarded project navigation with zero handoff POSTs, and stale handoff/generation/regen rejection across workspace replacement. |
| AC8 | missing project, failure retry, destructive transition confirmation | PASS — mounted error/retry, unavailable project, save-failure and discard confirmations pass; false-empty failure state fixed. |
| AC9 | 390×844 actions/readability, 320px no overflow, keyboard actions | PASS — 390/320 checks and screenshots pass. Tab/Enter/typeahead covers tabs, brand filter, search, open and main action; headless native status-select keyboard limitation recorded in QA report. |
| AC10 | access/owner/brand/MAPC regressions and locked-preview fixture | PASS — Hero Script/access, profile, MAPC and locked-preview fixture pass. |
| AC11 | fictional proposal and local QA, reviewable branch, no production mutation | PASS — all fixtures/captures are fictional local data; QA report records isolated scope. |

Review gates: Task 1, Task 2, Task 3, Task 4 independent scoped reviewers; final complete suite once after task fixes; high-assurance branch correctness + focused boundary security review; root Tier 2 decision.

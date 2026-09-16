# Hero Script: focused writing and a searchable script library

Date: 2026-09-17 · Interview complete · Approved · Execution in progress

## Goal

Make Hero Script useful as a repeat-creation workspace even with 20 brand profiles and 500 scripts. A creator can start a new topic immediately, recover a saved draft, find any older script, and intentionally open an existing Editor project or create a new one.

Use the Subscription North Star, MAPC, and Core Creation Outcome definitions in `CONTEXT.md` and ADR 0008. For Hero Script, a saved draft is not yet a Core Creation Outcome; an Editor-bound/sent script qualifies for an eligible cash-paying creator. More generated scripts from the same already-active payer do not by themselves increase MAPC.

Deliverables: an interactive visual proposal and this implementation plan now; repository code, tests and browser verification in the later approved execution session. Production deployment is not part of this plan.

## Evidence and design rationale

- Mew supplied three screenshots: beginner guidance and the entire brand list precede the topic input; empty workflow sections occupy space; the full history list is appended below the editor.
- `hero-script/page.tsx` renders every section in one vertical stack. `BrandProfilePanel.tsx` repeats the profile selection as both a dropdown and an always-visible management list. `HeroScriptQuickStart.tsx` starts expanded on every mount.
- `ScriptHistory.tsx` fetches the 50 newest full script objects and refetches after every autosave. `listScripts()` has a default limit of 50. A search over that client array would not satisfy the 500-script requirement.
- The existing handoff service creates a new Editor project on every POST. The library must distinguish opening a linked project from intentionally creating another.
- Brand Library's `/brands` list excludes legacy revision-0 profiles. Its editing form also does not expose every script-specific field. This redesign must retain the existing legacy profile editor and respect published-profile routing, rather than replacing all profile management with a `/brands` link.
- Inspection baseline: `docs/audits/2026-09-17-hero-script-usage-quality.md`. September 1–16 had 166 page viewers, 36 operational accounts and 33 full-generation accounts, excluding ADMIN. These are **not** cash-paying MAPC counts. There were 132 preview viewers; raw visitors-to-generation is not a valid eligible-customer conversion denominator.
- Existing database contention (HERO-10) and script-length/Hook-duplication findings remain separate work. A UI change cannot be reported as their fix.

## Confirmed interview decisions

| Question | Mew's choice |
| --- | --- |
| Q1 — Deliverables | Visual proposal plus plan for repository implementation |
| Q2 — Layout | Two tabs: “เขียนสคริปต์” and “คลังสคริปต์” |
| Q3 — Scope | UI/UX first; generation quality is a separate next task |
| Q4 — Returning visit | New-writing landing, remember last brand/duration, with “ทำร่างล่าสุดต่อ” |
| Q5 — Sent scripts | Open/read/edit scripts; separate “เปิดงานตัดต่อเดิม” from “สร้างงานตัดต่อใหม่” |
| Q6 — Acceptance scale | 20 brands, 500 scripts; topic visible without scrolling on desktop, whole-library search, draft retained across tabs, complete mobile functionality |

## Design and production copy

Visual proposal: `outputs/hero-script-workspace-concept.html`. Fictional data and simulated actions only. This is the layout/interaction reference, not production code or proof of backend correctness.

Keep the app's existing theme, fonts and violet action accent. Use clearer typography and a flatter hierarchy. Do not add a product dashboard, global navigation replacement or a new visual identity.

### Writing tab

1. Header: “เขียนสคริปต์ AI”; tabs “เขียนสคริปต์” / “คลังสคริปต์”; “สคริปต์ใหม่”.
2. A compact setup row: “โปรไฟล์แบรนด์”, selected name or “ไม่ใช้โปรไฟล์”, “ความยาว”, 30/60/90 seconds, and “จัดการโปรไฟล์”. A searchable selector handles 20 profiles without extending the page. Keep an explicit no-profile choice.
3. Topic input and “คิดไอเดียให้หน่อย” are immediately available. “ทำร่างล่าสุดต่อ” is a small secondary action when a saved draft exists. Loading this shortcut must not delay or overwrite the blank writing surface.
4. Reveal available steps progressively: topic → Hook choices → full script. Keep the user's choice/edit of Hook before full generation. Completed steps become compact summaries with an explicit way to revisit them. Do not create a forced multi-page wizard or require repeated Next clicks.
5. Full script keeps editable Hook, body and CTA, existing section-regeneration controls, and the existing word-budget indicator. Increase essential writing text to at least 16px. No automatic shortening or new generation-quality policy in this scope.
6. Clear save states: “กำลังบันทึก…”, “บันทึกแล้ว”, “บันทึกไม่สำเร็จ ลองอีกครั้ง”. The primary action is “ส่งไปตัดต่อ” for an unsent draft and “เปิดงานตัดต่อเดิม” when a valid linked project exists. Keep these actions reachable while reviewing text, without covering mobile inputs or the keyboard.
7. Beginner instructions are collapsed by default and available through “วิธีใช้”. Remember an explicit user expand/collapse preference. Essential step guidance must remain visible without opening the guide.
8. Profile creation/editing remains available on demand. Reuse the existing editor and its behavior for legacy profiles. For published profiles, preserve its existing read-only/`manageUrl` behavior; do not silently change or republish a versioned profile.

### Library tab

- Search label: “ค้นหาสคริปต์”; matches the topic/title across all owned rows. Filters: “ทุกแบรนด์” including “ไม่ใช้โปรไฟล์”, and “ทั้งหมด” / “ร่าง” / “ส่งแล้ว”.
- Dense, readable rows show topic, brand, last-updated date and status. Topic stays the dominant text. Desktop rows adapt into compact mobile entries without hiding search, filters or actions.
- Clicking a row loads that script into the writing tab. A sent row additionally exposes “เปิดงานตัดต่อเดิม”. The overflow menu contains “สร้างงานตัดต่อใหม่” and existing deletion with confirmation. Do not add archive, folders or bulk deletion.
- Paginate the full filtered result set, 20 rows per page in production. Show the filtered total and previous/next controls. Search/filter changes reset to page 1. Keep page/filter/search state when temporarily switching back to writing.
- Empty library: “ยังไม่มีสคริปต์” with “เริ่มเขียนสคริปต์”. No search matches: “ไม่พบสคริปต์ที่ตรงกับการค้นหา” with “ล้างตัวกรอง”. Fetch failure: “โหลดคลังสคริปต์ไม่สำเร็จ” with “ลองอีกครั้ง”; do not show a false empty state.
- Do not auto-open a historical script on initial page load. Recent-draft recovery is an explicit user action.

### Sent-script behavior

- “เปิดงานตัดต่อเดิม” navigates to the owned linked Editor project. It must issue **zero handoff POSTs**.
- Editing the stored Script does not automatically overwrite an already-created Editor project. When relevant, explain: “การแก้สคริปต์นี้ยังไม่เปลี่ยนงานตัดต่อเดิม”.
- “สร้างงานตัดต่อใหม่” explicitly creates a new project from the latest successfully saved text through the existing handoff service. Prevent repeated clicks while a request is in flight. Do not automatically retry an ambiguous non-idempotent handoff POST.
- A missing/deleted linked project has an honest unavailable state and the explicit create-new option. Do not silently create a replacement merely because open-existing failed.

## Architecture and state contract

- Keep `/hero-script` and its existing server layout/access gate. Tabs are local to this feature; do not introduce a second permanent app sidebar.
- Keep one workspace owner for topic, profile, duration, selected Hook and working draft. Reuse the existing request-context guards, serialized saves and restore behavior. Hiding the writing tab must not dispose of the save owner or lose an in-flight result.
- A response started for another profile/topic/duration or script must not overwrite the current workspace. Restoring a script loads its own context before allowing regeneration. Changing new-generation context must never relabel existing output as though it was generated for the new context; preserve the prior draft and indicate that a fresh Hook/generation is required.
- Store only the user's explicit new-writing preferences (profile ID, duration, guide state), scoped to the authenticated account, using existing browser facilities. Do not store raw scripts/prompts in analytics or new browser caches. Historical-script restore must not overwrite the remembered new-writing defaults.
- Validate remembered preferences against currently available profiles and allowed durations; deleted/archived/unavailable profiles fall back to an explicit no-profile state. Do not use another account's remembered settings after account switching.
- Switching tabs preserves all editing state. A destructive workspace replacement (new script / opening another record) must flush any pending autosave first; on save failure keep the text and offer retry or an explicit discard decision. Pre-generation topic/Hook input has no saved Script row: warn before an explicit action discards it. Do not create blank Script rows just to persist setup.
- Saving before handoff is a prerequisite, not a visual label: wait for the latest snapshot to commit, then use its script ID. On failed save, do not create a project from stale content.
- Keep one-shot initial library metadata/recent-draft fetch lightweight. Fetch full body/Hook/CTA through existing `GET /api/scripts/[id]` only when opening a record. Do not refetch the visible library or replace it with a spinner on every keystroke/autosave; invalidate and refresh when appropriate without losing selection/filter state.

### Small library read API

Add `GET /api/scripts/library`, with the same `requireHeroScriptUser()` admission and owner scoping as current script routes. Keep existing `GET /api/scripts` and `listScripts()` unchanged for compatibility.

Parameters: trimmed `q` (max 200 characters, matched with Prisma `Script.topic: { contains: q }`; the displayed title is this topic, not a separate persisted field), `status` (`all|draft|sent`), `brandProfileId` (an ID or explicit `none`), positive integer `page` (default 1), and `pageSize` (1–20; default 20). Invalid enum/length/integer input returns 400. Use Prisma predicates, never SQL string interpolation. An unknown/foreign brand filter yields no owned matches without exposing foreign profile existence.

Response: `{ items, brandOptions, total, page, pageSize, hasNextPage }`. `brandOptions` contains only `{ id, name }` for owner-scoped Brand Profiles referenced by the owner's Scripts, including archived profiles needed to filter historical rows; it does not change which profiles are editable or selectable for new creation. Summary items contain `id`, `topic`, `brandProfileId`, safe brand display name, `durationSec`, `status`, `editorProjectId`, owned linked-project availability, `createdAt`, `updatedAt`. Exclude body/Hook/CTA, provider information and customer identities. Resolve project availability in a bounded batched owner-scoped lookup, not one query per row.

Order by `updatedAt DESC, id DESC`; identical predicates for items/count. Offset pagination is sufficient for the accepted 500-row scenario. No new search service, generic query framework or schema migration. The recent-draft shortcut can request `status=draft&pageSize=1`; its query is independent of the currently selected library filters.

## North Star measurement

Primary outcome remains the existing server-authoritative MAPC calculation. Do not change its eligibility rules, window, outcome definition or timestamp behavior as part of this UI work.

For a post-release assessment, segment existing events/outcomes by actual paid eligibility. Monitor:

- Distinct eligible paying customers reaching a sent/Editor-bound Script; distinguish those who had no prior Core Creation Outcome in the trailing 30 days from customers already active through video/image.
- For eligible feature users, the proportion reaching handoff and time from first purposeful script action to successful handoff. Existing uncorrelated event counts cannot produce an exact attempt-level success rate; retain that caveat.
- Return usage and completion on later days, plus search/open success during the agreed usability scenarios.
- Guardrails: script/save/handoff failures, lost edits, repeated project creation, and regressions to mobile/access behavior.

These are evaluation questions, not promised percentage lifts. Existing September all-customer counts are only context. Exact paid-cohort baseline and a causally attributable MAPC lift remain unmeasured. No extra database telemetry tables or analytics dashboard in this plan; use current events and outcome records. If exact request correlation is needed, keep it in the separate observability work identified by the inspection.

## Global Constraints

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

## Assurance and Budget

- Profile: high-assurance for the new owner-scoped search API and save/handoff boundaries; normal visual review elsewhere.
- Risk: medium overall — a live multi-user read API and data-preserving workspace transitions are touched; payment policy and schema remain unchanged.
- Automatic fix rounds per task: 2; up to 5 only for a blocking ownership/data-loss finding, with the session ruling on scope before expansion.
- Maximum subagent runs: 18 including retries and final reviews. Reuse workers/reviewers; do not spawn repeated overlapping audits.
- Concurrency: fill only live harness slots; Tasks 1 and 2 may start independently with disjoint ownership below. Task 2 must not edit Task 1's page shell.
- Usage checkpoints: before execute, after each frontier wave, before final gate. At budget ceiling, the session narrows/replans rather than claiming incomplete work complete.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
| --- | --- | --- | --- | --- | --- |
| 1 | Focused writing surface and retained workspace | mew-worker | subagent | — | behavioral tests, responsive browser check, task review |
| 2 | Whole-library search and paginated list | mew-worker-heavy | subagent | — | failing API behavior tests, ownership/security review, task review |
| 3 | Integrate recovery, save-safe transitions and explicit project actions | mew-worker-heavy | subagent | 1, 2 | save/race/restore tests, handoff behavior review |
| 4 | Integrated scale/access/mobile verification and handoff | mew-worker | subagent | 3 | build, scoped regressions, fresh whole-branch and security review |

If a native named agent is unavailable, use the adapter-equivalent built-in worker/reviewer with the same model/effort. All dispatches get fresh context (`fork_turns="none"`), exact file ownership and the Global Constraints verbatim. Workers are not alone in the checkout and must not revert each other's changes.

### Task 1 — Focused writing surface and retained workspace

Ownership: `src/app/(dashboard)/hero-script/page.tsx`, `BrandProfilePanel.tsx`, `HeroScriptQuickStart.tsx`, `TopicStep.tsx`, `HookStep.tsx`, and a small colocated helper/component only if needed. Do not edit library API/service or `ScriptHistory.tsx` owned by Task 2. Reserve editor save/handoff changes for Task 3.

- [ ] Add a failing behavioral check for preserving topic, selected Hook and draft across tab changes; account-scoped preference validation and context-response rejection where moved code requires it. Use existing `node:assert`/`tsx` conventions and a scoped component harness; do not build a generic testing framework.
- [ ] Introduce the two-tab shell while keeping the editing/save owner mounted; conditionally fetch/display the library through its current interface until Task 3 integrates the new list.
- [ ] Replace the always-visible brand list with the compact searchable selector and on-demand management. Reuse current create/edit/delete flows. Published profile management follows existing behavior; no import/migration.
- [ ] Add explicit local fixtures and behavior/browser checks for a revision-0 profile and a published profile: both remain discoverable/selectable; legacy niche/audience/tone/bannedWords/CTA style/analysis notes remain editable through existing controls; published edits retain the read-only response and `manageUrl` routing, without mutable updates or implicit republishing. Also cover an unavailable remembered profile.
- [ ] Apply progressive workflow visibility and collapsed optional guide; keep returned/new creator actions explicit.
- [ ] Validate blank landing and 20-brand selector at 1366×768 and 390×844. Topic is visible without desktop scrolling.
- [ ] Run the scoped behavior check and relevant existing Hero Script/access checks; commit the complete surface change.

### Task 2 — Whole-library search and paginated list

Ownership: new `src/app/api/scripts/library/route.ts`, new `src/lib/hero-script-library.server.ts`, `ScriptHistory.tsx`, and `scripts/verify-hero-script-library.ts`. Existing script service exports may be reused without broad refactoring. Add the package script `verify:hero-script-library`; coordinate package/CI edits with Task 4.

- [ ] Write failing tests against an isolated SQLite database with 500 owned scripts, at least one foreign account, equal update timestamps, draft/sent records and no-brand records. Prove title search finds a row older than the previous 50-row cap; combined filters/counts, stable fixed-fixture pagination and invalid query handling.
- [ ] Prove authentication/feature gate remains in front of querying; foreign script/profile/project identities do not appear in items or totals. A manipulated filter or page cannot widen owner scope.
- [ ] Implement the bounded metadata API and batched project availability lookup. No full script content in list payloads, no provider calls, no writes in GET.
- [ ] Build responsive library rows, query/filter controls and previous/next pagination as a new named `ScriptLibrary` export in `ScriptHistory.tsx`, with props `{ onOpenScript(id: string): void; activeScriptId: string | null; refreshKey: number }`. Preserve the existing `ScriptHistory` export and its `onRestore` contract until Task 3 switches the page to the new export and removes the temporary legacy component. Metadata must never be passed as a complete editable Script. Task 2 tests the new component in isolation and does not edit Task 1's shell.
- [ ] Debounce text search modestly and ignore stale responses; test rapid query/filter changes so an older response cannot replace newer results. Distinguish loading/error/empty states.
- [ ] Test all 500 records can be found/page-accessed; existing legacy list/detail consumers retain their contracts.

### Task 3 — Safe recovery and explicit Editor actions

Ownership: page/library integration, `ScriptEditorStep.tsx`, SavedScript/draft interfaces, and `scripts/verify-hero-script-workspace.ts`. Change existing script detail/handoff APIs only if an evidenced contract gap requires it; no new model or generation policy.

- [ ] Write failing behavior tests: latest saved draft recovered only on explicit action; preference load never replaces typed text; selecting a library record fetches its full owned detail and restores its original context.
- [ ] Test a delayed autosave followed by tab switch, new-script click, another record, and handoff. A save failure keeps the working text and produces no stale handoff. Delayed requests from the previous record cannot overwrite the next one. Cover delete/restore response races.
- [ ] Add a failing pre-generation replacement test: enter a topic and select/edit a Hook before any Script exists; attempt “สคริปต์ใหม่” and opening a library record; cancel preserves the exact input/selection, explicit discard proceeds, and no blank Script row is created. Ordinary tab switching never prompts or discards.
- [ ] Refactor the existing serialized persistence minimally so explicit workspace replacement and new-project handoff can await the correct saved snapshot. Do not use button color or a stale `saveState` as the correctness guard.
- [ ] Implement “เปิดงานตัดต่อเดิม” as navigation only; a test asserts zero handoff POSTs. Explicit “สร้างงานตัดต่อใหม่” sends exactly one client request while pending, with current saved content. Preserve existing server quota/entitlement/brand pinning behavior.
- [ ] Handle missing/deleted projects and existing sent-script edits truthfully. No silent replacement project and no implied sync to the older project.
- [ ] Integrate recent-draft summary, request-on-open full details, and targeted library invalidation. State survives tab changes; transient library loading cannot clear the writer.

### Task 4 — Integrated verification and delivery

Ownership: `scripts/verify-hero-script-workspace.ts`, scoped package/CI registrations, fictional local scale fixtures and `docs/plans/reports/2026-09-17-hero-script-workspace-qa.md`. No production/test-customer seed data.

- [ ] Run new library/workspace checks, `npm run verify:hero-script` (already includes access tests), `npm run verify:brand-library-ui`, relevant existing brand/profile service regressions, `npm run verify:admin-number-mapc-definition`, changed-file lint, type check and production build using current repo commands. Record exact commands actually available; do not invent a passing check.
- [ ] Browser-test new topic → Hook → generated draft → latest-save handoff using mocked providers/local fixtures. Test recent-draft restore, sent-project open, explicit new-project action, profile CRUD access and every library filter.
- [ ] At 1366×768 and 390×844, test 20 profiles and 500 scripts, a long Thai topic, empty states, network failure and keyboard-only interaction. Also check 320px width for clipping. Assert topic is in the initial desktop viewport, main page has no horizontal overflow, library results are bounded and all key mobile actions remain available.
- [ ] Exercise entitled and locked-preview users without changing access policy; use local stubs/fixtures, not live account mutations.
- [ ] Record screenshots, fixture counts, request/payload behavior and any unverified environment limitation. No invented timing/lift claims.
- [ ] Fresh review against the full plan and a focused security review of the new query/owner and save/handoff boundaries; fix blocking findings. Do not rerun unrelated suites after passing absent a new change or concern.
- [ ] Deliver branch/draft PR and verified report. No merge/deploy, no claim that MAPC has risen, and no claim that AI length/Hook quality is fixed.

## Acceptance Criteria

- [ ] AC1: The initial writing tab shows the topic field without vertical scrolling at 1366×768 with 20 profiles; profile/history collection size does not lengthen it.
- [ ] AC2: The two agreed tabs work on desktop/mobile, and switching repeatedly during edits or requests loses no topic, Hook, draft or pending save.
- [ ] AC3: Explicit new-writing preferences are account-scoped and restored safely; first load stays blank, with a working recent-draft shortcut if available.
- [ ] AC4: Search and combined brand/status filters find any matching owned item among 500 scripts, including records beyond the former 50-row cap; pagination totals and states are correct.
- [ ] AC5: Only bounded summaries are fetched for library pages; opening a row retrieves complete owned content and the right context. Stale requests never overwrite newer selections.
- [ ] AC6: Legacy profile fields/actions and published-profile routing continue working; nothing disappears merely because a profile has revision 0.
- [ ] AC7: “เปิดงานตัดต่อเดิม” creates no project; only explicit send/create-new does. The newest edited text is saved first; failed save creates no project from stale data.
- [ ] AC8: Missing projects, failed saves/loads, unavailable remembered profiles and explicit draft replacement have truthful recovery states.
- [ ] AC9: 390px mobile has all core actions and readable input text; 320px has no horizontal clipping; keyboard users can select profiles, use tabs, search/filter, open a script and reach the main action.
- [ ] AC10: Existing paid/preview/owner boundaries, brand revision rules, quotas and MAPC behavior remain covered by passing regressions.
- [ ] AC11: Prototype is clearly simulated with fictional data. Implementation and QA have reviewable evidence; no production data/write/deploy is part of completion.

## Out of scope

- Model/prompt changes, automatic shortening, factuality/semantic relevance scoring and duplicate-Hook repair — separately requested quality work.
- HERO-10 database contention and broader telemetry correlation — existing operations issues, not solved by layout.
- Brand schema, migration/import of legacy profiles, new `/brands` authoring capabilities — avoid changing creator assets during a UI redesign.
- Archives, folders, favorites, batch generation, scheduling, bulk deletion, global navigation redesign — unnecessary for the agreed 500-script retrieval problem.
- New drafts before generation, cross-device unsaved-brief synchronization, immutable output history — require separate storage/product decisions.
- Changing MAPC's creation-time proxy or adding a new attribution dashboard — outside this UX outcome.
- Automatic synchronization of Script edits into an already-created Editor project — opening existing work and explicitly creating a new project are the agreed operations.

## Status

Independent plan critic: two blocking verification gaps corrected; second review has no remaining blockers. See `docs/plans/reports/2026-09-17-hero-script-workspace-plan-review.md`. This does not replace user approval or execution/browser QA.

interviewed 2026-09-17 | approved: 2026-09-17 | executed: Tasks 1–2 passed; Task 3 in progress on mew/hero-script-workspace-ux | delivered: proposal and plan 2026-09-17

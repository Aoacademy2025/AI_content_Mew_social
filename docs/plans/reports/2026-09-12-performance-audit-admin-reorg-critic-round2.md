# Pre-flight critique round 2 — `docs/plans/2026-09-12-performance-audit-admin-reorg.md`

Critic: fresh context, no access to the interview. Round-1 report: `docs/plans/reports/2026-09-12-performance-audit-admin-reorg-critic.md`.
Facts the plan marks as verified against the codebase (RenderJob covers every render, Remotion self-loads fonts, `src/components/remotion/` absent, bundle sync by email) are accepted as given; judged only for consistent use.

---

## Part A — Disposition of the 32 round-1 findings

| # | R1 severity | Verdict | Where it is resolved |
|---|---|---|---|
| 1 | BLOCKING | RESOLVED | C1 "Where renders live (verified)" + Step 1 fixture (b): MCP renders are RenderJob children, `rendersDone = 2` / `exportsDone = 1` for one editor + one MCP job |
| 2 | BLOCKING | RESOLVED | C1 Queries ("no `parentJobId` filter" on success; `parentJobId IS NULL` on RenderJob failures) + AC8 restated as "every RenderJob success row counts once (children included) … orchestrated failure counts once" |
| 3 | BLOCKING | RESOLVED | B3 Interfaces ("skips **only** its own initial `prisma.user.findUnique`"; bundle-by-email lookup never skipped) + Step 1 fixtures bundle-active / bundle-expired with byte-identical golden `User` row; AC10 names the five-fixture test |
| 4 | BLOCKING | RESOLVED | Global Constraints (render fonts loaded at `src/remotion/captionStyles.ts:219`, `SubtitleOverlayComposition.tsx:12`, `VideoComposition.tsx:7`), A3 Step 4 grep `-v '^src/remotion/'` + record, B4 "Never: any file under `src/remotion/**`" and Step 0 re-proof |
| 5 | BLOCKING | RESOLVED | AC2 split: `/dashboard`,`/videos`,`/admin/insights`,`/video-editor` after D3.n; new `/admin` after D5; Gate B labels the old-page figure |
| 6 | SHOULD-FIX | RESOLVED | A4 heading + Execution Directive row A4 = "A1, A2" |
| 7 | SHOULD-FIX | RESOLVED | B1 Files/Interfaces export `readDisk`; C1 Files "Read (already exported by B1)"; C1 Blocked by "Gate A, B1" |
| 8 | SHOULD-FIX | RESOLVED | A3 Step 7 (read-only render review) → §A3.6; A6 Step 1 section 6; Out of scope points at A3 Step 7 |
| 9 | SHOULD-FIX | RESOLVED | A6 Step 1 sections 8 (before/after) and 9 (commands); AC1 "sections 1–9" |
| 10 | SHOULD-FIX | RESOLVED | A2 Step 2 n = 20; AC2 "median < 350 ms and max < 500 ms over 20 runs" (see new finding N3 for the endpoint list) |
| 11 | SHOULD-FIX | PARTIAL | A1 Step 2 is now portable (`sed -E` + `date -u -d … +7 hours`), buckets by line timestamp, rotation claim deleted — but the `sed` prints non-matching lines unchanged (new finding N7) |
| 12 | SHOULD-FIX | RESOLVED | B6 last table row ("Evidence matches none of the above → Stop"), Deploy sequencing "D3.1…D3.n … 24 h apart" |
| 13 | SHOULD-FIX | RESOLVED | AC3 second sentence: residual class recorded in §8 with its holder, filed as follow-up, never hidden |
| 14 | SHOULD-FIX | RESOLVED | Global Constraints "no screenshots are saved in the repo or reports at all"; A2 Step 1; B4 Step 3 |
| 15 | SHOULD-FIX | RESOLVED | A1 Files "Not `.env`"; Global Constraints permit only `cut -d= -f1 .env \| sort` |
| 16 | SHOULD-FIX | RESOLVED | Local SQL capture moved to A3 Step 2; `EXPLAIN` split into Task A1b (Blocked by A1, A3); A1 Step 6 is now disk-walk timing |
| 17 | SHOULD-FIX | RESOLVED | C1 Queries filter and bucket both on `COALESCE(finishedAt, updatedAt)`; Step 1 fixture (d) |
| 18 | SHOULD-FIX | RESOLVED | C4 Files "Not modified: `src/app/api/admin/insights/route.ts` (payload stays byte-identical; pruning is a follow-up)" |
| 19 | SHOULD-FIX | RESOLVED | `defaultTrendDays(viewportWidth)` exported by C1, unit-tested at 639/640; C2 test asserts it is imported and used (but see N4) |
| 20 | SHOULD-FIX | RESOLVED | A5 Interfaces define **Error Source Class** (`ours`/`customer-key`/`third-party-noise`/`clerk-network`/`unclassified`), Global Constraints separate it from Job Failure Class; AC5 |
| 21 | SHOULD-FIX | RESOLVED | AC6 ("pre-change" + one row per new `/admin` number added at C2 time, proof `verify-admin-trends`); A4 Interfaces; C2 Step 3 |
| 22 | NIT | RESOLVED | C2 copy: `rate` → `—` when null, card → `ยังไม่มี snapshot`, `p` → `—` when previous total 0 |
| 23 | NIT | RESOLVED | C2/C4 tests name the full label `จ่ายจริง (จ่ายเงินสด)`; AC9 "the exact money labels" |
| 24 | NIT | RESOLVED | Global Constraints: "money on `/admin` is limited to the paid-count trend" |
| 25 | NIT | RESOLVED | Tech Stack line verified from `package.json` on `51396286` with the stale-`CLAUDE.md` note; C6 updates `CLAUDE.md` |
| 26 | NIT | RESOLVED | Global "Re-locate rule" (stop and report if a file/export/column is absent) + C3's explicit "confirm in the worktree" (but see N10 for enum *values*) |
| 27 | NIT | RESOLVED | Global Constraints: "Report-only helpers (A3's query counter) are snippets inside the report, not scripts"; A3 Files repeats it |
| 28 | NIT | RESOLVED | Global Constraints Linear bullet fixes both formats and the JSON field list |
| 29 | NIT | RESOLVED | Global "Re-locate rule (applies to every task)" |
| 30 | NIT | RESOLVED | Assurance and Budget: "Caps written at Gate A: B6 ≤ 3 rows, C5 ≤ 6 fixes" |
| 31 | NIT | RESOLVED | C2 Files: `src/app/api/admin/stats/route.ts` moved to "Read only" |
| 32 | NIT | RESOLVED | Q17 records the single-item `ภาพรวม` group as deliberate |

32/32 addressed; 1 PARTIAL (#11).

---

## Part B — New findings introduced or newly visible in the revision

### N1 — BLOCKING. B6 row 3's VACUUM step contradicts itself and takes writes down on a live SaaS
**Location:** Phase B → B6 decision table, `TelemetryEvent > 50 %` row: *"expect < 60 s on 480 MB; web stays up, writers wait on the 20 s busy timeout"*.
A `VACUUM` holds an exclusive lock for its whole duration. If it runs the expected up-to-60 s, every write that arrives after the first 20 s fails with `SQLITE_BUSY` — the same sentence states both numbers. The plan presents this to Mew at Gate A as a safe, web-stays-up operation, so the approval would be given on a false premise. The `20 s` busy timeout and the `< 60 s` duration are also both asserted without a source.
**Fix:** replace with a measured, honest window: state the busy-timeout value read from `src/lib/prisma.ts` in A1/A3, and either (a) stop `ai-content` for the VACUUM (accepted downtime, announced), or (b) keep the web up and state explicitly that writes arriving during the VACUUM may fail once the busy timeout expires, with the off-peak hour and the rollback (`VACUUM INTO` a copy + swap under a stop) named. Do not present it as zero-impact.

### N2 — SHOULD-FIX. Acceptance Criteria anchor on "D3.n", which may never exist
**Location:** AC2, AC3 ("after D3.n"), Deploy sequencing, B6 last table row.
If A1's evidence matches none of the B6 rows (the branch the revision correctly added), no B6 PR ships and there is no D3 — both performance and slow-tx criteria lose their measurement point.
**Fix:** one sentence: "if no B6 row is chosen, D3.n means D2, and AC3's 7-day window starts the day after D2."

### N3 — SHOULD-FIX. `max < 500 ms over 20 runs` is unreachable for three endpoints in A2 Step 2 by design
**Location:** AC2 vs A2 Step 2 list (`/api/admin/storage`, `/api/admin/cleanup?…`, `/api/admin/insights?days=30`) vs B1 (10-minute cache) and A1 Step 6 (the disk walk is seconds).
The criterion is over *every* endpoint in the list; the storage/cleanup endpoints are fast only on a cache hit, and one cold call in 20 sets the max. As written the plan fails its own criterion even when B1 works exactly as specified.
**Fix:** state the protocol — cold (cache-miss) and warm calls are reported separately; the `< 350 / < 500 ms` criterion applies to warm calls, and the cold disk-walk number is recorded in §8 as a known cost with `/admin` no longer paying it (the ADR 0062 outcome). Same treatment for `/api/admin/insights?days=30` if A1b shows a scan.

### N4 — SHOULD-FIX. `defaultTrendDays(window.innerWidth)` as initial state crashes server rendering
**Location:** C2 Copy → Trend cards: *"initial value `defaultTrendDays(window.innerWidth)`"*.
`"use client"` components are still prerendered on the server in the App Router; `window` is undefined there → `ReferenceError` at build/first render.
**Fix:** initialise to `30` and set `defaultTrendDays(window.innerWidth)` inside a `useEffect` (or read the width from a `useSyncExternalStore`/media-query hook). Keep the source test asserting `defaultTrendDays` is imported and used; AC7's "initial 14 days under 640 px" is then verified in the 390 px dev-server check.

### N5 — SHOULD-FIX. B1's specified test sequence cannot pass even with a correct implementation
**Location:** B1 Step 1: *"`getStorageHealth(dir, { now: 0 })` twice → once; `{ force: true }` → called again; `{ now: 11 * 60 * 1000 }` → called again"*.
The `{ force: true }` call passes no `now`, so the implementation in Step 2 stores `cache.at = Date.now()` (≈1.78e12). The next call with `now = 660000` computes `now - cache.at` as a large negative number, which is `< ttl`, so the cached value is returned and `runDu` is *not* called — the third assertion fails against correct code.
**Fix:** pass `now` in every call: `{ force: true, now: 0 }` then `{ now: 11 * 60 * 1000 }`. Also state whether the module-level cache is keyed by `cwd` (the signature accepts one) or is a single slot.

### N6 — SHOULD-FIX. No task owns the post-D5 re-measurement that AC2 requires
**Location:** AC2 ("after D5 — the new `/admin` overview ≤ 2.0 s"), C6 Files (records §8 "/admin re-measured after D5"), Execution Directive (B-gate covers Gate B only; C6 is `mew-worker-mech`, docs only). A2 also notes it "requires Mew present".
Nobody is instructed to run the A2 method after D5, and the person who must be present is not scheduled.
**Fix:** add a `C-gate` row to the Execution Directive: "(session model) inline, blocked by D5 — re-run A2 Step 1 for `/admin` with Mew present, write the row into §8", and make C6 blocked by it.

### N7 — SHOULD-FIX. A1 Step 2's `sed` passes non-matching lines through, poisoning the census
**Location:** A1 Step 2 code block.
`sed -E 's/…/\1 \2/'` prints every input line, matched or not. If a PM2 line lacks the leading ISO timestamp (PM2 only prefixes timestamps when configured), the raw line reaches `awk`, `$1` becomes arbitrary text, `date -u -d "<text>Z +7 hours"` fails silently and the bucket key is empty or wrong. This is the number B6's whole decision table keys off.
**Fix:** add `grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'` before the `sed` (or use `sed -nE 's/…/\1 \2/p'`), and make Step 2 report the count of lines dropped as unparseable — a non-zero count means the log format is different and the worker must stop and report.

### N8 — SHOULD-FIX. `สมัครใหม่/วัน` counts raw `User` rows, against the CONTEXT.md Signup Cohort definition
**Location:** C1 Queries (*"signups `User.createdAt`"*) vs `CONTEXT.md` → Growth & Conversion → **Signup Cohort** (*"team accounts and audit/test accounts excluded"*).
The plan's own goal is that every admin number matches its definition; this new card ships a number that does not, and AC6 only proves it against "the C1 query", i.e. against itself.
**Fix:** either apply the same exclusion the insights funnel uses (name the predicate) or rename the card/footnote to say it counts every account created, and record the choice as a row in the A4 table at C2 time.

### N9 — SHOULD-FIX. B6 row 3's trigger is unmeasurable on the likely A1 path
**Location:** B6 row *"`TelemetryEvent` > 50 % of DB bytes (§A1.3)"* vs A1 Step 4, which falls back to `count(*)` + `avg(length(properties))` when `ENABLE_DBSTAT_VTAB` is absent from `compile_options`.
Without `dbstat` there is no per-table byte figure, so the row's condition cannot be evaluated and the worker must improvise — which the re-locate rule forbids.
**Fix:** define the fallback estimate in the row itself, e.g. "`dbstat` mb, or `count(*) × (avg(length(properties)) + 120 B)` compared with `page_count × page_size`; state which method produced the number".

### N10 — SHOULD-FIX. B3's `≤ 12 SELECT` budget is a bare number that may be unreachable without decision changes
**Location:** B3 Step 1 (d) vs A3 Step 2 (*"expected … `/api/user/me` ≈ 15–20"*).
B3 must not change any decision logic (Q6), so the only reduction available is the proven duplicate reads. If A3 finds 18 queries of which 4 are duplicates, the target is 14 and the test fails for a reason the task is forbidden to fix.
**Fix:** state the budget as derived: "`≤ (A3 §A3.2 measured count − the duplicate reads §A3.2 proves), asserted as a literal constant written into the test at B3 time`", and have B3 record both numbers in the PR description.

### N11 — SHOULD-FIX. A5 pre-writes HERO-10's numbers before A1 measures them
**Location:** A5 Step 3: *"write the HERO-10 reopen comment (same-cause regression: slow-tx still 20–30 s after PRs #462/#465, criterion < 5/day never met)"*.
These figures come from prior context, not from this audit; A1 §A1.1 produces the real p50/p90/max for the 7-day window. A tracker comment carrying stale numbers is exactly the failure mode this plan exists to remove.
**Fix:** "quote A1 §A1.1's measured p50/p90/max and the ≥ 5 s per-day counts; if they are below the HERO-10 target, do not reopen — record why."

### N12 — NIT. Success and failure series of `สร้างคลิป/วัน` are counted in different units
**Location:** C1 Queries: successes = RenderJob rows (children included); failures = one row per job (VideoJob, plus parentless RenderJob).
The red overlay on card 2 is therefore not comparable with its bars (one MCP job contributes 2 successes but at most 1 failure), and card 2's overlay duplicates card 4.
**Fix:** one footnote in C2 copy stating the unit of each series, or drop the overlay from card 2 and let card 4 own failures.

### N13 — NIT. C1 depends on exact enum literals that are not in the verified-facts list
**Location:** C1 Queries: `type='RENDER'|'BURN'`, `status='DONE'|'FAILED'|'QUEUED'` on RenderJob; `status='failed'|'done'|'queued'` (lowercase) on VideoJob; `Notification.type='ERROR_SYSTEM'`; `TelemetryEvent.name='frontend_error'`; `NorthStarDailySnapshot` columns.
The re-locate rule covers missing files/exports/columns but not wrong string *values*, which fail silently as zeros rather than loudly.
**Fix:** add to C1 Step 1: "read the literals from `prisma/schema.prisma` and the writing call-sites; if any differs, stop and report — a wrong literal renders an all-zero chart, not an error."

### N14 — NIT. `rendersDone`/`exportsDone` filter on `finishedAt` only
**Location:** C1 Queries vs the failure series, which uses `COALESCE(finishedAt, updatedAt)`.
A `DONE` row with a null `finishedAt` disappears from the success series while its failed sibling would be counted. Either state that `DONE` always sets `finishedAt` (verified) or use the same `COALESCE` on all three series.

### N15 — NIT. A3 Step 5 presupposes its own finding
**Location:** A3 Step 5: *"note `next/dynamic` usage = 0"*. Instruct the worker to *count* it; the plan should not record an unmeasured answer.

### N16 — NIT. Task order in Phase C reads C1 → C3 → C2 → C4
Matches the dependency order but not the numbering; a worker skimming for "C2" finds it after C3. Either renumber or add a one-line note at the top of Phase C.

---

## Unsupported claims (assertions without a cited source)
- `< 60 s VACUUM on 480 MB`, `20 s busy timeout`, `web stays up` — B6 row 3 (N1).
- `~480 MB DB` — Q7; carried from the July audit, which the plan itself calls stale. A1 §A1.3 measures it; Q7 already conditions on that, so this is acceptable only because the condition exists.
- `wal_autocheckpoint default 1000 pages ≈ 4 MB` — A1 Step 5; true only if `page_size = 4096`, which the same task measures one step earlier. Say "≈ `page_size × 1000`".
- `slow-tx still 20–30 s after PRs #462/#465` — A5 Step 3 (N11).
- `getCurrentUser() + syncUserEntitlement() ≈ 5–8 queries`, `/api/user/me ≈ 15–20` — A3 Step 2. Correctly framed as "confirm or refute"; no action needed.

## Readability for the executor
Each task names its files, its failing test, its commit message and its verify command; the Global Constraints and the re-locate rule remove most judgement calls. The three places a worker would still have to ask are N2 (what does "after D3.n" mean if B6 chose nothing), N3 (which endpoints the max applies to) and N6 (who re-measures `/admin` after D5). N5 and N4 are the two places where following the text literally produces a red test or a crash.

---

## Verdict

READY WITH FIXES — one BLOCKING item (N1, confined to B6 row 3 and reachable only if Gate A selects it; correct the sentence before Gate A) and ten SHOULD-FIX items, all plan edits, none requiring another interview.

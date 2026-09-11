# Pre-flight critique — `docs/plans/2026-09-12-performance-audit-admin-reorg.md`

Critic: fresh-context, no access to the interview. Judged against §0 locked decisions, Global Constraints, Acceptance Criteria, `CONTEXT.md` (Operations & Admin / Growth & Conversion / Credit Economy) and ADR 0062.

---

## BLOCKING

### 1. Task C1 contradicts locked decision Q14 (MCP renders are missing from "สร้างคลิป/วัน")
**Location:** C1 → "Interfaces (Produces)" → Queries paragraph.
Q14 locks: *"สร้างคลิป/วัน shows two series: Base Render สำเร็จ + Export สำเร็จ **(editor + MCP together)**"*. C1 sources both success series from `RenderJob` only (`type='RENDER'|'BURN'`). MCP / worker jobs are tracked in `VideoJob` — C1 itself reads `VideoJob` for the failure series, so it already knows the two tables are different populations. As written the card counts editor successes against editor+MCP failures: MCP successes vanish and the failure share is systematically overstated.
**Fix:** state explicitly which table(s) hold MCP base renders and exports, add the `VideoJob` success query (`status='done'`, bucketed on the same column as its failures), and define the de-duplication rule for a VideoJob that also produced a RenderJob row. Add a fixture to `verify-admin-trends` that seeds one MCP job and one editor job and asserts both appear once.

### 2. Success series has no `parentJobId` guard, so Acceptance Criterion 8 cannot be satisfied as stated
**Location:** C1 Queries vs Acceptance Criteria bullet *"`verify-admin-trends` proves … no double count of `RenderJob` rows with `parentJobId`"*.
Only the failure query carries `parentJobId IS NULL`; `rendersDone` / `exportsDone` do not. Either child render jobs double-count on the success side, or the criterion is about the failure series only — the plan does not say which.
**Fix:** apply `parentJobId IS NULL` to all three `RenderJob` series (or state why a BURN child must be counted), and make the criterion name the series it covers.

### 3. B3 changes bundle-entitlement behaviour but its failing test has no bundle fixture (high-assurance, billing-adjacent)
**Location:** B3 Step 1 (fixtures: FREE, PRO-trial, PRO-Stripe) vs Step 2(b) (*"skip `syncStoredBundleEntitlementForUser` when the row has no bundle fields"*).
The one semantic change in the task — when bundle sync runs — is the one case the test never exercises. Q6 also requires *"Ask Mew first, every time: anything touching … billing/quota logic outcomes"*; B3 is dispatched under the blanket Gate A approval with no explicit ask.
**Fix:** add two fixtures (bundle-active user, bundle-expired user) asserting identical `User` state before/after with and without the skip, and either record Mew's explicit approval of 2(b) at Gate A or drop 2(b) and keep only the pass-the-loaded-row optimisation.

### 4. B4 can collide with the untouchable render path, and the plan gives the worker no rule for it
**Location:** B4 Files/Interfaces vs Global Constraint *"Render output is untouchable … anything under `src/remotion/` or `src/components/remotion/`"*.
B4's contract is A3 §A3.4, whose grep (`src --include='*.tsx' --include='*.ts' --include='*.css'`) covers `src/remotion/**` and `src/components/remotion/**` — the components that actually draw burned subtitles in the 25 families. If a render component appears in the consumer list, B4 is instructed to give it a route layout it cannot have and forbidden to edit it; if the Remotion/headless-Chromium entry HTML inherits fonts from `src/app/layout.tsx`, removing `GOOGLE_FONTS_URL` there changes rendered output — the exact outcome Q3 forbids.
**Fix:** add a step before B4: prove how the render bundle loads its font faces (file + mechanism) and record it in A3 §A3.4; if the render path depends on the root layout link, B4 is cancelled or reduced to preconnect removal. Add an explicit rule: render-path files are excluded from the consumer list and never receive a `SubtitleFonts` layout.

### 5. Acceptance Criterion 2 measures `/admin` after D3, i.e. the page Phase C then deletes
**Location:** Acceptance Criteria bullet 2 ("Measured after D3 …  `/admin` ≤ 2.0 s") vs Deploy sequencing (D4 = C1+C3+C2 rewrites `/admin`).
The `/admin` figure taken after D3 describes the five-tab page, not the shipped overview. The criterion is unfalsifiable for the delivered product.
**Fix:** split the criterion — `/dashboard`, `/videos`, `/admin/insights`, `/video-editor` measured after D3; `/admin` measured after D5 with the same method, and both rows appear in the before/after table.

---

## SHOULD-FIX

### 6. A4 consumes A2 but is not blocked by it, and the concurrency note forces the overlap
**Location:** A4 "Interfaces → Consumes: … A2's captured API JSON"; Execution Directive row A4 "Blocked by A1"; "Concurrency: … run A1 first, then A4 ‖ A5. A2 ‖ A3 run alongside A1."
A4 can start while A2 is still capturing the JSON it needs.
**Fix:** `Blocked by: A1, A2`.

### 7. C1 needs an export from a file B1 rewrites, with no dependency and no Files entry
**Location:** C1 Queries (*"Disk: `readDisk("/")` from `storage-health.ts` (export it)"*) vs C1 Files (does not list `src/lib/storage-health.ts`) vs Execution Directive (C1 blocked by Gate A only; B1 modifies the same file).
Concurrent PRs on one file, and the worker is told to change a file outside its declared Files list.
**Fix:** add `Modify: src/lib/storage-health.ts (export readDisk)` to C1 Files and `Blocked by: Gate A, B1`.

### 8. No task produces the render-pipeline read-only review that Q1 and Out-of-scope promise
**Location:** Q1 (*"render pipeline read-only review only"*), Out of scope (*"pipeline is reviewed read-only and reported only"*) vs A1/A3, which never inspect the render pipeline, and A6 §1–7, which has no section for it.
**Fix:** either add a step to A3 (read-only review of `run-render.ts` / worker concurrency with findings filed as follow-ups) plus a section in A6, or delete the promise from Q1's restatement and Out of scope.

### 9. A6's report structure omits the before/after table Q5 requires
**Location:** A6 Step 1 (sections 1–7) vs Q5 (*"audit report with a 2-minute Thai summary + English detail + before/after table"*) and Gate B (*"the before/after table is appended to the report"*) and C6 (*"§'After' table"*).
Acceptance Criterion 1 only checks "sections 1–7", so the table can be silently missing.
**Fix:** add "8 Before/after (Gate B + 7-day watch)" to A6 Step 1 and to Acceptance Criterion 1.

### 10. "API p95 < 500 ms" is not computable from A2's sample size
**Location:** A2 Step 2 ("time each API … 5×, report p50/p95") vs Acceptance Criterion 2 ("API p95 < 500 ms for every endpoint in A2 Step 2").
p95 from n=5 is the max with 5 % resolution; two runs decide pass/fail.
**Fix:** raise to n≥20 per endpoint, or restate the criterion as "median < 350 ms and max < 500 ms over 5 runs".

### 11. A1 Step 2's command is gawk-only and buckets by UTC, contradicting the Bangkok-day constraint
**Location:** A1 Step 2 code block and its preamble.
`awk '{match($0,/…/,m)}'` (3-argument `match`) is a GNU-awk extension; Ubuntu's default `mawk` errors out. `substr($1,1,13)` buckets by the UTC hour in the log line, while the step asks for counts "per Bangkok day" and Global Constraints fix Bangkok boundaries everywhere. The preamble claim *"rotation is 00:00 UTC — a file holds the previous Bangkok day"* is wrong: 00:00 UTC = 07:00 Bangkok, so each file straddles two Bangkok days.
**Fix:** use `gawk` explicitly or a portable `sed`/`grep -oP` extraction; bucket on the parsed line timestamp shifted +7 h, never on the filename; delete the rotation claim.

### 12. B6's decision table has no "evidence does not match any row" branch, and its step loop contradicts D3
**Location:** B6 decision table + "Chosen branch" gate; B6 Steps (*"next row only after the count moved"*) vs Deploy sequencing (*"D3 = B6 (its own PR)"*).
The table is otherwise concrete enough to fill at Gate A without new interviewing (six rows, each with files and a verify), but the plan orders the session to never guess while providing no escape if A1 ranks a cause outside the six rows (e.g. the 03:00 `cleanup-videos` cron, or a long admin read holding the write lock). Separately, a multi-row branch needs multiple deploys with 24 h between; D3 describes one.
**Fix:** add a seventh row — "evidence matches nothing above → stop, present the ranked cause to Mew, no code change" — and restate D3 as "D3.1…D3.n, one row per deploy, 24 h apart".

### 13. Acceptance Criterion 3 is absolute with no recorded-miss path
**Location:** Acceptance Criteria bullet 3 (slow-tx ≥5 s, `Socket timeout`, `P1008` all 0/day for 7 days in every PM2 app).
Bullet 2 has an explicit escape for `/video-editor`; bullet 3 has none, and it covers apps (`render-worker`, `story-film-system-worker`) whose remedies may fall outside the chosen B6 row. HERO-10's history (PRs #462/#465 did not reach the target) says this is the likely outcome.
**Fix:** mirror bullet 2 — a residual class is recorded in the report with its holder and filed as a follow-up rather than blocking closure.

### 14. A2 Step 1 weakens the absolute no-customer-identity rule
**Location:** A2 Step 1 (*"screenshots may be taken but must not be saved to the repo **if they show customer emails**"*) vs Global Constraint (*"No customer identity in any report, log excerpt, Linear draft **or screenshot**"*).
A conditional invites judgement on a rule the plan states as absolute.
**Fix:** "no screenshots are saved anywhere in the repo; record numbers only."

### 15. A1 reads prod `.env`; the constraint list and project history argue against it
**Location:** A1 Files (*"Read on prod: … `/var/www/ai-content/.env` (names of keys only — never values)"*) vs A1 Step 8, which already gets key names from `pm2 describe`.
Opening `.env` puts secret values one command away from the transcript (a Pixabay key fragment already leaked into a transcript once in this project).
**Fix:** drop `.env` from the Files list; if key names are needed, mandate `cut -d= -f1 .env | sort` and nothing else.

### 16. A1 Step 6 requires a local dev environment the task never sets up
**Location:** A1 Step 6 (*"Locally (worktree, `DEBUG="prisma:query" npm run dev` against the local dev DB…)"*) vs A1's Files (prod reads only) and the Workspace constraint (orca worktree + `cp .env` + `npm ci` + `prisma generate`).
A1 is dispatched as the read-only SSH task; A3 Step 2 already runs exactly this capture. The worker has no worktree step and the local `dev.db` is known to drift from the schema.
**Fix:** A1 Step 6 consumes the SQL captured by A3 (add `Blocked by: A3` or move Step 6 into A3 and keep only the `EXPLAIN QUERY PLAN` runs in A1).

### 17. C1 failure bucketing has unreachable fallback logic
**Location:** C1 Queries: `WHERE … finishedAt >= ?` … *"bucket by `finishedAt ?? updatedAt`"*.
Rows with null `finishedAt` are already excluded by the filter, so the fallback never fires — and failed jobs are precisely the ones likely to have no `finishedAt`.
**Fix:** filter on `COALESCE(finishedAt, updatedAt) >= ?` and bucket on the same expression, then say so in the verify fixture.

### 18. C4's insights-route instruction is ambiguous
**Location:** C4 Files: *"keep the response keys but omit the blocks so `verify:admin-insights-revenue` expectations are updated deliberately"*.
"Keep the key, omit the block" does not say what the key holds (`null`? `{}`? absent?), and the worker also has to decide whether `getRevenueCohorts` is still called.
**Fix:** specify the exact shape (e.g. `revenue: null, northStar: null`), and make the `getRevenueCohorts` call-site decision a one-line grep instruction with a stated expected answer.

### 19. C2's "auto-14 under 640 px" is asserted as testable but has no testable seam
**Location:** C2 test (*"chart switches to 14 days when `window.innerWidth < 640`"*) — the script is described as "source-level + render with fixture"; neither form observes `window.innerWidth` in the team's `tsx` temp-SQLite harness.
**Fix:** extract `export function defaultTrendDays(width: number): 14 | 30` and unit-test that pure function; the component test only asserts the function is used.

### 20. A5's error taxonomy adds a fifth class not in the glossary
**Location:** A5 Produces (*"ชั้น (ฝั่งเรา / ฝั่งลูกค้า / noise / **Clerk**)"*) vs Global Constraint (*"Job Failure Class … is the only failure taxonomy"*) and `CONTEXT.md` (system / byok / quota / noise, grouped as ฝั่งเรา / ฝั่งลูกค้า).
Job Failure Class is defined for *video-job* failures; A5 is classifying browser and third-party errors with it.
**Fix:** either state that A5's column is a distinct "Error Source Class" for the 14-day summary (and name its values), or fold Clerk noise into `noise`.

### 21. Acceptance Criterion 6 does not cover the numbers Phase C creates
**Location:** Acceptance Criteria bullet 6 ("Number-accuracy table covers every number on `/admin` …") — A4 runs before C2 exists, so the MAPC headline, trend cards, today strip and health pills are never in that table.
**Fix:** say the table covers the pre-change surfaces, and that the new `/admin` numbers are covered by `verify-admin-trends` plus one row per new number added to the A4 table at C2 time.

---

## NITS

22. **Division by zero.** C2 North Star sub: `{Math.round(100*activeCreators/activePayingCustomers)}%` renders `NaN%` when the denominator is 0 or the snapshot is null. Specify the fallback copy (`—`).
23. **Fragile money-string check.** `verify-money-only-on-revenue` forbids `จ่ายจริง (จ่ายเงินสด)` on `/admin` while C2 legitimately ships `จ่ายจริง/วัน`. A worker who implements the check as `includes("จ่ายจริง")` breaks C2. State that the assertion is on the full parenthesised label.
24. **Global Constraints overstate C2.** *"`/admin` shows the MAPC headline and the paid-count trend **only**"* contradicts C2's four cards, today strip and health pills (and ADR 0062, which names all of them). Reword to "money on `/admin` is limited to the paid-count trend".
25. **Unsupported version claims.** "Next.js 16.3 … React 19.2 … Prisma 6.19" conflict with `CLAUDE.md` (Next 15, Prisma 6). Tell the worker to read `package.json`.
26. **Unverified symbols asserted as existing:** `NorthStarDailySnapshot` (+ its `snapshotDate` / `activeCreators` / `activePayingCustomers` columns), `src/lib/prisma-options.ts` `withSqliteConnectionParams` / `transactionOptionsFromEnv`, the current signature of `classifyJobError`, `scripts/verify-prisma-slow-tx.ts`, and the existence of `/admin/users`, `/admin/coupons`, `/admin/loanwords`, `/admin/updates` pages (Task C3's `verify-admin-navigation` fails outright if any is missing). Add "confirm and report if absent" to the first step of each consuming task.
27. **`scripts/dev-query-counter.ts`** (A3) is exempted from the "every new script is wired into `package.json` + CI" constraint only implicitly, and the escape hatch *"may live in the report as a snippet if a script is impractical"* is a placeholder. Pick one.
28. **Linear draft formats are mixed:** `HERO-10-reopen.md` vs `*.json` for the rest, with no stated schema for either.
29. **Line-number precision without a re-locate rule:** B2 cites `src/app/api/admin/settings/route.ts:109` and B3 cites `entitlements.ts:187-203`; C3 alone tells the worker how to re-locate after drift. Apply C3's rule everywhere.
30. **Budget risk:** C5 and B6 are unbounded (one verify script per fix / per row) inside "Maximum subagent runs: 48". Cap them at Gate A when the lists are written.
31. **C2 Files lists `src/app/api/admin/stats/route.ts` as "Modify — unchanged fields"**, i.e. a file to modify with no modification. Move it to a "Read" note.
32. **Menu redundancy:** group `ภาพรวม` containing a single item `ภาพรวม`. Cosmetic, but it is in the acceptance criterion ("exactly the five Thai groups and eleven items"), so it ships as-is unless changed now.

---

## Verdict

Five BLOCKING items — a locked decision (Q14) that Task C1 contradicts, a criterion (AC8) no query can satisfy, a high-assurance billing change whose test omits the changed case, an unresolved collision between B4 and the untouchable render path, and a performance criterion measured against a page the plan deletes. None require re-interviewing Mew; all are plan edits or one extra evidence step.

**NOT READY**

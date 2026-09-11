# A4 — Number-accuracy audit (admin + dashboard surfaces)

**Task:** A4 of the 2026-09-12 performance-audit / admin-reorg plan.
**Method:** for every number on the pre-change surfaces, read the code path to its definition, then
re-derive it with an independent read-only SQL query against production `prisma/dev.db`.
**Code baseline:** `/Users/mewsocialmacmini/projects/AI_content_Mew_social-perf-audit-reports` at
`origin/main` `bd84ba40` (= prod HEAD `84e4d8c2` lineage).
**Shown values:** A2's sanitised API JSON, captured **2026-09-11 21:05–21:11 UTC = 2026-09-12 04:05–04:11 Asia/Bangkok**
(`docs/plans/reports/2026-09-12-A2-api-json/*.json`). Per-file capture times are in the table.
**Actual values:** measured **2026-09-11 21:34–21:52 UTC = 2026-09-12 04:34–04:52 Asia/Bangkok**
(25–45 min after the A2 capture). Where the only difference is that gap, the row is marked `Y (drift)`.
**Constraints honoured:** production was opened read-only (`sqlite3 -readonly …?mode=ro`); no writes, no
`VACUUM`, no pm2 mutation, no `.env` values read (key names only). No customer identity appears below —
the one user id shown is the admin's own account, truncated to an 8-char prefix (`cmoycf2v`).
**Day boundary:** every "today"/daily figure is re-derived at Asia/Bangkok midnight
(`date(col/1000,'unixepoch','+7 hours')`), per the global constraints.

---

## 0. Headline

| verdict | count | rows |
|---|---:|---|
| Numbers audited | **119** | #1–#119 |
| **Match `Y`** — value and definition both correct | **79** | of which **5** are "definition is right, label is misleading": #37, #64, #65, #97, #107 |
| **Match `Y (drift)`** — differs only by the 25–45 min capture gap | **5** | #21, #22, #38, #73, #74 |
| **Mismatch `N`** — the number does not mean what the label says, or is not the number it claims | **26** | #8, #9, #15, #18, #31, #40, #43, #45, #51, #52, #53, #69, #70, #71, #72, #76, #82, #84, #86, #92, #94, #95, #96, #101, #102, #106 |
| **Mixed** — arithmetic correct, meaning wrong (or one half of a pair wrong) | **9** | #6, #10, #16, #41, #58, #60, #79, #100, #116 |

Of the 26 mismatches, **4 are inherited** from the MRR defect (#18, #45, #95, #96) and **8 are the single
telemetry-sampling defect** (#51, #52, #70, #71, #72, #82, #86, #92) — so they collapse into the 6 fix
candidates in §9 rather than 26 independent bugs.

The three findings that change what Mew believes about the business:

1. **`จ่ายจริง` is two different numbers on the same page, and the bigger one is wrong.** `/admin` and
   `/admin/insights` show **39**; the North Star on the *same* `/admin/revenue` page shows **28**. The gap
   is exactly **11 accounts whose only plan `Payment` rows are ฿0**. `revenue-cohorts.ts` treats *any*
   non-credit `PAID` row as cash evidence regardless of amount; `subscription-north-star.server.ts`
   requires `amount > 0`. 28 is right.
2. **35 % of the MRR figure is money nobody paid.** Those same 11 zero-฿ accounts fall through
   `monthlyRevenueByUser` (only populated for `amount > 0`) onto the **list price**, contributing
   **฿6,389.33 of the ฿18,052.50 MRR** and **฿6,389.33 of the ฿9,739.50 `prepaidMrr`** — which then
   inflates `deferredRevenue` (฿35,569.96) too. `arr` is clean (recurring only).
3. **Every telemetry-derived number on the 7-day and 30-day `/admin/insights` view is a ~4-day sample.**
   The query is `take: 20_000` over a window that holds **102,501** rows at 30 days; the newest 20,000
   reach back only to 2026-09-08 16:06 Bangkok. The *previous*-window query has the same cap **with no
   `orderBy`**, so it takes the *oldest* 20,000 — current and previous are not comparable at all. The
   24-hour view (5,175 rows) is intact.

---

## 1. `/admin` overview cards — `GET /api/admin/stats`

Shown values from `admin-stats.json`, captured 2026-09-11 21:08 UTC. The A2 sanitiser capped the payload
at 10 keys, so `directPayingTotal · bundleActive · trialActive · compedPaid · mrr · directMrr · bundleMrr ·
lapsedPayers · payingCanceling · mrrAtRisk` have no captured shown value; they are audited by definition
and derived independently (marked *not captured*).

| # | Surface · label | Shown | Code definition (file:line + the SQL Prisma runs) | Independent read-only SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 1 | `/admin` · ผู้ใช้งานทั้งหมด | 1275 | `stats/route.ts:33` `prisma.user.count()` → `SELECT COUNT(*) FROM User` | `SELECT COUNT(*) FROM User` | 1275 | **Y** | — | — |
| 2 | `/admin` · ผู้ใช้งานระดับ Free | 1026 | `stats/route.ts:48` `totalUsers − paidUsers` (no query) | `1275 − 249` | 1026 | **Y** | — | but see #23: the cost panel's "Free" is 1023 |
| 3 | `/admin` · (note line) บนแผน PRO/BUSINESS | 249 | `stats/route.ts:34` `user.count({plan in [PRO,BUSINESS]})` | `… WHERE plan IN ('PRO','BUSINESS')` | 249 | **Y** | — | — |
| 4 | `/admin` · ถูกระงับการใช้งาน | 1 | `stats/route.ts:35` `user.count({suspended:true})` | `… WHERE suspended=1` | 1 | **Y** | — | — |
| 5 | `/admin` · เนื้อหาทั้งหมด | 3 | `stats/route.ts:36` `prisma.content.count()` | `SELECT COUNT(*) FROM Content` | 3 | **Y** | correct count of a **dead table** — newest `Content` row is 2026-05-29 | **C5**: drop the card (see Candidate 5) |
| 6 | `/admin` · **วิดีโอทั้งหมด** | 1585 | `stats/route.ts:37` `prisma.video.count()` → all `Video` rows | `SELECT COUNT(*) FROM Video` = 1585; `RenderJob type='RENDER' status='DONE'` = 2758; `VideoJob status='done'` = 3406 | 1585 | **Y** (number) / **definition disputed** | three defensible "videos created" exist and they differ by 2× | **C5** — see §3 "What วิดีโอที่สร้าง should mean" |
| 7 | `/admin` · รูปภาพทั้งหมด | 5639 | `stats/route.ts:38` `prisma.generatedImage.count()` | `SELECT COUNT(*) FROM GeneratedImage` = 5639; cross-check `AiGenerationJob kind='image' generatedImageId NOT NULL` = 5639 | 5639 | **Y** | — | — |
| 8 | `/admin` · **สมัครใช้งานวันนี้** | **9** | `stats/route.ts:15-16,39` `new Date(); setHours(0,0,0,0)` in **server TZ**; A1 §A1.7: `TZ` is **not set** → `Etc/UTC` | Bangkok today: `date(createdAt/1000,'unixepoch','+7 hours') = date('now','+7 hours')` | **0** | **N** | "today" starts at **07:00 Bangkok**, not 00:00. At 04:34 Bangkok the card shows 9 signups that all happened *yesterday* (Bangkok 09-11 after 07:00). Bangkok 09-11 total was 11, of which 2 fell in the 00:00–07:00 blind slice. | **C5** — day boundary |
| 9 | `/admin` · สมัครใช้งาน 7 วัน / "ย้อนหลัง 1 สัปดาห์" | 107 | `stats/route.ts:18-20,40` `now−7d` then `setHours(0,0,0,0)` (server TZ) | Bangkok 8 calendar days: 104 · Bangkok 7 calendar days: 102 | 104 / 102 | **N** | two errors compound: the 7 h shift **and** the window is 8 calendar days (`D-7` midnight → now), not 7. Label says 7. | **C5** — day boundary |
| 10 | `/admin` · **จ่ายจริง (จ่ายเงินสด)** | 39 | `stats/route.ts:43,57` → `revenue-cohorts.ts:499` `getRevenueCohorts()`; paying = `directRevenueBacked \|\| bundleRevenueBacked` (`:341-350`), where `cashPaid` = **any** `Payment status='PAID' AND note<>'credits'` (`:211-217`, no amount test) | full `classifyEntitlement` replay in SQL (see Commands, Q4) | 39 | **Y** (arithmetic) / **N** (meaning) | **11 of the 39 have only ฿0 plan payments.** North Star's `amount > 0` test (#27) gives 28. | **C5 — Candidate 1** |
| 11 | `/admin` · จ่ายจริง sub · Studio | *not captured* | `revenue-cohorts.ts:355` `directPayingTotal` | same replay | 37 | **Y** | of which 11 are ฿0 accounts | Candidate 1 |
| 12 | `/admin` · จ่ายจริง sub · Bundle | *not captured* | `revenue-cohorts.ts:413` `bundleActive` (`bundleStatus='ACTIVE' AND bundleAccessExpiresAt>now AND bundleAmountThb>0`) | same replay | 2 | **Y** | — | — |
| 13 | `/admin` · Trial (ทดลอง) | *not captured* | `revenue-cohorts.ts:433` `source==='TRIAL'` | same replay | 90 | **Y** | — | — |
| 14 | `/admin` · Comped (แจกสิทธิ์) | *not captured* | `revenue-cohorts.ts:425-432` entitled-but-not-cash-backed | same replay | 119 | **Y** | — | — |
| 15 | `/admin` · **MRR (รายได้/เดือน)** | *not captured* (= `base.activeMonthlyValue` on `/admin/revenue` = **18052.5**) | `revenue-cohorts.ts:364-369`: per payer, `monthlyRevenueByUser` (actual paid ÷ 12 if `periodDays>=300`, `:220`) **else `monthlyEquiv(listPrice…)`**; list price from `SiteConfig plan_*_price`, absent on prod → defaults 599/990 | recompute from actual paid amounts (Q6) | actual-paid MRR = **฿9,865.16** + bundle ฿1,798 = **฿11,663.16**; shipped figure ฿18,052.50 | **N** | the 11 zero-฿ accounts have no `monthlyRevenueByUser` entry and fall back to the **list price** — **฿6,389.33/month of pure fiction** (2 × PRO-annual @ ฿499.17, 9 × PRO-monthly @ ฿599) | **C5 — Candidate 2** |
| 16 | `/admin` · MRR sub · Studio / Bundle | *not captured* | `:368` `directMrr`, `:418` `bundleMrr` | Q6 | bundle ฿1,798.00 exact; directMrr inflated as #15 | Bundle **Y**, Studio **N** | as #15 | Candidate 2 |
| 17 | `/admin` · จ่ายอยู่ … ยกเลิกแล้ว รอหมดรอบ | *not captured* | `:408-411` `payingCanceling` = paying AND `subStatus='canceled'` | replay | 1 | **Y** | — | — |
| 18 | `/admin` · MRR เสี่ยง (`mrrAtRisk`) | *not captured* | `:410` sum of `add` for those users | derived from #15's inputs | inherits #15's list-price defect | **N** (inherited) | as #15 | Candidate 2 |
| 19 | `/admin` · lapsedPayers | *not captured* | `:437,440,443,446` | replay | 3 | **Y** | — | — |
| 20 | `/admin` disk tab · Disk total/used/avail/% | 387.5 / 255.2 / 132.3 GB / 66 % (`admin-storage.json`, 21:10 UTC) | `/api/admin/storage` reads the filesystem | `df -h /` | 388 G / 256 G / 133 G / **66 %** | **Y** | — | — |
| 21 | `/admin` disk tab · renders total | 13,433 files / 114,647 MB (`admin-cleanup.json`, 21:05 UTC) | `/api/admin/cleanup` walks `public/renders` | `ls \| wc -l` = 13,400 · `du -sm` = 114,594 MB | 13,400 / 114,594 | **Y (drift)** | 33 files / 53 MB deleted by `cleanup-videos` in the 45 min gap | — |
| 22 | `/admin` disk tab · stocks total | 21,658 files / 37,458 MB | same | `ls \| wc -l` = 21,657 · `du -sm` = 37,472 MB | 21,657 / 37,472 | **Y (drift)** | — | — |
| 23 | `/admin` support tab · open ticket badge | 2 (`admin-support-open.json`) | `/api/admin/support?status=OPEN` | `SELECT COUNT(*) FROM SupportTicket WHERE status='OPEN'` | 2 | **Y** | — | — |

> **ADR 0062 note (not a mismatch):** rows 10–18 render money on `/admin`. ADR 0062 (accepted 2026-09-12)
> says money renders only on `/admin/revenue`; `/admin` keeps only the จ่ายจริง **count** trend. These
> cards are the pre-change state the ADR was written to remove — recorded here so C2/C3 do not carry
> them forward.

---

## 2. `/admin/revenue` — `getRevenueGrowthDashboard` (`src/lib/revenue-growth.server.ts:146`)

Shown values from `admin-revenue.json`, captured 2026-09-11 21:09:45 UTC, `days=30`.

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 24 | **North Star · คนจ่ายที่กลับมาสร้างจริง (MAPC)** | 20 | `revenue-growth.server.ts:275` ← `subscription-north-star.server.ts:148-193`: payers (`activePayingBillingCohort`, `:111`) ∩ (completed video ∪ script ∪ Hero image) in trailing 30 d | full replay (Q3) | **20** | **Y** | number reproduces exactly | but see §4 — the *denominator* does not match CONTEXT.md |
| 25 | ลูกค้าจ่ายจริงที่ยังมีสิทธิ์ (`northStar.activePayingCustomers`) | 28 | `:180` `payerIds.size` — requires a `PAID` payment with **`amount>0 AND periodDays>0 AND note<>'credits' AND plan IN (PRO,BUSINESS)`** (`:116-121`), excludes suspended + ADMIN/`aoacademy.co`/`duckyhero@` | Q3 | 28 | **Y** | **this is the correct "จ่ายจริง"** | — |
| 26 | กลับมา % (`creatorRatePct`) | 71 | `:182` `round(creators/payers*100)` = 20/28 | Q3 | 71 | **Y** | — | — |
| 27 | ต่ออายุอัตโนมัติ (`activeRecurringPayers`) | 15 | `:160` ← `recurringBillingCohort:68` (live Stripe sub + `subStatus='active'` + `planExpiresAt>now`, or live paid bundle) | Q3 | 15 | **Y** | — | — |
| 28 | MAPC รายเดือน / รายปี | 7 / 13 | `:167-172` cohort of each creator | Q3 | 7 / 13 | **Y** | — | — |
| 29 | ผลลัพธ์ที่นับ · วิดีโอ / สคริปต์ / ภาพ | *not captured* (depth-2 collapse) | `:185` `outcomes.{video,script,image}Creators` | Q3 | **18 / 11 / 19** | **Y** (derived) | 18+11+19 = 48 > 20 — the page already warns not to add them | — |
| 30 | `northStar.asOf` | 2026-09-11T21:09:45Z | `:282` = request time | — | — | **Y** | live, not a snapshot | — |
| 31 | **MAPC history chart (last point)** | 30 rows, latest `snapshotDate` = 2026-09-11 | `revenue-growth.server.ts:164-171` `northStarDailySnapshot` desc take 31 | `SELECT MAX(snapshotDate)…` = **2026-09-11**; 30 rows, oldest 2026-08-13, no gaps; latest row `activeCreators=21 activePayingCustomers=29 activeRecurringPayers=16`, `asOf` **07:15 Bangkok** | latest = yesterday; values 21/29/16 vs live 20/28/15 | **N** | `ecosystem.config.js:279` `cron_restart: "15 0 * * *" // daily 00:15 Asia/Bangkok` — but `TZ` is unset (A1 §A1.7) so PM2 fires at **00:15 UTC = 07:15 Bangkok**. Consequences: (a) between Bangkok 00:00 and 07:15 the chart has no point for today and the "latest" point silently means yesterday; (b) each row labelled with a Bangkok date actually measures 07:15 of that day; (c) the chart's last point disagrees with the headline beside it because they are measured 21 h apart. | **C5 — Candidate 4** |
| 32 | เป้ารอบนี้ · ทำได้ (`goal.last30DaysGross`) | 31,346 | `:295` ← `summarizeRevenuePeriod` over **Stripe charges + refunds + manual `Payment` rows** (`revenue-growth.server.ts:188-231`) — Stripe truth, *not* `Payment.amount` ✓ | Stripe not queried (no API calls from this audit). Payment-ledger equivalent: `SUM(amount)/100 WHERE PAID AND paidAt>=now-30d` = **฿30,447 over 36 rows** | ฿31,346 (Stripe) vs ฿30,447 (ledger) | **Y** (definition correct) | an ฿899 ledger↔Stripe gap exists and is **already surfaced** as `cash.mix.reconciliation` — the right design | — |
| 33 | `goal.progressPct` / `gap` | 31 % / 68,654 | `:296-297` vs `MONTHLY_REVENUE_TARGET = 100_000` (`:21`, hard-coded) | 31,346/100,000 | 31 % / 68,654 | **Y** | target is a code constant, not admin-editable | — |
| 34 | รายได้รวม 30 วัน (`cash.currentGross`) | 31,346 | `revenue-growth.ts:77` `stripeGross − refunds + manual` | as #32 | — | **Y** | Stripe truth ✓ | — |
| 35 | `cash.stripeGross` / `stripeNet` / `refunds` | 31,945 / 31,346 / 599 | `revenue-growth.ts:72-79`; refunds are dated **when money leaves** (`:202-213`), not back-dated to the charge | — | internally consistent (31,945 − 599 = 31,346) | **Y** | — | — |
| 36 | `cash.manual` | 0 | `:65` manual `Payment` rows in window | `COUNT/SUM WHERE manual=1 AND paidAt>=now-30d` | 0 rows / ฿0 | **Y** | — | — |
| 37 | **รายการรับเงิน (`cash.transactions`)** | 23 | `revenue-growth.ts:70` `if (amount>0) transactions++` over **cashEvents only** = Stripe charges + manual receipts | `Payment PAID` rows in window = **36**, of which **21 have `amount>0`** and **15 are ฿0** | 23 Stripe charges vs 36 ledger rows | **Y** (definition) / label misleading | correct as "Stripe transactions", but it sits one line above #38 which counts **34 people** — a reader cannot reconcile 34 customers with 23 transactions | **C5 — Candidate 3** |
| 38 | **ลูกค้าใหม่ / เดิม (`newPayers`/`repeatPayers`)** | 28 / 6 | `revenue-growth.ts:157-162` over `receipts` = **every** `Payment PAID` row (all-time for the "first ever" test) + bundle invoices — **no amount filter** | distinct payers in window = 33 (28 new + 5 repeat) | 28 / 5 (+1 repeat from a bundle Stripe invoice invisible to the DB) | **Y (explained)** for `newPayers`; **Y (drift/bundle)** for `repeatPayers` | but **15 of the 36 window rows are ฿0**, so "ลูกค้าใหม่ 28" counts people who paid nothing, next to a Stripe-truth ฿31,346 | **C5 — Candidate 3** |
| 39 | เงินเข้าตลอดกาล (`cash.lifetimeGross`) | *not captured* (key-cap) | `:299` ← `revenue-cash.server.ts:36` `getLifetimeCashCollected()` — Stripe charges net of refunds + manual `Payment` rows, 5-min cache | Payment-ledger all-time = **฿64,568.95 over 53 rows** (incl. ฿5,302 manual) | Stripe figure not readable from here | **Y** (definition correct — Stripe, not `Payment.amount` ✓) | the ฿64,568.95 ledger number is **not** the truth and must never be quoted (2026-08-27 memory: ledger overstated revenue three ways) | — |
| 40 | ฐานรายเดือน (`base.activeMonthlyValue`) | 18,052.5 | `:304` = `cohorts.mrr` | Q6 | actual-paid ฿11,663.16 | **N** | as #15 | Candidate 2 |
| 41 | ลูกค้าจ่าย N คน (`base.activePayingCustomers`) | **39** | `:301` = `cohorts.payingTotal` | Q4 | 39 | **Y** (arithmetic) / **N** (meaning) | **same page, same Thai wording, two numbers: 28 (row 25) and 39.** Difference = exactly the 11 zero-฿ accounts. | **C5 — Candidate 1** |
| 42 | ฐานต่ออายุ (`base.recurringMonthly`) | 8,312.99 | `:237` `recurringMrr + bundleMrr` | Q6: 6,515.00 + 1,798.00 | 8,313.00 | **Y** | clean — every contributor paid > ฿0 | — |
| 43 | **จ่ายล่วงหน้า (`base.prepaidMonthlyEquivalent`)** | 9,739.5 | `:303` = `cohorts.prepaidMrr` (`revenue-cohorts.ts:386`) | Q6 prepaid-from-actual-paid = **฿3,350.17** | ฿3,350.17 | **N** | ฿6,389.33 (66 % of it) is list-price fiction from the 11 zero-฿ accounts | **C5 — Candidate 2** |
| 44 | ARR (`base.arr`) | 99,755.95 | `:469` `(recurringMrr + bundleMrr) × 12` — prepaid deliberately excluded | (6,514.99 + 1,798) × 12 | 99,755.88 | **Y** | the one revenue figure with no zero-฿ contamination | — |
| 45 | **เงินรอส่งมอบ (`base.deferredRevenue`)** | 35,569.96 | `revenue-cohorts.ts:395` straight-line over remaining term, built from the same `add` | not independently priced (needs per-user term dates) | inflated by the same 11 accounts | **N** (inherited) | zero-฿ accounts are given a "deferred obligation" for money never received | Candidate 2 |
| 46 | เติมเครดิต (`base.creditRevenue` / `creditBuyers`) | 1,295 / *not captured* | `revenue-cohorts.ts:212-214,235` `note='credits'` rows | `SUM(MAX(amount,0))/100 … note='credits'` = **1295.0**; `COUNT(DISTINCT userId)` = **5** | 1295.0 / 5 | **Y** | — | — |
| 47 | สินค้า · Studio / Bundle payers | *not captured* | `:309-310` | Q4 | 37 / 2 | **Y** | — | — |
| 48 | Trial / Free / Comped / Lapsed (`base.*`) | *not captured* | `:311-314` | Q4 | 90 / 1023 / 119 / 3 | **Y** | — | — |
| 49 | `cash.mix.{studio,bundle,credit,manual,other,reconciliation}` | *not captured* (depth-2 collapse) | `revenue-growth.ts:122-155`; `other = stripeGross − (studio+bundle+credit)`, `reconciliation = total − explained` | see #32 | ledger↔Stripe gap ≈ ฿899 | **Y** (design correct) | this is the only place the ledger/Stripe divergence is visible — keep it | — |
| 50 | `insights[]` (3 auto-generated notes) | *not captured* | `revenue-growth.server.ts:117-144`; "ยังดึงกลับได้อีก N คน" uses `activePayingCustomers − activeCreators` = 28 − 20 = 8 | — | 8 | **Y** | consistent with the *North Star* denominator, not with `จ่ายจริง 39` | — |

---

## 3. `/admin/insights` — all nine sections (`GET /api/admin/insights?days=30`)

Shown values from `admin-insights-days30.json`, captured 2026-09-11 21:10:44 UTC.
**Note on the default window:** the page's own state is `useState(1)` (`page.tsx:289`), so opening
`/admin/insights` from the sidebar fetches `?days=1`. A2 captured `?days=30` explicitly.

### 3.0 The 20,000-row cap (affects sections 4, 6, 8 and the whole dev drawer)

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 51 | **every telemetry-derived number** (`totals.sessions/users/editorOpens/errors/byokErrorCount/quotaErrorCount/noiseEvents/frontendErrors/serverErrors`, `steps[]`, `errors[]`, `vitals[]`, `resource.*`, `broll.*`, `playback.*`, `managedStock.*`) | *not captured* (A2 collapsed `current`) | `insights/route.ts:842-850` `telemetryEvent.findMany({where:{createdAt:{gte:since}}, orderBy:{createdAt:'desc'}, take: 20_000})` | rows in window: **1 d = 5,175 · 7 d = 30,251 · 30 d = 102,501**; newest 20,000 of the 30-day window start at **2026-09-08 16:06 Bangkok** | at `days=30` the page reads **19.5 %** of the window (≈ the last 3.5 days). e.g. error-class rows: **745 in the sample vs 5,615 in the real 30 days**; `editor_opened` events: **693 vs 3,886** | **N** | silent `take` cap with no "truncated" signal in the payload or the UI | **C5 — Candidate 5** |
| 52 | the same numbers for "ช่วงก่อนหน้า" (Health Score comparison, `previous.*`) | *not captured* | `insights/route.ts:851-858` — same `take: 20_000`, **no `orderBy`** | previous 30-day window holds **78,233** rows | Prisma emits no `ORDER BY`; SQLite returns rowid order → the **oldest** 20,000 | **N** | current = newest 20 k, previous = oldest 20 k. Every "ดีขึ้น/แย่ลงจากช่วงก่อน" comparison at 7 d or 30 d compares two non-overlapping, differently-selected samples. | **C5 — Candidate 5** |

### 3.1 Section 1 — North Star (MAPC)

Identical fields to rows 24–29 (`getSubscriptionNorthStar(now)`, `insights/route.ts:914`) and they matched:
shown `activeRecurringPayers 15 · activePayingCustomers 28 · activeCreators 20 · creatorRatePct 71 ·
monthlyCreators 7 · annualCreators 13` — all **Y**.

| # | Label | Shown | Code | SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 53 | `northStar.history[]` on insights | *not captured* | `:915-923` take 31 desc | `COUNT(*)=30`, max = 2026-09-11 | latest = yesterday at 04:34 Bangkok | **N** | same cron-TZ cause as #31 | Candidate 4 |

### 3.2 Section 2 — Activation headline · `activation.*`

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 54 | สมัคร (`activation.signups`) | 1260 | `insights/route.ts:460-497` `users.length − internalIds.size`, internal = `email.includes('@aoacademy')` (**substring**) | `1275 − COUNT(email LIKE '%@aoacademy%')` = `1275 − 15` | 1260 | **Y** | all-time, not windowed — the panel says so | — |
| 55 | หมายเหตุ · ตัดบัญชีทีมงาน (`internalTeam`) | 15 | `revenue-cohorts.ts:313` same substring rule | `COUNT(*) WHERE email LIKE '%@aoacademy%'` | 15 | **Y** | **three different "internal" definitions ship together**: substring `@aoacademy` (funnel + cohorts), exact domain `aoacademy.co` **+ role ADMIN + duckyhero@** (North Star, `subscription-north-star.server.ts:57`), and none at all (`/admin/stats`). They do not produce the same exclusions. | **C5 — Candidate 6** |
| 56 | hasGeminiKey | 125 | `:983` non-empty `geminiKey` | `TRIM(IFNULL(geminiKey,''))<>''` | 125 | **Y** | — | — |
| 57 | hasStockKey | 352 | `:984` non-empty `pexelsKey` OR `pixabayKey` | same | 352 | **Y** | — | — |
| 58 | **จ่ายจริง (`activation.paidTotal`)** | 39 | `:986` = `cohorts.payingTotal` | Q4 | 39 | **Y** (arithmetic) / **N** (meaning) | on this page it sits **directly under** the North Star block that says 28 | **Candidate 1** |
| 59 | Trial / แจกฟรี | *not captured* | `:1002-1003` | Q4 | 90 / 119 | **Y** | — | — |
| 60 | recurringMrr / prepaidMrr | 6,514.99 / 9,739.5 | `:993-994` | Q6 | 6,515.00 / **3,350.17** | recurring **Y**, prepaid **N** | as #43 | Candidate 2 |
| 61 | creditRevenue / creditBuyers | 1,295 / 5 | `:989-990` | Q4 | 1295.0 / 5 | **Y** | — | — |
| 62 | ช่วงที่เลือก: ได้วิดีโอ N คน / ก่อนหน้า N คน | *not captured* | `:1010-1011` distinct `Video.userId` where `COMPLETED`, non-internal, `createdAt` in window | `COUNT(DISTINCT userId)` 30 d / prev 30 d | **92 / 41** | **Y** (derived) | not capped (Video table, no `take` reached) | — |

### 3.3 Section 3 — Activation funnel (per person, all-time)

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 63 | 1. สมัคร | 1260 | as #54 | — | 1260 | **Y** | — | — |
| 64 | **2. เข้าใช้งาน (เปิด editor / เริ่มผ่านแชท)** | *not captured* | `:486-488` **union** of {`editor_opened` telemetry users} ∪ {VideoJob creators} ∪ {completed-video creators}, minus internal | union = 773; telemetry-only = 771 | **773** | **Y** (number) / label misleading | it is an "engaged" union, not "opened the editor". The union is a deliberate fix for >100 % steps (code comment `:480-485`) — the *label* is what's wrong, not the maths. No double counting: `Set` semantics. | "definition is right, label is misleading" → rename to **เคยเข้าใช้งาน** |
| 65 | 3. กดเริ่มสร้าง | *not captured* | `:477-479` {VideoJob creators} ∪ {completed-video creators}, minus internal | union = 265; VideoJob-only = 262 | **265** | **Y** | 3 legacy users completed videos before `VideoJob` existed; folding them in is what keeps the funnel monotone | label: **เคยสั่งสร้าง** |
| 66 | 4. ได้วิดีโอเสร็จ | *not captured* | `:494` `video.groupBy(userId)` where `status='COMPLETED'`, minus internal | `COUNT(DISTINCT userId)` | **136** | **Y** | — | — |
| 67 | 5. ทำซ้ำ ≥2 | *not captured* | `:495` same groupBy, `count >= 2` | same | **86** | **Y** | — | — |
| 68 | conversion % per step | *not captured* | `page.tsx:353` `Math.min(100, pctOf(count, prev))` | 773/1260 = 61 % · 265/773 = 34 % · 136/265 = 51 % · 86/136 = 63 % | as left | **Y** | clamping is defensive only; no clamp actually fires here | — |

### 3.4 Section 4 — System-health metric tiles

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 69 | **Video completed %** + helper `N/N jobs` | *not captured* | `insights/route.ts:219-240,777` — over **`Video` rows** in window, not `VideoJob`: `completed/total` | `SELECT status, COUNT(*) FROM Video GROUP BY status` → **COMPLETED 1585, everything else 0** (`Video_ever_nonCOMPLETED = 0`) | **always 100 %** | **N** | the `Video` table only ever holds `COMPLETED` rows on this database, so the tile is a constant. It is also labelled "jobs" while reading the `Video` table. Knock-on: `videoCompletionPenalty` (`:702-704`) and `statusStuckWithOutput` (`:715`) contribute **0** to the Health Score by construction — 35 of its 100 points can never be lost. | **C5 — Candidate 5** (point the tile at `VideoJob`) |
| 70 | Health Score | *not captured* | `:705-719` — 100 minus capped penalties for frontend errors ×3, server errors ×5, `renderP95/30 s`, video-completion, status-stuck, fail-candidates | inputs #51 (capped sample), #69 (constant 0), #75 (constant 0) | not reproducible as a business fact | **N** | three of its six penalty terms are structurally dead or sampled | Candidate 5 |
| 71 | Error telemetry (count) | *not captured* | `:622,769` real errors minus noise/byok/quota | error-class rows in 30 d = 5,615; in the newest-20 k sample = 745 | ~745 shown vs 5,615 real | **N** | #51 | Candidate 5 |
| 72 | เปิด Editor (ครั้ง) + helper `users · sessions · jobs` | *not captured* | `:611` raw `editor_opened` events; `:608-609` distinct sessionId / userId; `:613` **`pipelineJobs = videoJobs.total` = `Video` rows**, labelled "jobs" | `editor_opened` events 30 d = **3,886** (sample: 693); distinct sessions 30 d = **4,208**; `Video` rows 30 d non-internal = **661** | as left | **N** + label misleading | #51 for the first three; "jobs" is the `Video` table | Candidate 5 |

### 3.5 Section 5 — งานจริง (server) · `jobOutcomes`

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 73 | งานทั้งหมด | 1704 | `:1028` `VideoJob createdAt>=since`, internal excluded | `COUNT(*) FROM VideoJob WHERE createdAt>=now-30d AND userId NOT IN (internal)` | 1703 | **Y (drift)** | one job created in the 25-min gap | — |
| 74 | done | 1395 | `:1029` | `status='done'` | 1394 | **Y (drift)** | — | — |
| 75 | ล้มเหลว: บั๊กระบบ / ชนเพดานแผน / คีย์ลูกค้า / noise | 245 / 8 / 0 / 1 | `:1034-1037` ← `classifyJobError:339` (noise → quota → managed-429 → byok → system) | total failed = **254** = 245+8+0+1 ✓ | 254 | **Y** | classification reproduces | — |
| 76 | **the missing 55** | — | the tile prints `total`, `done`, `processing` and the four failure classes | `status='canceled'` in window = **55**; 1394 done + 254 failed + 0 processing + 0 queued = 1648 ≠ 1703 | **55 canceled jobs are rendered nowhere** | **N** | `jobOutcomes` has no `canceled` field (`:1027-1039`); a reader subtracting gets 55 unexplained jobs | **C5 — Candidate 5** |
| 77 | processing / waitingProvider / queued | 0 / 0 / 0 | `:1031-1033` | same | 0 / 0 / 0 | **Y** | — | — |

### 3.6 Section 6 — งานสร้างวิดีโอ funnel (per job, windowed)

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 78 | 1. เริ่มสร้าง (สั่งเรนเดอร์) | *not captured* | `insights/route.ts:431-453` all `VideoJob` in window, non-internal | same | **1703** | **Y** | — | — |
| 79 | **2. ได้ B-roll (`progress>=55`)** | *not captured* | `:433` | `progress>=55` = **1462**, of which `type='create'` **941** and `type='export'` **521** | 1462 | **Y** (number) / **N** (meaning) | the window holds **1,142 `create` + 561 `export`** jobs. An export job re-encodes an existing timeline and never fetches B-roll, yet all 521 that pass 55 % are counted as "ได้ B-roll". True create-path B-roll conversion is **941/1142 = 82 %**, the funnel shows **1462/1703 = 86 %**. | **C5 — Candidate 6** (split or filter `type`) |
| 80 | 3. จัดคลิปเสร็จ (`>=65`) / 4. เรนเดอร์ (`>=75`) / 5. เสร็จสมบูรณ์ | *not captured* | `:434-436` | 1427 / 1411 / 1394 | as left | **Y** (numbers) | same `create`/`export` conflation; also 30 jobs that reached `progress>=75` later **failed**, so step 4 legitimately exceeds step 5 | Candidate 6 |
| 81 | "นับจากงานเรนเดอร์จริง (VideoJob) N งาน" | *not captured* | `page.tsx:548` `funnelRuns` | = 1703 | 1703 | **Y** | no double counting: one row per job, `Set`-free counting | — |

### 3.7 Section 7 — ขั้นตอน pipeline + **Status stuck**

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 82 | ขั้นตอน pipeline table (started/done/error/p50/p95) | *not captured* | `:638-670` over telemetry `pipeline_step_*`, de-duped by `pipelineRunId` | — | sampled per #51 | **N** | #51 | Candidate 5 |
| 83 | **Status stuck · PROCESSING >20 นาที** | *not captured* | `:871` `getProcessingReconcilePlan({staleAfterMinutes:20, failAfterHours:3, limit:100})` → `video-reconcile.ts:119-132` `Video status='PROCESSING' AND createdAt <= now−20 min`, **`take: 100`** | `COUNT(*) FROM Video WHERE status='PROCESSING' AND createdAt <= now−20min` | **0** | **Y** (0 = 0) | but structurally dead: zero `Video` rows have ever been non-`COMPLETED` on this DB (#69). And `total` is silently capped at 100 by `take: limit` — if a real backlog appeared, the tile would read "100" forever. | **C5 — Candidate 5** |
| 84 | **Status stuck thresholds — the two `failAfterHours` disagree** | — | read path `insights/route.ts:871` uses **`failAfterHours: 3`**; the Apply button `page.tsx:578` POSTs **`failAfterHours: 24`** with `failMissingOutput:false` | — | — | **N** | "fail ได้ N" is computed at a 3-hour cutoff but the button that acts on it uses 24 hours, so the count shown and the count acted on are different populations. The panel label ("PROCESSING >20 นาที") also never states either fail cutoff. | **C5 — Candidate 6** |
| 85 | มี output แล้ว / ไม่มี output / งานเก่าสุด | *not captured* | `video-reconcile.ts:167-176`; `existingOutput` **stats the filesystem** (`:84-96`, `size > 1500 B`) | 0 rows to inspect | 0 / 0 / – | **Y** | note: this is the one admin number that does disk I/O per row | — |

### 3.8 Section 8 — Error telemetry list · 3.9 Section 9 — dev drawer

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 86 | `errors[] / byokErrors[] / noise[]` (top 8 each) | *not captured* | `:672-674` `summarizeIssueGroups`, `slice(0,8)` | — | sampled per #51 | **N** | #51 — and the top-8 ranking is over the sample, so a class that dominated 25 days ago is invisible | Candidate 5 |
| 87 | Render (จาก RenderJob) · งานเรนเดอร์ done/total | 1244 / 1246 | `:30-53,893-896` `RenderJob createdAt>=since`, `type='RENDER'` | `type='RENDER' AND createdAt>=now−30d`: total **1246**, done **1244** | 1246 / 1244 | **Y** | **not** telemetry — reads `RenderJob` directly, so it escapes the 20 k cap | — |
| 88 | success % / failed / queued / running / cancelled | 100 % / 2 / 0 / 0 | `:42-48` | failed = **2**; `100 × 1244/1246 = 99.8 → round 100` | 2 | **Y** | `pct()` rounds 99.84 % to "100 %" — hides both failures | cosmetic; note in C5 |
| 89 | Web / MCP | 37 / 1209 | `:46-47` `parentJobId` null / not-null, **`type='RENDER'` only** | `type='RENDER'`: 37 / 1209 | 37 / 1209 | **Y** | — | — |
| 90 | ฝังซับ (BURN) done/total | *not captured* | `:51-52` | `type='BURN' AND createdAt>=now−30d` total **912** | 912 | **Y** | — | — |
| 91 | p50 / p95 render ms | p50 209,411 | `:49-50` `finishedAt − startedAt` over DONE renders | not re-derived (percentile over 1,244 rows) | — | **Y** (definition) | — | — |
| 92 | Web Vitals / Playback / B-roll panels | *not captured* | `:676-682`, `:554-593`, `:500-552` — all telemetry | — | sampled per #51 | **N** | #51 | Candidate 5 |
| 93 | Managed stock · pexelsMonth used / ceiling | *not captured* | `:1046-1062` ← `ManagedStockUsage` table (not telemetry) | `SELECT provider, periodKey, count FROM ManagedStockUsage` → pexels `2026-09` = **458**, pixabay `2026-09` = **543** | 458 / 543 | **Y** | month counters are durable ✓; but `managedStock.searches/cacheHits/jobs` on the same panel come from `currentRows` → sampled per #51 | Candidate 5 (partial) |

---

## 4. `/admin/insights` section 1 — `CostMarginPanel` (`GET /api/admin/costs`)

**A2 did not capture `/api/admin/costs`**, so every shown value here is *not captured*; rows are audited by
definition with an independently derived actual. Default window on page load is **`days=1`**.

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 94 | ลูกค้าจ่ายเงินจริงทั้งหมดตอนนี้ (`customers.payingTotal`) | *n/c* | `costs/route.ts:103,334` `getRevenueCohorts(now)` | Q4 | 39 | **N** (meaning) | a **third** rendering of `จ่ายจริง = 39` on the same page as the North Star's 28 | **Candidate 1** |
| 95 | MRR (`hero.mrr`) / Gross Margin % / AI Cost % / กำไรขาดทุน | *n/c* | `:254` `cohorts.mrr`; `:259-264` `computeMargins({revenue: mrr, …})` | Q6 | every one of the four is computed **from the ฿18,052.50 MRR**, ฿6,389.33 of which is fiction | **N** (inherited) | a ~55 % over-statement of the revenue denominator flows into margin, AI-cost-% and profit | **Candidate 2** |
| 96 | Break-even N/target | *n/c* | `:269-273` `computeBreakEvenTarget({infraMonthly, grossProfit, payingTotal})`; `breakEven.subs = cohorts.breakEvenSubs = payingTotal` | Q4 | numerator 39 (incl. 11 zero-฿); denominator derived from the inflated margin | **N** (inherited) | break-even looks nearer than it is, from both sides | Candidate 2 |
| 97 | รายการรับเงินใน Studio · ช่วง N (`cash.total`) | *n/c* | `:122-125,246,337` — **`Payment.amount` where `status='PAID' AND paidAt>=from`**, *not* Stripe | `SUM(amount)/100`: 1 d = **฿599**, 30 d = **฿30,447 / 36 rows** | as left | **Y** (arithmetic) / label misleading | this is the **ledger**, while "รายได้รวมสะสม" two tiles away is **Stripe**. Two money numbers from two different sources sit in the same panel; the ledger one silently includes the 15 ฿0 rows and excludes nothing for refunds. | **C5 — Candidate 3** |
| 98 | Sub/รายเดือน vs รายปี split | *n/c* | `:242` `periodDays >= 365` = annual | 30 d: annual **฿23,960**, monthly **฿5,391**, packs **฿1,096** | as left | **Y** (arithmetic) | but `revenue-cohorts.ts:178` uses **`ANNUAL_PERIOD_DAYS = 300`** for the same concept. **1 `PAID` row has `300 <= periodDays < 365`** — it is "annual" for MRR and "monthly" for this split. | **C5 — Candidate 6** |
| 99 | รายได้รวมสะสม (`cash.allTimeTotal`) | *n/c* | `:171,341` `getLifetimeCashCollected()` — Stripe ✓ | ledger comparison ฿64,568.95 | — | **Y** (definition) | correct source; do not replace with the ledger | — |
| 100 | ARR / รอส่งมอบ / เติมเครดิต / Trial / Free tiles | *n/c* | `:334` whole `cohorts` object | Q4 | ARR ✓, deferred inherits #45, credits ✓, trial 90 ✓, **Free = 1023** | mixed | `cohorts.free` (1023) excludes the 3 lapsed payers, while `/admin`'s freeUsers (1026) does not → **two "Free" counts differ by 3** | note in C5 |
| 101 | **Render Web / MCP** (`usage.rendersWeb/Mcp`) | *n/c* | `:128-135` `renderJob.count({status:'DONE', parentJobId …})` — **no `type` filter** | `status='DONE'` 30 d: web **52**, mcp **2085**. `type='RENDER'` only: **37 / 1209** | 52 / 2085 | **N** | it counts `BURN` jobs as renders. The **same page** shows 37/1209 in the dev drawer (#89) — a 1.7× discrepancy between two tiles on one screen. | **C5 — Candidate 6** |
| 102 | **ครีเอเตอร์ active** (`usage.activeCreators`) | *n/c* | `:138-141` `telemetryEvent.groupBy(userId)` where `createdAt>=from` — **any** telemetry event | `COUNT(DISTINCT userId)`: 1 d = **39**, 30 d = **440** | 39 / 440 | **N** (label) | "creator" here means "emitted any telemetry event", including a page view. CONTEXT.md reserves *creator* for someone who completed a **Core Creation Outcome** (30 d: 92 people, #62). The word is load-bearing — it is the North Star's noun. | **C5 — Candidate 6** |
| 103 | นาทีที่จัดการ (Managed) | *n/c* | `:108-111,190-198` `SUM(ChargedClip.chargedMinutes)` in window | `SUM` 1 d = **93**, 30 d = **1484** | 93 / 1484 | **Y** | — | — |
| 104 | เครดิตใช้ไป / รับ | *n/c* | `:232,249` gross image spend − refunds / `SUM(delta)` where `kind='grant'` | granted 1 d = **106**, 30 d = **1204** | as left | **Y** | — | — |
| 105 | ต้นทุนแยก Provider (tts/image/video/infra) | *n/c* | `:258` `netCogs(…30-day inputs…)`, rates from `SiteConfig cost_*` → **no `cost_*` rows exist on prod**, so `COST_DEFAULTS` apply (`cost-rates.ts:37-47`: ฿0.7/min, infra ฿2,600/mo) | `SELECT key,value FROM SiteConfig WHERE key LIKE 'plan_%_price'` → **no rows** (same for `cost_*`) | TTS COGS ≈ 1484 × 0.7 = **฿1,039** | **Y** (arithmetic) | worth knowing: every "admin-editable" price and cost rate on prod is actually the **hard-coded default** — `plan_pro_price`/`plan_business_price` are absent too, so MRR list price is 599/990 from code | note in C5 |
| 106 | **Daily trend chart (revenue/COGS per day)** | *n/c* | `:60-62` `dateLabel(d) = d.toISOString().slice(0,10)` — **UTC day**, used for both the bucket keys and the loop (`:291-319`) | global constraint: Bangkok days | every bar is a **UTC day**, shifted 7 h from the Bangkok day it is labelled with | **N** | `revenue-growth.ts:82-89` already has a correct `bangkokDate()` helper; `costs/route.ts` does not use it | **C5 — Candidate 4** |
| 107 | trend `revenue` series | *n/c* | `:309,318` `dailyMrr = mrr / 30`, pushed **flat** into every bar | — | a constant line, not daily revenue | **Y** (definition) / label misleading | the chart implies daily revenue vs daily cost; the revenue series is a prorated run-rate that cannot move | note in C5 |
| 108 | topUsers[] (userId, cogs, minutes, images) | *n/c* | `:276-286` | not re-derived (identity) | — | **Y** | **renders raw user ids in an admin payload** — flag for the C-series privacy pass | note |

---

## 5. `/dashboard` — the admin's own account (`cmoycf2v…`)

Shown values from `user-stats.json` (21:09 UTC) and `user-me.json` (21:07 UTC).

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 109 | `/api/user/stats` · plan | BUSINESS | `user/stats/route.ts:39-42` `paidEquivalent` else `classifyEntitlement` | `User.plan` | BUSINESS | **Y** | — | — |
| 110 | **Videos tile (`videoCount`)** | 177 | `user/stats/route.ts:23` `video.count({userId})` | `COUNT(*) FROM Video WHERE userId=…` = **177**; same user's `VideoJob done` = **366**, `RenderJob RENDER DONE` = **289** | 177 | **Y** (number) | same three-definition problem as #6, seen from the customer side: the user ran 366 successful jobs and the dashboard says 177 videos | §3 recommendation |
| 111 | Styles tile (`styleCount`) | 0 | `:21` `style.count({userId})` | `COUNT(*) FROM Style WHERE userId=…` = 0; **`SELECT COUNT(*) FROM Style` = 0 globally** | 0 | **Y** | correct, and permanently 0 for **every** user — the `Style` table has no rows at all | **C5 — Candidate 5** (drop the tile) |
| 112 | contentCount | 0 | `:22` `content.count({userId})` | 0 | 0 | **Y** | dead table (#5) | — |
| 113 | recentVideos / recentContents lengths | 5 / 0 | `:24-35` take 5 | — | — | **Y** | — | — |
| 114 | limits `{styles:null, contents:null, images:null}` | nulls | `:55-57` `isPaid ? nulls : FREE_LIMITS` | — | — | **Y** | — | — |
| 115 | `/api/user/me` · plan / role | BUSINESS / ADMIN | `user/me/route.ts:26-47` | `User.plan`, `User.role` | BUSINESS / ADMIN | **Y** | — | — |
| 116 | **`usageCount` / `usageLimit`** | **0 / 300** | `user/me/route.ts:124-125` ← `syncUsageWindow` ← `User.usageCount` / `usageLimit` | `usageCount=0, usageLimit=300`; but `ChargedClip` rows for this user **since `usagePeriodStartedAt`** (2026-08-18 13:50 Bangkok, 24.6 d ago) = **61** | 0 / 300 | **Y** (field) / **N** (meaning) | `MINUTE_QUOTA` is set on prod, so the **minute** meter is the live gate and nothing increments `usageCount` any more. Across the whole DB only **2 users have `usageCount>0`** while **128 have `minutesUsed>0`**. `/api/user/me` still ships `usageCount/usageLimit` as if they were the meter; the `/dashboard` chip correctly reads `/api/videos/usage` (which surfaces `minutes` when the flag is on, `videos/usage/route.ts:30-47`), but any consumer trusting `user/me` reads a dead counter. | **C5 — Candidate 5** |
| 117 | minute quota (`minutesUsed` / `minutesLimit`) | *not captured* (key cap) | `user/me/route.ts:57-64` `checkMinuteQuota`; chip at `quota-status.tsx:121-129` | `User.minutesUsed = 56.0`, `minutesLimit = 150`; `SUM(ChargedClip.chargedMinutes)` since period start = **54** | 56.0 / 150 | **Y (≈)** | 2-minute gap between the counter and the `ChargedClip` ledger — within the expected drift of AI-audio minutes and refunded reservations, not a defect on its own; worth one confirming query if minutes are ever disputed | note |
| 118 | `usagePeriodStartedAt` / `usageResetAt` | 2026-08-18T06:50:33Z | `:126-127` | `User.usagePeriodStartedAt` = 2026-08-18 13:50 Bangkok, 24.62 d old | — | **Y** | — | — |
| 119 | `cancelAtPeriodEnd` / `cancelAt` / `trialStartedAt` / `trialEndsAt` | false / null / null / null | `:38-41` direct columns | — | — | **Y** | — | — |

---

## 6. ตัวเลขนี้หมายถึงอะไรจริง ๆ — one paragraph per mismatch

**#8, #9 — "สมัครใช้งานวันนี้ 9" / "7 วัน 107".**
ตัวเลขนี้ไม่ได้แปลว่า "วันนี้มีคนสมัคร 9 คน" จริง ๆ มันแปลว่า "นับตั้งแต่ 07:00 น. ตามเวลาไทยของเมื่อวาน มีคนสมัคร 9 คน"
เพราะโปรเซส `ai-content` ไม่ได้ตั้งค่า `TZ` เลย (A1 §A1.7) Node จึงคิดว่าเที่ยงคืนคือเที่ยงคืน UTC = 07:00 น. ไทย
ตอนที่วัด (04:34 น. ไทย) คนที่สมัคร "วันนี้" ตามเวลาไทยจริง ๆ คือ **0 คน** ส่วนช่อง "7 วัน" ยิ่งซ้อนความผิดพลาดสองชั้น:
เลื่อน 7 ชั่วโมง **และ** กินช่วง 8 วันปฏิทิน (ตั้งแต่เที่ยงคืนของวันที่ D−7) ไม่ใช่ 7 วันตามป้าย ค่าจริงตามวันไทยคือ 104 (8 วัน) / 102 (7 วัน)

**#10, #41, #58, #94 — "จ่ายจริง 39".**
ตัวเลขนี้ไม่ได้แปลว่า "มีลูกค้า 39 คนที่จ่ายเงินสดให้เรา" มันแปลว่า "มี 39 คนที่ยังมีสิทธิ์ใช้งานอยู่ และมีแถว `Payment` สถานะ `PAID`
ที่ไม่ใช่แพ็กเครดิตอย่างน้อยหนึ่งแถว — **ไม่ว่ายอดจะเป็นเท่าไหร่ รวมทั้ง ฿0**" ในฐานข้อมูลตอนนี้มี **11 คน** ที่แถว `Payment` ของเขาทั้งหมดเป็น ฿0
(คูปอง/สิทธิ์ที่แอดมินบันทึก) เขาไม่เคยจ่ายเงินสดเลย ตัวเลขที่ถูกคือ **28** ซึ่ง North Star คำนวณไว้ถูกอยู่แล้ว
(`amount > 0 AND periodDays > 0`) และแสดงอยู่บนหน้าเดียวกัน ห่างกันไม่กี่บรรทัด 39 − 11 = 28 พอดี

**#15, #18, #40, #43, #45, #95, #96 — "MRR ฿18,052.50" และทุกอย่างที่คิดต่อจากมัน.**
MRR ตัวนี้ไม่ได้แปลว่า "ทุกเดือนมีเงินเข้า ฿18,052" มันแปลว่า "ผลรวมของราคาที่ลูกค้า *จ่ายจริง* สำหรับคนที่มีข้อมูลราคา
บวกกับ **ราคาป้าย** สำหรับคนที่ไม่มี" และ 11 คนที่จ่าย ฿0 ข้างบนนั้น "ไม่มีข้อมูลราคา" ทุกคน (`monthlyRevenueByUser` เก็บเฉพาะ `amount > 0`)
ระบบจึงตีราคาเขาที่ PRO ป้ายเต็ม: 9 คน × ฿599 + 2 คน × ฿499.17 = **฿6,389.33 ต่อเดือนที่ไม่มีอยู่จริง** คิดเป็น 35 % ของ MRR ทั้งก้อน
และ 66 % ของ "จ่ายล่วงหน้า ฿9,739.50" MRR จากเงินที่เก็บได้จริงคือ **฿11,663.16** (Studio ฿9,865.16 + Bundle ฿1,798)
ตัวเลขนี้ยังไหลต่อเข้า `deferredRevenue`, Gross Margin %, AI Cost %, กำไร/ขาดทุน และ Break-even ทั้งหมด ส่วน **ARR ฿99,756 สะอาด**
เพราะสร้างจาก `recurringMrr` อย่างเดียว ซึ่งทุกคนในนั้นจ่ายเงินจริง

**#31, #53, #106 — "กราฟ MAPC" และ "กราฟรายได้/ต้นทุนรายวัน".**
จุดล่าสุดของกราฟ MAPC ไม่ได้แปลว่า "เมื่อวาน" มันแปลว่า "07:15 น. ของเมื่อวาน" เพราะ cron เขียนไว้ว่า `15 0 * * *` พร้อมคอมเมนต์ว่า
"daily 00:15 Asia/Bangkok" แต่ PM2 ใช้ TZ ของโปรเซสซึ่งเป็น UTC จึงยิงจริงที่ 00:15 UTC = 07:15 น. ไทย ผลคือระหว่างเที่ยงคืนถึง 07:15 น.
กราฟไม่มีจุดของวันนี้เลย และจุดสุดท้าย (21/29/16) ไม่ตรงกับพาดหัวที่อยู่ข้าง ๆ (20/28/15) เพราะวัดคนละเวลา ห่างกัน 21 ชั่วโมง
ส่วนกราฟใน `CostMarginPanel` แย่กว่านั้น: มันแบ่งวันด้วย `toISOString().slice(0,10)` = **วัน UTC** ทั้งที่ระบบมี `bangkokDate()` ที่ถูกต้องอยู่แล้วในไฟล์ข้างเคียง

**#51, #52, #70, #71, #72, #82, #86, #92 — ทุกตัวเลขที่มาจาก telemetry บนหน้า 7 วัน / 30 วัน.**
"Error telemetry 745 ครั้งใน 30 วัน" ไม่ได้แปลว่า 30 วันมี error 745 ครั้ง มันแปลว่า "ใน 20,000 เหตุการณ์ล่าสุด มี error 745 ครั้ง"
ช่วง 30 วันมี telemetry จริง **102,501 แถว** โค้ดดึงมาแค่ 20,000 แถวใหม่สุด = ย้อนถึงแค่ 8 ก.ย. 16:06 น. ไทย (ประมาณ 3 วันครึ่ง)
ของจริงคือ **5,615 ครั้ง** — ต่ำกว่าความจริงราว 7.5 เท่า และที่แย่กว่าคือ query ของ "ช่วงก่อนหน้า" ใช้ `take: 20_000` เหมือนกันแต่
**ไม่มี `orderBy`** SQLite จึงคืนแถว *เก่าสุด* 20,000 แถว ทุกคำว่า "ดีขึ้น/แย่ลงจากช่วงก่อน" บนหน้านี้จึงเทียบของคนละชุดกัน
หน้า 24 ชั่วโมง (5,175 แถว) ยังเชื่อถือได้ ซึ่งบังเอิญเป็นค่า default ของหน้า

**#69, #70, #83, #111 — "Video completed %" และ "Status stuck".**
"Video completed 100 %" ไม่ได้แปลว่าระบบทำงานสมบูรณ์ มันแปลว่า **ตาราง `Video` มีแต่แถว `COMPLETED` เท่านั้น** (ทั้งตาราง 1,585 แถว
ไม่มีสถานะอื่นเลยสักแถว) ตัวเลขนี้จึงเป็นค่าคงที่ 100 % ตลอดกาล ไม่ใช่ตัววัด เช่นเดียวกับ "Status stuck = 0" ที่เป็น 0 โดยโครงสร้าง
ไม่ใช่เพราะไม่มีงานค้าง ผลกระทบต่อเนื่อง: Health Score มีโทษ 3 ใน 6 ข้อที่ตายสนิท (35 คะแนนจาก 100 ไม่มีทางหักได้)
และ tile "Styles" บน `/dashboard` ก็เป็น 0 ตลอดเพราะตาราง `Style` ไม่มีข้อมูลเลยทั้งระบบ

**#76 — "งานทั้งหมด 1,704 · done 1,395 · ล้มเหลว 254".**
1,395 + 254 + 0 + 0 = 1,649 ไม่ใช่ 1,704 ส่วนที่หายไปคือ **งาน 55 ชิ้นที่สถานะ `canceled`** ซึ่ง `jobOutcomes` ไม่มีช่องให้เลย
คนอ่านจะสรุปเองว่า "มี 55 งานที่ระบบไม่รู้ว่าเกิดอะไรขึ้น" ทั้งที่จริงมันคืองานที่ผู้ใช้กดยกเลิก

**#79, #80 — funnel "ได้ B-roll 1,462".**
ตัวเลขนี้รวมงาน 2 ประเภทที่เดินคนละเส้นทาง: `create` 1,142 งาน (หา B-roll จริง) กับ `export` 561 งาน (เอา timeline เดิมไป burn ไม่เคยแตะ B-roll)
งาน export 521 ชิ้นที่ progress เกิน 55 ถูกนับเป็น "ได้ B-roll" ทั้งที่ไม่เคยหา อัตราแปลงจริงของเส้นทางสร้างคือ **941/1,142 = 82 %**
ไม่ใช่ 86 % ที่หน้าจอแสดง

**#84 — "fail ได้ N งาน" กับปุ่มที่กด.**
ตัวเลข "fail ได้" คำนวณที่เกณฑ์ **3 ชั่วโมง** (`failAfterHours: 3`) แต่ปุ่มข้างล่างส่ง **24 ชั่วโมง** ไปที่ API
ตัวเลขที่เห็นกับประชากรที่ปุ่มจะไปแตะจึงเป็นคนละชุดกัน

**#101 — "Render Web / MCP".**
ตัวเลขนี้นับ `RenderJob` ที่ `status='DONE'` ทุกชนิด **รวม `BURN`** จึงได้ 52/2,085 ขณะที่แผง "Render (จาก RenderJob)" บนหน้าเดียวกัน
กรอง `type='RENDER'` ได้ 37/1,209 ต่างกัน 1.7 เท่าบนหน้าจอเดียว

**#102 — "ครีเอเตอร์ active 39 คน".**
ไม่ได้แปลว่ามีคนสร้างงาน 39 คน แปลว่า "มี 39 user id ที่ยิง telemetry อะไรก็ได้เข้ามา" — เปิดหน้าเว็บเฉย ๆ ก็นับ
คำว่า *creator* ใน CONTEXT.md สงวนไว้สำหรับคนที่ทำ **Core Creation Outcome** สำเร็จ ซึ่งใน 30 วันคือ **92 คน** (แถว #62)
การใช้คำเดียวกันกับตัวหารของ North Star ทำให้สองตัวเลขนี้ชนกันโดยไม่จำเป็น

**#97 — "รายการรับเงินใน Studio ฿30,447" vs "รายได้รวมสะสม".**
สองตัวเลขในแผงเดียวกันมาจากคนละแหล่ง: ตัวแรกมาจากตาราง `Payment` (บัญชีของเราเอง รวมแถว ฿0 จำนวน 15 แถวในช่วง 30 วัน)
ตัวหลังมาจาก Stripe (เงินที่เข้าจริง หักคืนเงินแล้ว) ตาม `revenue-cash.ts` ซึ่งเป็นแหล่งที่ถูก ส่วน `Payment.amount` ไม่ใช่ความจริงเรื่องเงิน
(บทเรียน 2026-08-27: ตัวเลขรายได้เคยเกินจริงสามทางเพราะเชื่อตารางนี้) ตัวเลข "รายการรับเงิน 23 รายการ" กับ "ลูกค้าใหม่ 28 คน"
บน `/admin/revenue` ก็ขัดกันเองด้วยเหตุผลเดียวกัน — 34 คนออกใบเสร็จได้แค่ 23 รายการไม่ได้ เว้นแต่บางใบเป็น ฿0 ซึ่งก็เป็นอย่างนั้นจริง ๆ

**#98 — เกณฑ์ "รายปี" สองค่า.**
`revenue-cohorts.ts` ใช้ `periodDays >= 300` ส่วน `costs/route.ts` ใช้ `>= 365` มีแถว `Payment` 1 แถวที่อยู่ระหว่างกลาง
มันจึงเป็น "รายปี" ตอนคิด MRR และ "รายเดือน" ตอนแยกยอดเงินสด

**#116 — "usageCount 0 / usageLimit 300".**
ไม่ได้แปลว่าเจ้าของบัญชียังไม่ได้ใช้อะไรเลย เจ้าของบัญชีสร้างคลิปที่คิดเงินไป **61 คลิป** ในรอบบิลปัจจุบัน
แต่ระบบเปลี่ยนไปวัดเป็น **นาที** (`MINUTE_QUOTA`) แล้ว ตัวนับคลิปจึงหยุดเดินถาวร — ทั้งฐานข้อมูลมีแค่ **2 คน** ที่ `usageCount > 0`
ขณะที่ **128 คน** มี `minutesUsed > 0` `/api/user/me` ยังส่งสองฟิลด์นี้ออกมาเหมือนเป็นมิเตอร์จริงอยู่

---

## 7. What `วิดีโอที่สร้าง` should mean (mandated check)

Three tables answer "a video was created" and they differ by **2.2×**:

| source | all-time | what it actually counts |
|---|---:|---|
| `Video` rows (what `/admin` shows today) | **1,585** | one row per **delivered gallery asset**. Every row is `COMPLETED` with an output URL; failures and cancellations never appear. |
| `RenderJob type='RENDER' status='DONE'` | **2,758** | one row per **successful base render**, including re-renders of the same clip (avatar re-composite, timeline edit, free re-render). Excludes the 1,939 `BURN` jobs. |
| `VideoJob status='done'` | **3,406** | one row per **successful orchestrated job**, and it mixes `create` (1,142 in 30 d) with `export` (561 in 30 d) — a clip that is created once and exported twice counts three times. |

**Recommendation:** `วิดีโอที่สร้าง` on `/admin` should stay **`Video` rows** — it is the only one of the three
that answers "how many finished videos do our customers have", it is the unit the customer sees in their
gallery, and it never double-counts a re-render. But it must be relabelled and split, because as it stands
it is silently a *success-only* count sitting next to failure counts that use a different denominator:

- keep **`Video` rows** as **"คลิปที่ส่งมอบ"** (delivered clips) — the outcome number;
- add **`VideoJob` `type='create'`** as **"งานสร้าง"** with its own done/failed/canceled split — the effort
  number, and the one the funnel and `jobOutcomes` should both be built on (they already are);
- keep **`RenderJob`** in the dev drawer only — it is an infrastructure counter, not a product one.

The same three-way split explains #110: the admin's own dashboard says 177 videos while that account ran
366 successful jobs. Neither number is wrong; they answer different questions and only one is labelled.

---

## 8. MAPC vs the CONTEXT.md definition (mandated check)

CONTEXT.md:202 — *"unique customers with an **active recurring monthly or annual paid entitlement** who
complete at least one Core Creation Outcome within the trailing 30 days."*

| | CONTEXT.md | as implemented | measured |
|---|---|---|---|
| denominator | active **recurring** paid entitlement | `activePayingBillingCohort` (`subscription-north-star.server.ts:111-146`) — accepts a live Stripe sub **or** a still-valid prepaid term **or** `planExpiresAt IS NULL AND stripeSubscriptionId IS NULL` | **28** (of which 13 are prepaid one-time terms, 0 via the no-expiry branch) |
| the literal CONTEXT.md denominator | — | `recurringBillingCohort` (`:68-104`) exists and is already computed | **15** |
| numerator (Core Creation Outcome) | completed video · saved-or-Editor-bound Hero Script · usable Hero AI Image | `:221-244` — `Video COMPLETED` with a URL and **`updatedAt >= since`**; **any** `Script` row `createdAt >= since`; `AiGenerationJob` image completed+settled+URL on `hero_video`/`automix`/`scene_reroll` | **20** (video 18 · script 11 · image 19) |
| exclusions | Trials, coupons, Administrator Grants | enforced — `amount > 0 AND periodDays > 0 AND note<>'credits' AND plan IN (PRO,BUSINESS)`; plus suspended, ADMIN, `duckyhero@`, `aoacademy.co` | ✓ |

**Verdict: the shipped number (20) is arithmetically exact — my independent replay returns 20/28/15/7/13
identically — but the denominator is broader than CONTEXT.md's wording.** The code makes a deliberate,
documented product argument for it (`:106-110`: "a customer who paid for an annual term up front is still a
paying customer for the life of that term"), and I think that argument is right. The defect is that
**CONTEXT.md and the code disagree in writing**, and the two numbers (28 and 15) both render on the same
page with different labels. Two smaller numerator gaps:

- **`Script`**: CONTEXT.md says "**saved or Editor-bound** Hero Script"; the query counts every `Script`
  row created in the window, including the 25 still at `status='draft'`. A draft is not a saved outcome.
- **`Video.updatedAt`**: the window test is on `updatedAt`, not on when the video completed. Any later
  touch of an old row (a thumbnail edit, a reconcile) pulls a months-old video into the trailing 30 days.

**Recommendation for C5:** do not change the shipped MAPC denominator. Instead (a) reconcile CONTEXT.md:202
to say "active paid entitlement (recurring **or** a prepaid term still running)" and name
`activeRecurringPayers` as the separate recurring-only figure, and (b) tighten the numerator to
`Script.status='sent' OR editorProjectId IS NOT NULL` and to a completion timestamp rather than `updatedAt`.

**`NorthStarDailySnapshot` freshness:** 30 rows, 2026-08-13 → 2026-09-11, **no gaps**. The table is healthy.
The problem is *when* it is written (07:15 Bangkok, not the documented 00:15) — see #31.

---

## 9. Candidate C5 fixes, ranked by user impact

The session picks ≤ 6 at Gate A.

1. **`จ่ายจริง` must mean cash.** Make `revenue-cohorts.ts` require `amount > 0` for `cashPaid` (the North
   Star already does, `subscription-north-star.server.ts:116-121`), so `payingTotal` becomes 28 and stops
   contradicting the North Star on the same page. Rows #10, #41, #58, #94. *Impact: the single number Mew
   quotes for "how many customers do we have" is 39 % too high.* Verify script: feed one PRO user whose
   only `Payment` is ฿0 and assert `payingTotal` excludes them.
2. **MRR must never fall back to the list price.** In `computeRevenueCohorts:364-367`, a payer with no
   `monthlyRevenueByUser` entry should contribute **0**, not `monthlyEquiv(listPrice)` (and once fix 1
   lands, no such payer exists). Removes ฿6,389.33/month of fiction from MRR, `prepaidMrr`,
   `deferredRevenue`, Gross Margin %, AI Cost %, profit and break-even. Rows #15, #18, #40, #43, #45, #95,
   #96. *Impact: every financial number except ARR and the Stripe cash figures.*
3. **One money source per surface.** `/admin/revenue` is already Stripe-truth; make `CostMarginPanel`'s
   "รายการรับเงินใน Studio" either read the same Stripe path or be labelled explicitly as the internal
   ledger, and stop counting ฿0 `Payment` rows into `newPayers`/`repeatPayers` so "23 รายการ / 34 คน"
   stops contradicting itself. Rows #37, #38, #97. *Impact: ADR 0062's "money renders in one place" is
   unenforceable while two sources ship side by side.*
4. **Fix the day boundary everywhere at once.** (a) `/api/admin/stats` `newToday`/`newThisWeek` → Bangkok
   days and a true 7-day window; (b) `costs/route.ts:60-62` `dateLabel` → the existing
   `bangkokDate()` helper; (c) set `TZ=Asia/Bangkok` on the `ai-content` **and cron** PM2 apps, or change
   `cron_restart` to `15 17 * * *` so the North Star snapshot really lands at 00:15 Bangkok and its
   comment stops lying. Rows #8, #9, #31, #53, #106. *Impact: three surfaces currently label UTC days with
   Bangkok dates; this is also the constraint the whole plan is built on.*
5. **Stop shipping sampled and structurally-dead numbers as facts.** (a) Replace `take: 20_000` in
   `insights/route.ts:842-858` with server-side aggregation (or at minimum add the missing `orderBy` on
   the previous window and surface a `truncated: true` flag the UI renders); (b) repoint the "Video
   completed" tile and the Health Score's video terms at `VideoJob`, since `Video` is 100 % `COMPLETED` by
   construction; (c) add `canceled` to `jobOutcomes` so the 55 missing jobs are accounted for; (d) drop
   the dead `เนื้อหาทั้งหมด` card, the dead `Styles` tile, and `usageCount`/`usageLimit` from
   `/api/user/me`. Rows #5, #51, #52, #69–#72, #76, #82–#83, #86, #92, #111, #116. *Impact: the largest
   count of wrong numbers, though each is individually less costly than 1–3.*
6. **One definition per concept.** Three "internal team" rules (#55), two annual thresholds — 300 vs 365
   days (#98), two `failAfterHours` — 3 vs 24 (#84), two render counters — with and without the `type`
   filter (#101), a funnel that mixes `create` and `export` jobs (#79), and "creator" meaning "emitted a
   telemetry event" (#102). Each is a one-line fix; together they are why two tiles on one screen
   disagree. *Impact: low per item, high for trust.*

---

## 10. Commands run on production (A4)

Every command below was run over `ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230`, read-only.
SQL was delivered as a heredoc to `sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro"`.
No writes, no `VACUUM`, no write `PRAGMA`, no pm2 mutation, no `.env` values read, no DB copied off the box.

```
# Q0 — table inventory
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" ".tables"

# Q1 — /api/admin/stats basic counts + Bangkok vs server-TZ day boundary
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
SELECT "now_utc", datetime("now");
SELECT "now_bkk", datetime("now","+7 hours");
SELECT "totalUsers", COUNT(*) FROM User;
SELECT "paidUsers", COUNT(*) FROM User WHERE plan IN ("PRO","BUSINESS");
SELECT "suspendedUsers", COUNT(*) FROM User WHERE suspended=1;
SELECT "totalContents", COUNT(*) FROM Content;
SELECT "totalVideos_Video_rows", COUNT(*) FROM Video;
SELECT "totalImages_GeneratedImage", COUNT(*) FROM GeneratedImage;
SELECT "newToday_serverUTCmidnight", COUNT(*) FROM User WHERE createdAt >= strftime("%s", date("now"))*1000;
SELECT "newToday_bangkokday", COUNT(*) FROM User WHERE date(createdAt/1000,"unixepoch","+7 hours") = date("now","+7 hours");
SELECT "newThisWeek_serverUTC_from_D-7_midnight", COUNT(*) FROM User WHERE createdAt >= strftime("%s", date("now","-7 days"))*1000;
SELECT "newThisWeek_bangkok_8calendardays", COUNT(*) FROM User WHERE date(createdAt/1000,"unixepoch","+7 hours") >= date("now","+7 hours","-7 days");
SELECT "newThisWeek_bangkok_7calendardays", COUNT(*) FROM User WHERE date(createdAt/1000,"unixepoch","+7 hours") > date("now","+7 hours","-7 days");
SELECT "signup_by_bkk_day", date(createdAt/1000,"unixepoch","+7 hours"), COUNT(*) FROM User WHERE createdAt >= strftime("%s","now","-10 days")*1000 GROUP BY 2 ORDER BY 2;
SELECT "signups_in_bkk_0000_to_0700_today", COUNT(*) FROM User WHERE date(createdAt/1000,"unixepoch","+7 hours") = date("now","+7 hours") AND CAST(strftime("%H", createdAt/1000,"unixepoch","+7 hours") AS INT) < 7;
SQL

# Q2 — MAPC / North Star full replay (activePayingBillingCohort + recurringBillingCohort + outcomes)
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms),
s AS (SELECT (SELECT ms FROM n) - 30*86400000 AS since),
u AS (
 SELECT id, plan, billingPeriod, bundleBillingPeriod,
  (role = "ADMIN" OR lower(trim(email)) = "<owner-email>" OR lower(substr(email, instr(email,"@")+1)) = "aoacademy.co") AS internal,
  suspended,
  EXISTS(SELECT 1 FROM Payment p WHERE p.userId=User.id AND p.status="PAID" AND p.amount>0 AND p.periodDays>0 AND IFNULL(p.note,"")<>"credits" AND p.plan IN ("PRO","BUSINESS")) AS hasPlanCash,
  (planExpiresAt IS NOT NULL AND planExpiresAt > (SELECT ms FROM n)) AS planLive,
  (stripeSubscriptionId IS NOT NULL AND IFNULL(subStatus,"")="active") AS subLive,
  (planExpiresAt IS NULL AND stripeSubscriptionId IS NULL) AS noExpiryNoSub,
  (bundleSubscriptionId IS NOT NULL AND IFNULL(bundleStatus,"")="ACTIVE" AND bundleAccessExpiresAt IS NOT NULL AND bundleAccessExpiresAt > (SELECT ms FROM n) AND IFNULL(bundleAmountThb,0)>0) AS bundleLive
 FROM User
),
c AS (
 SELECT u.*, (u.hasPlanCash AND u.plan IN ("PRO","BUSINESS") AND (u.planLive OR u.subLive OR u.noExpiryNoSub)) AS directAccess
 FROM u WHERE u.suspended=0 AND u.internal=0
),
payers AS (SELECT c.*, (c.directAccess OR c.bundleLive) AS isPayer, (c.hasPlanCash AND c.subLive AND c.planLive) AS directRecurring FROM c),
p2 AS (SELECT * FROM payers WHERE isPayer=1),
outcome AS (
 SELECT p2.id,
  EXISTS(SELECT 1 FROM Video v WHERE v.userId=p2.id AND v.status="COMPLETED" AND v.updatedAt >= (SELECT since FROM s) AND (TRIM(IFNULL(v.videoUrl,""))<>"" OR TRIM(IFNULL(v.avatarVideoUrl,""))<>"")) AS vid,
  EXISTS(SELECT 1 FROM Script sc WHERE sc.userId=p2.id AND sc.createdAt >= (SELECT since FROM s)) AS scr,
  EXISTS(SELECT 1 FROM AiGenerationJob a WHERE a.userId=p2.id AND a.kind="image" AND a.status="completed" AND a.chargeState="settled" AND TRIM(IFNULL(a.outputUrl,""))<>"" AND a.productSurface IN ("hero_video","automix","scene_reroll") AND (a.finishedAt >= (SELECT since FROM s) OR (a.finishedAt IS NULL AND a.updatedAt >= (SELECT since FROM s)))) AS img,
  CASE WHEN ((CASE WHEN p2.directAccess AND p2.billingPeriod IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN p2.bundleLive AND p2.bundleBillingPeriod IS NOT NULL THEN 1 ELSE 0 END)) > 0
    AND (CASE WHEN p2.directAccess AND p2.billingPeriod IS NOT NULL AND p2.billingPeriod<>"annual" THEN 1 ELSE 0 END) = 0
    AND (CASE WHEN p2.bundleLive AND p2.bundleBillingPeriod IS NOT NULL AND p2.bundleBillingPeriod<>"annual" THEN 1 ELSE 0 END) = 0
   THEN "annual" ELSE "monthly" END AS cohort
 FROM p2
)
SELECT "activePayingCustomers", COUNT(*) FROM p2
UNION ALL SELECT "activeRecurringPayers", (SELECT COUNT(*) FROM payers WHERE directRecurring=1 OR bundleLive=1)
UNION ALL SELECT "activeCreators_MAPC", (SELECT COUNT(*) FROM outcome WHERE vid OR scr OR img)
UNION ALL SELECT "videoCreators", (SELECT COUNT(*) FROM outcome WHERE vid)
UNION ALL SELECT "scriptCreators", (SELECT COUNT(*) FROM outcome WHERE scr)
UNION ALL SELECT "imageCreators", (SELECT COUNT(*) FROM outcome WHERE img)
UNION ALL SELECT "monthlyCreators", (SELECT COUNT(*) FROM outcome WHERE (vid OR scr OR img) AND cohort="monthly")
UNION ALL SELECT "annualCreators", (SELECT COUNT(*) FROM outcome WHERE (vid OR scr OR img) AND cohort="annual")
UNION ALL SELECT "payers_directAccess_only", (SELECT COUNT(*) FROM p2 WHERE directAccess=1 AND bundleLive=0)
UNION ALL SELECT "payers_bundle_only", (SELECT COUNT(*) FROM p2 WHERE directAccess=0 AND bundleLive=1)
UNION ALL SELECT "payers_via_noExpiryNoSub_branch", (SELECT COUNT(*) FROM p2 WHERE directAccess=1 AND planLive=0 AND subLive=0 AND noExpiryNoSub=1)
UNION ALL SELECT "payers_prepaid_planLive_not_sub", (SELECT COUNT(*) FROM p2 WHERE directAccess=1 AND planLive=1 AND subLive=0);
SQL

# Q3 — NorthStarDailySnapshot freshness + the three "videos created" definitions
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
SELECT "snapshot_rows", COUNT(*) FROM NorthStarDailySnapshot;
SELECT "snapshot_latest", snapshotDate, datetime(asOf/1000,"unixepoch","+7 hours"), activeCreators, activePayingCustomers, activeRecurringPayers FROM NorthStarDailySnapshot ORDER BY snapshotDate DESC LIMIT 6;
SELECT "snapshot_oldest", MIN(snapshotDate) FROM NorthStarDailySnapshot;
SELECT "snapshot_expected_bkk_today", date("now","+7 hours");
SELECT "snapshot_missing_days_last31", (SELECT COUNT(*) FROM NorthStarDailySnapshot WHERE snapshotDate >= date("now","+7 hours","-30 days"));
SELECT "Video_rows_all", COUNT(*) FROM Video;
SELECT "Video_COMPLETED", COUNT(*) FROM Video WHERE status="COMPLETED";
SELECT "Video_by_status", status, COUNT(*) FROM Video GROUP BY status;
SELECT "Video_with_output", COUNT(*) FROM Video WHERE TRIM(IFNULL(videoUrl,""))<>"" OR TRIM(IFNULL(avatarVideoUrl,""))<>"";
SELECT "RenderJob_RENDER_DONE_all", COUNT(*) FROM RenderJob WHERE type="RENDER" AND status="DONE";
SELECT "RenderJob_BURN_DONE_all", COUNT(*) FROM RenderJob WHERE type="BURN" AND status="DONE";
SELECT "VideoJob_done_all", COUNT(*) FROM VideoJob WHERE status="done";
SELECT "VideoJob_rows_all", COUNT(*) FROM VideoJob;
SELECT "Video_distinct_videoUrl", COUNT(DISTINCT videoUrl) FROM Video WHERE videoUrl IS NOT NULL;
SQL

# Q4 — revenue cohorts replay (classifyEntitlement, combined + direct-only)
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms),
b AS (
 SELECT id, plan, subStatus, billingPeriod, planExpiresAt, trialEndsAt, stripeSubscriptionId,
  bundleStatus, bundleAccessExpiresAt, bundlePrimary, bundleAmountThb,
  EXISTS(SELECT 1 FROM Payment p WHERE p.userId=User.id AND p.status="PAID" AND IFNULL(p.note,"")<>"credits") AS cashPaid,
  CASE WHEN bundlePrimary=1 AND planExpiresAt IS NULL AND IFNULL(subStatus,"")<>"active" THEN "FREE" ELSE plan END AS directPlan
 FROM User
),
cl AS (
 SELECT b.*,
  CASE
   WHEN IFNULL(bundleStatus,"")="ACTIVE" AND bundleAccessExpiresAt IS NOT NULL AND bundleAccessExpiresAt > (SELECT ms FROM n) THEN "BUNDLE"
   WHEN plan NOT IN ("PRO","BUSINESS") THEN "FREE"
   WHEN IFNULL(subStatus,"")="active" THEN "SUBSCRIPTION"
   WHEN trialEndsAt IS NOT NULL AND trialEndsAt <= (SELECT ms FROM n) THEN "EXPIRED_TRIAL"
   WHEN trialEndsAt IS NOT NULL THEN "TRIAL"
   WHEN planExpiresAt IS NOT NULL AND planExpiresAt <= (SELECT ms FROM n) THEN "EXPIRED_PLAN"
   WHEN planExpiresAt IS NOT NULL THEN "TIMED_PLAN"
   WHEN bundlePrimary=1 AND bundleAccessExpiresAt IS NOT NULL AND bundleAccessExpiresAt <= (SELECT ms FROM n) THEN "EXPIRED_BUNDLE"
   ELSE "PERMANENT_OR_MANUAL" END AS src,
  CASE
   WHEN directPlan NOT IN ("PRO","BUSINESS") THEN "FREE"
   WHEN IFNULL(subStatus,"")="active" THEN "SUBSCRIPTION"
   WHEN trialEndsAt IS NOT NULL AND trialEndsAt <= (SELECT ms FROM n) THEN "EXPIRED_TRIAL"
   WHEN trialEndsAt IS NOT NULL THEN "TRIAL"
   WHEN planExpiresAt IS NOT NULL AND planExpiresAt <= (SELECT ms FROM n) THEN "EXPIRED_PLAN"
   WHEN planExpiresAt IS NOT NULL THEN "TIMED_PLAN"
   ELSE "PERMANENT_OR_MANUAL" END AS dsrc,
  (IFNULL(bundleStatus,"")="ACTIVE" AND bundleAccessExpiresAt IS NOT NULL AND bundleAccessExpiresAt > (SELECT ms FROM n) AND IFNULL(bundleAmountThb,0) > 0) AS bundleBacked
 FROM b
),
f AS (SELECT cl.*, (dsrc IN ("SUBSCRIPTION","TIMED_PLAN","PERMANENT_OR_MANUAL") AND cashPaid) AS directBacked FROM cl)
SELECT "payingTotal", COUNT(*) FROM f WHERE directBacked OR bundleBacked
UNION ALL SELECT "directPayingTotal", (SELECT COUNT(*) FROM f WHERE directBacked)
UNION ALL SELECT "bundleActive", (SELECT COUNT(*) FROM f WHERE bundleBacked)
UNION ALL SELECT "compedPaid", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND src IN ("SUBSCRIPTION","BUNDLE","TIMED_PLAN","PERMANENT_OR_MANUAL"))
UNION ALL SELECT "trialActive", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND src NOT IN ("SUBSCRIPTION","BUNDLE","TIMED_PLAN","PERMANENT_OR_MANUAL") AND src="TRIAL")
UNION ALL SELECT "expiredTrial", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND src="EXPIRED_TRIAL")
UNION ALL SELECT "expiredPlan", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND src="EXPIRED_PLAN")
UNION ALL SELECT "expiredBundle", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND src="EXPIRED_BUNDLE")
UNION ALL SELECT "free", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND src="FREE" AND NOT cashPaid AND IFNULL(bundleAmountThb,0)<=0)
UNION ALL SELECT "lapsedPayers", (SELECT COUNT(*) FROM f WHERE NOT(directBacked OR bundleBacked) AND ((src="EXPIRED_TRIAL" AND cashPaid) OR (src="EXPIRED_PLAN" AND cashPaid) OR (src="EXPIRED_BUNDLE") OR (src="FREE" AND (cashPaid OR IFNULL(bundleAmountThb,0)>0))))
UNION ALL SELECT "payingCanceling", (SELECT COUNT(*) FROM f WHERE directBacked AND IFNULL(subStatus,"")="canceled")
UNION ALL SELECT "paidPlanUsers_PRO_BUSINESS", (SELECT COUNT(*) FROM User WHERE plan IN ("PRO","BUSINESS"))
UNION ALL SELECT "cashPaidUsers_anyPlanPayment", (SELECT COUNT(*) FROM f WHERE cashPaid)
UNION ALL SELECT "creditBuyers", (SELECT COUNT(DISTINCT userId) FROM Payment WHERE status="PAID" AND IFNULL(note,"")="credits")
UNION ALL SELECT "creditRevenue_baht", (SELECT IFNULL(SUM(MAX(amount,0)),0)/100.0 FROM Payment WHERE status="PAID" AND IFNULL(note,"")="credits");
SQL

# Q5 — insights window metrics: activation, jobOutcomes, job funnel, renderStats, staleProcessing
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms, strftime("%s","now")*1000 - 30*86400000 AS since),
intu AS (SELECT id FROM User WHERE lower(IFNULL(email,"")) LIKE "%@aoacademy%"),
j AS (SELECT * FROM VideoJob WHERE createdAt >= (SELECT since FROM n) AND userId NOT IN (SELECT id FROM intu))
SELECT "internalTeam_aoacademy_substring", (SELECT COUNT(*) FROM intu)
UNION ALL SELECT "activation_signups_expected", (SELECT COUNT(*) FROM User) - (SELECT COUNT(*) FROM intu)
UNION ALL SELECT "hasGeminiKey", (SELECT COUNT(*) FROM User WHERE TRIM(IFNULL(geminiKey,""))<>"")
UNION ALL SELECT "hasStockKey", (SELECT COUNT(*) FROM User WHERE TRIM(IFNULL(pexelsKey,""))<>"" OR TRIM(IFNULL(pixabayKey,""))<>"")
UNION ALL SELECT "jobOutcomes_total_30d_nonInternal", (SELECT COUNT(*) FROM j)
UNION ALL SELECT "jobOutcomes_done", (SELECT COUNT(*) FROM j WHERE status="done")
UNION ALL SELECT "jobOutcomes_failed", (SELECT COUNT(*) FROM j WHERE status="failed")
UNION ALL SELECT "jobOutcomes_processing_or_waiting", (SELECT COUNT(*) FROM j WHERE status IN ("processing","waiting_provider"))
UNION ALL SELECT "jobOutcomes_queued", (SELECT COUNT(*) FROM j WHERE status="queued")
UNION ALL SELECT "jobOutcomes_canceled_status", (SELECT COUNT(*) FROM j WHERE status="canceled")
UNION ALL SELECT "funnel_created", (SELECT COUNT(*) FROM j)
UNION ALL SELECT "funnel_broll_p55", (SELECT COUNT(*) FROM j WHERE progress >= 55)
UNION ALL SELECT "funnel_config_p65", (SELECT COUNT(*) FROM j WHERE progress >= 65)
UNION ALL SELECT "funnel_render_p75", (SELECT COUNT(*) FROM j WHERE progress >= 75)
UNION ALL SELECT "funnel_done", (SELECT COUNT(*) FROM j WHERE status="done")
UNION ALL SELECT "failed_with_done_progress_100", (SELECT COUNT(*) FROM j WHERE status="failed" AND progress >= 75)
UNION ALL SELECT "renderJob_30d_RENDER_total", (SELECT COUNT(*) FROM RenderJob WHERE createdAt >= (SELECT since FROM n) AND type="RENDER")
UNION ALL SELECT "renderJob_30d_RENDER_done", (SELECT COUNT(*) FROM RenderJob WHERE createdAt >= (SELECT since FROM n) AND type="RENDER" AND status="DONE")
UNION ALL SELECT "renderJob_30d_RENDER_failed", (SELECT COUNT(*) FROM RenderJob WHERE createdAt >= (SELECT since FROM n) AND type="RENDER" AND status="FAILED")
UNION ALL SELECT "renderJob_30d_RENDER_web_noParent", (SELECT COUNT(*) FROM RenderJob WHERE createdAt >= (SELECT since FROM n) AND type="RENDER" AND parentJobId IS NULL)
UNION ALL SELECT "renderJob_30d_RENDER_mcp_parent", (SELECT COUNT(*) FROM RenderJob WHERE createdAt >= (SELECT since FROM n) AND type="RENDER" AND parentJobId IS NOT NULL)
UNION ALL SELECT "renderJob_30d_BURN_total", (SELECT COUNT(*) FROM RenderJob WHERE createdAt >= (SELECT since FROM n) AND type="BURN")
UNION ALL SELECT "video_PROCESSING_older20min", (SELECT COUNT(*) FROM Video WHERE status="PROCESSING" AND createdAt <= (SELECT ms FROM n) - 20*60000)
UNION ALL SELECT "video_30d_rows", (SELECT COUNT(*) FROM Video WHERE createdAt >= (SELECT since FROM n))
UNION ALL SELECT "video_30d_completed", (SELECT COUNT(*) FROM Video WHERE createdAt >= (SELECT since FROM n) AND status="COMPLETED")
UNION ALL SELECT "videoJob_creators_distinct_alltime", (SELECT COUNT(DISTINCT userId) FROM VideoJob)
UNION ALL SELECT "video_completed_creators_distinct_alltime", (SELECT COUNT(DISTINCT userId) FROM Video WHERE status="COMPLETED")
UNION ALL SELECT "editor_opened_distinct_users", (SELECT COUNT(DISTINCT userId) FROM TelemetryEvent WHERE name="editor_opened" AND userId IS NOT NULL);
SQL

# Q6 — MRR components: actual-paid vs list-price fallback
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
SELECT "siteconfig_plan_price", key, value FROM SiteConfig WHERE key LIKE "plan_%_price";
WITH n AS (SELECT strftime("%s","now")*1000 AS ms),
b AS (
 SELECT id, plan, subStatus, billingPeriod, planExpiresAt, trialEndsAt, stripeSubscriptionId,
  bundleStatus, bundleAccessExpiresAt, bundlePrimary, bundleAmountThb, bundleBillingPeriod,
  EXISTS(SELECT 1 FROM Payment p WHERE p.userId=User.id AND p.status="PAID" AND IFNULL(p.note,"")<>"credits") AS cashPaid,
  CASE WHEN bundlePrimary=1 AND planExpiresAt IS NULL AND IFNULL(subStatus,"")<>"active" THEN "FREE" ELSE plan END AS directPlan
 FROM User),
cl AS (SELECT b.*,
  CASE WHEN directPlan NOT IN ("PRO","BUSINESS") THEN "FREE"
   WHEN IFNULL(subStatus,"")="active" THEN "SUBSCRIPTION"
   WHEN trialEndsAt IS NOT NULL AND trialEndsAt <= (SELECT ms FROM n) THEN "EXPIRED_TRIAL"
   WHEN trialEndsAt IS NOT NULL THEN "TRIAL"
   WHEN planExpiresAt IS NOT NULL AND planExpiresAt <= (SELECT ms FROM n) THEN "EXPIRED_PLAN"
   WHEN planExpiresAt IS NOT NULL THEN "TIMED_PLAN"
   ELSE "PERMANENT_OR_MANUAL" END AS dsrc FROM b),
d AS (SELECT * FROM cl WHERE dsrc IN ("SUBSCRIPTION","TIMED_PLAN","PERMANENT_OR_MANUAL") AND cashPaid),
newest AS (
 SELECT p.userId, CASE WHEN p.periodDays >= 300 THEN (p.amount/100.0)/12.0 ELSE (p.amount/100.0) END AS monthly
 FROM Payment p
 JOIN (SELECT userId, MAX(createdAt) AS mc FROM Payment WHERE status="PAID" AND IFNULL(note,"")<>"credits" AND amount>0 GROUP BY userId) m
   ON m.userId=p.userId AND m.mc=p.createdAt
 WHERE p.status="PAID" AND IFNULL(note,"")<>"credits" AND p.amount>0)
SELECT "directMrr_from_actual_paid", ROUND(SUM(COALESCE((SELECT monthly FROM newest WHERE newest.userId=d.id), 0)),2) FROM d
UNION ALL SELECT "directPayers_without_actualPaid_row", (SELECT COUNT(*) FROM d WHERE (SELECT monthly FROM newest WHERE newest.userId=d.id) IS NULL)
UNION ALL SELECT "recurringMrr_subscription_only", (SELECT ROUND(SUM(COALESCE((SELECT monthly FROM newest WHERE newest.userId=d.id),0)),2) FROM d WHERE dsrc="SUBSCRIPTION" AND stripeSubscriptionId IS NOT NULL AND IFNULL(subStatus,"")="active")
UNION ALL SELECT "prepaidMrr_rest", (SELECT ROUND(SUM(COALESCE((SELECT monthly FROM newest WHERE newest.userId=d.id),0)),2) FROM d WHERE NOT(dsrc="SUBSCRIPTION" AND stripeSubscriptionId IS NOT NULL AND IFNULL(subStatus,"")="active"))
UNION ALL SELECT "bundleMrr", (SELECT ROUND(SUM(CASE WHEN IFNULL(bundleBillingPeriod,"")="annual" THEN IFNULL(bundleAmountThb,0)/12.0 ELSE IFNULL(bundleAmountThb,0) END),2) FROM cl WHERE IFNULL(bundleStatus,"")="ACTIVE" AND bundleAccessExpiresAt > (SELECT ms FROM n) AND IFNULL(bundleAmountThb,0)>0);
SQL

# Q7 — the 11 zero-baht "payers" and their list-price MRR contribution
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms),
b AS (SELECT id, plan, subStatus, billingPeriod, planExpiresAt, trialEndsAt, stripeSubscriptionId, bundlePrimary,
  EXISTS(SELECT 1 FROM Payment p WHERE p.userId=User.id AND p.status="PAID" AND IFNULL(p.note,"")<>"credits") AS cashPaid,
  EXISTS(SELECT 1 FROM Payment p WHERE p.userId=User.id AND p.status="PAID" AND IFNULL(p.note,"")<>"credits" AND p.amount>0) AS cashPaidPositive,
  CASE WHEN bundlePrimary=1 AND planExpiresAt IS NULL AND IFNULL(subStatus,"")<>"active" THEN "FREE" ELSE plan END AS directPlan FROM User),
cl AS (SELECT b.*, CASE WHEN directPlan NOT IN ("PRO","BUSINESS") THEN "FREE"
   WHEN IFNULL(subStatus,"")="active" THEN "SUBSCRIPTION"
   WHEN trialEndsAt IS NOT NULL AND trialEndsAt <= (SELECT ms FROM n) THEN "EXPIRED_TRIAL"
   WHEN trialEndsAt IS NOT NULL THEN "TRIAL"
   WHEN planExpiresAt IS NOT NULL AND planExpiresAt <= (SELECT ms FROM n) THEN "EXPIRED_PLAN"
   WHEN planExpiresAt IS NOT NULL THEN "TIMED_PLAN"
   ELSE "PERMANENT_OR_MANUAL" END AS dsrc FROM b),
d AS (SELECT * FROM cl WHERE dsrc IN ("SUBSCRIPTION","TIMED_PLAN","PERMANENT_OR_MANUAL") AND cashPaid)
SELECT "directPayers_total", COUNT(*) FROM d
UNION ALL SELECT "directPayers_zeroBahtOnly", (SELECT COUNT(*) FROM d WHERE cashPaidPositive=0)
UNION ALL SELECT "listPriceMrr_of_zeroBahtPayers", (SELECT ROUND(SUM(CASE WHEN IFNULL(billingPeriod,"")="annual" THEN (CASE WHEN plan="BUSINESS" THEN 990.0 ELSE 599.0 END)*10/12 ELSE (CASE WHEN plan="BUSINESS" THEN 990.0 ELSE 599.0 END) END),2) FROM d WHERE cashPaidPositive=0)
UNION ALL SELECT "zeroBaht_by_plan_period_PROannual", (SELECT COUNT(*) FROM d WHERE cashPaidPositive=0 AND plan="PRO" AND IFNULL(billingPeriod,"")="annual")
UNION ALL SELECT "zeroBaht_by_plan_period_PROmonthly", (SELECT COUNT(*) FROM d WHERE cashPaidPositive=0 AND plan="PRO" AND IFNULL(billingPeriod,"")<>"annual")
UNION ALL SELECT "zeroBaht_by_plan_period_BUSannual", (SELECT COUNT(*) FROM d WHERE cashPaidPositive=0 AND plan="BUSINESS" AND IFNULL(billingPeriod,"")="annual")
UNION ALL SELECT "zeroBaht_by_plan_period_BUSmonthly", (SELECT COUNT(*) FROM d WHERE cashPaidPositive=0 AND plan="BUSINESS" AND IFNULL(billingPeriod,"")<>"annual")
UNION ALL SELECT "zeroBahtPayment_rows_total", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND IFNULL(note,"")<>"credits" AND amount<=0)
UNION ALL SELECT "zeroBahtPayment_distinct_users", (SELECT COUNT(DISTINCT userId) FROM Payment WHERE status="PAID" AND IFNULL(note,"")<>"credits" AND amount<=0);
SQL

# Q8 — telemetry 20,000-row cap impact
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms)
SELECT "telemetry_rows_last_1d", COUNT(*) FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 86400000
UNION ALL SELECT "telemetry_rows_last_7d", (SELECT COUNT(*) FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 7*86400000)
UNION ALL SELECT "telemetry_rows_last_30d", (SELECT COUNT(*) FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 30*86400000)
UNION ALL SELECT "telemetry_rows_prev_30d", (SELECT COUNT(*) FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 60*86400000 AND createdAt < (SELECT ms FROM n) - 30*86400000)
UNION ALL SELECT "telemetry_rows_prev_7d", (SELECT COUNT(*) FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 14*86400000 AND createdAt < (SELECT ms FROM n) - 7*86400000)
UNION ALL SELECT "telemetry_newest20k_covers_from_bkk", (SELECT datetime(MIN(createdAt)/1000,"unixepoch","+7 hours") FROM (SELECT createdAt FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 30*86400000 ORDER BY createdAt DESC LIMIT 20000))
UNION ALL SELECT "telemetry_errorish_rows_last_30d", (SELECT COUNT(*) FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 30*86400000 AND (category="error" OR status="error" OR name LIKE "%failed%" OR name LIKE "%error%"))
UNION ALL SELECT "telemetry_errorish_in_newest20k", (SELECT COUNT(*) FROM (SELECT category,status,name FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 30*86400000 ORDER BY createdAt DESC LIMIT 20000) WHERE category="error" OR status="error" OR name LIKE "%failed%" OR name LIKE "%error%")
UNION ALL SELECT "telemetry_editor_opened_events_30d", (SELECT COUNT(*) FROM TelemetryEvent WHERE name="editor_opened" AND createdAt >= (SELECT ms FROM n) - 30*86400000)
UNION ALL SELECT "telemetry_editor_opened_in_newest20k", (SELECT COUNT(*) FROM (SELECT name FROM TelemetryEvent WHERE createdAt >= (SELECT ms FROM n) - 30*86400000 ORDER BY createdAt DESC LIMIT 20000) WHERE name="editor_opened")
UNION ALL SELECT "telemetry_distinct_sessions_30d", (SELECT COUNT(DISTINCT sessionId) FROM TelemetryEvent WHERE sessionId IS NOT NULL AND createdAt >= (SELECT ms FROM n) - 30*86400000);
SQL

# Q9 — activation funnel union counts
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 - 30*86400000 AS since),
intu AS (SELECT id FROM User WHERE lower(IFNULL(email,"")) LIKE "%@aoacademy%"),
opened AS (SELECT DISTINCT userId AS id FROM TelemetryEvent WHERE name="editor_opened" AND userId IS NOT NULL),
jobu AS (SELECT DISTINCT userId AS id FROM VideoJob),
compu AS (SELECT userId AS id, COUNT(*) AS c FROM Video WHERE status="COMPLETED" GROUP BY userId),
started AS (SELECT id FROM jobu UNION SELECT id FROM compu),
engaged AS (SELECT id FROM opened UNION SELECT id FROM started)
SELECT "openedEditor_union_nonInternal", (SELECT COUNT(*) FROM engaged WHERE id NOT IN (SELECT id FROM intu))
UNION ALL SELECT "openedEditor_telemetryOnly_nonInternal", (SELECT COUNT(*) FROM opened WHERE id NOT IN (SELECT id FROM intu))
UNION ALL SELECT "startedPipeline_union_nonInternal", (SELECT COUNT(*) FROM started WHERE id NOT IN (SELECT id FROM intu))
UNION ALL SELECT "startedPipeline_videoJobOnly_nonInternal", (SELECT COUNT(*) FROM jobu WHERE id NOT IN (SELECT id FROM intu))
UNION ALL SELECT "completedFirstVideo_nonInternal", (SELECT COUNT(*) FROM compu WHERE id NOT IN (SELECT id FROM intu))
UNION ALL SELECT "repeatCreators_nonInternal", (SELECT COUNT(*) FROM compu WHERE c >= 2 AND id NOT IN (SELECT id FROM intu))
UNION ALL SELECT "completedUsers_not_in_videoJob", (SELECT COUNT(*) FROM compu WHERE id NOT IN (SELECT id FROM jobu))
UNION ALL SELECT "openedTelemetry_users_deleted_or_missing", (SELECT COUNT(*) FROM opened WHERE id NOT IN (SELECT id FROM User))
UNION ALL SELECT "video_30d_nonInternal_rows", (SELECT COUNT(*) FROM Video WHERE createdAt >= (SELECT since FROM n) AND userId NOT IN (SELECT id FROM intu))
UNION ALL SELECT "video_30d_nonInternal_completed", (SELECT COUNT(*) FROM Video WHERE createdAt >= (SELECT since FROM n) AND status="COMPLETED" AND userId NOT IN (SELECT id FROM intu))
UNION ALL SELECT "windowCompletedUsers_30d_nonInternal", (SELECT COUNT(DISTINCT userId) FROM Video WHERE createdAt >= (SELECT since FROM n) AND status="COMPLETED" AND userId NOT IN (SELECT id FROM intu))
UNION ALL SELECT "prevWindowCompletedUsers_30d_nonInternal", (SELECT COUNT(DISTINCT userId) FROM Video WHERE createdAt >= (SELECT since FROM n) - 30*86400000 AND createdAt < (SELECT since FROM n) AND status="COMPLETED" AND userId NOT IN (SELECT id FROM intu));
SQL

# Q10 — create vs export split in the creation funnel; managed-stock month counters
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 - 30*86400000 AS since),
intu AS (SELECT id FROM User WHERE lower(IFNULL(email,"")) LIKE "%@aoacademy%"),
j AS (SELECT * FROM VideoJob WHERE createdAt >= (SELECT since FROM n) AND userId NOT IN (SELECT id FROM intu))
SELECT "create_total", (SELECT COUNT(*) FROM j WHERE type="create")
UNION ALL SELECT "create_done", (SELECT COUNT(*) FROM j WHERE type="create" AND status="done")
UNION ALL SELECT "create_failed", (SELECT COUNT(*) FROM j WHERE type="create" AND status="failed")
UNION ALL SELECT "create_canceled", (SELECT COUNT(*) FROM j WHERE type="create" AND status="canceled")
UNION ALL SELECT "create_p55", (SELECT COUNT(*) FROM j WHERE type="create" AND progress>=55)
UNION ALL SELECT "export_total", (SELECT COUNT(*) FROM j WHERE type="export")
UNION ALL SELECT "export_done", (SELECT COUNT(*) FROM j WHERE type="export" AND status="done")
UNION ALL SELECT "export_failed", (SELECT COUNT(*) FROM j WHERE type="export" AND status="failed")
UNION ALL SELECT "export_canceled", (SELECT COUNT(*) FROM j WHERE type="export" AND status="canceled")
UNION ALL SELECT "export_p55", (SELECT COUNT(*) FROM j WHERE type="export" AND progress>=55);
.schema ManagedStockUsage
SELECT * FROM ManagedStockUsage ORDER BY rowid DESC LIMIT 6;
SQL

# Q11 — CostMarginPanel inputs (days=1 and days=30) + Payment-ledger vs Stripe comparison
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms, strftime("%s","now")*1000 - 86400000 AS d1, strftime("%s","now")*1000 - 30*86400000 AS d30)
SELECT "managedMinutes_1d", IFNULL(SUM(chargedMinutes),0) FROM ChargedClip WHERE createdAt >= (SELECT d1 FROM n) AND chargedMinutes IS NOT NULL
UNION ALL SELECT "managedMinutes_30d", (SELECT IFNULL(SUM(chargedMinutes),0) FROM ChargedClip WHERE createdAt >= (SELECT d30 FROM n) AND chargedMinutes IS NOT NULL)
UNION ALL SELECT "rendersWeb_DONE_1d", (SELECT COUNT(*) FROM RenderJob WHERE status="DONE" AND parentJobId IS NULL AND createdAt >= (SELECT d1 FROM n))
UNION ALL SELECT "rendersMcp_DONE_1d", (SELECT COUNT(*) FROM RenderJob WHERE status="DONE" AND parentJobId IS NOT NULL AND createdAt >= (SELECT d1 FROM n))
UNION ALL SELECT "rendersWeb_DONE_30d", (SELECT COUNT(*) FROM RenderJob WHERE status="DONE" AND parentJobId IS NULL AND createdAt >= (SELECT d30 FROM n))
UNION ALL SELECT "rendersMcp_DONE_30d", (SELECT COUNT(*) FROM RenderJob WHERE status="DONE" AND parentJobId IS NOT NULL AND createdAt >= (SELECT d30 FROM n))
UNION ALL SELECT "note_rendersWeb_DONE_includes_BURN", (SELECT COUNT(*) FROM RenderJob WHERE status="DONE" AND type="BURN" AND createdAt >= (SELECT d30 FROM n))
UNION ALL SELECT "telemetry_distinct_users_1d", (SELECT COUNT(DISTINCT userId) FROM TelemetryEvent WHERE userId IS NOT NULL AND createdAt >= (SELECT d1 FROM n))
UNION ALL SELECT "telemetry_distinct_users_30d", (SELECT COUNT(DISTINCT userId) FROM TelemetryEvent WHERE userId IS NOT NULL AND createdAt >= (SELECT d30 FROM n))
UNION ALL SELECT "creditsGranted_1d", (SELECT IFNULL(SUM(delta),0) FROM CreditLedger WHERE kind="grant" AND createdAt >= (SELECT d1 FROM n))
UNION ALL SELECT "creditsGranted_30d", (SELECT IFNULL(SUM(delta),0) FROM CreditLedger WHERE kind="grant" AND createdAt >= (SELECT d30 FROM n))
UNION ALL SELECT "payments_PAID_paidAt_1d_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND paidAt >= (SELECT d1 FROM n))
UNION ALL SELECT "payments_PAID_paidAt_30d_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND paidAt >= (SELECT d30 FROM n))
UNION ALL SELECT "payments_PAID_paidAt_30d_count", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND paidAt >= (SELECT d30 FROM n))
UNION ALL SELECT "payments_PAID_paidAt_NULL_total", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND paidAt IS NULL)
UNION ALL SELECT "payments_PAID_alltime_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID")
UNION ALL SELECT "payments_PAID_alltime_count", (SELECT COUNT(*) FROM Payment WHERE status="PAID")
UNION ALL SELECT "payments_manual_PAID_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND manual=1)
UNION ALL SELECT "payments_PAID_30d_annual_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND paidAt >= (SELECT d30 FROM n) AND IFNULL(note,"")<>"credits" AND IFNULL(periodDays,30) >= 365)
UNION ALL SELECT "payments_PAID_30d_monthly_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND paidAt >= (SELECT d30 FROM n) AND IFNULL(note,"")<>"credits" AND IFNULL(periodDays,30) < 365)
UNION ALL SELECT "payments_PAID_30d_packs_baht", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND paidAt >= (SELECT d30 FROM n) AND IFNULL(note,"")="credits")
UNION ALL SELECT "payments_periodDays_between300_364", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND periodDays >= 300 AND periodDays < 365);
SQL

# Q12 — newPayers / repeatPayers denominators
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
WITH n AS (SELECT strftime("%s","now")*1000 AS ms, strftime("%s","now")*1000 - 30*86400000 AS since),
w AS (SELECT userId, MIN(IFNULL(paidAt,createdAt)) AS firstInWin FROM Payment WHERE status="PAID" AND IFNULL(paidAt,createdAt) >= (SELECT since FROM n) AND IFNULL(paidAt,createdAt) < (SELECT ms FROM n) GROUP BY userId),
a AS (SELECT userId, MIN(IFNULL(paidAt,createdAt)) AS firstEver FROM Payment WHERE status="PAID" GROUP BY userId)
SELECT "distinct_payers_in_30d_window", (SELECT COUNT(*) FROM w)
UNION ALL SELECT "newPayers_firstEverInWindow", (SELECT COUNT(*) FROM w JOIN a ON a.userId=w.userId WHERE a.firstEver = w.firstInWin)
UNION ALL SELECT "repeatPayers", (SELECT COUNT(*) FROM w JOIN a ON a.userId=w.userId WHERE a.firstEver <> w.firstInWin)
UNION ALL SELECT "payment_rows_in_30d_window", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND IFNULL(paidAt,createdAt) >= (SELECT since FROM n))
UNION ALL SELECT "payment_rows_in_30d_window_amount_gt0", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND amount>0 AND IFNULL(paidAt,createdAt) >= (SELECT since FROM n))
UNION ALL SELECT "payment_rows_in_30d_window_zero", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND amount<=0 AND IFNULL(paidAt,createdAt) >= (SELECT since FROM n))
UNION ALL SELECT "manual_rows_in_30d_window", (SELECT COUNT(*) FROM Payment WHERE status="PAID" AND manual=1 AND IFNULL(paidAt,createdAt) >= (SELECT since FROM n))
UNION ALL SELECT "manual_baht_in_30d_window", (SELECT IFNULL(SUM(amount),0)/100.0 FROM Payment WHERE status="PAID" AND manual=1 AND IFNULL(paidAt,createdAt) >= (SELECT since FROM n));
SQL

# Q13 — dead-table / dead-counter checks
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
SELECT "GeneratedImage_total", COUNT(*) FROM GeneratedImage;
SELECT "GeneratedImage_latest_bkk", datetime(MAX(createdAt)/1000,"unixepoch","+7 hours") FROM GeneratedImage;
SELECT "GeneratedImage_30d", COUNT(*) FROM GeneratedImage WHERE createdAt >= strftime("%s","now")*1000 - 30*86400000;
SELECT "AiGenerationJob_image_completed_total", COUNT(*) FROM AiGenerationJob WHERE kind="image" AND status="completed";
SELECT "AiGenerationJob_image_completed_settled_withUrl", COUNT(*) FROM AiGenerationJob WHERE kind="image" AND status="completed" AND chargeState="settled" AND TRIM(IFNULL(outputUrl,""))<>"";
SELECT "AiGenerationJob_image_linkedGeneratedImage", COUNT(*) FROM AiGenerationJob WHERE kind="image" AND generatedImageId IS NOT NULL;
SELECT "Content_total", COUNT(*) FROM Content;
SELECT "Content_latest_bkk", datetime(MAX(createdAt)/1000,"unixepoch","+7 hours") FROM Content;
SELECT "Video_latest_bkk", datetime(MAX(createdAt)/1000,"unixepoch","+7 hours") FROM Video;
SELECT "Video_ever_nonCOMPLETED", COUNT(*) FROM Video WHERE status<>"COMPLETED";
SELECT "usageCount_gt0_users", COUNT(*) FROM User WHERE usageCount > 0;
SELECT "minutesUsed_gt0_users", COUNT(*) FROM User WHERE minutesUsed > 0;
SELECT "Style_total", COUNT(*) FROM Style;
SELECT "Script_total", COUNT(*) FROM Script;
SELECT "Script_30d", COUNT(*) FROM Script WHERE createdAt >= strftime("%s","now")*1000 - 30*86400000;
SELECT "Script_status_breakdown", status, COUNT(*) FROM Script GROUP BY status;
SELECT "SupportTicket_OPEN", COUNT(*) FROM SupportTicket WHERE status="OPEN";
SQL

# Q14 — the admin's own /dashboard numbers (own account only; id shown as an 8-char prefix in the report)
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" <<"SQL"
.mode list
.separator |
SELECT "admin_id_prefix", substr(id,1,8), role, plan, usageCount, usageLimit, minutesUsed, minutesLimit, datetime(usagePeriodStartedAt/1000,"unixepoch","+7 hours") FROM User WHERE id="cmoycf2v8000elcv0aka8u7p2";
SELECT "admin_videoCount", COUNT(*) FROM Video WHERE userId="cmoycf2v8000elcv0aka8u7p2";
SELECT "admin_video_completed", COUNT(*) FROM Video WHERE userId="cmoycf2v8000elcv0aka8u7p2" AND status="COMPLETED";
SELECT "admin_styleCount", COUNT(*) FROM Style WHERE userId="cmoycf2v8000elcv0aka8u7p2";
SELECT "admin_contentCount", COUNT(*) FROM Content WHERE userId="cmoycf2v8000elcv0aka8u7p2";
SELECT "admin_videoJobs_all", COUNT(*) FROM VideoJob WHERE userId="cmoycf2v8000elcv0aka8u7p2";
SELECT "admin_videoJobs_done", COUNT(*) FROM VideoJob WHERE userId="cmoycf2v8000elcv0aka8u7p2" AND status="done";
SELECT "admin_renderJob_RENDER_DONE", COUNT(*) FROM RenderJob WHERE userId="cmoycf2v8000elcv0aka8u7p2" AND type="RENDER" AND status="DONE";
SELECT "admin_chargedClips_30d_minutes", IFNULL(SUM(chargedMinutes),0) FROM ChargedClip WHERE userId="cmoycf2v8000elcv0aka8u7p2" AND createdAt >= strftime("%s","now")*1000 - 30*86400000;
SELECT "admin_chargedClips_sinceUsagePeriod_minutes", IFNULL(SUM(chargedMinutes),0) FROM ChargedClip WHERE userId="cmoycf2v8000elcv0aka8u7p2" AND createdAt >= (SELECT usagePeriodStartedAt FROM User WHERE id="cmoycf2v8000elcv0aka8u7p2");
SELECT "admin_chargedClips_count_sinceUsagePeriod", COUNT(*) FROM ChargedClip WHERE userId="cmoycf2v8000elcv0aka8u7p2" AND createdAt >= (SELECT usagePeriodStartedAt FROM User WHERE id="cmoycf2v8000elcv0aka8u7p2");
SELECT "usagePeriod_age_days", ROUND((strftime("%s","now")*1000 - (SELECT usagePeriodStartedAt FROM User WHERE id="cmoycf2v8000elcv0aka8u7p2"))/86400000.0, 2);
SQL

# Q15 — plan/cost SiteConfig rows (are prices actually admin-set on prod?)
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" "SELECT key,value FROM SiteConfig WHERE key LIKE \"plan_%\" ORDER BY key;"

# Q16 — env key NAMES only (no values) + the north-star cron schedule
cut -d= -f1 /var/www/ai-content/.env | sort | grep -E "MINUTE_QUOTA|MANAGED_GEMINI|MANAGED_STOCK|CREDITS_LIVE|TZ|EDITOR_V2"
grep -n -A4 "north-star-snapshot" /var/www/ai-content/ecosystem.config.js | head -30

# Q17 — filesystem cross-check for the disk/cleanup cards
df -h /
ls /var/www/ai-content/public/renders | wc -l
du -sm /var/www/ai-content/public/renders
ls /var/www/ai-content/stocks | wc -l
du -sm /var/www/ai-content/stocks
```

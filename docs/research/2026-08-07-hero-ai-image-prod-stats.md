# Hero AI Image — Production Usage Stats (read-only pull)

Pulled 2026-08-07 from live prod SQLite (`/var/www/ai-content/prisma/dev.db` on the Hostinger VPS) via read-only `sqlite3`. All timestamps below are converted to Asia/Bangkok (+7h) unless noted. Facts only — no recommendations, no verdicts.

## 0. Schema check (adaptations)

Checked `.schema` for `AiGenerationJob`, `AiGenerationAttempt`, `CreditLedger`, `CreditBalance`, `User`, `GeneratedImage` before running queries.

- `AiGenerationJob.createdAt` and `User.trialEndsAt` are stored as **integer ms-epoch** (verified via `typeof()`), so the plan's `createdAt/1000, 'unixepoch'` conversions and the `trialEndsAt > strftime('%s','now')*1000` comparison work as written — no adaptation needed.
- All other columns referenced in the plan's queries (`provider`, `providerRoute`, `model`, `status`, `chargeState`, `creditCost`, `executionTimeMs`, `providerReportedCostUsdMicros`, `estimatedCostUsdMicros`, `errorCode`, `inputJson`, `kind`, `action`, `delta`, `granted`, `purchased`, `plan`, `role`) exist as named — no column substitutions needed.
- No schema adaptation was required for any query in this pull.

## 1. Image-gen overview (volume, price charged, failure/refund split)

Query: `GROUP BY provider, providerRoute, model, status, chargeState` on `AiGenerationJob WHERE kind='image'`.

| provider | providerRoute | model | status | chargeState | n | credits | avg_exec_ms | cost_usd_micros |
|---|---|---|---|---|---|---|---|---|
| runpod | runpod-custom | z-image-turbo | completed | settled | 921 | 2763 | 6374 | 46,050,000 |
| runpod | runpod-public | z-image-turbo | completed | settled | 480 | 960 | 7266 | 2,400,000 |
| runpod | runpod-custom | z-image-turbo | completed | refunded | 145 | 435 | 5743 | 7,250,000 |
| runpod | runpod-public | z-image-turbo | failed | refunded | 30 | 60 | — | 150,000 |
| runpod | runpod-public | z-image-turbo | completed | refunded | 26 | 52 | 7587 | 130,000 |
| runpod | runpod-custom | z-image-turbo | failed | refunded | 3 | 9 | — | 150,000 |

All 1,605 image jobs to date use `provider=runpod`, `model=z-image-turbo`, split across the `runpod-custom` and `runpod-public` routes; 1,451/1,605 (90.4%) are `completed`+`settled`, and 209/1,605 (13.0%) carry `chargeState=refunded` (both failed jobs and some completed-but-refunded jobs).

`cost_usd_micros` here is `COALESCE(providerReportedCostUsdMicros, estimatedCostUsdMicros)` per the query — see section 6 for which of those two sources actually populated it per route.

## 2. Weekly timeline

| week (ISO, Bangkok) | jobs | credits | distinct users |
|---|---|---|---|
| 2026-29 | 307 | 614 | 4 |
| 2026-30 | 752 | 2027 | 4 |
| 2026-31 | 546 | 1638 | 4 |

Image-gen activity spans exactly three ISO weeks (2026-07-22 through 2026-08-07, confirmed via `MIN/MAX(createdAt)`), with the same 4 distinct users active in each of the three weeks.

## 3. Per-user usage (masked)

| who | plan | role | imgs | credits | first_use | last_use |
|---|---|---|---|---|---|---|
| duc*** | BUSINESS | ADMIN | 567 | 1510 | 2026-07-22 | 2026-08-07 |
| sum*** | BUSINESS | ADMIN | 478 | 1169 | 2026-07-22 | 2026-08-05 |
| thi*** | BUSINESS | ADMIN | 295 | 846 | 2026-07-25 | 2026-08-02 |
| bun*** | PRO | ADMIN | 232 | 655 | 2026-07-22 | 2026-08-07 |
| ken*** | PRO | ADMIN | 33 | 99 | 2026-08-03 | 2026-08-05 |

All 5 distinct users who have ever created an image job carry `role=ADMIN`; no `role=USER` account has generated an image job as of this pull.

## 4. Images + credits per clip

Query grouped `AiGenerationJob WHERE kind='image' AND json_extract(inputJson,'$.videoJobId') IS NOT NULL` by `videoJobId`. 102 distinct clips (`videoJobId`s) have associated image jobs; the full per-clip table (102 rows) was written to the query output and is summarized below rather than reproduced in full.

| metric | value |
|---|---|
| clips with image jobs | 102 |
| images per clip — min | 2 |
| images per clip — median | 15 |
| images per clip — avg | 15.73 |
| images per clip — max | 43 |
| credits per clip — min | 4 |
| credits per clip — avg | 41.93 |
| credits per clip — max | 129 |

Across the 102 clips that used AI image generation, per-clip image counts range from 2 to 43 images (median 15, avg 15.73), corresponding to 4–129 credits per clip (avg 41.93).

Standalone (no `videoJobId`) image jobs: **1 row** out of 1,605 total kind='image' jobs has `json_extract(inputJson,'$.videoJobId') IS NULL` — i.e. essentially all image generation in this dataset is tied to a video clip, not standalone AI-Studio usage.

## 5. Real COGS per image

Query: `AiGenerationJob WHERE kind='image' AND providerReportedCostUsdMicros IS NOT NULL GROUP BY model, providerRoute`.

| model | providerRoute | n | avg_usd_micros | min_usd_micros | max_usd_micros |
|---|---|---|---|---|---|
| z-image-turbo | runpod-public | 506 | 5000.0 | 5000 | 5000 |

Every row with a non-null `providerReportedCostUsdMicros` is on the `runpod-public` route, at a flat $0.005/image (≈0.18 THB/image at 36 THB/USD) with zero variance (min=max=avg=5000 micros).

Coverage: **1,099 of 1,605** image jobs (68.5%) have `providerReportedCostUsdMicros IS NULL` — this is every `runpod-custom` row (1,069 jobs: 921 settled + 145 refunded-completed + 3 refunded-failed) plus 30 of the 536 `runpod-public` rows (the `failed`/`refunded` ones). For the `runpod-custom` route, section 1's `cost_usd_micros` column is entirely derived from `estimatedCostUsdMicros` (the COALESCE fallback), which averages $0.05/image (≈1.80 THB/image) — 10x the `runpod-public` route's actually-reported $0.005/image — since no `runpod-custom` row has a provider-reported cost in this dataset.

## 6. Failure detail

Query: `errorCode` breakdown for `status='failed'`:

| errorCode | n |
|---|---|
| RUNPOD_FAILED | 27 |
| RUNPOD_QUEUE_TIMEOUT | 3 |
| OUTPUT_INVALID | 2 |
| PROVIDER_SUBMIT_FAILED | 1 |

33 image jobs have `status='failed'` total (matches the `n` sum above), with `RUNPOD_FAILED` accounting for 27/33 (81.8%) of failures.

Query: `chargeState` for failed jobs:

| chargeState | n |
|---|---|
| refunded | 33 |

All 33 failed image jobs have `chargeState=refunded` — no failed job in this dataset has an unrefunded charge state.

Stuck-reservation probe (`chargeState='reserved'`): **zero rows returned** — no image job is currently sitting in `chargeState=reserved` as of this pull.

## 7. Credit-economy context

Query: `CreditLedger GROUP BY kind, action`. This produced 211+ distinct `action` values (many are per-job refund entries with unique job-ID/incident suffixes, e.g. `ai-image-batch-refund:<jobId>:incident_2026_07_29`). Reported here at two levels of granularity — by `kind` alone, and by `kind` + action-prefix (text before the first `:`) — rather than the full 211-row raw table, per the Data caveats note below.

By `kind` only:

| kind | n | total delta |
|---|---|---|
| grant | 648 | 3744 |
| purchase | 6 | 10000 |
| refund | 211 | 574 |
| spend | 1649 | -4393 |

By `kind` + action prefix:

| kind | action_prefix | n | total delta |
|---|---|---|---|
| grant | monthly-reset | 646 | 3728 |
| grant | ops_smoke_refund | 2 | 16 |
| purchase | admin-manual | 1 | 1000 |
| purchase | admin-manual-credit | 3 | 3000 |
| purchase | manual-support-topup | 1 | 1000 |
| purchase | manual-topup | 1 | 5000 |
| refund | ai-image-batch-refund | 171 | 487 |
| refund | ai-image-refund | 33 | 69 |
| refund | render-refund | 7 | 18 |
| spend | ai-image | 1605 | -4279 |
| spend | render-overflow | 44 | -114 |

`spend:ai-image` has exactly 1,605 ledger rows totaling -4,279 credits, which matches the 1,605 `kind='image'` `AiGenerationJob` rows and the sum of `creditCost` across all image jobs (2763+960+435+60+52+9=4279) from section 1 — the ledger and job table are internally consistent for image spend. All 6 `purchase` ledger rows total 10,000 credits and are manual/admin top-ups (`admin-manual*`, `manual-support-topup`, `manual-topup`), not self-serve purchases.

Query: `CreditBalance` averages by plan (PRO/BUSINESS only):

| plan | users | avg_granted_left | avg_purchased |
|---|---|---|---|
| BUSINESS | 7 | 86.0 | 805.0 |
| PRO | 81 | 28.0 | 17.0 |

Across the 7 BUSINESS-plan `CreditBalance` rows, the average remaining granted balance is 86 credits and average purchased-balance is 805 credits; across the 81 PRO-plan rows the averages are 28 granted and 17 purchased.

## 8. Audience sizes

Query: `User GROUP BY plan, role` with a `trialing` count (`trialEndsAt` in the future).

| plan | role | trialing | total |
|---|---|---|---|
| BUSINESS | ADMIN | 0 | 4 |
| BUSINESS | USER | 0 | 3 |
| FREE | ADMIN | 0 | 6 |
| FREE | USER | 0 | 778 |
| PRO | ADMIN | 0 | 7 |
| PRO | USER | 28 | 103 |

Total users in the DB: 901 (4+3+6+778+7+103). Of the 103 PRO/USER accounts, 28 are currently within an active trial window (`trialEndsAt` in the future); combined PRO+BUSINESS (paid-tier) USER+ADMIN total is 117 accounts, versus 784 FREE-tier accounts.

## 9. Prod flags snapshot (names + on/off only)

Grep of `/var/www/ai-content/.env` for the listed flag names, values reported as set/unset/0/1 only (secret values masked as `<set>` per the hard rules; `AI_STUDIO_Z_IMAGE_ROUTE` value is explicitly non-secret per instructions).

| flag | value |
|---|---|
| MANAGED_KIE | unset (no match) |
| CREDITS_LIVE | 1 |
| MINUTE_QUOTA | 1 |
| NEXT_PUBLIC_CREDITS_LIVE | 1 |
| NEXT_PUBLIC_BROLL_WINDOW_MODE | 1 |
| AI_STUDIO_IMAGE_ENABLED | 1 |
| AI_STUDIO_Z_IMAGE_ROUTE | custom |
| RUNPOD_API_KEY | \<set\> |
| RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID | \<set\> |
| RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH | \<set\> |
| INTERNAL_AI_ALLOWED_EMAILS | 1 entry |
| INTERNAL_AI_ALLOWED_DOMAINS | 1 entry |
| AUTOMIX_WEIGHT_* | unset (no match) |

Prod has `AI_STUDIO_IMAGE_ENABLED=1` and `AI_STUDIO_Z_IMAGE_ROUTE=custom` (the RunPod custom-worker route) live, with an internal allowlist of exactly 1 email address and 1 email domain gating access; `MANAGED_KIE` and any `AUTOMIX_WEIGHT_*` vars are not set in this `.env`.

## 10. Legacy table + purchase demand

| query | result |
|---|---|
| `COUNT(*) FROM GeneratedImage` | 1572 |
| `COUNT(*), SUM(delta) FROM CreditLedger WHERE kind='purchase'` | 6 rows, 10000 total delta |

The legacy `GeneratedImage` table has 1,572 rows (close to but not identical to the 1,605 `AiGenerationJob kind='image'` count), and there have been exactly 6 `purchase`-kind ledger entries totaling 10,000 credits to date (all manual/admin top-ups per section 7, not self-serve checkout purchases).

---

## Data caveats

- **Section 4 (per-clip table) truncated to summary stats.** The raw per-`videoJobId` query returned 102 rows; rather than reproducing all 102 in this file, only the aggregate min/median/avg/max were computed (via SQL, not by hand) and reported. The full raw output is not persisted anywhere outside the SSH session.
- **Section 7 (CreditLedger by kind/action) condensed.** The plan's literal query (`GROUP BY kind, action`) returns 211 distinct rows because many `action` values embed a unique job ID or incident tag (e.g. `ai-image-batch-refund:<jobId>:incident_2026_07_29`, one row per refunded job). Reporting all 211 rows was impractical for a findings table, so this file reports both a `kind`-only rollup and a `kind` + action-prefix (text before first `:`) rollup instead. This is an adaptation of the literal query, not a change to what was queried.
- **`providerReportedCostUsdMicros` coverage gap.** 1,099 of 1,605 image jobs (all `runpod-custom` route jobs, plus 30 failed `runpod-public` jobs) have no provider-reported cost — only `estimatedCostUsdMicros` is available for those rows. Section 1's `cost_usd_micros` totals for `runpod-custom` rows are therefore estimates, not actuals. No real (provider-reported) COGS figure exists for the `runpod-custom` route in this dataset.
- **Small-n warning: only 5 distinct users have ever run image generation**, and all 5 are `role=ADMIN`. Per-user, per-plan, and per-route statistics in this pull (sections 1, 2, 3, 6) reflect this very small, admin-only population, not general customer usage.
- **Small-n warning: only 3 calendar weeks of image-gen data exist** (2026-07-22 through 2026-08-07), all falling within ISO weeks 29–31, 2026 — the weekly timeline (section 2) is not a long-run trend.
- **`GeneratedImage` (1,572) vs `AiGenerationJob kind='image'` (1,605) count mismatch is unexplained** by this pull — no join or reconciliation query was run between the two tables; the discrepancy (33 rows) is reported as-is without root-causing it, per the read-only/facts-only scope of this task.
- **RunPod credential values were not read or logged** beyond confirming they are set — `RUNPOD_API_KEY` and `RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID` are reported as `<set>` only, per the hard rule against copying secret values. `RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH` (a file path, not obviously a secret) was also conservatively masked to `<set>` since the task's rule covers "keys/IDs" broadly and this flag looked adjacent to the RunPod credential group.
- **No schema deviations from the plan were encountered** — all referenced columns/tables existed as named, and both `createdAt` and `trialEndsAt` are ms-epoch integers as the plan assumed, so no query rewrites (beyond the two condensations above) were needed.

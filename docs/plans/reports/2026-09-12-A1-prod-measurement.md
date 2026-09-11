# A1 — Production measurement (read-only)

Measured: 2026-09-11 20:47 UTC → 2026-09-11 21:05 UTC (Bangkok 2026-09-12 03:47 → 04:05).
Host: `72.62.196.230`, app `/var/www/ai-content`, DB `prisma/dev.db`, prod HEAD `84e4d8c2`.
Every command is read-only. Nothing on production was written, restarted or modified.

## Coverage caveat — the 7-day census is not possible

PM2 only began writing a leading ISO timestamp on **2026-09-09T11:31:07 UTC** (Bangkok
2026-09-09 18:31). The `[prisma-slow-tx]` instrumentation (`src/lib/prisma.ts:101`) first
appears on that exact line — timestamps and instrumentation arrived in the same deploy.

| log file | lines | lines with a leading ISO timestamp | `prisma-slow-tx` lines |
|---|---:|---:|---:|
| `ai-content-error__2026-09-07_00-00-00.log` | 251 | 0 | 0 |
| `ai-content-error__2026-09-08_00-00-00.log` | 729 | 0 | 0 |
| `ai-content-error__2026-09-09_00-00-00.log` | 536 | 0 | 0 |
| `ai-content-error__2026-09-10_00-00-00.log` | 546 | 274 | 53 |
| `ai-content-error__2026-09-11_00-00-00.log` | 523 | 523 | 96 |
| `ai-content-error.log` (live) | 179 | 179 | 68 |
| `ai-content-out__2026-09-07/08/09` | 4,990 / 11,771 / 10,662 | 0 / 0 / 0 | 0 |
| `ai-content-out__2026-09-10` | 20,032 | 10,868 | 0 |

**Brief's stop-check passes**: `grep -c 'prisma-slow-tx'` = 219, timestamped = 219, **untimestamped = 0**.
Every slow-tx line carries a leading ISO timestamp, so the extraction pipeline in the brief is valid.

What is lost: lines carrying the other markers that predate 2026-09-09T11:31 cannot be bucketed to
a Bangkok day — `Socket timeout` 40, `Transaction already closed` 94, `P1008` 10 untimestamped lines.

**Measured window: 2026-09-09 18:31 BKK → 2026-09-12 04:05 BKK = 2.40 days**, not 7.
Counts below drifted during the session as new events landed (217 → 219 for ai-content); each
table states its own snapshot time.

Server timezone is `Etc/UTC`; PM2 log rotation fires at 00:00 UTC = 07:00 Bangkok, so every
rotated file straddles two Bangkok days. All bucketing below is by the line's own timestamp +7 h.

---

## §A1.1 Slow-transaction census

### ai-content (snapshot: 219 events at 2026-09-11T21:00 UTC; per-day table taken at 20:52 UTC = 217 events)

| Bangkok day | slow-tx count | ≥ 5000 ms | p50 (ms) | p90 (ms) | max (ms) |
|---|---:|---:|---:|---:|---:|
| 2026-09-09 (from 18:31) | 42 | 42 | 29,497 | 39,215 | 45,572 |
| 2026-09-10 | 99 | 98 | 20,241 | 30,147 | 46,302 |
| 2026-09-11 | 72 | 71 | 27,035 | 30,137 | 45,284 |
| 2026-09-12 (to 03:47) | 4 | 4 | 20,701 | 30,062 | 30,089 |

Pooled distribution (n = 217): min 2,004 · p50 25,166 · p75 30,093 · p90 30,191 · p95 37,280 · max 46,302 ms.

Hold-time histogram (n = 219), bucketed against the configured budgets:

| bucket (ms) | events | share |
|---|---:|---:|
| 0 – 4,999 | 2 | 0.9 % |
| 5,000 – 14,999 | 2 | 0.9 % |
| 15,000 – 19,499 | 12 | 5.5 % |
| **19,500 – 20,499** (socket_timeout 20 s) | **83** | **37.9 %** |
| 20,500 – 29,499 | 39 | 17.8 % |
| **29,500 – 30,499** (tx timeout 30 s) | **67** | **30.6 %** |
| 30,500 – 38,999 | 5 | 2.3 % |
| 39,000 – 40,999 (maxWait 10 s + timeout 30 s) | 6 | 2.7 % |
| 41,000 + | 3 | 1.4 % |

150 of 219 (68.5 %) land within ±500 ms of a configured timeout.

### story-film-system-worker

| Bangkok day | slow-tx count | ≥ 5000 ms | p50 (ms) | max (ms) |
|---|---:|---:|---:|---:|
| 2026-09-09 | 34 | 23 | 18,359 | 20,132 |
| 2026-09-10 | 90 | 68 | 17,759 | 20,253 |
| 2026-09-11 | 66 | 52 | 19,362 | 20,212 |
| 2026-09-12 (to 03:5x) | 6 | 4 | 18,358 | 20,041 |

Pooled (n = 196): min 2,036 · p50 18,358 · p90 20,047 · max 20,253 ms.
Histogram: < 5,000 = 49 · 5,000–14,999 = 11 · 15,000–19,499 = 55 · **19,500–20,499 = 83 (42 %)**.

### mcp-video-worker

2 slow-tx total (both Bangkok 2026-09-10): p50 8,945 ms, max 16,759 ms.

### render-worker (PM2 ids 12 and 13)

**0** slow-tx lines in either instance (132,688 + 969,325 log lines read).

### Error-marker counts per Bangkok day (timestamped era only)

| marker | app | 09-09 | 09-10 | 09-11 | total (incl. untimestamped era) |
|---|---|---:|---:|---:|---:|
| `Socket timeout` | ai-content | 17 | 11 | 5 | 73 |
| `Transaction already closed` | ai-content | 2 | 4 | 1 | 101 |
| `P1008` | ai-content | 7 | 3 | 3 | 23 |
| `SQLITE_BUSY` | ai-content | 0 | 0 | 0 | 0 |
| `database is locked` | ai-content | — | — | — | 4 lines = 1 multi-line Prisma error |
| `transient SQLite timeout; retry` | ai-content | 1 | 2 | 0 | 9 (+2 `[transient-db-retry]`) |
| `lease failed` | story-film | 25 | 24 | 25 | 102 |
| `Socket timeout` | story-film | 25 | 24 | 25 | 102 |
| `P1008` | story-film | 25 | 24 | 25 | 102 |
| `P1008` | mcp-video-worker | 1 | 2 | 1 | 5 |
| `Socket timeout` / `P1008` | render-worker-12 | — | — | — | 2 / 1 |
| `Socket timeout` / `P1008` | render-worker-13 | — | — | — | 2 / 2 |

story-film's `lease failed`, `Socket timeout` and `P1008` are the same 102 events (one multi-line error each).

### Slow-tx by Bangkok hour (ai-content, all days pooled, n = 217)

| BKK hour | n | ≥5 s | max (ms) | | BKK hour | n | ≥5 s | max (ms) |
|---:|---:|---:|---:|---|---:|---:|---:|---:|
| 00 | 12 | 11 | 46,302 | | 12 | 3 | 3 | 30,106 |
| 01 | 4 | 3 | 30,093 | | 13 | 13 | 13 | 37,772 |
| 02 | 4 | 4 | 30,089 | | 14 | 9 | 9 | 30,263 |
| 03 | 0 | 0 | — | | 15 | 7 | 7 | 39,503 |
| 04 | 0 | 0 | — | | 16 | 7 | 7 | 30,153 |
| 05 | 2 | 2 | 30,110 | | 17 | 6 | 6 | 30,348 |
| 06 | 1 | 1 | 30,098 | | 18 | 12 | 12 | 30,147 |
| 07 | 2 | 2 | 30,307 | | 19 | 10 | 10 | 45,284 |
| 08 | 10 | 10 | 30,048 | | 20 | 14 | 14 | 40,131 |
| 09 | 8 | 8 | 37,280 | | 21 | 18 | 18 | 30,302 |
| 10 | 5 | 5 | 30,141 | | 22 | 27 | 27 | 36,366 |
| 11 | 9 | 9 | 30,125 | | 23 | 34 | 34 | 45,572 |

Peak 21:00–00:00 Bangkok (79 of 217 = 36 %); trough 03:00–04:00 Bangkok (0).

---

## §A1.2 Lock-holder correlation

Windows are `[T − hold − 2 s, T]` for every ai-content slow-tx ≥ 5,000 ms.
215 windows (at the time of this pass) cover **3,736 distinct seconds** of the
**206,235 s** timestamped span = **1.81 % baseline**.

### Tag enrichment inside slow-tx windows

| tag | lines in windows | lines total | in-window share | enrichment vs 1.81 % |
|---|---:|---:|---:|---:|
| `[story-film-system]` | 73 | 112 | 65.2 % | **36×** |
| `[api/videos/usage]` | 6 | 6 | 100 % | 55× (n = 6) |
| `[stripe-webhook]` | 8 | 21 | 38.1 % | 21× |
| `[instrumentation]` | 6 | 32 | 18.8 % | 10× |
| `[reconcile-ai-images]` | 11 | 231 | 4.8 % | 2.6× |
| `[founding-sweep]` | 10 | 230 | 4.3 % | 2.4× |
| `[reconcile-processing]` | 10 | 230 | 4.3 % | 2.4× |
| `[config]` | 16 | 664 | 2.4 % | 1.3× |
| `[transcribe]` | 39 | 1,682 | 2.3 % | 1.3× |
| `[fetch-stock]` | 124 | 5,991 | 2.1 % | 1.1× |
| `[Render]` (Remotion progress) | 1,957 | 111,007 | 1.8 % | 0.97× |
| `[mcp-worker]` | 30 | 2,286 | 1.3 % | 0.72× |
| `[render-worker]` | 6 | 499 | 1.2 % | 0.66× |
| `[media-storage-rollout]` | 65 | 5,306 | 1.2 % | 0.68× |
| `[tts-gemini]` | 10 | 1,001 | 1.0 % | 0.55× |

### Per-window presence (217 windows)

| present in window | windows | share |
|---|---:|---:|
| story-film `lease failed` | 69 | 32 % |
| `[mcp-worker] job … step=` | 17 | 8 % |
| 15-minute cron (`founding-sweep` / `reconcile-*`) | 12 | 6 % |
| `[transcribe]` / `[tts*]` | 14 | 6 % |
| `[fetch-stock]` | 11 | 5 % |
| `[stripe-webhook]` | 5 | 2 % |
| render progress | 3 | 1 % |
| `[backup-db]` `VACUUM INTO` | **0** | **0 %** |
| none of the above | 130 | 60 % |

### Holder vs victim split

`[prisma-slow-tx]` records **only a counter and a duration** (`src/lib/prisma.ts:101`), so a
transaction that *held* the writer and one that *waited* for it log identically. Proxy used:
does a `P1008` / `Socket timeout` / `Transaction already closed` / `transient SQLite` /
`database is locked` line appear within ±2 s?

| app | events ≥ 5 s | victim (error within 2 s) | no error nearby |
|---|---:|---:|---:|
| ai-content | 219 | 54 (25 %) | 165 (75 %) |
| story-film-system-worker | 152 | 74 (49 %) | 78 (51 %) |

Holder-candidate (no error nearby) hold-times cluster on the same caps: 71 at 19.5–20.5 s and
51 at 29.5–30.5 s — i.e. most "successful" slow transactions are still pinned to a timeout value.

### Burst structure

Merging ai-content + story-film slow-tx events and starting a new cluster on a gap > 5 s:

| metric | value |
|---|---:|
| events | 424 |
| clusters | 209 |
| mean events per cluster | 2.0 |
| clusters with ≥ 3 events | 59 (28 %) |
| largest cluster | 6 events across 2 processes |

Correlated bursts across independent processes are the signature of a shared blocker, not of
independently slow queries.

### Candidate-holder table

| window (UTC) | candidate holder | confidence | evidence (sanitised) |
|---|---|---|---|
| 2026-09-09 17:03:42 – 17:04:31 (hold 46,302 ms) | MCP video-worker `config` step | medium | `[mcp-worker] job cmtuc4b9… step=config 20.1s` (step mean 0.09 s over n = 280) + `[prisma-slow-tx] #567 held 20100ms`, then `[story-film-system] lease failed … Socket timeout` and `[video-job] set pipeline step transient SQLite P1008; retry 1 in 50ms` |
| 2026-09-09 16:51:29 – 16:52:18 (hold 45,572 ms) | `/api/videos/fetch-stock` transactions | medium | three `[prisma-slow-tx]` at 39,215 / 39,642 / 40,312 ms whose stacks end at `app/api/videos/fetch-stock/route.js` + `[fetch-stock] Auto Mix Hero AI Image failed … Socket timeout`; `[stripe-webhook]` 30 s earlier |
| 2026-09-11 12:07:54 – 12:08:42 (hold 45,284 ms) | story-film lease + Stripe webhook | low | `[stripe-webhook] … → PRO`, then two `[story-film-system] lease failed … Socket timeout` at 20,034 / 20,033 ms |
| 2026-09-11 01:58:44 – 01:59:18 (hold 30,048 ms) | unidentified | low | burst of 6 slow-tx across 2 processes (20,087 / 19,072 / 20,088 / 24,951 / 30,048 / 2,037 ms) ending in `[editor-project] transient SQLite timeout; retry 1 in 50ms`; no long-running tagged operation in the window |

**Cron overlap.** `db-backup`'s `VACUUM INTO` runs 02:00 UTC (09:00 Bangkok). Across 6 nights it
overlaps exactly **one** slow-tx: `#5989` at 2026-09-11T02:00:23.927 held 20,230 ms (started
02:00:03.7; VACUUM ran 02:00:00.572 → 02:00:20.204). `cleanup-videos` (03:00 UTC) overlaps **zero**
slow-tx on any day (`03:00–03:05` UTC empty).

**Verdict:** no single holder is identifiable with the current instrumentation. 60 % of windows
contain no tagged application line at all, and the timer cannot distinguish holder from waiter.
The one structural candidate found by source inspection is the story-film lease (see §A1.8 #2).

---

## §A1.3 Database anatomy

| PRAGMA | value | note |
|---|---|---|
| `page_size` | 4,096 | |
| `page_count` | 135,682 | = 555,753,472 B = 555.75 MB (matches the file) |
| `freelist_count` | 638 | 2.6 MB = 0.47 % — no meaningful bloat |
| `journal_mode` | `wal` | |
| `wal_autocheckpoint` | 1,000 pages | ≈ 4,120,032 B including frame headers |
| `cache_size` | −2,000 | sqlite3 CLI session default; the app sets −65,536 (64 MiB) per connection at boot (`src/lib/prisma.ts`) |
| `auto_vacuum` | 0 | none |
| `journal_size_limit` | −1 | WAL is never truncated → its size is a high-water mark |
| `mmap_size` | 0 | |
| `compile_options` | includes `ENABLE_DBSTAT_VTAB` | dbstat path used below |

sqlite3 3.37.2 on the box (`/usr/bin/sqlite3`), opened as `sqlite3 -readonly "file:…?mode=ro"`.
`dbstat` total = **527.52 MB** live (vs 555.75 MB file ⇒ 28.2 MB unused/free).

### Logical footprint (table + its own indexes), top 20

| logical table | MB | share of 527.52 MB |
|---|---:|---:|
| TelemetryEvent | 149.41 | **28.3 %** |
| VideoJob | 142.44 | 27.0 % |
| SupportTicket | 53.54 | 10.1 % |
| RenderJob | 41.77 | 7.9 % |
| MediaObject | 34.57 | 6.6 % |
| User | 27.06 | 5.1 % |
| ProjectVisualBeat | 17.44 | 3.3 % |
| Video | 11.49 | 2.2 % |
| Notification | 10.64 | 2.0 % |
| AiGenerationJob | 9.68 | 1.8 % |
| EditorProject | 7.68 | 1.5 % |
| GeneratedImage | 3.17 | 0.6 % |
| ProductUpdateRead | 2.69 | 0.5 % |
| StockSearchCache | 2.43 | 0.5 % |
| ContentPreflight | 2.19 | 0.4 % |
| AiGenerationAttempt | 2.19 | 0.4 % |
| CreditLedger | 1.45 | 0.3 % |
| ToolCallAudit | 1.32 | 0.3 % |
| Script | 1.09 | 0.2 % |
| ChargedClip | 1.05 | 0.2 % |

TelemetryEvent's own indexes are 70.4 MB of its 149.41 MB (6 secondary indexes + 2 unique):
`sessionId_createdAt` 15.17 · `userId_createdAt` 11.86 · autoindex 11.37 · `name_createdAt` 10.11 ·
`category_createdAt` 8.33 · `step_createdAt` 5.83 · `createdAt` 5.01 · `dedupeKey` 2.73 MB.

### Row counts

| table | rows | | table | rows |
|---|---:|---|---|---:|
| TelemetryEvent | 305,452 | | User | 1,275 |
| MediaObject | 52,228 | | ContentPreflight | 918 |
| Notification | 16,537 | | Payment | 226 |
| ProjectVisualBeat | 12,334 | | SupportTicket | 223 |
| AiGenerationJob | 5,764 | | StoryFilmArtifact | 116 |
| ToolCallAudit | 4,920 | | StoryFilmGenerationJob | **114** |
| RenderJob | 4,771 | | BrandLookPreviewItem | 99 |
| VideoJob | 4,066 | | | |
| EditorProject | 2,346 | | tables / indexes in schema | 76 / 272 |
| Video | 1,585 | | | |

### Column sizes

| measurement | avg | max |
|---|---:|---:|
| `RenderJob.payload` | 7,232 B | 53,636 B |
| `TelemetryEvent.properties` | 107 B | 2,841 B |

`SupportTicket` = 53.54 MB over 223 rows (**240 KB/row**); the table stores `imageBase64` (and
`imageMimeType`, `imageName`) inline.

### Retention

| table | age check | rows | share |
|---|---|---:|---:|
| TelemetryEvent | total | 305,452 | 100 % |
| TelemetryEvent | older than 30 d | 203,002 | 66 % |
| TelemetryEvent | older than 60 d | 124,742 | 41 % |
| TelemetryEvent | last 7 d | 30,177 | 10 % |
| Notification | older than 30 d | 9,740 | 59 % |
| VideoJob | older than 30 d | 1,774 | 44 % |
| RenderJob | older than 30 d | 2,611 | 55 % |

TelemetryEvent oldest row 2026-06-13, newest 2026-09-12 (91 days). Rows per Bangkok day
(last 10): 317 (partial) · 5,553 · 6,858 · 5,671 · 4,663 · 3,201 · 2,280 · 1,700 · 3,011 · 2,581.
`cleanup-videos` deletes 1,447–5,114 TelemetryEvent rows per night, which is roughly the daily
insert rate — the table is stable-ish in growth but the 91-day tail is never pruned.

### Stale snapshots and disk

| measurement | value |
|---|---|
| `ls prisma/ \| grep -c 'dev\.db\.'` | **125** |
| of which real `.db` snapshots (excluding `-shm`/`-wal` sidecars) | 64 |
| `du -sh prisma/` | **19 GB** |
| `du -sh /var/backups/heroai` | **11 GB** |
| `df -h /` | 388 G total, 256 G used, 133 G avail, **66 %** |

Oldest in-tree snapshot: `dev.db.bak-golive-2026-06-05-0828` (2026-06-05). Largest:
`dev.db.before-blank-caption-20260830-0028` (381.7 MB), `dev.db.before-subtitle-hotfix-20260827T181856Z`
(369.3 MB), `dev.db.before-broll-timeline-20260827T115345Z` (366.7 MB).

---

## §A1.4 WAL / backup / checkpoint interplay

### WAL size samples

| sample | time (UTC) | time (Bangkok) | `dev.db-wal` bytes | ratio vs 4,120,032 B threshold |
|---|---|---|---:|---:|
| 1 | 2026-09-11 20:47:00 | 2026-09-12 03:47 | 35,201,312 | **8.54×** |
| 2 | 2026-09-11 20:59:26 | 2026-09-12 03:59 | 35,201,312 | 8.54× |
| 3 | 2026-09-11 21:33:29 | 2026-09-12 04:33 | 35,201,312 | 8.54× |

Per the dispatch, samples 1 and 2 bracket this task's run; the third one-hour sample was taken by
Task A1b (`ls -l` + `date -u` on the same files, §A1.5's "A1b" command list). WAL size is
byte-identical to samples 1 and 2 — `dev.db-wal` mtime (21:32) predates the sample and no
checkpoint fired between samples 2 and 3, consistent with the high-water-mark behavior already
noted (`journal_size_limit = -1`).

≈ 8,544 WAL frames at the high-water mark against a 1,000-frame `wal_autocheckpoint`.

### Checkpoint cadence (30-second sampling, 2026-09-11 21:00:18 → 21:04:18 UTC)

| sample (UTC) | `dev.db` size | `dev.db` mtime (UTC) | `dev.db-wal` size | `dev.db-wal` mtime (UTC) |
|---|---:|---|---:|---|
| 21:00:18 | 555,753,472 | 20:47:36 | 35,201,312 | 21:00:04 |
| 21:00:48 | 555,753,472 | 20:47:36 | 35,201,312 | 21:00:04 |
| 21:01:18 | 555,753,472 | 20:47:36 | 35,201,312 | 21:01:17 |
| 21:01:48 | 555,753,472 | 20:47:36 | 35,201,312 | 21:01:17 |
| 21:02:18 | 555,753,472 | 20:47:36 | 35,201,312 | 21:01:17 |
| 21:02:48 | 555,753,472 | 20:47:36 | 35,201,312 | 21:01:17 |
| 21:03:18 | 555,753,472 | 20:47:36 | 35,201,312 | 21:03:08 |
| **21:03:48** | 555,753,472 | **21:03:40** | 35,201,312 | 21:03:40 |
| 21:04:18 | 555,753,472 | 21:03:40 | 35,201,312 | 21:04:10 |

Reading: the WAL is written continuously and **reused in place**; because
`journal_size_limit = -1` SQLite never truncates it, so 35.2 MB is a high-water mark, not a
current backlog. Two checkpoints are visible in the sampled period (`dev.db` mtime 20:47:36 then
21:03:40) — **one checkpoint every ~16 minutes**, and `dev.db` size never changed, i.e. the
checkpoints wrote back in place.

**Verdict on starvation:** a WAL that reached **8.5× the autocheckpoint threshold** is direct
evidence that checkpointing *was* starved — SQLite only grows the WAL past 1,000 pages when the
autocheckpoint at commit cannot copy the frames back, i.e. a reader is still holding an older
snapshot. A checkpoint interval of ~16 minutes against a 1,000-page (≈4 MB) autocheckpoint budget
says the same thing in the present tense: the WAL routinely carries many multiples of the
threshold between checkpoints. What is *not* true is unbounded growth — during 17 minutes of
observation the WAL neither grew nor shrank and two checkpoints completed.
There is no historical WAL-size series recorded anywhere on the box, so the brief's "WAL around
02:00–02:30 vs 09:00" comparison **cannot be reconstructed retroactively** — flagged as a gap,
not a finding. (Task B6 will need a forward-looking sample if it wants that curve.)

### Nightly `VACUUM INTO` (`db-backup`, cron `0 2 * * *` UTC = 09:00 Bangkok)

| night (UTC) | start | end | duration | snapshot size |
|---|---|---|---:|---:|
| 2026-09-06 | 02:00:00.456 | 02:00:11.090 | 10.6 s | 432.5 MB |
| 2026-09-07 | 02:00:00.353 | 02:00:10.719 | 10.4 s | 435.9 MB |
| 2026-09-08 | 02:00:00.434 | 02:00:12.906 | 12.5 s | 446.6 MB |
| 2026-09-09 | 02:00:00.408 | 02:00:15.134 | 14.7 s | 458.2 MB |
| 2026-09-10 | 02:00:00.493 | 02:00:11.033 | 10.5 s | 474.9 MB |
| 2026-09-11 | 02:00:00.572 | 02:00:20.204 | **19.6 s** | 504.3 MB |

Snapshot grew 432.5 → 504.3 MB in 6 days ≈ **12 MB/day**; duration is tracking it upward.
`VACUUM INTO` opens a long read transaction — this is exactly the kind of reader that can starve a
checkpoint — but its measured overlap with slow transactions is 1 event in 6 nights (§A1.2).

Off-box copy is **not configured** (`BACKUP_RSYNC_TARGET not set`); retention 14 days,
`/var/backups/heroai` holds 14 dailies + 5 ad-hoc snapshots = 11 GB.

### Other nightly jobs

| job | cron (UTC) | last observed effect | slow-tx in its window |
|---|---|---|---:|
| `cleanup-videos` | `0 3 * * *` | 1,447–5,114 TelemetryEvent rows deleted/night; `remotionTmpDeleted` 0 | **0** on every day |
| `media-cleanup` | `30 3 * * *` | report-only (`candidates` 12,942, `expired` 12,942, apply disabled) | not observed |
| `disk-watch` | `0 5 * * *` | usedPercent 58–64 %, swept 0–63 MB | not observed |
| `founding-sweep` / `reconcile-processing` / `reconcile-ai-images` | `*/15 * * * *` | all no-ops (released=0, stale=0, scanned=0) | 12 of 217 windows (6 %) |

---

## §A1.5 Query plans (Task A1b)

`EXPLAIN QUERY PLAN` run read-only on prod (`sqlite3 -readonly "file:…?mode=ro"`) for every SQL
statement in A3 §A3.7 (11 numbered items, 15 statements — item 11 is a write, planned via its
`SELECT`-only lookup instead). `?` placeholders replaced with representative literals of the
right type per the dispatch (a status string, an epoch-ms number, a fake id/email for point
lookups); the plan does not depend on the value. SQL is abbreviated to `FROM … WHERE … ORDER BY …
LIMIT ? OFFSET ?` — the full column lists (up to 63 columns for `User`) are verbatim in A3
§A3.7 under the same item numbers and are not reproduced here. Row counts are A1 §A1.3's;
`BundleEntitlement`, `SiteConfig`, `ProductUpdate` are not in that table (it lists only the top
tables) and were counted live in this task (`SELECT COUNT(*)`, read-only) — marked "†".

| # | A3.7 item | SQL (abbreviated) | `EXPLAIN QUERY PLAN` (verbatim) | table rows | verdict | flag |
|---|---|---|---|---:|---|---|
| 1 | 1 | `User WHERE (clerkId=? AND 1=1) LIMIT ? OFFSET ?` | `SEARCH main.User USING INDEX User_clerkId_key (clerkId=?)` | 1,275 | SEARCH USING INDEX `User_clerkId_key` | |
| 2 | 2 | `BundleEntitlement WHERE (email=? AND 1=1) LIMIT ? OFFSET ?` | `SEARCH main.BundleEntitlement USING INDEX sqlite_autoindex_BundleEntitlement_1 (email=?)` | 2† | SEARCH USING INDEX (unique autoindex on `email`) | |
| 3a | 3 (user scan) | `User WHERE 1=1 LIMIT ? OFFSET ?` | `SCAN main.User` | 1,275 | SCAN | |
| 3b | 3 (payment scan) | `Payment WHERE status=? ORDER BY createdAt ASC LIMIT ? OFFSET ?` | `SEARCH main.Payment USING INDEX Payment_status_idx (status=?)` / `USE TEMP B-TREE FOR ORDER BY` | 226 | SEARCH USING INDEX `Payment_status_idx` (+ temp-B-tree sort) | |
| 4a | 4 (current window) | `TelemetryEvent WHERE createdAt>=? ORDER BY createdAt DESC LIMIT 20000 OFFSET ?` | `SEARCH main.TelemetryEvent USING INDEX TelemetryEvent_createdAt_idx (createdAt>?)` | 305,452 | SEARCH USING INDEX `TelemetryEvent_createdAt_idx` | |
| 4b | 4 (previous window) | `TelemetryEvent WHERE (createdAt>=? AND createdAt<?) ORDER BY id ASC LIMIT 20000 OFFSET ?` | `SEARCH main.TelemetryEvent USING INDEX TelemetryEvent_createdAt_idx (createdAt>? AND createdAt<?)` / `USE TEMP B-TREE FOR ORDER BY` | 305,452 | SEARCH USING INDEX (+ temp-B-tree sort on `id`) | |
| 4c | 4 (distinct by name) | `TelemetryEvent WHERE (name=? AND userId IS NOT NULL) LIMIT ? OFFSET ?` | `SEARCH main.TelemetryEvent USING INDEX TelemetryEvent_name_createdAt_idx (name=?)` | 305,452 | SEARCH USING INDEX `TelemetryEvent_name_createdAt_idx` | see note ¹ |
| 5 | 5 | `VideoJob WHERE createdAt>=? LIMIT ? OFFSET ?` | `SEARCH main.VideoJob USING INDEX VideoJob_createdAt_idx (createdAt>?)` | 4,066 | SEARCH USING INDEX `VideoJob_createdAt_idx` | |
| 6a | 6 (constructed `@@index([status,type])`) | `RenderJob WHERE (status=? AND type=?) LIMIT ? OFFSET ?` | `SEARCH main.RenderJob USING INDEX RenderJob_status_type_idx (status=? AND type=?)` | 4,771 | SEARCH USING INDEX `RenderJob_status_type_idx` (full composite match) | |
| 6b | 6 (queue's real hot query, 3 s poll) | `RenderJob WHERE status=? ORDER BY createdAt ASC LIMIT ? OFFSET ?` | `SEARCH main.RenderJob USING INDEX RenderJob_status_type_idx (status=?)` / `USE TEMP B-TREE FOR ORDER BY` | 4,771 | SEARCH USING INDEX (leading-column only; + temp-B-tree sort every poll) | see note ² |
| 6c | 6 (insights range scan) | `RenderJob WHERE createdAt>=? LIMIT ? OFFSET ?` | `SEARCH main.RenderJob USING INDEX RenderJob_createdAt_idx (createdAt>?)` | 4,771 | SEARCH USING INDEX `RenderJob_createdAt_idx` | |
| 7 | 7 | `SupportTicket WHERE status=? ORDER BY createdAt DESC LIMIT ? OFFSET ?` | `SEARCH main.SupportTicket USING INDEX SupportTicket_status_createdAt_idx (status=?)` | 223 | SEARCH USING INDEX `SupportTicket_status_createdAt_idx` | |
| 8 | 8 | `SiteConfig WHERE key IN (?×32) LIMIT ? OFFSET ?` | `SEARCH main.SiteConfig USING INDEX sqlite_autoindex_SiteConfig_1 (key=?)` | 26† | SEARCH USING INDEX (unique autoindex on `key`, per-key probe of the `IN` list) | |
| 9 | 9 | `Notification WHERE (userId=? AND NOT type=?) ORDER BY createdAt DESC LIMIT ? OFFSET ?` | `SCAN main.Notification` / `USE TEMP B-TREE FOR ORDER BY` | 16,537 | SCAN | **⚠️** |
| 10 | 10 | `ProductUpdate WHERE (state=? AND (publishedAt IS NULL OR publishedAt<=?)) ORDER BY isPinned DESC, publishedAt DESC, createdAt DESC LIMIT ? OFFSET ?` | `SEARCH main.ProductUpdate USING INDEX ProductUpdate_state_publishedAt_idx (state=?)` / `USE TEMP B-TREE FOR ORDER BY` | 28† | SEARCH USING INDEX `ProductUpdate_state_publishedAt_idx` (+ temp-B-tree sort) | |
| 11 | 11 (write's `WHERE`, derived — the `UPDATE`/`BEGIN IMMEDIATE`/`COMMIT` was **not executed**) | `SELECT id FROM User WHERE (id=? AND plan IN (?,?) AND (subStatus IS NULL OR subStatus<>?))` | `SEARCH main.User USING INDEX sqlite_autoindex_User_1 (id=?)` | 1,275 | SEARCH USING INDEX (primary key) | not planned (write) |

¹ A3 §A3.7 flags item 4c as unbounded ("scans the whole table forever") because it has no
`createdAt` predicate at all — that is a row-volume risk, not a plan-shape one: the plan itself
is an efficient equality `SEARCH` on `TelemetryEvent_name_createdAt_idx`'s leading column, not a
table `SCAN`. Both things are true at once: good access path, unbounded result set.

² Row count (4,771) is below the 10,000-row flag threshold, so no ⚠️, but this exact statement is
`render/job-store.ts:235`'s polling query, issued every 3 s by every render-worker instance
(§A3.7 item 6, F9) — a `USE TEMP B-TREE FOR ORDER BY` on every poll is cheap at this table size
but is a repeating cost, not a one-off page load, unlike every other row in this table.

**SCAN on a table > 10,000 rows:** only **#9** (`Notification`, 16,537 rows) — confirms A3.7's
prediction that `Notification` carries no `@@index` beyond its primary key. #3a (`User`, `SCAN`,
1,275 rows) is a full-table scan too but the table is small enough to fall under the flag
threshold.

### §A1.5b Affected cohort count

A3 §A3.1's read-only cohort query (accounts that pay the extra `+4` reads / `1` write on every
authenticated request because `resolvePaidEquivalentEntitlement()` finds no qualifying evidence)
run on prod:

| metric | value |
|---|---:|
| cohort count (query verbatim in A3 §A3.1) | **107** |
| total accounts with `plan IN ('PRO','BUSINESS')` | 249 |
| cohort share of PRO/BUSINESS accounts | **107 / 249 = 43.0 %** |

43 % of all PRO/BUSINESS accounts on prod take the extra write-lock transaction on **every**
authenticated request — not a handful of comped edge cases. This is the strongest confirmation
yet, on real prod data, of §A3.1's HERO-10 write-lock hypothesis.

---

## §A1.6 Disk-walk timing (`/api/admin/storage`)

`src/lib/storage-health.ts` runs `du -sk` on four directories via `Promise.all`, each with a
15,000 ms timeout, plus one `df -kP /`.

| directory | `du -sk` result | size | files (`find -type f \| wc -l`) | `du -sk` wall time |
|---|---:|---:|---:|---:|
| `public/renders` | 117,428,804 KB | 112.0 GB | 13,433 | **0.05 s** |
| `stocks` | 38,370,432 KB | 36.6 GB | 21,658 | **0.07 s** |
| `.tmp` | 3,364 KB | 3.3 MB | 686 | 0.00 s |
| `public/music` | 509,788 KB | 498 MB | 108 | 0.00 s |

Warm re-run of `public/renders`: 0.04 s.
**All four in parallel (what the route actually does): 0.072 s** for 35,885 files.

Caveat: the dentry cache was warm (box uptime 70 days, 2.0 GB in buff/cache). This is not a
cold-cache number; it is, however, the number a live admin page sees on a box that has been
serving those directories all day.

---

## §A1.7 Process profile

### `pm2 status` (2026-09-11 20:47 UTC)

| app | id | status | pid | uptime | restarts | unstable | mem |
|---|---:|---|---:|---:|---:|---:|---:|
| ai-content | 5 | online | 3778262 | 107 min | **321** | 0 | 2,011 MB RSS (765 MB reported by `pm2 status`) |
| mcp-video-worker | 8 | online | 3778359 | 107 min | 372 | 0 | 63 MB |
| render-worker | 12 | online | 3778449 | 107 min | 281 | 0 | 64 MB |
| render-worker | 13 | online | 3778507 | 107 min | 280 | 0 | 63 MB |
| story-film-system-worker | 20 | online | 3778410 | 107 min | 76 | 0 | 135 MB |
| pm2-logrotate (module) | 0 | online | 980 | 70 d | 0 | 0 | 39 MB |
| cleanup-videos, db-backup, disk-watch, founding-sweep, media-cleanup, mine-loanwords, north-star-snapshot, reconcile-ai-images, reconcile-processing, renewal-reminders, runpod-image-cost-sync, trial-expiry, trial-reminders | — | stopped | — | — | 0 | 0/1 | 0 |

`stopped` crons are by design (`autorestart: false` + `cron_restart`). All five long-running
processes were started together at 2026-09-11T19:08:44Z — the HERO-27 deploy.

### `pm2 describe ai-content` code metrics

| metric | value |
|---|---|
| Heap Size | 896.75 MiB |
| Used Heap Size | 856.28 MiB |
| Heap Usage | **95.49 %** |
| Active requests | 0 |
| Active handles | 8 |
| Event Loop Latency | 0.38 ms |
| Event Loop Latency p95 | 2.26 ms |
| HTTP Mean Latency | 18 ms |
| interpreter args | `--max-old-space-size=3072` |
| max memory restart | 4 GB |
| node | 22.22.2 · Prisma client 6.19.3 |

### Environment key names (names only; no values read)

`pm2 env 5` exposes 165 keys. `/var/www/ai-content/.env` has 135 keys.

| key | present? | consequence |
|---|---|---|
| `TZ` | **not set** | Node runs in `Etc/UTC` (system tz) |
| `PRISMA_TX_MAX_WAIT_MS` | **not set** | default **10,000 ms** |
| `PRISMA_TX_TIMEOUT_MS` | **not set** | default **30,000 ms** |
| `PRISMA_SLOW_TX_MS` | **not set** | default 2,000 ms |
| `SQLITE_BUSY_TIMEOUT_SEC` | **not set** | default **20 s** (also `socket_timeout=20` on the datasource URL) |
| `SQLITE_CACHE_SIZE_KIB` | **not set** | default 65,536 KiB (64 MiB) per connection |
| `DATABASE_URL`, `NODE_OPTIONS`, `NODE_ENV`, `PORT`, `RENDER_VIA_QUEUE`, `MCP_*`, `STORY_FILM_*` | set | — |

Defaults resolved from `src/lib/prisma-options.ts` at prod HEAD `84e4d8c2`. The three cap values
(20 s / 30 s / 40 s) are exactly the three clusters in the §A1.1 histogram.

### Host

| metric | 20:47 UTC | 20:59 UTC |
|---|---|---|
| load average (1/5/15) | 0.05 / 0.10 / 0.23 | 1.09 / 0.77 / 0.50 |
| RAM total / free / buff-cache | 32,091 / 28,538 / 1,846 MB | 32,091 / 26,958 / 2,086 MB |
| swap used | 94 MB of 32,767 MB | 94 MB |
| `nproc` | 8 | 8 |
| uptime | 70 days | 70 days |
| `df /` | 388 G, 256 G used, 133 G avail, 66 % | same |

Kernel 5.15.0-185-generic. Note: `CLAUDE.md` records "4 vCPU / 15 GB"; the box measures
**8 vCPU / 32 GB** (the second load figure includes this audit's own `dbstat` and `du` work).

---

## §A1.8 Top causes of delay, ranked by evidence

**1. Writer-queue contention on one SQLite file — not slow work.**
219 transactions ≥ 2 s in 2.40 days (≈ 91/day), of which 217 are ≥ 5 s. **150 of 219 (68.5 %)
land within ±500 ms of a configured timeout** (83 at 20 s, 67 at 30 s). Events arrive in
correlated bursts across independent processes: 424 events in 209 clusters, 59 clusters with
≥ 3 events, largest 6 events spanning ai-content and story-film-system-worker. Meanwhile the box
is idle (load 0.05–1.09, 26.9 GB RAM free, event-loop p95 2.26 ms, HTTP mean 18 ms).

**2. A 4-second write-transaction poll from `story-film-system-worker`.**
`leaseStoryFilmGenerationJobs` (`src/lib/story-film-generation-queue.server.ts:224`) opens an
interactive `prisma.$transaction` whose first statement is a write (`requeueExpiredLeases`), then
a `count`, a `findMany` with a relation filter, and an `updateMany` — on every poll, every
`POLL_MS = 4,000` ms (`scripts/story-film-system-worker.ts:41,473`). That is **≈ 21,600 write
transactions/day against a 114-row table**. It is by far the most enriched tag inside slow-tx
windows (**65.2 % of its log lines fall inside one, 36× baseline**), it produces 196 slow
transactions of its own (p50 18.4 s, 83 pinned at the 20 s socket timeout), and it fails its lease
**25 / 24 / 25 times per Bangkok day** with `P1008 Socket timeout`.

**3. Queueing budgets that convert contention into 20–40 s stalls.**
No `PRISMA_*` or `SQLITE_*` key is set on prod, so `maxWait = 10 s`, `timeout = 30 s`,
`busy_timeout`/`socket_timeout = 20 s` apply. A blocked transaction therefore occupies a Node
request slot for 20–40 s instead of failing fast: p50 hold **25.2 s**, p90 30.2 s, max **46.3 s**.
Customer-visible fallout in the same window: 33 `Socket timeout`, 13 `P1008`, 7
`Transaction already closed`, 9 `transient SQLite timeout` retries on ai-content.

**4. Database size and un-retained rows.**
555.75 MB file / 527.52 MB live. **TelemetryEvent is 149.41 MB = 28.3 %** of it, 305,452 rows, of
which **203,002 (66 %) are older than 30 days** and 124,742 (41 %) older than 60; 70.4 MB of that
is index. `SupportTicket` is 53.54 MB for **223 rows** because `imageBase64` is stored inline.
WAL high-water 35.2 MB = **8.54×** the 4.12 MB autocheckpoint threshold. Every page the writer
touches is a page in this file.

**5. Snapshot/back-up sprawl (cost and blast radius, not latency).**
**125** `dev.db.*` entries (64 real snapshots) = **19 GB** inside `prisma/`, plus 11 GB in
`/var/backups/heroai`, on a disk at 66 %. Nightly `VACUUM INTO` has grown 10.4 s → **19.6 s** in
six days as the DB grows ≈ 12 MB/day, and there is no off-box copy
(`BACKUP_RSYNC_TARGET not set`).

### Ruled out by measurement

| suspected cause | measurement | verdict |
|---|---|---|
| `/api/admin/storage` disk walk | 0.072 s for 4 dirs / 35,885 files in parallel | **not a cause** |
| `db-backup` `VACUUM INTO` (02:00 UTC) | 0 of 217 slow-tx windows overlap; 1 of 219 events started inside a VACUUM, on 1 of 6 nights | **negligible** |
| `cleanup-videos` (03:00 UTC) | 0 slow-tx in 03:00–03:05 UTC on any day | **not a cause** |
| Remotion render progress logging | `[Render]` appears in windows at 0.97× baseline | **not a cause** |
| render-worker DB pressure | 0 slow-tx across both instances; 4 `Socket timeout`, 3 `P1008` total | **not a cause** |
| Host CPU / RAM / disk saturation | load ≤ 1.09 on 8 vCPU, 26.9 GB free, 66 % disk, event-loop p95 2.26 ms | **not a cause** |
| Network I/O inside a transaction | only `src/lib/hero-voice-canary-review.server.ts` combines `$transaction(` with an awaited network call; not in the hot path | **not found in the hot path** |
| Freelist / page bloat | `freelist_count` 638 = 0.47 % | **not a cause** |

### B6 decision inputs

| question | answer | evidence |
|---|---|---|
| **Is `wal_autocheckpoint` starved?** | **Yes — but not runaway.** WAL high-water 35,201,312 B = **8.54×** the 4,120,032 B threshold (≈ 8,544 frames vs 1,000), and checkpoints land only about **every 16 minutes** (`dev.db` mtime 20:47:36 → 21:03:40 during 17 min of 30 s sampling), so the WAL routinely carries many multiples of the 1,000-page budget between checkpoints. Growth is not unbounded: size was flat across all samples and two checkpoints completed. `journal_size_limit = -1` means the file never truncates. No historical WAL series exists on the box. | §A1.4 |
| **Is a transaction holding I/O?** | **Not demonstrated.** 75 % of ai-content slow transactions log no error and 60 % of windows contain no tagged application line; `[prisma-slow-tx]` records only a counter + duration, so holder and waiter are indistinguishable. The single structural candidate is the 4 s write-first story-film lease transaction (#2 above). Source inspection found **no** network call inside a hot-path transaction. | §A1.2 |
| **TelemetryEvent share of the DB** | **149.41 MB of 527.52 MB = 28.3 %** (305,452 rows; 66 % older than 30 d; 70.4 MB of it index) | §A1.3 |
| **SCAN candidates for A1b** | Deferred to §A1.5. Plan at minimum: `TelemetryEvent` (305 k rows, 8 indexes), `MediaObject` (52,228 rows), `VideoJob` (4,066 rows / 142.44 MB — large `inputJson`/`outputJson` blobs), `RenderJob` (payload avg 7.2 KB), and `leaseStoryFilmGenerationJobs`' relation filter `project: { status: { notIn: [...] } }`, which Prisma compiles to a correlated sub-query inside the 4 s poll transaction. | §A1.5 |

---

## Commands run on production

Every command below was executed over
`ssh -o ConnectTimeout=<n> -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 'bash -s' <<'EOF' … EOF`.
Only the remote script bodies are reproduced.

**1 — WAL sample 1, sqlite3 availability, host profile**
```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'; TZ=Asia/Bangkok date '+%Y-%m-%d %H:%M:%S %Z'
ls -l /var/www/ai-content/prisma/dev.db*
which sqlite3 || echo "NO_SQLITE3"
sqlite3 --version 2>/dev/null || true
uname -a
nproc
free -m
uptime
df -h
```

**2 — PM2 log inventory**
```bash
ls -la /root/.pm2/logs/ | head -80
du -sh /root/.pm2/logs/
```

**3 — PM2 status, snapshot inventory**
```bash
pm2 status
ls /var/www/ai-content/prisma/ | grep -c 'dev\.db\.'
du -sh /var/www/ai-content/prisma/
du -sh /var/backups/heroai 2>&1 || echo "NO /var/backups/heroai"
ls -la /var/backups/ 2>&1 | head -20
```

**4 — log-format probe (the brief's stop-check)**
```bash
cd /root/.pm2/logs
head -3 /root/.pm2/logs/ai-content-error.log
head -3 /root/.pm2/logs/ai-content-out.log
grep -m 3 'prisma-slow-tx' /root/.pm2/logs/ai-content-out.log | cut -c1-220
for f in /root/.pm2/logs/ai-content-out.log /root/.pm2/logs/ai-content-error.log; do echo -n "$f: "; grep -c 'prisma-slow-tx' "$f" || true; done
grep -c 'prisma-slow-tx' /root/.pm2/logs/ai-content-out.log || true
grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx' /root/.pm2/logs/ai-content-out.log || true
grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms' /root/.pm2/logs/ai-content-out.log || true
cat /etc/timezone 2>/dev/null; timedatectl 2>/dev/null | head -6
```

**5 — untimestamped-line census**
```bash
cd /root/.pm2/logs
zcat -f ai-content-error.log ai-content-error__*.log* ai-content-error.log.1.gz 2>/dev/null | grep -c 'prisma-slow-tx'
zcat -f ai-content-error.log ai-content-error__*.log* ai-content-error.log.1.gz 2>/dev/null | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx'
zcat -f ai-content-error.log ai-content-error__*.log* ai-content-error.log.1.gz 2>/dev/null | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms'
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -c 'prisma-slow-tx'
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms'
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}' | sort | uniq -c | head -5
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}' | sort | uniq -c | tail -3
zcat -f ai-content-out.log ai-content-out__*.log 2>/dev/null | grep -c 'prisma-slow-tx'
```

**6 — per-file timestamp coverage**
```bash
cd /root/.pm2/logs
for f in ai-content-error__2026-09-07_00-00-00.log ai-content-error__2026-09-08_00-00-00.log \
         ai-content-error__2026-09-09_00-00-00.log ai-content-error__2026-09-10_00-00-00.log \
         ai-content-error__2026-09-11_00-00-00.log ai-content-error.log; do
  echo "--- $f ---"
  echo -n "lines=$(wc -l < $f)  iso_lines="; grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$f" || true
  echo -n "  first ts: "; grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}' "$f" | head -1
  echo -n "  last  ts: "; grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}' "$f" | tail -1
  echo -n "  slow-tx: "; grep -c 'prisma-slow-tx' "$f" || true
done
```

**7 — untimestamped sample, out-log + worker coverage**
```bash
cd /root/.pm2/logs
head -3 ai-content-error__2026-09-08_00-00-00.log | cut -c1-150
grep -nE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' ai-content-error__2026-09-10_00-00-00.log | head -1
for f in ai-content-out__2026-09-07_00-00-00.log ai-content-out__2026-09-08_00-00-00.log \
         ai-content-out__2026-09-09_00-00-00.log ai-content-out__2026-09-10_00-00-00.log \
         ai-content-out__2026-09-11_00-00-00.log ai-content-out.log; do
 echo -n "$f lines=$(wc -l < $f) iso="; grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$f" || true
done
for f in mcp-video-worker-out.log mcp-video-worker-error.log story-film-system-worker-out.log \
         story-film-system-worker-error.log render-worker-out.log render-worker-error.log; do
 if [ -f "$f" ]; then echo -n "$f lines=$(wc -l < $f) iso="; grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$f" || true; fi
done
ls -la | grep -E 'story-film|render-worker'
```

**8 — slow-tx census by Bangkok day / hour, pooled percentiles**
```bash
cd /root/.pm2/logs
for f in render-worker-out-12.log render-worker-out-13.log render-worker-error-12.log render-worker-error-13.log; do
 echo -n "$f lines=$(wc -l < $f) iso="; grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$f" || true
done
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null \
 | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms' \
 | sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})[^ ]*.*held ([0-9]+)ms.*/\1 \2/p' \
 | awk '{ cmd="date -u -d \""$1"Z +7 hours\" +%Y-%m-%d"; cmd | getline bkk; close(cmd); print bkk, $2 }' \
 | sort -k1,1 -k2,2n \
 | awk '{ d=$1; v[d][++n[d]]=$2; if ($2>=5000) big[d]++ } END { for (d in n) { c=n[d]; p50=v[d][int((c+1)/2)]; i90=int(c*0.9); if(i90<1)i90=1; p90=v[d][i90]; mx=v[d][c]; printf "%s count=%d ge5000=%d p50=%d p90=%d max=%d\n", d, c, big[d]+0, p50, p90, mx } }' | sort
# (same pipeline with +%Y-%m-%d_%H and with +%H for the hourly tables)
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null \
 | grep -oE 'prisma-slow-tx\] #[0-9]+ held [0-9]+ms' | grep -oE 'held [0-9]+ms' | grep -oE '[0-9]+' \
 | sort -n | awk '{v[NR]=$1} END { printf "n=%d p50=%d p75=%d p90=%d p95=%d max=%d min=%d\n", NR, v[int((NR+1)/2)], v[int(NR*0.75)], v[int(NR*0.9)], v[int(NR*0.95)], v[NR], v[1] }'
```

**9 — error-marker counts per Bangkok day (ai-content)**
```bash
cd /root/.pm2/logs
for pat in 'Socket timeout' 'Transaction already closed' 'P1008' 'SQLITE_BUSY' 'database is locked'; do
  echo "--- pattern: $pat ---"
  zcat -f ai-content-error.log ai-content-error__*.log ai-content-out.log ai-content-out__*.log 2>/dev/null | grep -cF "$pat" || true
  zcat -f ai-content-error.log ai-content-error__*.log ai-content-out.log ai-content-out__*.log 2>/dev/null \
   | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' | grep -F "$pat" \
   | sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}).*/\1/p' \
   | awk '{ cmd="date -u -d \""$1"Z +7 hours\" +%Y-%m-%d"; cmd | getline b; close(cmd); n[b]++ } END { for (d in n) printf "  BKK %s = %d\n", d, n[d] }' | sort
done
```

**10 — worker census (mcp-video-worker, story-film-system-worker, render-worker 12/13)**
```bash
cd /root/.pm2/logs
zcat -f ai-content-error.log ai-content-error__*.log ai-content-out.log ai-content-out__*.log 2>/dev/null | grep -F 'database is locked' | cut -c1-200
for pat in 'Socket timeout' 'Transaction already closed' 'P1008' 'prisma-slow-tx'; do
 zcat -f ai-content-error.log ai-content-error__*.log ai-content-out.log ai-content-out__*.log 2>/dev/null | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' | grep -cF "$pat" || true
done
for app in mcp-video-worker story-film-system-worker; do
 files=$(ls ${app}-error.log ${app}-error__*.log ${app}-out.log ${app}-out__*.log 2>/dev/null | tr '\n' ' ')
 zcat -f $files 2>/dev/null | wc -l
 zcat -f $files 2>/dev/null | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' || true
 for pat in 'prisma-slow-tx' 'Socket timeout' 'Transaction already closed' 'P1008' 'SQLITE_BUSY' 'database is locked'; do
   zcat -f $files 2>/dev/null | grep -cF "$pat" || true
 done
 # plus the per-Bangkok-day slow-tx pipeline from command 8
done
for inst in 12 13; do
 files=$(ls render-worker-error-${inst}.log render-worker-error-${inst}__*.log render-worker-out-${inst}.log \
            render-worker-out-${inst}__*.log render-worker-out-${inst}.log.1.gz 2>/dev/null | tr '\n' ' ')
 # same counters
done
zcat -f story-film-system-worker-*.log 2>/dev/null | grep -oE '\[story-film-system\][^"]{0,90}' \
 | sed -E 's/[0-9a-f]{8,}/<ID>/g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -20
```

**11 — prod HEAD, instrumentation source, cron schedule**
```bash
cd /var/www/ai-content
git log -1 --format='%H %ci %s'
grep -rn 'prisma-slow-tx' src/ scripts/ 2>/dev/null | head -20
grep -nE "name:|cron_restart|autorestart|script:" ecosystem.config.js | sed -n '1,200p'
```

**12 — tag-enrichment correlation over all slow-tx windows**
```bash
cd /root/.pm2/logs
LOGS="ai-content-error.log ai-content-error__*.log ai-content-out.log ai-content-out__*.log \
      story-film-system-worker-*.log mcp-video-worker-*.log render-worker-error-12*.log \
      render-worker-error-13*.log render-worker-out-12*.log render-worker-out-13.log \
      db-backup-out*.log cleanup-videos-out*.log media-cleanup-out*.log reconcile-*-out*.log \
      north-star-snapshot-out*.log mine-loanwords-out*.log disk-watch-out*.log founding-sweep-out*.log"
awk '
FNR==NR { t=$1+0; h=$2+0; if (h < 5000) next; ev++; start = t - int(h/1000) - 2; for (s=start; s<=t; s++) win[s]=1; next }
{ if ($0 !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/) next;
  ts = substr($0,1,19); gsub(/T/," ",ts);
  if (!(ts in ecache)) { cmd = "date -u -d \"" ts "\" +%s"; cmd | getline e; close(cmd); ecache[ts]=e }
  e = ecache[ts]; tag="";
  if (match($0, /\[[a-zA-Z0-9_\/:-]+\]/)) tag = substr($0, RSTART, RLENGTH);
  if (tag=="") next; total[tag]++; if (e in win) inwin[tag]++ }
END { printf "events_ge5000=%d window_seconds=%d\n", ev, length(win);
      for (t in inwin) printf "%d\t%d\t%s\n", inwin[t], total[t], t }
' <(zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null \
     | grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms" \
     | sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})[^ ]*.*held ([0-9]+)ms.*/\1 \2 \3/p' \
     | while read d t h; do echo "$(date -u -d "$d $t" +%s) $h"; done) \
   <(zcat -f $LOGS 2>/dev/null) | sort -t$'\t' -k1,1nr | head -45
```

**13 — window-seconds coverage, timestamped span, cross-process overlap**
```bash
cd /root/.pm2/logs
mkev() { zcat -f $1 2>/dev/null | grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms" \
   | sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})[^ ]*.*held ([0-9]+)ms.*/\1 \2 \3/p' \
   | while read d t h; do echo "$(date -u -d "$d $t" +%s) $h"; done; }
mkev "ai-content-error.log ai-content-error__*.log" \
 | awk '$2>=5000{ev++; s=$1-int($2/1000)-2; for(i=s;i<=$1;i++)w[i]=1} END{printf "events=%d window_seconds=%d\n", ev, length(w)}'
zcat -f ai-content-out.log ai-content-out__*.log ai-content-error.log ai-content-error__*.log 2>/dev/null \
 | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | sort | sed -n '1p;$p'
awk 'FNR==NR{ if($2>=5000){ev++; s=$1-int($2/1000)-2; for(i=s;i<=$1;i++)w[i]=ev} next }
     { if($1 in w) hit[w[$1]]=1; sf++ }
     END{ n=0; for(k in hit)n++; printf "ai_events_ge5000=%d story_film_events=%d overlap=%d (%.1f%%)\n", ev, sf, n, 100.0*n/ev }' \
 <(mkev "ai-content-error.log ai-content-error__*.log") <(mkev "story-film-system-worker-*.log")
# and the reverse direction with the two inputs swapped
```

**14 — cron-window checks and top-10 longest events**
```bash
cd /root/.pm2/logs
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -E '^[0-9-]+T0[12]:[0-9]{2}:[0-9]{2}.*prisma-slow-tx' | head -20
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -E '^[0-9-]+T03:0[0-5]:.*prisma-slow-tx' | head -20
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -oE '^[0-9-]+T([0-9]{2}):.*prisma-slow-tx' | grep -oE 'T[0-9]{2}:' | sort | uniq -c
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null \
 | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx.*held [0-9]+ms' \
 | sed -nE 's/^([0-9-]+T[0-9:]{8})[^ ]*.*held ([0-9]+)ms.*/\2 \1/p' | sort -rn | head -10
```

**15 — window context dumps for the three longest events**
```bash
cd /root/.pm2/logs
LOGS="ai-content-error.log ai-content-error__*.log ai-content-out.log ai-content-out__*.log \
      story-film-system-worker-*.log mcp-video-worker-*.log render-worker-error-12*.log \
      render-worker-error-13*.log db-backup-out*.log founding-sweep-out*.log \
      reconcile-processing-out*.log reconcile-ai-images-out*.log"
show() { zcat -f $LOGS 2>/dev/null | grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" \
   | awk -v a="$1" -v b="$2" 'substr($0,1,19)>=a && substr($0,1,19)<=b' | sort \
   | sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/<email>/g' | cut -c1-190 | head -40; }
show "2026-09-09T17:03:42" "2026-09-09T17:04:31"
show "2026-09-09T16:51:29" "2026-09-09T16:52:18"
show "2026-09-11T12:07:54" "2026-09-11T12:08:42"
show "2026-09-11T01:58:44" "2026-09-11T01:59:18"
```

**16 — SQLite PRAGMAs and compile options**
```bash
DB=/var/www/ai-content/prisma/dev.db
sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
.timeout 5000
SELECT 'page_size', * FROM pragma_page_size();
SELECT 'page_count', * FROM pragma_page_count();
SELECT 'freelist_count', * FROM pragma_freelist_count();
SELECT 'journal_mode', * FROM pragma_journal_mode();
SELECT 'cache_size', * FROM pragma_cache_size();
SELECT 'auto_vacuum', * FROM pragma_auto_vacuum();
SQL
sqlite3 -readonly "file:$DB?mode=ro" "SELECT * FROM pragma_compile_options();"
sqlite3 -readonly "file:$DB?mode=ro" "PRAGMA wal_autocheckpoint;"
sqlite3 -readonly "file:$DB?mode=ro" "PRAGMA journal_size_limit; PRAGMA mmap_size;"
```

**17 — dbstat per-table and per-logical-table footprint**
```bash
DB=/var/www/ai-content/prisma/dev.db
time sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
.mode list
.separator "|"
SELECT name, round(SUM(pgsize)/1048576.0, 2) AS mb, count(*) AS pages
FROM dbstat GROUP BY name ORDER BY mb DESC LIMIT 25;
SQL
sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
.mode list
.separator "|"
WITH m AS (SELECT name AS obj, CASE WHEN type='index' THEN tbl_name ELSE name END AS tbl
           FROM sqlite_master WHERE type IN ('table','index'))
SELECT COALESCE(m.tbl, d.name) AS logical_table, round(SUM(d.pgsize)/1048576.0,2) AS mb
FROM dbstat d LEFT JOIN m ON m.obj = d.name
GROUP BY logical_table ORDER BY mb DESC LIMIT 20;
SQL
sqlite3 -readonly "file:$DB?mode=ro" "SELECT round(SUM(pgsize)/1048576.0,2) FROM dbstat;"
```

**18 — row counts, column sizes, retention**
```bash
DB=/var/www/ai-content/prisma/dev.db
sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
SELECT 'TelemetryEvent', count(*) FROM TelemetryEvent
UNION ALL SELECT 'Notification', count(*) FROM Notification
UNION ALL SELECT 'RenderJob', count(*) FROM RenderJob
UNION ALL SELECT 'VideoJob', count(*) FROM VideoJob
UNION ALL SELECT 'ToolCallAudit', count(*) FROM ToolCallAudit
UNION ALL SELECT 'StoryFilmArtifact', count(*) FROM StoryFilmArtifact
UNION ALL SELECT 'StoryFilmGenerationJob', count(*) FROM StoryFilmGenerationJob
UNION ALL SELECT 'BrandLookPreviewItem', count(*) FROM BrandLookPreviewItem
UNION ALL SELECT 'ContentPreflight', count(*) FROM ContentPreflight
UNION ALL SELECT 'User', count(*) FROM User
UNION ALL SELECT 'Payment', count(*) FROM Payment
UNION ALL SELECT 'Video', count(*) FROM Video
UNION ALL SELECT 'SupportTicket', count(*) FROM SupportTicket
UNION ALL SELECT 'MediaObject', count(*) FROM MediaObject
UNION ALL SELECT 'ProjectVisualBeat', count(*) FROM ProjectVisualBeat
UNION ALL SELECT 'EditorProject', count(*) FROM EditorProject
UNION ALL SELECT 'AiGenerationJob', count(*) FROM AiGenerationJob;
SQL
sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
SELECT 'RenderJob.payload avg/max bytes', round(avg(length(payload)),0), max(length(payload)) FROM RenderJob;
SELECT 'TelemetryEvent.properties avg/max bytes', round(avg(length(properties)),0), max(length(properties)) FROM TelemetryEvent;
SQL
sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
SELECT 'oldest', date(min(createdAt)/1000,'unixepoch','+7 hours'), 'newest', date(max(createdAt)/1000,'unixepoch','+7 hours') FROM TelemetryEvent;
SELECT date(createdAt/1000,'unixepoch','+7 hours') d, count(*) FROM TelemetryEvent GROUP BY d ORDER BY d DESC LIMIT 10;
SQL
sqlite3 -readonly "file:$DB?mode=ro" <<'SQL'
SELECT 'total', count(*) FROM TelemetryEvent;
SELECT 'older_than_30d', count(*) FROM TelemetryEvent WHERE createdAt < (strftime('%s','now')-30*86400)*1000;
SELECT 'older_than_60d', count(*) FROM TelemetryEvent WHERE createdAt < (strftime('%s','now')-60*86400)*1000;
SELECT 'last_7d', count(*) FROM TelemetryEvent WHERE createdAt >= (strftime('%s','now')-7*86400)*1000;
SELECT 'Notification older_than_30d', count(*) FROM Notification WHERE createdAt < (strftime('%s','now')-30*86400)*1000;
SELECT 'VideoJob older_than_30d', count(*) FROM VideoJob WHERE createdAt < (strftime('%s','now')-30*86400)*1000;
SELECT 'RenderJob older_than_30d', count(*) FROM RenderJob WHERE createdAt < (strftime('%s','now')-30*86400)*1000;
SQL
sqlite3 -readonly "file:$DB?mode=ro" "SELECT count(*) FROM sqlite_master WHERE type='index';"
sqlite3 -readonly "file:$DB?mode=ro" "SELECT count(*) FROM sqlite_master WHERE type='table';"
sqlite3 -readonly "file:$DB?mode=ro" ".schema SupportTicket"
sqlite3 -readonly "file:$DB?mode=ro" ".schema VideoJob"
```

**19 — backup / cleanup / disk-watch cron logs**
```bash
pm2 describe db-backup | sed -n '1,40p'
pm2 logs db-backup --lines 300 --nostream | tail -60
sed -n '1,80p' /var/www/ai-content/scripts/backup-db.ts
cd /root/.pm2/logs
zcat -f db-backup-out.log db-backup-out__*.log 2>/dev/null | grep -E 'source=|snapshot OK' \
  | sed -E 's#source=[^ ]*#source=<db>#; s#dest=[^ ]*#dest=<dest>#'
zcat -f cleanup-videos-out.log cleanup-videos-out__*.log 2>/dev/null | cut -c1-200
tail -12 media-cleanup-out.log | cut -c1-200
zcat -f disk-watch-out.log disk-watch-out__*.log 2>/dev/null | cut -c1-200
ls -l /var/backups/heroai/ | head -25
```

**20 — hold-time histograms, per-window classification, holder/victim split, burst structure**
```bash
cd /root/.pm2/logs
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null \
 | sed -nE 's/.*prisma-slow-tx\] #[0-9]+ held ([0-9]+)ms.*/\1/p' \
 | awk '{v=$1; if(v<5000)b="0000-4999"; else if(v<15000)b="5000-14999"; else if(v<19500)b="15000-19499";
         else if(v<20500)b="19500-20499"; else if(v<29500)b="20500-29499"; else if(v<30500)b="29500-30499";
         else if(v<39000)b="30500-38999"; else if(v<41000)b="39000-40999"; else b="41000+"; n[b]++}
        END{for(k in n) printf "%-32s %d\n", k, n[k]}' | sort
# (same for story-film-system-worker-*.log)
awk '
FNR==NR { if($2>=5000){ ev++; s=$1-int($2/1000)-2; for(i=s;i<=$1;i++){ w[i]=ev } } next }
{ if ($0 !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/) next;
  ts=substr($0,1,19); gsub(/T/," ",ts);
  if (!(ts in ec)) { cmd="date -u -d \"" ts "\" +%s"; cmd|getline e; close(cmd); ec[ts]=e }
  e=ec[ts]; if (!(e in w)) next; id=w[e];
  if ($0 ~ /story-film-system\] lease failed/) sf[id]=1;
  if ($0 ~ /\[fetch-stock\]/) fs[id]=1;
  if ($0 ~ /\[mcp-worker\] job/) mw[id]=1;
  if ($0 ~ /\[stripe-webhook\]/) sw[id]=1;
  if ($0 ~ /\[backup-db\]/) bk[id]=1;
  if ($0 ~ /\[founding-sweep\]|\[reconcile-/) cr[id]=1;
  if ($0 ~ /\[transcribe\]|\[tts-gemini\]|\[tts\]/) tt[id]=1;
  if ($0 ~ /\[Render\]|\[render\]|\[render-worker\]/) rd[id]=1 }
END{ ... per-category counts ... }' <(mkev) <(zcat -f $LOGS 2>/dev/null)
# holder/victim split (v2 patterns) and burst clustering
zcat -f ai-content-error.log ai-content-error__*.log 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' \
 | awk '{ ts=substr($0,1,19); gsub(/T/," ",ts);
     if (!(ts in ec)) { cmd="date -u -d \"" ts "\" +%s"; cmd|getline e; close(cmd); ec[ts]=e } e=ec[ts];
     if ($0 ~ /prisma-slow-tx\] #[0-9]+ held/) { match($0,/held [0-9]+ms/); h=substr($0,RSTART+5,RLENGTH-7)+0; ev[++n]=e; hold[n]=h; next }
     if ($0 ~ /P1008|Socket timeout|Transaction already closed|transient SQLite|transient-db-retry|database is locked/) err[e]=1 }
   END{ for(i=1;i<=n;i++){ if(hold[i]<5000) continue; t++; hit=0; for(d=-2;d<=2;d++) if((ev[i]+d) in err) hit=1; if(hit)victim++; else holder++ }
        printf "ge5000=%d VICTIM=%d HOLDER-candidate=%d\n", t, victim, holder }'
zcat -f ai-content-error.log ai-content-error__*.log story-film-system-worker-*.log 2>/dev/null \
 | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*prisma-slow-tx' \
 | sed -nE 's/^([0-9-]+T[0-9:]{8}).*held ([0-9]+)ms.*/\1 \2/p' \
 | while read t h; do ts=${t/T/ }; echo "$(date -u -d "$ts" +%s) $h"; done | sort -n \
 | awk '{ if (prev=="" || $1-prev>5) {c++; size[c]=0} size[c]++; if(size[c]>mx)mx=size[c]; prev=$1 }
        END{ for(i=1;i<=c;i++){n++; s+=size[i]; if(size[i]>=3)big++}
             printf "clusters=%d events=%d mean=%.1f max_cluster=%d ge3=%d\n", n, s, s/n, mx, big+0 }'
```

**21 — mcp-worker step durations**
```bash
cd /root/.pm2/logs
zcat -f mcp-video-worker-out*.log ai-content-out.log ai-content-out__*.log 2>/dev/null \
 | grep -oE 'step=[a-z_-]+ [0-9.]+s' | sed -E 's/s$//' \
 | awk '{split($1,a,"="); n[a[2]]++; s[a[2]]+=$2; if($2>m[a[2]])m[a[2]]=$2}
        END{for(k in n) printf "step=%s n=%d mean=%.2fs max=%.1fs\n", k, n[k], s[k]/n[k], m[k]}' | sort -t= -k2
```

**22 — disk-walk timing (what `/api/admin/storage` executes)**
```bash
cd /var/www/ai-content
for d in public/renders stocks .tmp public/music; do
  /usr/bin/time -f "du -sk %e s (real)" du -sk "$d" 2>&1 | tail -2
  find "$d" -type f 2>/dev/null | wc -l
done
/usr/bin/time -f "du -sk %e s (real)" du -sk public/renders 2>&1 | tail -2
start=$(date +%s.%N)
( du -sk public/renders & du -sk stocks & du -sk .tmp & du -sk public/music & wait ) > /dev/null 2>&1
end=$(date +%s.%N); echo "parallel elapsed: $(echo "$end - $start" | bc) s"
```

**23 — process profile and env key names (names only)**
```bash
pm2 describe ai-content | sed -n '1,45p'
pm2 env 5 | cut -d: -f1 | sort | grep -E '^(TZ|PRISMA|SQLITE|DATABASE|NODE_OPTIONS|NODE_ENV|RENDER_VIA_QUEUE|STORY_FILM|MCP_|PORT)'
pm2 env 5 | wc -l
pm2 env 5 | cut -d: -f1 | grep -cx 'TZ' || echo "TZ_NOT_SET"
pm2 env 5 | cut -d: -f1 | grep -cE '^(PRISMA_|SQLITE_)' || echo "NONE"
cd /var/www/ai-content && cut -d= -f1 .env | sort | grep -E '^(TZ|PRISMA|SQLITE|DATABASE|NODE_|PM2)'
cut -d= -f1 .env | sort | wc -l
sed -n '135,215p' ecosystem.config.js
pm2 jlist | node -e "…restart_time / unstable_restarts / status / memory / uptime per app…"
```

**24 — WAL sample 2, snapshot inventory, host sample 2**
```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'; TZ=Asia/Bangkok date '+%Y-%m-%d %H:%M:%S %Z'
stat -c '%n size=%s mtime=%y' /var/www/ai-content/prisma/dev.db \
   /var/www/ai-content/prisma/dev.db-wal /var/www/ai-content/prisma/dev.db-shm
s=$(stat -c %s /var/www/ai-content/prisma/dev.db-wal)
echo "wal_bytes=$s frames=$(( (s-32)/(4096+24) )) threshold_bytes=$((32+1000*(4096+24)))"
ls /var/www/ai-content/prisma/ | grep -c 'dev\.db\.'
ls /var/www/ai-content/prisma/ | grep 'dev\.db' | grep -vE -- '-(shm|wal)$' | grep -v '^dev.db$' | wc -l
du -sh /var/www/ai-content/prisma/ | cut -f1
du -sh /var/backups/heroai | cut -f1
df -h / | tail -1
free -m; uptime; nproc
```

**25 — checkpoint cadence sampler (30 s × 9)**
```bash
for i in $(seq 1 9); do
  printf "%s db_size=%s db_mtime=%s wal_size=%s wal_mtime=%s\n" "$(date -u +%H:%M:%S)" \
    "$(stat -c %s /var/www/ai-content/prisma/dev.db)" "$(stat -c %Y /var/www/ai-content/prisma/dev.db)" \
    "$(stat -c %s /var/www/ai-content/prisma/dev.db-wal)" "$(stat -c %Y /var/www/ai-content/prisma/dev.db-wal)"
  timeout 30 tail -f /dev/null || true
done
```

**Not run on production (read locally from the repo at the same commit `84e4d8c2`):**
`src/lib/prisma.ts`, `src/lib/prisma-options.ts`, `src/lib/storage-health.ts`,
`src/app/api/admin/storage/route.ts`, `src/lib/story-film-generation-queue.server.ts`,
`scripts/story-film-system-worker.ts`, `src/lib/media-catalog.ts`.

### A1b

Executed as `ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 "sqlite3 -readonly
'file:/var/www/ai-content/prisma/dev.db?mode=ro'" < <local-script>.sql` (local script piped over
stdin — no writes, no `PRAGMA` writes, `sqlite3 -readonly`). All `?` placeholders in A3 §A3.7
replaced with representative literals per the dispatch; item 11's write (`BEGIN
IMMEDIATE`/`UPDATE`/`COMMIT`) was never executed, only its `WHERE` clause as a bare `SELECT`.

**26 — `EXPLAIN QUERY PLAN` for A3 §A3.7 items 1–11 (15 statements + 1 derived), plus live row
counts for the 3 tables not in §A1.3 (`BundleEntitlement`, `SiteConfig`, `ProductUpdate`)**
```sql
.headers off
.mode list
SELECT '=== ITEM1: User by clerkId (auth hot path) ===';
EXPLAIN QUERY PLAN SELECT `main`.`User`.`id`, `main`.`User`.`clerkId`, `main`.`User`.`name`, `main`.`User`.`email`, `main`.`User`.`password`, `main`.`User`.`googleId`, `main`.`User`.`image`, `main`.`User`.`role`, `main`.`User`.`plan`, `main`.`User`.`usageCount`, `main`.`User`.`usageLimit`, `main`.`User`.`usagePeriodStartedAt`, `main`.`User`.`openaiKey`, `main`.`User`.`geminiKey`, `main`.`User`.`heygenKey`, `main`.`User`.`elevenlabsKey`, `main`.`User`.`pexelsKey`, `main`.`User`.`pixabayKey`, `main`.`User`.`kieKey`, `main`.`User`.`unsplashKey`, `main`.`User`.`flickrKey`, `main`.`User`.`avatar`, `main`.`User`.`heygenAvatarId`, `main`.`User`.`heygenAvatarsCache`, `main`.`User`.`heygenAvatarsCachedAt`, `main`.`User`.`elevenlabsVoiceId`, `main`.`User`.`ttsProvider`, `main`.`User`.`geminiVoiceName`, `main`.`User`.`suspended`, `main`.`User`.`planExpiresAt`, `main`.`User`.`onboardingDismissedAt`, `main`.`User`.`firstClipConvertDismissedAt`, `main`.`User`.`stripeCustomerId`, `main`.`User`.`stripeSubscriptionId`, `main`.`User`.`subStatus`, `main`.`User`.`billingPeriod`, `main`.`User`.`cancelAtPeriodEnd`, `main`.`User`.`cancelAt`, `main`.`User`.`trialStartedAt`, `main`.`User`.`trialEndsAt`, `main`.`User`.`trialEndedAt`, `main`.`User`.`bundleGrantId`, `main`.`User`.`bundleSubscriptionId`, `main`.`User`.`bundleAccessExpiresAt`, `main`.`User`.`bundleStatus`, `main`.`User`.`bundleBillingPeriod`, `main`.`User`.`bundleAmountThb`, `main`.`User`.`bundleLastEventId`, `main`.`User`.`bundleQuotaGrantId`, `main`.`User`.`bundleCreditsGrantId`, `main`.`User`.`bundlePrimary`, `main`.`User`.`minutesUsed`, `main`.`User`.`minutesLimit`, `main`.`User`.`aiAudioMinutesUsed`, `main`.`User`.`aiTextCallsUsed`, `main`.`User`.`geminiKeyMode`, `main`.`User`.`affiliateRefCode`, `main`.`User`.`resetToken`, `main`.`User`.`resetExpires`, `main`.`User`.`createdAt`, `main`.`User`.`updatedAt` FROM `main`.`User` WHERE (`main`.`User`.`clerkId` = 'user_x' AND 1=1) LIMIT 1 OFFSET 0;

SELECT '=== ITEM2: BundleEntitlement by email ===';
EXPLAIN QUERY PLAN SELECT `main`.`BundleEntitlement`.`email`, `main`.`BundleEntitlement`.`grantId`, `main`.`BundleEntitlement`.`subscriptionId`, `main`.`BundleEntitlement`.`status`, `main`.`BundleEntitlement`.`accessEndsAt`, `main`.`BundleEntitlement`.`billingPeriod`, `main`.`BundleEntitlement`.`amountThb`, `main`.`BundleEntitlement`.`lastEventId`, `main`.`BundleEntitlement`.`eventOccurredAt`, `main`.`BundleEntitlement`.`createdAt`, `main`.`BundleEntitlement`.`updatedAt` FROM `main`.`BundleEntitlement` WHERE (`main`.`BundleEntitlement`.`email` = 'x@example.invalid' AND 1=1) LIMIT 1 OFFSET 0;

SELECT '=== ITEM3a: revenue-cohorts user scan ===';
EXPLAIN QUERY PLAN SELECT `main`.`User`.`id`, `main`.`User`.`email`, `main`.`User`.`plan`, `main`.`User`.`role`, `main`.`User`.`subStatus`, `main`.`User`.`billingPeriod`, `main`.`User`.`planExpiresAt`, `main`.`User`.`trialStartedAt`, `main`.`User`.`trialEndsAt`, `main`.`User`.`stripeSubscriptionId`, `main`.`User`.`bundleAccessExpiresAt`, `main`.`User`.`bundleStatus`, `main`.`User`.`bundlePrimary`, `main`.`User`.`bundleBillingPeriod`, `main`.`User`.`bundleAmountThb` FROM `main`.`User` WHERE 1=1 LIMIT -1 OFFSET 0;

SELECT '=== ITEM3b: revenue-cohorts payment scan ===';
EXPLAIN QUERY PLAN SELECT `main`.`Payment`.`id`, `main`.`Payment`.`userId`, `main`.`Payment`.`amount`, `main`.`Payment`.`note`, `main`.`Payment`.`periodDays`, `main`.`Payment`.`createdAt` FROM `main`.`Payment` WHERE `main`.`Payment`.`status` = 'PAID' ORDER BY `main`.`Payment`.`createdAt` ASC LIMIT -1 OFFSET 0;

SELECT '=== ITEM4a: TelemetryEvent current window ===';
EXPLAIN QUERY PLAN SELECT `main`.`TelemetryEvent`.`id`, `main`.`TelemetryEvent`.`name`, `main`.`TelemetryEvent`.`category`, `main`.`TelemetryEvent`.`source`, `main`.`TelemetryEvent`.`sessionId`, `main`.`TelemetryEvent`.`userId`, `main`.`TelemetryEvent`.`step`, `main`.`TelemetryEvent`.`status`, `main`.`TelemetryEvent`.`durationMs`, `main`.`TelemetryEvent`.`value`, `main`.`TelemetryEvent`.`path`, `main`.`TelemetryEvent`.`properties`, `main`.`TelemetryEvent`.`createdAt` FROM `main`.`TelemetryEvent` WHERE `main`.`TelemetryEvent`.`createdAt` >= 1757000000000 ORDER BY `main`.`TelemetryEvent`.`createdAt` DESC LIMIT 20000 OFFSET 0;

SELECT '=== ITEM4b: TelemetryEvent previous window ===';
EXPLAIN QUERY PLAN SELECT `main`.`TelemetryEvent`.`id`, `main`.`TelemetryEvent`.`name`, `main`.`TelemetryEvent`.`category`, `main`.`TelemetryEvent`.`source`, `main`.`TelemetryEvent`.`sessionId`, `main`.`TelemetryEvent`.`userId`, `main`.`TelemetryEvent`.`step`, `main`.`TelemetryEvent`.`status`, `main`.`TelemetryEvent`.`durationMs`, `main`.`TelemetryEvent`.`value`, `main`.`TelemetryEvent`.`path`, `main`.`TelemetryEvent`.`properties`, `main`.`TelemetryEvent`.`createdAt` FROM `main`.`TelemetryEvent` WHERE (`main`.`TelemetryEvent`.`createdAt` >= 1756000000000 AND `main`.`TelemetryEvent`.`createdAt` < 1757000000000) ORDER BY `main`.`TelemetryEvent`.`id` ASC LIMIT 20000 OFFSET 0;

SELECT '=== ITEM4c: TelemetryEvent distinct by name (no createdAt bound) ===';
EXPLAIN QUERY PLAN SELECT `main`.`TelemetryEvent`.`id`, `main`.`TelemetryEvent`.`userId` FROM `main`.`TelemetryEvent` WHERE (`main`.`TelemetryEvent`.`name` = 'video_create_started' AND `main`.`TelemetryEvent`.`userId` IS NOT NULL) LIMIT -1 OFFSET 0;

SELECT '=== ITEM5: VideoJob createdAt range ===';
EXPLAIN QUERY PLAN SELECT `main`.`VideoJob`.`id`, `main`.`VideoJob`.`userId`, `main`.`VideoJob`.`status`, `main`.`VideoJob`.`currentStep`, `main`.`VideoJob`.`errorMessage`, `main`.`VideoJob`.`progress`, `main`.`VideoJob`.`startedAt`, `main`.`VideoJob`.`finishedAt` FROM `main`.`VideoJob` WHERE `main`.`VideoJob`.`createdAt` >= 1757000000000 LIMIT -1 OFFSET 0;

SELECT '=== ITEM6a: RenderJob by status,type (constructed @@index shape) ===';
EXPLAIN QUERY PLAN SELECT `main`.`RenderJob`.`id`, `main`.`RenderJob`.`userId`, `main`.`RenderJob`.`videoId`, `main`.`RenderJob`.`parentJobId`, `main`.`RenderJob`.`type`, `main`.`RenderJob`.`status`, `main`.`RenderJob`.`attempts`, `main`.`RenderJob`.`maxAttempts`, `main`.`RenderJob`.`payload`, `main`.`RenderJob`.`progress`, `main`.`RenderJob`.`phase`, `main`.`RenderJob`.`heartbeatAt`, `main`.`RenderJob`.`cancelRequested`, `main`.`RenderJob`.`reservedQuota`, `main`.`RenderJob`.`reservedMinutes`, `main`.`RenderJob`.`creditsSpent`, `main`.`RenderJob`.`creditsFromGranted`, `main`.`RenderJob`.`creditsFromPromotional`, `main`.`RenderJob`.`creditFundingJson`, `main`.`RenderJob`.`error`, `main`.`RenderJob`.`idempotencyKey`, `main`.`RenderJob`.`scopeKey`, `main`.`RenderJob`.`videoUrl`, `main`.`RenderJob`.`createdAt`, `main`.`RenderJob`.`startedAt`, `main`.`RenderJob`.`finishedAt` FROM `main`.`RenderJob` WHERE (`main`.`RenderJob`.`status` = 'DONE' AND `main`.`RenderJob`.`type` = 'RENDER') LIMIT -1 OFFSET 0;

SELECT '=== ITEM6b: RenderJob queue hot query (status only, order by createdAt) ===';
EXPLAIN QUERY PLAN SELECT `main`.`RenderJob`.`id`, `main`.`RenderJob`.`userId`, `main`.`RenderJob`.`videoId`, `main`.`RenderJob`.`parentJobId`, `main`.`RenderJob`.`type`, `main`.`RenderJob`.`status`, `main`.`RenderJob`.`attempts`, `main`.`RenderJob`.`maxAttempts`, `main`.`RenderJob`.`payload`, `main`.`RenderJob`.`progress`, `main`.`RenderJob`.`phase`, `main`.`RenderJob`.`heartbeatAt`, `main`.`RenderJob`.`cancelRequested`, `main`.`RenderJob`.`reservedQuota`, `main`.`RenderJob`.`reservedMinutes`, `main`.`RenderJob`.`creditsSpent`, `main`.`RenderJob`.`creditsFromGranted`, `main`.`RenderJob`.`creditsFromPromotional`, `main`.`RenderJob`.`creditFundingJson`, `main`.`RenderJob`.`error`, `main`.`RenderJob`.`idempotencyKey`, `main`.`RenderJob`.`scopeKey`, `main`.`RenderJob`.`videoUrl`, `main`.`RenderJob`.`createdAt`, `main`.`RenderJob`.`startedAt`, `main`.`RenderJob`.`finishedAt` FROM `main`.`RenderJob` WHERE `main`.`RenderJob`.`status` = 'QUEUED' ORDER BY `main`.`RenderJob`.`createdAt` ASC LIMIT 1 OFFSET 0;

SELECT '=== ITEM6c: RenderJob insights range scan ===';
EXPLAIN QUERY PLAN SELECT `main`.`RenderJob`.`id`, `main`.`RenderJob`.`type`, `main`.`RenderJob`.`status`, `main`.`RenderJob`.`parentJobId`, `main`.`RenderJob`.`startedAt`, `main`.`RenderJob`.`finishedAt` FROM `main`.`RenderJob` WHERE `main`.`RenderJob`.`createdAt` >= 1757000000000 LIMIT -1 OFFSET 0;

SELECT '=== ITEM7: SupportTicket by status ===';
EXPLAIN QUERY PLAN SELECT `main`.`SupportTicket`.`id`, `main`.`SupportTicket`.`message`, `main`.`SupportTicket`.`imageName`, `main`.`SupportTicket`.`imageMimeType`, `main`.`SupportTicket`.`status`, `main`.`SupportTicket`.`adminReply`, `main`.`SupportTicket`.`category`, `main`.`SupportTicket`.`severity`, `main`.`SupportTicket`.`recommendedAction`, `main`.`SupportTicket`.`auditNote`, `main`.`SupportTicket`.`impactNote`, `main`.`SupportTicket`.`sentryIssueId`, `main`.`SupportTicket`.`linearIssueIdentifier`, `main`.`SupportTicket`.`auditedAt`, `main`.`SupportTicket`.`repliedAt`, `main`.`SupportTicket`.`createdAt`, `main`.`SupportTicket`.`updatedAt`, `main`.`SupportTicket`.`userId` FROM `main`.`SupportTicket` WHERE `main`.`SupportTicket`.`status` = 'OPEN' ORDER BY `main`.`SupportTicket`.`createdAt` DESC LIMIT -1 OFFSET 0;

SELECT '=== ITEM8: SiteConfig key IN (32) ===';
EXPLAIN QUERY PLAN SELECT `main`.`SiteConfig`.`key`, `main`.`SiteConfig`.`value`, `main`.`SiteConfig`.`updatedAt` FROM `main`.`SiteConfig` WHERE `main`.`SiteConfig`.`key` IN ('k1','k2','k3','k4','k5','k6','k7','k8','k9','k10','k11','k12','k13','k14','k15','k16','k17','k18','k19','k20','k21','k22','k23','k24','k25','k26','k27','k28','k29','k30','k31','k32') LIMIT -1 OFFSET 0;

SELECT '=== ITEM9: Notification by userId ===';
EXPLAIN QUERY PLAN SELECT `main`.`Notification`.`id`, `main`.`Notification`.`userId`, `main`.`Notification`.`type`, `main`.`Notification`.`title`, `main`.`Notification`.`body`, `main`.`Notification`.`link`, `main`.`Notification`.`read`, `main`.`Notification`.`createdAt` FROM `main`.`Notification` WHERE (`main`.`Notification`.`userId` = 'user_x' AND (NOT `main`.`Notification`.`type` = 'SYSTEM')) ORDER BY `main`.`Notification`.`createdAt` DESC LIMIT -1 OFFSET 0;

SELECT '=== ITEM10: ProductUpdate summary ===';
EXPLAIN QUERY PLAN SELECT `main`.`ProductUpdate`.`id`, `main`.`ProductUpdate`.`version`, `main`.`ProductUpdate`.`title`, `main`.`ProductUpdate`.`summary`, `main`.`ProductUpdate`.`body`, `main`.`ProductUpdate`.`category`, `main`.`ProductUpdate`.`importance`, `main`.`ProductUpdate`.`state`, `main`.`ProductUpdate`.`isPinned`, `main`.`ProductUpdate`.`targetPath`, `main`.`ProductUpdate`.`ctaLabel`, `main`.`ProductUpdate`.`ctaHref`, `main`.`ProductUpdate`.`imageUrl`, `main`.`ProductUpdate`.`publishedAt`, `main`.`ProductUpdate`.`createdAt`, `main`.`ProductUpdate`.`updatedAt` FROM `main`.`ProductUpdate` WHERE (`main`.`ProductUpdate`.`state` = 'PUBLISHED' AND (`main`.`ProductUpdate`.`publishedAt` IS NULL OR `main`.`ProductUpdate`.`publishedAt` <= 1757000000000)) ORDER BY `main`.`ProductUpdate`.`isPinned` DESC, `main`.`ProductUpdate`.`publishedAt` DESC, `main`.`ProductUpdate`.`createdAt` DESC LIMIT -1 OFFSET 0;

SELECT '=== ITEM11: derived SELECT for the write WHERE clause (write itself NOT executed) ===';
EXPLAIN QUERY PLAN SELECT `main`.`User`.`id` FROM `main`.`User` WHERE (`main`.`User`.`id` = 'user_x' AND `main`.`User`.`plan` IN ('PRO','BUSINESS') AND (`main`.`User`.`subStatus` IS NULL OR `main`.`User`.`subStatus` <> 'active'));

SELECT '=== ROWCOUNT BundleEntitlement ===';
SELECT COUNT(*) FROM `main`.`BundleEntitlement`;
SELECT '=== ROWCOUNT SiteConfig ===';
SELECT COUNT(*) FROM `main`.`SiteConfig`;
SELECT '=== ROWCOUNT ProductUpdate ===';
SELECT COUNT(*) FROM `main`.`ProductUpdate`;
```

**27 — §A1.5b: affected-cohort count (A3 §A3.1's exact SQL) + PRO/BUSINESS denominator**
```sql
.headers off
.mode list
SELECT '=== A1.5b: affected cohort count (A3.1 SELECT) ===';
SELECT COUNT(*) FROM User u
WHERE u.plan IN ('PRO','BUSINESS')
  AND (u.trialEndsAt IS NULL OR u.trialEndsAt <= strftime('%s','now')*1000)
  AND NOT EXISTS (SELECT 1 FROM Payment p
                  WHERE p.userId = u.id AND p.status = 'PAID'
                    AND p.periodDays > 0 AND p.plan IN ('PRO','BUSINESS'))
  AND NOT EXISTS (SELECT 1 FROM AdministratorGrant g
                  WHERE g.userId = u.id AND g.revokedAt IS NULL)
  AND NOT (u.bundleStatus = 'ACTIVE' AND COALESCE(u.bundleAmountThb,0) > 0
           AND u.bundleAccessExpiresAt > strftime('%s','now')*1000);

SELECT '=== A1.5b denominator: total PRO/BUSINESS accounts ===';
SELECT COUNT(*) FROM User WHERE plan IN ('PRO','BUSINESS');
```

**28 — WAL size sample 3**
```bash
date -u
ls -l /var/www/ai-content/prisma/dev.db*
```
</content>
</invoke>

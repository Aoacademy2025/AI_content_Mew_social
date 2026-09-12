# Performance audit, error summary and admin re-organisation — 2026-09-12

> Plan: docs/plans/2026-09-12-performance-audit-admin-reorg.md · ADR 0062 · CONTEXT.md (Operations & Admin). Raw evidence: docs/plans/reports/2026-09-12-A{1,2,3,4,5}-*.md. Production was read-only throughout; every command is in §9.

## สรุปไทย (อ่าน 2 นาที)

**หน้าเว็บไม่ได้ช้าเพราะโค้ดทำงานหนัก — มันช้าเพราะ "ต่อคิวเขียน" ฐานข้อมูล SQLite ไฟล์เดียวกัน** วัดจริงบน prod 2.4 วัน (log มี timestamp ตั้งแต่ 09-09 เท่านั้น ไม่ใช่ 7 วัน) พบ transaction ที่ค้าง ≥ 5 วินาที **42 / 98 / 71 ครั้งต่อวัน** ค่ากลางค้าง **25 วินาที** สูงสุด 46 วินาที และ **68 %** ของทั้งหมดหยุดตรง timeout พอดี (20 s / 30 s) — แปลว่ามันไม่ได้ทำงานช้า มัน "รอ" จนหมดเวลา ขณะที่เครื่องว่าง (load ≤ 1.1 บน 8 vCPU, RAM ว่าง 27 GB)

**ใครทำให้คิวยาว (เรียงตามหลักฐาน)**
1. **ทุก request ของลูกค้าจ่ายเงิน 107 จาก 249 บัญชี (43 %) เปิด write transaction ที่ไม่ได้เปลี่ยนอะไรเลย** (`UPDATE User` 0 แถว ใน `entitlements.ts`) — เพราะไม่มีแถว `Payment` ที่เข้าเกณฑ์ ระบบจึง "sync" ใหม่ทุกครั้ง แม้แต่ตอนตอบ 403
2. **`story-film-system-worker` เปิด write transaction ทุก 4 วินาที** (~21,600 ครั้ง/วัน) บนตารางที่มี 114 แถว และล้มเหลว (`P1008`) วันละ 25 ครั้ง — 65 % ของ log worker นี้อยู่ในช่วงที่มี slow-tx (36 เท่าของค่าปกติ)
3. **auth path อ่านซ้ำ**: `/api/user/me` ของบัญชีลูกค้าจ่ายเงิน (ไม่ใช่ admin) ยิง **34 statements** (อ่าน `User` แถวเดียวกัน 15 ครั้ง) ทุกหน้ายิงมัน; ลดได้เหลือ ~10
4. **`/admin` เดินไฟล์ทั้งดิสก์ทุกครั้งที่เปิด** (`/api/admin/cleanup` เดิน 35,091 ไฟล์ ≈ 10 วินาที) และ **ระหว่างนั้น API admin อื่นค้างตามไปด้วย** (ระหว่างวัด `/api/admin/stats` กระโดดจาก 0.2 s เป็น 23 s) — ADR 0062 ย้ายสิ่งนี้ออกจากหน้า `/admin` ไปหน้า `/admin/storage` **แต่ย้ายไม่ใช่แก้**: หน้านั้นยังรอ ~10 วิ เท่าเดิม การแก้จริง (จำกัด scan / ทำเบื้องหลัง) เป็น follow-up
5. **font ซับ 24 ตระกูล (107 KB CSS ที่ block การวาดครั้งแรก) โหลดทุก route** ทั้งที่หน้าปกติใช้ 2 ตระกูล — เป็นน้ำหนักหน้าเว็บที่ลดได้ (→ 11 KB ใน route ที่ไม่มีซับ) **ไม่ใช่สาเหตุของอาการช้าที่วัดได้** (สไตล์ชีตใช้ 0–21 ms เมื่อ cache แล้ว)

นอกคิวเขียน: **`/admin/revenue` คือหน้าที่ช้าที่สุดที่มิวใช้จริง** (1.7 วิ warm / 3.0 วิ cold) เพราะเรียก Stripe สด ๆ ทุกครั้งโดยไม่มี cache — แผนนี้**ไม่แก้** (เป็น route เงิน ต้องถามมิวก่อน) และ `/api/admin/insights` 0.8 วิ จะดีขึ้นเมื่อแก้ตัวเลข (C5 ข้อ 4)

**ตัวเลขที่เชื่อไม่ได้ (ตรวจ 119 ตัว ผิดความหมาย 26 + ครึ่งผิด 9)**
- **"จ่ายจริง 39" ผิด — ตัวจริงคือ 28** (11 บัญชีมีแค่ `Payment` ฿0) และ North Star บนหน้าเดียวกันก็บอก 28 อยู่แล้ว
- **MRR ฿18,052 มี ฿6,389 (35 %) ที่ไม่มีใครจ่าย** — 11 บัญชีเดิมถูกนับด้วยราคาป้าย → ลามไป prepaid, deferred, margin, break-even
- **"สมัครวันนี้ 9" จริง ๆ คือ 0** — เซิร์ฟเวอร์ไม่ได้ตั้ง `TZ` วันจึงเป็น UTC; cron North Star ทำงาน 07:15 ไม่ใช่ 00:15; ต้นทุนรายวันก็ใช้วัน UTC
- **ทุกตัวเลขจาก telemetry บน insights 7/30 วัน เป็นตัวอย่างแค่ ~4 วัน** (`take: 20_000` จาก 102,501 แถว) และช่วง "ก่อนหน้า" ดึง 20,000 แถว *เก่าสุด* จึงเทียบกันไม่ได้
- MAPC = 20 ถูกต้องตามเลขคณิต แต่ตัวหารกว้างกว่าที่ CONTEXT.md เขียน (นับ prepaid ที่ยังไม่หมดอายุด้วย) — ต้องตัดสินใจว่าแก้เอกสารหรือแก้โค้ด

**Error 14 วัน:** 22 กลุ่ม — แก้ 4 · เฝ้าดู 15 · noise 3. Sentry **ไม่เห็น** กลุ่มที่ใหญ่ที่สุดเลย (คิว SQLite 369 slow-tx อยู่ใน PM2 เท่านั้น) กลุ่มที่ต้องแก้: คิว SQLite (HERO-10 ร่างเปิดใหม่), Hero AI Image `OUTPUT_INVALID` 84 ครั้ง/20 บัญชี แนวโน้มขึ้น, brand visual preflight ปฏิเสธ 41 ครั้ง/13 บัญชี, 401 storm บน endpoint ที่ poll เบื้องหลัง 1,730 events. ร่าง Linear 6 ไฟล์ ยังไม่ apply

**สิ่งที่ยืนยันว่าไม่ใช่สาเหตุ:** backup `VACUUM INTO` (ทับ 0 จาก 217 ช่วง slow-tx; มี 1 ใน 219 เหตุการณ์ที่*เริ่ม*ระหว่าง VACUUM คืนเดียว), `cleanup-videos`, render-worker, CPU/RAM/ดิสก์, Google Fonts ใน `/dashboard` (0–21 ms), และ **ไม่มี transaction ในเส้นทางหลักที่ถือ network/ffmpeg ไว้ข้างใน** (ตรวจ 122 จุด; จุดเดียวที่มี network อยู่ใน canary review ที่ไม่ใช่ทางร้อน) — สมมติฐานเดิมของ HERO-10 ผิด

**จะแก้ยังไง:** Phase B ตามนโยบาย quick-win (cache ดิสก์ 10 นาที, อ่าน SiteConfig ครั้งเดียว, ส่งแถว `User` ที่โหลดแล้วต่อกันไป, font เฉพาะ route ที่วาดซับ, updates ครั้งเดียว) + B6 สามแถวที่เลือกจากหลักฐาน (index `Notification`, worker story-film อ่านก่อนค่อยเขียน, ตัด write เปล่าใน entitlements) — สองแถวหลังต้องให้มิวตัดสินใจก่อน. Phase C ทำ `/admin` ใหม่ + แก้ตัวเลข 6 รายการ. ตัวเลขก่อน/หลังอยู่ที่ §8

**ต้องการคำตอบจากมิว 3 เรื่องที่ Gate A:** (1) B6 แถว 2 — worker story-film อ่านก่อนค่อยเขียน, (2) B6 แถว 3 — ตัด write เปล่าใน entitlements (รวมใน B3), (3) แก้ตัวเลข 6 รายการ C5 ตามรายการในแผน. **สิ่งที่ต้องให้มิวลงมือเอง (ไม่มีใครทำแทนได้):** ลบ snapshot เก่า 64 ไฟล์ (19 GB) ใน `prisma/`, ตั้ง `BACKUP_RSYNC_TARGET` ให้มีสำเนานอกเครื่อง, และเลื่อน cron North Star ให้ตรง 00:15 กรุงเทพ (`ecosystem.config.js`). **ถ้าทำครบ "ดีขึ้น" หน้าตาเป็นแบบนี้:** อาการค้าง 20–40 วิ แบบสุ่มหายไป (slow-tx ≥ 5 s = 0/วัน), `/admin` เปิดโดยไม่เดินดิสก์, ตัวเลขเงินตรงกันทุกหน้า (จ่ายจริง 28, MRR ไม่มีราคาป้าย), และ "วันนี้" คือวันนี้จริง ๆ


## 1. Baseline measured

**Incidents during measurement (disclosed):** (a) *Production, A2* — the brief-mandated 20× loop on `/api/admin/cleanup` overlapped with a second loop and degraded the admin API for ~2–3 min (`/api/admin/stats` 204 ms → 23,494 ms); the worker aborted it and cut that route to single measurements — see the incident note in §1.2. (b) *Local Mac only, A3* — while stopping its own dev servers the A3 worker ran `pkill -f "next dev"`, which also killed an unrelated Next 14 dev server on port 3011 (a different repo); its supervisor restarted it within seconds. **No process on production was signalled at any point**; §9 holds every production command.


#### 1.1 Production (A1)

**Coverage caveat** (source: A1 §Coverage caveat)

### Coverage caveat — the 7-day census is not possible

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

**ai-content per-day table** (source: A1 §A1.1)

#### ai-content (snapshot: 219 events at 2026-09-11T21:00 UTC; per-day table taken at 20:52 UTC = 217 events)

| Bangkok day | slow-tx count | ≥ 5000 ms | p50 (ms) | p90 (ms) | max (ms) |
|---|---:|---:|---:|---:|---:|
| 2026-09-09 (from 18:31) | 42 | 42 | 29,497 | 39,215 | 45,572 |
| 2026-09-10 | 99 | 98 | 20,241 | 30,147 | 46,302 |
| 2026-09-11 | 72 | 71 | 27,035 | 30,137 | 45,284 |
| 2026-09-12 (to 03:47) | 4 | 4 | 20,701 | 30,062 | 30,089 |


**ai-content hourly table** (source: A1 §A1.1)

#### Slow-tx by Bangkok hour (ai-content, all days pooled, n = 217)

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


**Candidate-holder table** (source: A1 §A1.2)

#### Candidate-holder table

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

**Logical footprint, top 20** (source: A1 §A1.3)

#### Logical footprint (table + its own indexes), top 20

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

**Row counts** (source: A1 §A1.3)

#### Row counts

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

**Retention** (source: A1 §A1.3)

#### Retention

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

**Stale snapshots and disk** (source: A1 §A1.3)

#### Stale snapshots and disk

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

**WAL size samples** (source: A1 §A1.4)

#### WAL size samples

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

**Checkpoint cadence** (source: A1 §A1.4)

#### Checkpoint cadence (30-second sampling, 2026-09-11 21:00:18 → 21:04:18 UTC)

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

**Nightly VACUUM INTO** (source: A1 §A1.4)

#### Nightly `VACUUM INTO` (`db-backup`, cron `0 2 * * *` UTC = 09:00 Bangkok)

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

**EXPLAIN table** (source: A1 §A1.5)

### §A1.5 Query plans (Task A1b)

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

**§A1.5b Affected cohort count** (source: A1 §A1.5b)

#### §A1.5b Affected cohort count

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

**§A1.6 Disk-walk timing** (source: A1 §A1.6)

### §A1.6 Disk-walk timing (`/api/admin/storage`)

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

**`pm2 status`** (source: A1 §A1.7)

#### `pm2 status` (2026-09-11 20:47 UTC)

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

**Environment key names** (source: A1 §A1.7)

#### Environment key names (names only; no values read)

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

**Host** (source: A1 §A1.7)

#### Host

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

#### 1.2 Browser (A2)

**Incident note** (source: A2 §Incident note)

### Incident note (read before the numbers)

Mid-session, an attempt to time `/api/admin/cleanup` 20× sequentially (per the original Step-2 plan) left two overlapping fetch loops running concurrently for several minutes. `/api/admin/cleanup` does a full disk walk (confirmed: 35,091 files / ~159GB scanned — see `admin-cleanup.json`) and appears to cause collateral slowdown on unrelated endpoints while it runs: an isolated `/api/admin/stats` fetch measured **204ms, then 1,062ms, then 20,955ms, then 23,494ms**, then recovered to ~200ms after ~90s of no further load. All in-flight requests were killed by navigating the tab away, and the endpoint's own repetition count was cut from 20 to a single measurement for `/api/admin/cleanup` and `/api/admin/insights?days=30` (the other endpoint the brief flagged as "expected slow") to avoid repeating this. All 12 other endpoints below have full, clean n=20 data taken before this incident. See the process report for the full timeline and rationale. **A3 should treat this as a live finding**, not just a testing artifact: a single admin request can apparently degrade the whole admin API surface for ~1-2 minutes.

**Per-page table** (source: A2 §Per-page table)

### Per-page table

| Page | Cold #1 | Cold #2 | Cold #3 | Cold median | Warm #1 | Warm #2 | Warm #3 | Warm median | Time-to-usable request |
|---|---|---|---|---|---|---|---|---|---|
| `/admin` | 1539 | 1038 | 488 | **1038** | 786 | 747 | 616 | **747** | `GET /api/admin/stats` |
| `/dashboard` | 743 | 674 | 618 | **674** | 541 | 3342 | 3458 | **3342** | `GET /api/user/me` |
| `/videos` | 568 | 686 | 684 | **684** | 546 | 523 | 570 | **546** | `GET /api/videos` |
| `/admin/insights?days=30` | 815 | 933 | 874 | **874** | 773 | 746 | 666 | **746** | `GET /api/admin/insights` |
| `/video-editor` (existing project) | 994 | 880 | 817 | **880** | 802 | 887 | 860 | **860** | `GET /api/editor-projects/:id` |

All times in ms. `/dashboard` warm is bimodal (541 vs 3342/3458) — see "Worst offenders" below.

**Per-endpoint timings** (source: A2 §Per-endpoint timings)

### Per-endpoint timings (Step 2)

n=20 (run 1 = cold, runs 2-20 sorted for p50/p95/max) for all rows except the two marked *(reduced n, see incident note)*.

| Route | Status | Cold (run 1) | Warm p50 | Warm p95 | Warm max |
|---|---|---|---|---|---|
| `/api/user/me` | 200 | 338 | 182 | 219 | 219 |
| `/api/updates?summary=1` | 200 | 88 | 95 | 163 | 163 |
| `/api/notifications` | 200 | 226 | 104 | 182 | 182 |
| `/api/admin/stats` | 200 | 127 | 190 | 209 | 209 |
| `/api/admin/settings` | 200 | 99 | 100 | 232 | 232 |
| `/api/admin/storage` | 200 | 259 | 269 | 528 | 528 |
| `/api/admin/cleanup?olderThanDays=3&includeStocks=false&includeTmp=false` *(n=1, see incident note)* | 200 | 10164-10738 (3 independent samples, all in this range) | n/a | n/a | n/a |
| `/api/admin/support?status=OPEN` | 200 | 155 | 93 | 169 | 169 |
| `/api/admin/music` | 200 | 102 | 91 | 160 | 160 |
| `/api/admin/insights?days=30` *(n=20, but see note)* | 200 | 1041 | 826 | 996 | 996 |
| `/api/user/stats` | 200 | 254 | 100 | 188 | 188 |
| `/api/videos` | 200 | 216 | 99 | 160 | 160 |
| `/api/editor-projects` | 200 | 86 | 93 | 155 | 155 |
| `/api/admin/revenue` | 200 | 2953 | 1704 | 1853 | 1853 |

Note on `/api/admin/insights?days=30`: the brief expected this to be slow-cold like storage/cleanup (disk/scan cost). It was **not** — cold=1041ms, stable warm ~800-970ms across 19 warm reps. Recommend the plan's assumption here be corrected for A3/A4.

**Lighthouse substitute note** (source: A2 §Per-page detail)

**Long Tasks / LCP / CLS / paint timing could not be measured in this session.** `performance.getEntriesByType('paint')` returned `[]` and a live `PerformanceObserver({type:'largest-contentful-paint', buffered:true})` also returned nothing, even seconds after load. Root cause: Chrome suppresses the Paint Timing / LCP / CLS APIs for tabs that are not the foreground/visible tab, and the `claude-in-chrome` automation tabs used here are background tabs. Nav Timing (TTFB/DCL/load) and Resource Timing (all XHR/fetch/script/css entries) are unaffected by this and are fully reliable. **Lighthouse was not available** — `chrome-devtools` MCP was attached to a separate, logged-out Chrome profile, so the render-blocking-CSS substitute above (the `fonts.googleapis.com` stylesheet duration) is used instead, and it is consistently negligible (0-21ms) across every page — Google Fonts CSS is not a meaningful render-blocking cost in this app.

**Three worst offenders per page** (source: A2 §Three worst offenders per page)

### Three worst offenders per page (A3 to confirm)

**`/admin`**
1. `GET /api/admin/cleanup` — ~10.2-11.5s every single time, consistently. Confirmed cause (from its own response body): it walks 35,091 files (~159GB) synchronously on every request, no caching, no pagination. *Hypothesis: synchronous `fs` directory walk on the Node request thread, run fresh on every page load instead of cached/backgrounded.*
2. `GET /api/notifications` — 226-1170ms cold, payload is 50 full notification objects with no visible pagination/limit. *Hypothesis: missing `LIMIT`/pagination on the notifications query, or full-object hydration when only unread-count + last N are needed.*
3. `GET /api/user/me` — 277-861ms cold, called on literally every page (it's the top offender-adjacent cost across all 5 pages measured, not unique to `/admin`). Payload has 40+ top-level fields, several nested feature-flag objects, and a base64-encoded avatar image on some responses. *Hypothesis: over-fetching — one "kitchen sink" `/api/user/me` shape is called on every route instead of route-scoped fields.*

**`/dashboard`**
1. Warm-navigation bimodality: 541ms then two consecutive 3,342/3,458ms warm loads, all navigating from `/admin`. *Hypothesis: NOT simply "coming from /admin" (the fast 541ms rep also came from /admin) — more likely genuine backend contention during the measurement window (matches the /api/admin/stats 204ms-to-23,494ms swings seen independently). A3 should re-test with the admin panel completely idle.*
2. `GET /api/videos/jobs/:id` — 777-1029ms, the slowest single dashboard XHR every rep. *Hypothesis: a per-render-job detail lookup (probably for the "recent video" card status) that isn't batched with the recent-videos list.*
3. `GET /api/user/me` — 618-864ms cold, same over-fetching hypothesis as above.

**`/videos`**
1. `GET /api/user/me` — 768-813ms cold, again the single slowest call despite `/videos` not needing most of its fields.
2. `GET /api/videos` — 568-690ms, the page's own primary list; payload is 24 full job records for a page rendering thumbnails/status only. *Hypothesis: over-fetching per row (e.g. full script/prompt fields) instead of a list-view-shaped projection.*
3. `GET /api/editor-projects` — 589-700ms, fetched on `/videos` even though this page doesn't render editor projects. *Hypothesis: a shared layout-level fetch (e.g. a "continue editing" widget) running unconditionally on pages that don't use the data.*

**`/admin/insights?days=30`**
1. `GET /api/admin/insights` — 666-996ms, the heaviest single query on this page (renderStats/jobOutcomes/activation aggregates in the response). *Hypothesis: several grouped-by aggregation queries running sequentially rather than in parallel/pre-aggregated.*
2. `GET /api/admin/costs` — 549-1051ms, a sibling call fired alongside insights. *Hypothesis: same root cause as #1 — could likely be parallelized or merged into one response.*
3. `GET /api/user/me` — 944-1098ms cold on this page specifically (slower here than elsewhere), consistent with the cross-page over-fetching hypothesis, possibly worse here due to concurrent load from the two heavier sibling calls above.

**`/video-editor` (existing project)**
1. `GET /api/heygen/avatar-info` — 2,385-3,283ms, by far the single slowest call on any of the 5 pages measured (excluding the confirmed-slow admin/cleanup), on *every* load including warm. *Hypothesis: uncached, synchronous call out to the third-party HeyGen API on every editor mount, regardless of whether the project uses an avatar.*
2. `GET /api/omnivoice/status` — 1,148-1,347ms. *Hypothesis: another uncached third-party/status round-trip fired unconditionally on mount.*
3. `GET /api/videos/jobs/:id` — fetched **twice** per page load (1,108-1,198ms then 1,345-1,681ms for the second call). *Hypothesis: duplicate fetch — likely one from an initial-state hook and one from a polling/status hook that aren't deduplicated.*

#### 1.3 Code (A3)

**§A3.1 Result table — ADMIN, PRO, `subStatus='active'`, with a qualifying `Payment` row** (source: A3 §A3.1)

#### Results — ADMIN, PRO, `subStatus='active'`, **with** a qualifying `Payment` row

Auth prefix = **9** statements, **0** writes (`/api/admin/storage` is the pure-prefix probe: it does no DB work of its own).

| Endpoint | HTTP | total r1 | total r2 | writes | route's own (total − 9) |
|---|---|---|---|---|---|
| `/api/user/me` | 200 | 30 | 31 | 0 | **21–22** |
| `/api/admin/insights?days=30` | 200 | 30 | 30 | 0 | **21** |
| `/api/admin/revenue` | 500¹ | 28 | 26 | 0 | 17–19¹ |
| `/api/admin/stats` | 200 | 21 | 23 | 0 | 12–14 |
| `/api/admin/cleanup?days=7` | 200 | 18 | 18 | 0 | 9 |
| `/api/user/stats` | 200 | 18 | 18 | 0 | 9 |
| `/api/admin/support?status=OPEN` | 200 | 12 | 12 | 0 | 3 |
| `/api/admin/settings` | 200 | 12 | 11 | 0 | 2–3 |
| `/api/admin/music` | 200 | 12 | 11 | 0 | 2–3 |
| `/api/updates?summary=1` | 200 | 11 | 11 | 0 | 2 |
| `/api/videos` | 200 | 11 | 11 | 0 | 2 |
| `/api/notifications` | 200 | 11 | 10 | 0 | 1–2 |
| `/api/editor-projects` | 200 | 10 | 10 | 0 | 1 |
| `/api/admin/storage` | 200 | 9 | 9 | 0 | **0** |

¹ `/api/admin/revenue` returned 500 locally because the seeded Stripe key is fake. **The route makes live Stripe API calls on every request** — `for await (const charge of stripe.charges.list(...))` and `stripe.refunds.list(...)` (unbounded async pagination) plus one `stripe.invoices.list()` per bundle subscription inside a `Promise.all` (`src/lib/revenue-growth.server.ts:100`, `:188`, `:202`). The counts above are therefore a **lower bound**: they are the DB work that completed before the first Stripe call threw. This is the single biggest latency risk on `/admin/revenue` and A2's cold number will be dominated by Stripe round-trips, not SQLite.

**§A3.1 Result table — non-admin PRO user** (source: A3 §A3.1)

#### Results — non-admin PRO user

| Endpoint | HTTP | total | note |
|---|---|---|---|
| `/api/user/me` | 200 | **35** | +5 vs ADMIN: `resolveHeroAiImageAccess` short-circuits for the ADMIN/beta cohort (`isHeroAiBetaUser`) and skips a 5th `resolvePaidEquivalentEntitlement` + starter-allowance read. **35 is the number that describes a paying customer.** |
| `/api/user/stats` | 200 | 18 | |
| `/api/updates?summary=1` | 200 | 11 | |
| `/api/videos` | 200 | 11 | |
| `/api/notifications`, `/api/editor-projects` | 200 | 10 | |
| every `/api/admin/*` | **403** | **9–10** | A rejected admin request still pays the entire 9-statement entitlement prefix before the role check. |

**§A3.1 Result table — ADMIN, PRO, `subStatus='active'`, without a qualifying `Payment` row** (source: A3 §A3.1)

#### Results — ADMIN, PRO, `subStatus='active'`, **without** a qualifying `Payment` row

This is the same account with its `Payment` row deleted, re-measured after a clean dev-server restart. Every endpoint gains **+4 statements and one write transaction**:

| Endpoint | total | reads | **writes** |
|---|---|---|---|
| `/api/user/me` | 38 | 36 | **2** |
| `/api/admin/insights?days=30` | 34 | 33 | **1** |
| `/api/admin/revenue` | 32 (500) | 31 | **1** |
| `/api/admin/stats` | 25 | 24 | **1** |
| `/api/user/stats` | 22 | 21 | **1** |
| `/api/admin/cleanup?days=7` | 21 | 20 | **1** |
| `/api/admin/support?status=OPEN` | 16 | 15 | **1** |
| `/api/admin/settings`, `/api/admin/music`, `/api/updates`, `/api/videos` | 15 | 14 | **1** |
| `/api/notifications`, `/api/editor-projects` | 14 | 13 | **1** |
| **`/api/admin/storage`** | **13** | 12 | **1** |

**§A3.1 Expected-finding verdict** (source: A3 §A3.1)

#### Expected-finding verdict

| Brief's expectation | Measured | Verdict |
|---|---|---|
| `getCurrentUser()` + `syncUserEntitlement()` ≈ 5–8 queries | **8** (Clerk, paid evidence) / **12** incl. 1 write (no evidence) | **at the top of the range at best, 50 % over it at worst** |
| `/api/user/me` ≈ 15–20 | **29** (Clerk, ADMIN) / **34** (Clerk, non-admin paying customer) / **37** + 2 writes (no evidence) | **refuted — roughly double** |

**§A3.2 Chain 1 — `getCurrentUser()` Clerk fast path** (source: A3 §A3.2)

#### `getCurrentUser()` — Clerk fast path, steady state, paid evidence = **8 statements**

| # | Function | Query | Duplicate of a row already loaded? |
|---|---|---|---|
| 1 | `clerk-auth.ts:96` `getCurrentUserForClerkId` | `SELECT User` (all 63 cols) `WHERE clerkId = ?` | N — first load of the row |
| — | `clerk-auth.ts:103` admin upgrade | `UPDATE User SET role` | none (only when `role != 'ADMIN'` and email qualifies) |
| 2 | `entitlements.ts:185` `syncUserEntitlement` | `SELECT User` (15 cols) `WHERE id = ?` | **Y — same row as #1** |
| 3 | `bundle-entitlement.ts:103` `syncStoredBundleEntitlementForUser` | `SELECT User` (10 cols) `WHERE id = ?` | **Y — same row as #1/#2** |
| 4 | `bundle-entitlement.ts:120` | `SELECT BundleEntitlement WHERE email = ?` | N — but the email came from #3, which re-read it |
| 5 | `paid-equivalent-entitlement.server.ts:249` `resolvePaidEquivalentEntitlement` | `SELECT User` (11 cols) `WHERE id = ?` | **Y — same row as #1/#2/#3** |
| 6 | same call, relation | `SELECT Payment WHERE status=? AND periodDays>? AND userId IN (?)` | N |
| 7 | same call, relation | `SELECT CouponRedemption LEFT JOIN Coupon … userId IN (?)` | N |
| 8 | same call, relation | `SELECT AdministratorGrant WHERE userId IN (?)` | N |
| — | `entitlements.ts:347` early return | — | returns here **only** when the plan is FREE or a trial is active |
| 9–11 | `entitlements.ts:365` `updateMany` (paid plan, no evidence) | `BEGIN IMMEDIATE` / `UPDATE User` / `COMMIT` | **write; matches 0 rows in steady state** |
| 12 | `entitlements.ts:411` final re-read | `SELECT User` (15 cols) | **Y** |
| — | `clerk-auth.ts:109` `demoteLapsedPaidPlan` | 0 queries when `classifyEntitlement().action !== 'DOWNGRADE'` | — |

So: **4 reads of the identical `User` row** (#1, #2, #3, #5) before any route code runs — 5 with #12 on the no-evidence path.

**§A3.2 Chain 2 — `/api/user/me` full request chain** (source: A3 §A3.2)

#### `/api/user/me` — full request chain (non-admin paying customer, Clerk-equivalent **34 statements**)

| Step | Function (file) | Statements | Duplicate? |
|---|---|---|---|
| 1 | `getCurrentUser()` (`clerk-auth.ts`) | **8** (as above) | 4 of them re-read the same `User` row |
| 2 | route's own `prisma.user.findUnique` (`user/me/route.ts:26`) | **1** — `SELECT User` (18 cols) `WHERE id=?` | **Y — `authUser` already holds every one of these columns** |
| 3 | `syncUsageWindow` → `syncSharedUsageCycle` (`usage-limits.ts:53`) | **9** | contains a **second full `syncUserEntitlement`** (7 stmts, all duplicates of step 1) + 2 more `SELECT User` (10 cols) around the rollover check |
| 4 | `resolvePaidEquivalentEntitlement(authUser.id)` (route line 75) | **4** | **Y — 3rd execution of the identical 4-statement evidence bundle** |
| 5 | `resolveHeroAiImageAccess` (`internal-ai-access.ts:159`) | **4 + 2** | **Y — 4th `resolvePaidEquivalentEntitlement`**, plus `SELECT User`(6) + `SELECT ConversionTrialAiImageAllowance` from `getStarterAiImageAllowanceStatus`. Skipped entirely for ADMIN/beta accounts (`isHeroAiBetaUser` early return) — that is the whole ADMIN-vs-customer delta |
| 6 | `resolveHeroScriptAccess` (`hero-script-rollout.server.ts:99`) | **4** | **Y — 5th** |
| 7 | `resolveBrandVisualAccess` (`brand-visual-rollout.server.ts:102`) | **4** | **Y — 6th** |
| 8 | `getStarterAiImageAllowanceStatus` (route line 79) | **2** | **Y — same two statements as inside step 5** |
| 9 | `resolveFirstClipPath` (`first-clip-path.server.ts:41-48`) | **4 + 1 + 1** | **Y — 7th `resolvePaidEquivalentEntitlement`**, plus `SELECT Video` (first completed clip) and `SELECT User` (3 cols: `trialStartedAt/trialEndsAt/suspended`) — **another duplicate of the same row** |
| 10 | `resolveManagedStockAccess` | 0 | flag-gated, no query |
| 11 | `decideBrandLibraryAccess`, `classifyEntitlement`, `limitsForPlan` | 0 | pure |

Because steps 4–9 run inside one `Promise.all`, several of those `resolvePaidEquivalentEntitlement` calls collapse onto the same event-loop tick but each still issues its own 4 statements — **there is no request-scoped cache anywhere in this chain.**

Measured per-table tally for one ADMIN `/api/user/me` (30 statements):

```
14 × User   4 × Payment   4 × CouponRedemption   4 × AdministratorGrant
 2 × BundleEntitlement   1 × Video   1 × ConversionTrialAiImageAllowance
```

**14 reads of one `User` row in a single request**, and the 3-table paid-equivalent evidence bundle executed **4 times** (5 for a non-admin: 35 statements, 5×Payment/CouponRedemption/AdministratorGrant). Nothing in the request mutates any of those rows between reads.

The same pattern is visible on cheaper endpoints — `/api/user/stats` (18 statements) runs the evidence bundle twice because it also calls `syncUsageWindow`; `/api/admin/settings` spends **9 of its 11 statements** on the entitlement prefix, and reads all 32 `SiteConfig` rows with one query.

**Design note for B3:** the cheapest correct fix is a request-scoped memo (React `cache()` or an `AsyncLocalStorage` keyed on `userId`) around `resolvePaidEquivalentEntitlement` and `syncUserEntitlement` — not new queries, not new indexes. That alone removes 3–4 evidence bundles (12–16 statements) and one whole `syncUserEntitlement` from `/api/user/me`. Passing the already-loaded `User` row down instead of re-selecting it removes most of the remaining 14 `User` reads.

**§A3.3 Holder candidates table** (source: A3 §A3.3)

#### Holder candidates

| Site | Span | Awaited inside | Verdict / max plausible hold |
|---|---|---|---|
| `src/lib/hero-voice-canary-ledger.server.ts:995` | 57 lines, 3 loops | `loadRunForMutation`, `verifyLedgerWithClient`, `appendHeroVoiceCanaryLedgerRecordInTransaction`, `tx.reviewRun.update` | The only **direct** I/O match is an `ffmpeg`-shaped identifier inside the ledger-evidence validation. **Hold: bounded by ledger size, not by a network call** — it is CPU + DB over the run's slot manifest. Gated behind `HERO_VOICE_CANARY_*` (never on together with prod clone). **Estimated worst case: hundreds of ms.** Low priority: canary-only path. |
| `src/lib/brand-profile-library.server.ts:941` | 125 lines, 4 `tx.*` ops | `await import(…)` + `createBrandProfileFromPayloadInTransaction`, `pinProjectBrandRevisionInTransaction`, `starterAllowanceStatusInTransaction` | A **dynamic module import inside an open write transaction**. First call per process pays module resolution + compile while holding the lock; afterwards it is a resolved-cache hit. **Max plausible hold: first call after a deploy/restart — tens to low hundreds of ms; steady state ≈ 0.** Worth hoisting the import above the `$transaction`, but it is not the HERO-10 shape. |
| `src/lib/brand-setup.server.ts:42` | 61 lines | `resolveBrandProfileRevisionForNewProjectInTransaction`, `publishBrandProfileDraft`, `saveBrandProfileDraft`, `createBrandProfileFromPayloadInTransaction`, `createEditorProject` | **False positive** — the matches were `GEMINI_VOICES.some(...)` / `RUNPOD_HERO_VOICES.some(...)` / `["gemini","elevenlabs","omnivoice"].includes(...)`, i.e. array predicates on constant lists, not provider calls. DB-only. Already wrapped in `withTransientSqliteRetry`. |

**§A3.3 The honest conclusion on write-lock hold** (source: A3 §A3.3)

#### The honest conclusion on write-lock hold

**No `$transaction` in this codebase awaits a network call, an ffmpeg spawn, or file I/O inside the callback.** The 44-file, 122-site sweep found nothing of the shape "transaction opened, HTTP request awaited, transaction committed". The transactions are uniformly short and DB-only, and the longest ones by statement count are in `ai-generation-jobs.server.ts`, `story-film.server.ts` and `hero-voice-generation.server.ts` — all `tx.*` only.

That makes the §A3.1 finding the better explanation for HERO-10: **not one long holder, but a very large number of very short `BEGIN IMMEDIATE` write transactions** issued by `syncUserEntitlement` on the authentication path of every request from an affected account, against a single-process web app (`ecosystem.config.js` gives `ai-content` no `instances` key → one fork) sharing one SQLite file with 2 × `render-worker`, `mcp-video-worker` and `story-film-system-worker`. A1b should read this section together with §A3.1 rather than looking for a long transaction.

**§A3.4 What is loaded, globally** (source: A3 §A3.4)

#### What is loaded, globally

`src/app/layout.tsx:20` declares one `GOOGLE_FONTS_URL` with **24 families**, linked as a **render-blocking stylesheet on every route** (`layout.tsx:52`), plus `Inter` via `next/font/google` (self-hosted, not blocking).

Measured (Chrome UA, `display=swap`):

| Variant | CSS bytes | `@font-face` blocks | distinct `.woff2` URLs |
|---|---|---|---|
| **current, 24 families** | **109,637 B (107.1 KB)** | **278** | **240** |
| 24 − the 5 with no consumer anywhere | 98,794 B (96.5 KB) | 251 | 221 |
| the 12 editor-picker families (editor routes only) | 71,261 B (69.6 KB) | 182 | 167 |
| Bai Jamjuree + IBM Plex Sans Thai only (what non-editor routes need) | **11,294 B (11.0 KB)** | 28 | 28 |

Every prerendered route in the build carries this link — verified by grepping `fonts.googleapis.com/css2` in all 26 prerendered HTML files (`true` for all except `/_global-error`).

**§A3.4 Family → consumer → route map** (source: A3 §A3.4)

#### Family → consumer → route map

`src/app/layout.tsx` itself is excluded as a consumer (it is the loader). `src/remotion/**` is excluded per the brief.

| Family | Non-remotion consumers | Route(s) that render it |
|---|---|---|
| **Kanit** | `_v2/fonts.ts` (`next/font`, self-hosted), `_components/constants.ts` `FONTS_LIST`, `_v2/subtitle-style.ts`, `video-editor/page.tsx`, `video-creator/page.tsx`, `style-pack-catalog.ts`, `top-nav.tsx`, `return-loop-card.tsx`, `revenue-growth-dashboard.tsx`, `dashboard/page.tsx`, `videos/page.tsx`, `settings/page.tsx`, `pricing*`, `admin/*`, `ai-studio*`, `hero-script/page.tsx`, `headline-hook.ts`, `story-film-editorial.ts`, `mcp/orchestrator-steps.ts` | `/video-editor`, `/video-creator`, `/dashboard`, `/videos`, `/settings`, `/pricing`, `/admin`, `/admin/users`, `/admin/coupons`, `/ai-studio`, `/ai-studio/story-film`, `/hero-script` — **already self-hosted via `next/font` for the v2 editor** |
| **Noto Sans Thai** | `_v2/fonts.ts` (`next/font`, self-hosted), `_v2/tokens.ts`, `FONTS_LIST`, `video-creator/page.tsx`, `admin/insights/page.tsx`, `ThumbnailEditor.tsx`, `headline-hook.ts`, `story-film-editorial.ts` | `/video-editor`, `/video-creator`, `/admin/insights` — **already self-hosted via `next/font`** |
| **Bai Jamjuree** | `globals.css:974`, `page.tsx` (marketing), `auth-shell.tsx`, `pricing-toggle.tsx`, `youtube-lite.tsx`, `first-clip-hero.tsx`, `docs/page.tsx`, `docs/[slug]/page.tsx`, `FONTS_LIST`, `video-creator/page.tsx` | **every route** (`globals.css`) + `/`, `/login`, `/register`, `/docs/*`, `/dashboard`, `/video-editor`, `/video-creator` |
| **IBM Plex Sans Thai** | `page.tsx` (marketing), `auth-shell.tsx`, `FONTS_LIST`, `video-creator/page.tsx` | `/`, `/login`, `/register`, `/video-editor`, `/video-creator` |
| **Sarabun** | `FONTS_LIST`, `video-creator/page.tsx`, `style-pack-catalog.ts`, `send-email.ts` (email HTML, not browser), `ThumbnailEditor.tsx`†, `StoryFilmWorkbench.tsx`, `headline-hook.ts`, `story-film-editorial.ts`, `api/story-film/[transport]/route.ts` (server JSON) | `/video-editor`, `/video-creator`, `/ai-studio/story-film` |
| **Prompt** | `FONTS_LIST`, `video-creator/page.tsx`, `style-pack-catalog.ts`, `StoryFilmWorkbench.tsx`, `ThumbnailEditor.tsx`†, `headline-hook.ts`, `story-film-editorial.ts` | `/video-editor`, `/video-creator`, `/ai-studio/story-film` |
| **Mitr** | `FONTS_LIST`, `video-creator/page.tsx`, `StoryFilmWorkbench.tsx`, `ThumbnailEditor.tsx`†, `headline-hook.ts`, `story-film-editorial.ts` | `/video-editor`, `/video-creator`, `/ai-studio/story-film` |
| **K2D** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Krub** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Pridi** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Chonburi** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Itim** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Chakra Petch** | *none outside `src/remotion/**`* | **no browser route** (burn-only; in the Remotion URLs) |
| **Fahkwang** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Charm** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Sriracha** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Oswald** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Anton** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Bebas Neue** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Bangers** | *none anywhere* | **none — not in any Remotion URL either** |
| **Lobster** | *none anywhere* | **none — not in any Remotion URL either** |
| **Pacifico** | *none anywhere* | **none — not in any Remotion URL either** |
| **Playfair Display** | *none anywhere* | **none — not in any Remotion URL either** |
| **Righteous** | *none anywhere* | **none — not in any Remotion URL either** |

† `src/components/thumbnail/ThumbnailEditor.tsx` (24 font declarations) has **no importer anywhere in `src` or `scripts`** — it is dead code and must not be treated as a live consumer.

**Summary for B4:** 12 families are reachable in the browser via the editor's `FONTS_LIST` picker and the in-editor Remotion Player preview (`/video-editor`, `/video-creator`, `/ai-studio/story-film`). 7 more (Chakra Petch, Fahkwang, Charm, Sriracha, Oswald, Anton, Bebas Neue) appear only in the burn-side Remotion URLs and have **no browser consumer at all**. 5 (Bangers, Lobster, Pacifico, Playfair Display, Righteous) appear in **no** Remotion URL and **no** app file — they are pure dead weight in the global stylesheet. Two of the 12 (Kanit, Noto Sans Thai) are already self-hosted through `next/font` for the v2 editor, so the Google copy is partly redundant on the exact route that needs them most.

**§A3.4 Remotion self-loading — confirmed** (source: A3 §A3.4)

#### Remotion self-loading — confirmed

`src/remotion/**` loads its own Google Fonts URLs and **imports nothing from `src/app/layout.tsx`**:

| File | Families in its own URL |
|---|---|
| `src/remotion/captionStyles.ts:219` | 4 — Sarabun, Kanit, Prompt, Mitr |
| `src/remotion/SubtitleOverlayComposition.tsx:12` | 19 |
| `src/remotion/VideoComposition.tsx:7` | 1 — Sarabun (`@import url(...)`) |
| `src/remotion/ShortVideoComposition.tsx:26` | 19 (a 4th file, not named in Global Constraints — flagged so B4 keeps it in sync) |

The only references to `layout.tsx` inside `src/remotion/` are two "keep in sync with" **comments** (`SubtitleOverlayComposition.tsx:9`, `ShortVideoComposition.tsx:26`). Grep for `app/layout` / `@/app/` under `src/remotion/` returns nothing else. **Every family that Remotion needs is present in a Remotion-owned URL**, so trimming `layout.tsx` cannot change render output. B4 must still leave the four Remotion files untouched (Global Constraints), and should keep the "in sync" comments honest by updating them.

**§A3.5 Per-route First Load JS** (source: A3 §A3.5)

### §A3.5 Per-route First Load JS

**Method note — a real deviation from the brief.** Next 16's `next build` route table no longer prints `Size` / `First Load JS`; it prints `Revalidate` / `Expire` only, and Next 16 emits no `app-build-manifest.json`. There is nothing to copy. The numbers below were computed instead by extracting every `/_next/static/**.js` referenced by each route's prerendered HTML (`.next/server/app/*.html`) and summing the on-disk raw and gzip sizes; dynamic (`ƒ`) routes were fetched from `next start` on port 3106 using the service-actor header and processed identically. `/video-editor` is prerendered **and** was fetched live — both methods agree to the byte, which validates the method.

Build: `BUILD_NO_LINT=1 npm run build` → compiled in 29.0 s, TypeScript in 15.9 s, 186 static pages generated, `.next/BUILD_ID` written. No OOM, no `NODE_OPTIONS` bump needed.

| Route | JS chunks | JS raw | JS gzip | CSS files | CSS raw | CSS gzip | blocking Google-Fonts link |
|---|---|---|---|---|---|---|---|
| **`/video-editor`** | **34** | **2234.4 KB** | **657.8 KB** | 3 | 277.8 KB | 38.9 KB | yes |
| `/brands` | 30 | 1539.9 KB | 478.1 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/video-creator` | 28 | 1484.2 KB | 458.4 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/hero-script` | 29 | 1418.7 KB | 445.6 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin` | 27 | 1417.3 KB | 438.2 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/settings` | 29 | 1414.9 KB | 440.9 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/insights` | 25 | 1382.1 KB | 427.7 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/dashboard` | 27 | 1375.2 KB | 430.9 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/content` | 28 | 1369.6 KB | 430.2 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/videos` | 25 | 1347.6 KB | 422.4 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/ai-studio` | 25 | 1342.0 KB | 420.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/revenue` | 25 | 1336.7 KB | 418.7 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/users` | 26 | 1336.0 KB | 420.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/style` | 27 | 1336.8 KB | 421.1 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/coupons` | 26 | 1327.3 KB | 417.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/updates` | 25 | 1320.4 KB | 415.1 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/loanwords` | 25 | 1316.2 KB | 413.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/updates` | 25 | 1313.5 KB | 413.9 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/` (marketing) | 17 | 1311.5 KB | 412.5 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/pricing` | 24 | 1300.8 KB | 409.5 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/docs`, `/docs/*` (8 pages) | 18 | 1202.3 KB | 371.4 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/_not-found` | 12 | 1114.2 KB | 346.2 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/forgot-password`, `/reset-password` | 7 | **913.4 KB** | **288.9 KB** | 0 | — | — | yes |

**Largest First Load JS route: `/video-editor` — 2234.4 KB raw / 657.8 KB gzip across 34 chunks.** The floor that every route pays (framework + Clerk + shared client islands) is ~913 KB raw / ~289 KB gzip, and the dashboard shell adds ~400 KB raw on top of it before a page's own code.

**§A3.5 `next/dynamic` usages** (source: A3 §A3.5)

#### `next/dynamic` usages: **0**

```
$ grep -rn "next/dynamic" src | wc -l
0
```

`React.lazy` is also used nowhere in `src`. **There is no code splitting in this application beyond Next's automatic route-level split.** Every client component a route's module graph touches is in that route's first load. This is the single mechanical explanation for `/video-editor`'s 2.2 MB and for the ~400 KB the dashboard shell adds to `/admin` and `/dashboard`.

## 2. Causes ranked

Cross-ranking of A1 §A1.8 (measured on prod) and A3 §A3.8 (measured in code). "Page" = which of the five pages feels it; "Fix" = the task in §5.

| # | Cause | Prod evidence (A1 / A1b / A2) | Code evidence (A3) | Page | Fix |
|---|---|---|---|---|---|
| 1 | **SQLite writer-queue contention** — many short `BEGIN IMMEDIATE` writes from several processes on one file; a blocked transaction sits 20–40 s until a timeout | 219 slow-tx / 2.40 d (42 / 98 / 71 per day ≥ 5 s); p50 hold 25.2 s, max 46.3 s; 68.5 % pinned at a timeout; bursts across `ai-content` + `story-film-system-worker`; box idle | no `$transaction` awaits I/O (122 sites); the transactions are short and DB-only | all (random 20–40 s stalls) | B3 + B6 rows 2–3 |
| 1a | ↳ **no-op `UPDATE User` on every authenticated request from paid accounts without a qualifying `Payment` row** (`entitlements.ts:365`, runs twice on `/api/user/me`, even on 403) | cohort = **107 / 249 PRO/BUSINESS (43 %)** (§A1.5b) | §A3.1 no-evidence table: +4 reads and **1 write transaction** per request | all | B6 row 3 (via B3) |
| 1b | ↳ **`story-film-system-worker` 4 s poll opens a write-first interactive transaction** (`leaseStoryFilmGenerationJobs`) | ≈ 21,600 write tx/day on a 114-row table; 196 own slow-tx ≥ 2 s (152 ≥ 5 s); 25 / 24 / 25 `P1008` lease failures per day; 65.2 % of its lines inside slow-tx windows (36× baseline) | relation filter compiles to a correlated sub-query inside the transaction | all | B6 row 2 |
| 1c | ↳ **budgets unset on prod** (`maxWait` 10 s, `timeout` 30 s, socket 20 s) turn a wait into a 20–40 s stall instead of a fast failure | no `PRISMA_*`/`SQLITE_*` keys (§A1.7) | `prisma-options.ts` defaults | all | advisory — the decision table's remedy for this row (`withSqliteConnectionParams` + `transactionOptionsFromEnv`, i.e. shorter budgets) changes failure timing for every process and needs its own measurement window, so it is recorded in the HERO-10 comment instead; the story-film cause (1b) is addressed at its source (B6 row 2) |
| 2 | **Entitlement chain re-reads** — same `User` row read up to 15× per request, evidence bundle 5× | `/api/user/me` warm p50 182 ms, cold 338 ms; called on every page | auth prefix 8 statements; `/api/user/me` 34 → ~10 possible | all, `/dashboard` most (bimodal warm 541 ms vs 3,342 ms = contention, not code) | B3 |
| 3 | **`/api/admin/cleanup` synchronous disk walk + 6 unbounded scans** on `/admin` open; degrades every other admin request while it runs | 10.2–10.7 s per call (35,091 files / 159 GB); collateral `/api/admin/stats` 204 ms → 23,494 ms during the walk (A2 incident) | `readdirSync`/`lstatSync` on the single web process; `findMany` without `take` (§A3.6 F3–F5). Reconciliation with §A1.6: `du -sk` of the same directories takes 0.072 s — the 10 s is the route's own synchronous walk plus six unbounded scans, not the filesystem | `/admin` | ADR 0062 / C3 moves it off `/admin` (**relocated, not fixed** — the new `/admin/storage` page still pays ~10 s); B1 caches only `/api/admin/storage` (269 ms); bounding the six scans = follow-up |
| 4 | **`/api/admin/revenue` live Stripe pagination per request, no cache** | cold 2,953 ms, warm p50 1,704 ms, max 1,853 ms — misses the 350 / 500 ms targets | unbounded charges + refunds + one invoice list per bundle sub (§A3.6 F6) | `/admin/revenue` | follow-up (cache/window) — money route, ask Mew |
| 5 | **`/api/admin/insights` unbounded telemetry scans** | warm p50 826 ms, max 996 ms — misses 350 / 500 ms | two 20 000-row windows + an all-time `editor_opened` distinct scan; 30 statements | `/admin/insights` | C5 fix 4 (bound + aggregate); the same defect makes the numbers wrong |
| 6 | **24-family Google Fonts sheet on every route** (107 KB render-blocking CSS, 278 `@font-face`) | stylesheet duration 0–21 ms warm (cached) — cheap when cached, paid on every cold first paint | 5 families used by nothing, 7 only by Remotion (self-loading) | first paint everywhere | B4 |
| 7 | **`Notification` full-table SCAN** on `/api/notifications` (16,537 rows, PK only) | cold 226–1,170 ms; 50 full objects, no pagination | only SCAN > 10 k rows in §A1.5 | all (bell poll) | B6 row 1 (`@@index`) |
| 8 | **Sidebar refetches the updates summary on every navigation** | `/api/updates?summary=1` ≈ 95 ms × every route change | effect deps include `pathname` | all (warm nav) | B5 |
| 9 | **32 `SiteConfig` `findUnique` calls on `/api/admin/settings`** — Prisma batches them into one `IN` query (A3 §A3.2; A1b §A1.5 #8), so this is code clarity, not a measured latency cause; 9 of the route's 11 statements are the auth prefix (cause 2) | warm p50 100 ms | `Promise.all(KEYS.map(getConfig))` | `/admin` settings | B2 (no latency win expected) |
| 10 | **No code splitting** — `/video-editor` 2,234 KB raw / 658 KB gzip, 0 `next/dynamic` | `/video-editor` cold 880 ms, warm 860 ms — **within the 3.0 s target** on office network | §A3.5 | `/video-editor` | out of scope (recorded; only becomes a plan if the target is missed) |
| — | **DB file 555.75 MB (`page_count × page_size`), 527.52 MB live per `dbstat`**: TelemetryEvent 149 MB (28 %), SupportTicket 54 MB for 223 rows (`imageBase64` inline), WAL steady at 35 MB (8.5× autocheckpoint), 64 stale snapshots = 19 GB in `prisma/` | §A1.3 / §A1.4 | — | cost + blast radius, not latency | Telemetry < 50 % → no retention change, no VACUUM (Q7); snapshots = Mew's hand |

**What the A2 page numbers say about the targets (Q3):** cold medians `/admin` 1,038 ms · `/dashboard` 674 ms · `/videos` 684 ms · `/admin/insights` 874 ms · `/video-editor` 880 ms are all inside their targets **when the writer queue is quiet**. The "ง่วง" is (a) the random 20–40 s contention stall (cause 1), (b) `/dashboard` warm bimodality (541 ms vs 3.3 s, seen twice in three runs during a contention window), (c) `/admin`'s 10 s disk walk making the disk tab unusable, and (d) three API routes miss Q3: `/api/admin/revenue` (1,704 ms) and `/api/admin/insights` (826 ms) above the 350 ms median line, `/api/admin/storage` above the 500 ms max line (528 ms); `/api/admin/cleanup` is the plan's recorded known cold cost. LCP/CLS/Lighthouse could not be captured this session (background-tab suppression; devtools MCP attached to a logged-out profile) — re-measure at Gate B with a foreground tab.


## 3. Number accuracy (A4)

**Full A4 table — sections 1-5** (source: A4 §1-§5)

### §3.0 Verdict tally (A4 §0)

(source: A4 §0)

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

### 1. `/admin` overview cards — `GET /api/admin/stats`

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
| 6 | `/admin` · **วิดีโอทั้งหมด** | 1585 | `stats/route.ts:37` `prisma.video.count()` → all `Video` rows | `SELECT COUNT(*) FROM Video` = 1585; `RenderJob type='RENDER' status='DONE'` = 2758; `VideoJob status='done'` = 3406 | 1585 | **Y** (number) / **definition disputed** | three defensible "videos created" exist and they differ by 2× | **C5** — see §3.7 |
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

> **C2 note (rows 24–33, added 2026-09-12):** rows 1–19 above are the pre-ADR-0062 `/admin` (fed by
> `GET /api/admin/stats`), replaced in Task C2 by the thin overview page fed by `GET /api/admin/trends`
> (`getAdminTrends`, `src/lib/admin-trends.server.ts`). Each new number's own correctness — Bangkok day
> boundaries, no double-counted orchestrated renders/failures, zero-fill, previous-window math — is
> pinned by 30 fixture assertions in `scripts/verify-admin-trends.ts` (Task C1, all green), not by a
> fresh A2 production capture: this plan's production access is read-only, and no A2 browser session
> against the rebuilt page exists yet. "Code definition" below cites the exact `getAdminTrends` query;
> "Actual"/"Match" are left "not captured" rather than guessed.
>
> | # | Surface · label | Shown | Code definition (file:line + the SQL Prisma runs) | Independent read-only SQL | Actual | Match | Cause | Fix |
> |---|---|---|---|---|---|---|---|---|
> | 24 | `/admin` North Star · ลูกค้าจ่ายที่กลับมาสร้างคลิป (MAPC) | *not captured* | `admin-trends.server.ts:170,215-224` `prisma.northStarDailySnapshot.findFirst({orderBy:{snapshotDate:'desc'}})`; `activeCreators`/`activePayingCustomers` read verbatim off the latest `NorthStarDailySnapshot` row, `rate = round(100·activeCreators/activePayingCustomers)` (client, `NorthStarHeadline.tsx`) | `SELECT * FROM NorthStarDailySnapshot ORDER BY snapshotDate DESC LIMIT 1` | *not captured* | — | same snapshot table `/admin/insights` §3.5's North Star reads (no new computation) | — |
> | 25 | `/admin` North Star · delta vs 30 days ago | *not captured* | `admin-trends.server.ts:217-223` looks up the snapshot exactly `NORTH_STAR_COMPARE_DAYS=30` Bangkok days earlier by primary key; `null` if that row is missing | `SELECT activeCreators FROM NorthStarDailySnapshot WHERE snapshotDate = date(<latest>, '-30 days')` | *not captured* | — | a snapshot gap (cron miss) reports "—" rather than a fabricated delta (verified: verify-admin-trends.ts "context: a missing 30-day-earlier snapshot…") | — |
> | 26 | `/admin` trend card · สมัครใหม่/วัน | *not captured* | `admin-trends.server.ts:124-130` `User` grouped by `date(createdAt/1000,'unixepoch','+7 hours')`, `WHERE email NOT LIKE '%@aoacademy%'` (same team exclusion as row 9 / insights Signup Cohort) | `SELECT date(createdAt/1000,'unixepoch','+7 hours'), COUNT(*) FROM User WHERE lower(email) NOT LIKE '%@aoacademy%' GROUP BY 1` | *not captured* | — | fixes row 8/9's day-boundary defect (Bangkok midnight, not server-TZ midnight) | — |
> | 27 | `/admin` trend card · สร้างคลิป/วัน (เรนเดอร์สำเร็จ) | *not captured* | `admin-trends.server.ts:132-141` `RenderJob` where `type='RENDER' AND status='DONE'`, bucketed by `COALESCE(finishedAt,createdAt)`; every row counts once, editor + orchestrated children alike (no `parentJobId` filter) | `SELECT date(COALESCE(finishedAt,createdAt)/1000,'unixepoch','+7 hours'), COUNT(*) FROM RenderJob WHERE type='RENDER' AND status='DONE' GROUP BY 1` | *not captured* | — | resolves row 6's three-way "videos created" ambiguity by picking one definition and stating it | — |
> | 28 | `/admin` trend card · สร้างคลิป/วัน (ส่งออกสำเร็จ) | *not captured* | `admin-trends.server.ts:132-141` same query, `type='BURN'` | `… WHERE type='BURN' AND status='DONE' GROUP BY 1` | *not captured* | — | — | — |
> | 29 | `/admin` trend card · จ่ายจริง/วัน (COUNT, no amount) | *not captured* | `admin-trends.server.ts:159-164` `Payment` where `status='PAID'`, bucketed by `date(paidAt/…)`; **count only**, never `amount` — ADR 0062 | `SELECT date(paidAt/1000,'unixepoch','+7 hours'), COUNT(*) FROM Payment WHERE status='PAID' GROUP BY 1` | *not captured* | — | deliberately does not replay row 10's `classifyEntitlement`/₿0-payment dispute — that dispute lives entirely on `/admin/revenue` now | — |
> | 30 | `/admin` trend card · งานล้มเหลว/วัน (ฝั่งเรา / ฝั่งลูกค้า) | *not captured* | `admin-trends.server.ts:142-158,180-188` `VideoJob status='failed'` + standalone `RenderJob status='FAILED' AND parentJobId IS NULL`, each row's error text run through `classifyJobError` (Job Failure Class, `src/lib/job-failure-class.ts`); `noise` dropped, `system`→ฝั่งเรา, `byok`/`quota`→ฝั่งลูกค้า | replay `classifyJobError` over the same two `SELECT … text` queries | *not captured* | — | an orchestrated failure's child `RenderJob` is intentionally excluded so it is not double-counted against its parent `VideoJob` | — |
> | 31 | `/admin` today strip + health pill · คิวเรนเดอร์ | *not captured* | `admin-trends.server.ts:167-168` `renderJob.count({status:'QUEUED'})` + `videoJob.count({status:'queued'})`, summed client-side | `SELECT COUNT(*) FROM RenderJob WHERE status='QUEUED'` + `SELECT COUNT(*) FROM VideoJob WHERE status='queued'` | *not captured* | — | — | — |
> | 32 | `/admin` health pill · Ticket ค้าง | *not captured* | `admin-trends.server.ts:169` `supportTicket.count({status:'OPEN'})` — same definition as row 23, now surfaced as a pill linking to `/admin/support` instead of a tab badge | `SELECT COUNT(*) FROM SupportTicket WHERE status='OPEN'` | *not captured* | — | — | — |
> | 33 | `/admin` health pill · ดิสก์ {p}% / แจ้งเตือน error ระบบ | *not captured* | `admin-trends.server.ts:120,171-172` `readDisk('/')` (single `df` call, never a `du` walk — same guard as row 20); `admin-trends.server.ts:165-166` `notification.count({type:'ERROR_SYSTEM', createdAt:{gte:currentStart}})` + `telemetryEvent.count({name:'frontend_error', createdAt:{gte:currentStart}})` | `df -h /`; `SELECT COUNT(*) FROM Notification WHERE type='ERROR_SYSTEM' AND createdAt>=<window start>` | *not captured* | — | disk figure keeps row 20's cheap single-call contract; error pill windows to the current 14/30-day toggle, not all-time | — |

> **ADR 0062 note (not a mismatch):** rows 10–18 render money on `/admin`. ADR 0062 (accepted 2026-09-12)
> says money renders only on `/admin/revenue`; `/admin` keeps only the จ่ายจริง **count** trend. These
> cards are the pre-change state the ADR was written to remove — recorded here so C2/C3 do not carry
> them forward.

---

### 2. `/admin/revenue` — `getRevenueGrowthDashboard` (`src/lib/revenue-growth.server.ts:146`)

Shown values from `admin-revenue.json`, captured 2026-09-11 21:09:45 UTC, `days=30`.

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 24 | **North Star · คนจ่ายที่กลับมาสร้างจริง (MAPC)** | 20 | `revenue-growth.server.ts:275` ← `subscription-north-star.server.ts:148-193`: payers (`activePayingBillingCohort`, `:111`) ∩ (completed video ∪ script ∪ Hero image) in trailing 30 d | full replay (Q3) | **20** | **Y** | number reproduces exactly | but see §3.8 — the *denominator* does not match CONTEXT.md |
| 25 | ลูกค้าจ่ายจริงที่ยังมีสิทธิ์ (`northStar.activePayingCustomers`) | 28 | `:180` `payerIds.size` — requires a `PAID` payment with **`amount>0 AND periodDays>0 AND note<>'credits' AND plan IN (PRO,BUSINESS)`** (`:116-121`), excludes suspended + ADMIN/`aoacademy.co`/`<owner-email>@` | Q3 | 28 | **Y** | **this is the correct "จ่ายจริง"** | — |
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

### 3. `/admin/insights` — all nine sections (`GET /api/admin/insights?days=30`)

Shown values from `admin-insights-days30.json`, captured 2026-09-11 21:10:44 UTC.
**Note on the default window:** the page's own state is `useState(1)` (`page.tsx:289`), so opening
`/admin/insights` from the sidebar fetches `?days=1`. A2 captured `?days=30` explicitly.

#### 3.0 The 20,000-row cap (affects sections 4, 6, 8 and the whole dev drawer)

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 51 | **every telemetry-derived number** (`totals.sessions/users/editorOpens/errors/byokErrorCount/quotaErrorCount/noiseEvents/frontendErrors/serverErrors`, `steps[]`, `errors[]`, `vitals[]`, `resource.*`, `broll.*`, `playback.*`, `managedStock.*`) | *not captured* (A2 collapsed `current`) | `insights/route.ts:842-850` `telemetryEvent.findMany({where:{createdAt:{gte:since}}, orderBy:{createdAt:'desc'}, take: 20_000})` | rows in window: **1 d = 5,175 · 7 d = 30,251 · 30 d = 102,501**; newest 20,000 of the 30-day window start at **2026-09-08 16:06 Bangkok** | at `days=30` the page reads **19.5 %** of the window (≈ the last 3.5 days). e.g. error-class rows: **745 in the sample vs 5,615 in the real 30 days**; `editor_opened` events: **693 vs 3,886** | **N** | silent `take` cap with no "truncated" signal in the payload or the UI | **C5 — Candidate 5** |
| 52 | the same numbers for "ช่วงก่อนหน้า" (Health Score comparison, `previous.*`) | *not captured* | `insights/route.ts:851-858` — same `take: 20_000`, **no `orderBy`** | previous 30-day window holds **78,233** rows | Prisma emits no `ORDER BY`; SQLite returns rowid order → the **oldest** 20,000 | **N** | current = newest 20 k, previous = oldest 20 k. Every "ดีขึ้น/แย่ลงจากช่วงก่อน" comparison at 7 d or 30 d compares two non-overlapping, differently-selected samples. | **C5 — Candidate 5** |

#### 3.1 Section 1 — North Star (MAPC)

Identical fields to rows 24–29 (`getSubscriptionNorthStar(now)`, `insights/route.ts:914`) and they matched:
shown `activeRecurringPayers 15 · activePayingCustomers 28 · activeCreators 20 · creatorRatePct 71 ·
monthlyCreators 7 · annualCreators 13` — all **Y**.

| # | Label | Shown | Code | SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 53 | `northStar.history[]` on insights | *not captured* | `:915-923` take 31 desc | `COUNT(*)=30`, max = 2026-09-11 | latest = yesterday at 04:34 Bangkok | **N** | same cron-TZ cause as #31 | Candidate 4 |

#### 3.2 Section 2 — Activation headline · `activation.*`

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 54 | สมัคร (`activation.signups`) | 1260 | `insights/route.ts:460-497` `users.length − internalIds.size`, internal = `email.includes('@aoacademy')` (**substring**) | `1275 − COUNT(email LIKE '%@aoacademy%')` = `1275 − 15` | 1260 | **Y** | all-time, not windowed — the panel says so | — |
| 55 | หมายเหตุ · ตัดบัญชีทีมงาน (`internalTeam`) | 15 | `revenue-cohorts.ts:313` same substring rule | `COUNT(*) WHERE email LIKE '%@aoacademy%'` | 15 | **Y** | **three different "internal" definitions ship together**: substring `@aoacademy` (funnel + cohorts), exact domain `aoacademy.co` **+ role ADMIN + <owner-email>@** (North Star, `subscription-north-star.server.ts:57`), and none at all (`/admin/stats`). They do not produce the same exclusions. | **C5 — Candidate 6** |
| 56 | hasGeminiKey | 125 | `:983` non-empty `geminiKey` | `TRIM(IFNULL(geminiKey,''))<>''` | 125 | **Y** | — | — |
| 57 | hasStockKey | 352 | `:984` non-empty `pexelsKey` OR `pixabayKey` | same | 352 | **Y** | — | — |
| 58 | **จ่ายจริง (`activation.paidTotal`)** | 39 | `:986` = `cohorts.payingTotal` | Q4 | 39 | **Y** (arithmetic) / **N** (meaning) | on this page it sits **directly under** the North Star block that says 28 | **Candidate 1** |
| 59 | Trial / แจกฟรี | *not captured* | `:1002-1003` | Q4 | 90 / 119 | **Y** | — | — |
| 60 | recurringMrr / prepaidMrr | 6,514.99 / 9,739.5 | `:993-994` | Q6 | 6,515.00 / **3,350.17** | recurring **Y**, prepaid **N** | as #43 | Candidate 2 |
| 61 | creditRevenue / creditBuyers | 1,295 / 5 | `:989-990` | Q4 | 1295.0 / 5 | **Y** | — | — |
| 62 | ช่วงที่เลือก: ได้วิดีโอ N คน / ก่อนหน้า N คน | *not captured* | `:1010-1011` distinct `Video.userId` where `COMPLETED`, non-internal, `createdAt` in window | `COUNT(DISTINCT userId)` 30 d / prev 30 d | **92 / 41** | **Y** (derived) | not capped (Video table, no `take` reached) | — |

#### 3.3 Section 3 — Activation funnel (per person, all-time)

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 63 | 1. สมัคร | 1260 | as #54 | — | 1260 | **Y** | — | — |
| 64 | **2. เข้าใช้งาน (เปิด editor / เริ่มผ่านแชท)** | *not captured* | `:486-488` **union** of {`editor_opened` telemetry users} ∪ {VideoJob creators} ∪ {completed-video creators}, minus internal | union = 773; telemetry-only = 771 | **773** | **Y** (number) / label misleading | it is an "engaged" union, not "opened the editor". The union is a deliberate fix for >100 % steps (code comment `:480-485`) — the *label* is what's wrong, not the maths. No double counting: `Set` semantics. | "definition is right, label is misleading" → rename to **เคยเข้าใช้งาน** |
| 65 | 3. กดเริ่มสร้าง | *not captured* | `:477-479` {VideoJob creators} ∪ {completed-video creators}, minus internal | union = 265; VideoJob-only = 262 | **265** | **Y** | 3 legacy users completed videos before `VideoJob` existed; folding them in is what keeps the funnel monotone | label: **เคยสั่งสร้าง** |
| 66 | 4. ได้วิดีโอเสร็จ | *not captured* | `:494` `video.groupBy(userId)` where `status='COMPLETED'`, minus internal | `COUNT(DISTINCT userId)` | **136** | **Y** | — | — |
| 67 | 5. ทำซ้ำ ≥2 | *not captured* | `:495` same groupBy, `count >= 2` | same | **86** | **Y** | — | — |
| 68 | conversion % per step | *not captured* | `page.tsx:353` `Math.min(100, pctOf(count, prev))` | 773/1260 = 61 % · 265/773 = 34 % · 136/265 = 51 % · 86/136 = 63 % | as left | **Y** | clamping is defensive only; no clamp actually fires here | — |

#### 3.4 Section 4 — System-health metric tiles

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 69 | **Video completed %** + helper `N/N jobs` | *not captured* | `insights/route.ts:219-240,777` — over **`Video` rows** in window, not `VideoJob`: `completed/total` | `SELECT status, COUNT(*) FROM Video GROUP BY status` → **COMPLETED 1585, everything else 0** (`Video_ever_nonCOMPLETED = 0`) | **always 100 %** | **N** | the `Video` table only ever holds `COMPLETED` rows on this database, so the tile is a constant. It is also labelled "jobs" while reading the `Video` table. Knock-on: `videoCompletionPenalty` (`:702-704`) and `statusStuckWithOutput` (`:715`) contribute **0** to the Health Score by construction — 35 of its 100 points can never be lost. | **C5 — Candidate 5** (point the tile at `VideoJob`) |
| 70 | Health Score | *not captured* | `:705-719` — 100 minus capped penalties for frontend errors ×3, server errors ×5, `renderP95/30 s`, video-completion, status-stuck, fail-candidates | inputs #51 (capped sample), #69 (constant 0), #75 (constant 0) | not reproducible as a business fact | **N** | three of its six penalty terms are structurally dead or sampled | Candidate 5 |
| 71 | Error telemetry (count) | *not captured* | `:622,769` real errors minus noise/byok/quota | error-class rows in 30 d = 5,615; in the newest-20 k sample = 745 | ~745 shown vs 5,615 real | **N** | #51 | Candidate 5 |
| 72 | เปิด Editor (ครั้ง) + helper `users · sessions · jobs` | *not captured* | `:611` raw `editor_opened` events; `:608-609` distinct sessionId / userId; `:613` **`pipelineJobs = videoJobs.total` = `Video` rows**, labelled "jobs" | `editor_opened` events 30 d = **3,886** (sample: 693); distinct sessions 30 d = **4,208**; `Video` rows 30 d non-internal = **661** | as left | **N** + label misleading | #51 for the first three; "jobs" is the `Video` table | Candidate 5 |

#### 3.5 Section 5 — งานจริง (server) · `jobOutcomes`

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 73 | งานทั้งหมด | 1704 | `:1028` `VideoJob createdAt>=since`, internal excluded | `COUNT(*) FROM VideoJob WHERE createdAt>=now-30d AND userId NOT IN (internal)` | 1703 | **Y (drift)** | one job created in the 25-min gap | — |
| 74 | done | 1395 | `:1029` | `status='done'` | 1394 | **Y (drift)** | — | — |
| 75 | ล้มเหลว: บั๊กระบบ / ชนเพดานแผน / คีย์ลูกค้า / noise | 245 / 8 / 0 / 1 | `:1034-1037` ← `classifyJobError:339` (noise → quota → managed-429 → byok → system) | total failed = **254** = 245+8+0+1 ✓ | 254 | **Y** | classification reproduces | — |
| 76 | **the missing 55** | — | the tile prints `total`, `done`, `processing` and the four failure classes | `status='canceled'` in window = **55**; 1394 done + 254 failed + 0 processing + 0 queued = 1648 ≠ 1703 | **55 canceled jobs are rendered nowhere** | **N** | `jobOutcomes` has no `canceled` field (`:1027-1039`); a reader subtracting gets 55 unexplained jobs | **C5 — Candidate 5** |
| 77 | processing / waitingProvider / queued | 0 / 0 / 0 | `:1031-1033` | same | 0 / 0 / 0 | **Y** | — | — |

#### 3.6 Section 6 — งานสร้างวิดีโอ funnel (per job, windowed)

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 78 | 1. เริ่มสร้าง (สั่งเรนเดอร์) | *not captured* | `insights/route.ts:431-453` all `VideoJob` in window, non-internal | same | **1703** | **Y** | — | — |
| 79 | **2. ได้ B-roll (`progress>=55`)** | *not captured* | `:433` | `progress>=55` = **1462**, of which `type='create'` **941** and `type='export'` **521** | 1462 | **Y** (number) / **N** (meaning) | the window holds **1,142 `create` + 561 `export`** jobs. An export job re-encodes an existing timeline and never fetches B-roll, yet all 521 that pass 55 % are counted as "ได้ B-roll". True create-path B-roll conversion is **941/1142 = 82 %**, the funnel shows **1462/1703 = 86 %**. | **C5 — Candidate 6** (split or filter `type`) |
| 80 | 3. จัดคลิปเสร็จ (`>=65`) / 4. เรนเดอร์ (`>=75`) / 5. เสร็จสมบูรณ์ | *not captured* | `:434-436` | 1427 / 1411 / 1394 | as left | **Y** (numbers) | same `create`/`export` conflation; also 30 jobs that reached `progress>=75` later **failed**, so step 4 legitimately exceeds step 5 | Candidate 6 |
| 81 | "นับจากงานเรนเดอร์จริง (VideoJob) N งาน" | *not captured* | `page.tsx:548` `funnelRuns` | = 1703 | 1703 | **Y** | no double counting: one row per job, `Set`-free counting | — |

#### 3.7 Section 7 — ขั้นตอน pipeline + **Status stuck**

| # | Label | Shown | Code definition | Independent SQL | Actual | Match | Cause | Fix |
|---|---|---|---|---|---|---|---|---|
| 82 | ขั้นตอน pipeline table (started/done/error/p50/p95) | *not captured* | `:638-670` over telemetry `pipeline_step_*`, de-duped by `pipelineRunId` | — | sampled per #51 | **N** | #51 | Candidate 5 |
| 83 | **Status stuck · PROCESSING >20 นาที** | *not captured* | `:871` `getProcessingReconcilePlan({staleAfterMinutes:20, failAfterHours:3, limit:100})` → `video-reconcile.ts:119-132` `Video status='PROCESSING' AND createdAt <= now−20 min`, **`take: 100`** | `COUNT(*) FROM Video WHERE status='PROCESSING' AND createdAt <= now−20min` | **0** | **Y** (0 = 0) | but structurally dead: zero `Video` rows have ever been non-`COMPLETED` on this DB (#69). And `total` is silently capped at 100 by `take: limit` — if a real backlog appeared, the tile would read "100" forever. | **C5 — Candidate 5** |
| 84 | **Status stuck thresholds — the two `failAfterHours` disagree** | — | read path `insights/route.ts:871` uses **`failAfterHours: 3`**; the Apply button `page.tsx:578` POSTs **`failAfterHours: 24`** with `failMissingOutput:false` | — | — | **N** | "fail ได้ N" is computed at a 3-hour cutoff but the button that acts on it uses 24 hours, so the count shown and the count acted on are different populations. The panel label ("PROCESSING >20 นาที") also never states either fail cutoff. | **C5 — Candidate 6** |
| 85 | มี output แล้ว / ไม่มี output / งานเก่าสุด | *not captured* | `video-reconcile.ts:167-176`; `existingOutput` **stats the filesystem** (`:84-96`, `size > 1500 B`) | 0 rows to inspect | 0 / 0 / – | **Y** | note: this is the one admin number that does disk I/O per row | — |

#### 3.8 Section 8 — Error telemetry list · 3.9 Section 9 — dev drawer

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

### 4. `/admin/insights` section 1 — `CostMarginPanel` (`GET /api/admin/costs`)

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

### 5. `/dashboard` — the admin's own account (`cmoycf2v…`)

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

**ตัวเลขนี้หมายถึงอะไรจริง ๆ — Thai per-mismatch paragraphs** (source: A4 §6)

### 6. ตัวเลขนี้หมายถึงอะไรจริง ๆ — one paragraph per mismatch

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

**Candidate C5 fixes, ranked by user impact** (source: A4 §9)

### 9. Candidate C5 fixes, ranked by user impact

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

### §3.7 What `วิดีโอที่สร้าง` should mean (A4 §7, mandated check)

(source: A4 §7)

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

### §3.8 MAPC vs the CONTEXT.md definition (A4 §8, mandated check)

(source: A4 §8)

CONTEXT.md:202 — *"unique customers with an **active recurring monthly or annual paid entitlement** who
complete at least one Core Creation Outcome within the trailing 30 days."*

| | CONTEXT.md | as implemented | measured |
|---|---|---|---|
| denominator | active **recurring** paid entitlement | `activePayingBillingCohort` (`subscription-north-star.server.ts:111-146`) — accepts a live Stripe sub **or** a still-valid prepaid term **or** `planExpiresAt IS NULL AND stripeSubscriptionId IS NULL` | **28** (of which 13 are prepaid one-time terms, 0 via the no-expiry branch) |
| the literal CONTEXT.md denominator | — | `recurringBillingCohort` (`:68-104`) exists and is already computed | **15** |
| numerator (Core Creation Outcome) | completed video · saved-or-Editor-bound Hero Script · usable Hero AI Image | `:221-244` — `Video COMPLETED` with a URL and **`updatedAt >= since`**; **any** `Script` row `createdAt >= since`; `AiGenerationJob` image completed+settled+URL on `hero_video`/`automix`/`scene_reroll` | **20** (video 18 · script 11 · image 19) |
| exclusions | Trials, coupons, Administrator Grants | enforced — `amount > 0 AND periodDays > 0 AND note<>'credits' AND plan IN (PRO,BUSINESS)`; plus suspended, ADMIN, `<owner-email>@`, `aoacademy.co` | ✓ |

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

### §3.9 Deferred with reason (not in the six C5 fixes)

| A4 row | Defect | Why deferred | Filed |
|---|---|---|---|
| #79/#80 | creation funnel mixes `create` and `export` jobs (86 % shown vs 82 % real) | funnel is rebuilt as the `/admin` trend cards (C1 counts renders and exports separately, ADR 0062); the insights funnel is pruned in the post-C4 follow-up | insights-payload follow-up (plan "Out of scope") |
| #101 | "Render Web / MCP" counts `BURN` too (52/2,085 next to 37/1,209) | same surface as #79; C1's series use `type='RENDER'` / `type='BURN'` explicitly | same follow-up |
| #102 | "ครีเอเตอร์ active 39" = anyone who emitted any telemetry (CONTEXT.md creator count = 92) | definition change of a Growth term → Mew decides; C2's North Star card uses `NorthStarDailySnapshot.activeCreators` instead | Gate A question / A5 umbrella |
| #116 | `/api/user/me` still ships the dead `usageCount`/`usageLimit` meter | touching the `/api/user/me` payload belongs to B3's review scope (auth hot path); dropping fields is a contract change for the dashboard client → done with B3 if the reviewer clears it, else follow-up | B3 / A5 umbrella |
| #55 | three different "internal team" rules | one-line each; grouped into the definitions follow-up so one PR carries one rule | A5 umbrella |
| #84, #98 | `failAfterHours` 3 vs 24; annual threshold 300 vs 365 days | same | A5 umbrella |
| MAPC denominator (§3.8) | code counts prepaid terms still running; CONTEXT.md:202 says recurring | the shipped number is exact and the code's argument is sound → reconcile CONTEXT.md wording in C6; numerator tightening (`Script` drafts, `Video.updatedAt`) is a North Star definition change → Mew decides | C6 + Gate A question |

## 4. Error summary — 14 days (A5)

**§0 ช่วงเวลาที่วัดได้จริง (window caveat)** (source: A5 §0)

### 0. ช่วงเวลาที่วัดได้จริง (อ่านก่อนใช้ตัวเลข)

| แหล่ง | ครอบคลุมจริง | เหตุผล |
|---|---|---|
| `TelemetryEvent` (DB) | **14 วันเต็ม** 2026-08-30 → 2026-09-12 | ข้อมูลอยู่ใน DB ครบ |
| `SupportTicket` (DB) | **14 วันเต็ม** | เช่นกัน |
| Sentry | **14 วันเต็ม** (`statsPeriod=14d`) | retention ของ Sentry ครอบคลุม |
| PM2 logs | **2.40 วัน** (2026-09-09 18:31 → 2026-09-12 04:05 BKK) | PM2 เพิ่งเริ่มเขียน ISO timestamp เมื่อ 2026-09-09T11:31:07 UTC (A1 §Coverage caveat) ก่อนหน้านั้นแยกเป็นวันกรุงเทพฯ ไม่ได้ ไฟล์ log เก่าสุดบนเครื่องคือ 2026-09-07 |

**ตัวเลขจาก PM2 ทุกตัวในตารางนี้คือของ 2.40 วัน ไม่ได้คูณขยายเป็น 14 วัน** ช่องไหนที่มาจาก PM2 จะเขียนกำกับไว้

**§1 ตารางสรุป error 14 วัน** (source: A5 §1)

### 1. ตารางสรุป error 14 วัน

Error Source Class: `ours` (โค้ดเรา ไม่ว่ารันที่ไหน) · `customer-key` (คีย์/เครดิต BYOK ของลูกค้า) · `third-party-noise` (ส่วนขยายเบราว์เซอร์, in-app WebView, สคริปต์ที่ถูกฉีดเข้ามา) · `clerk-network` (เบราว์เซอร์ผู้เข้าชมต่อ CDN ของ Clerk ไม่ได้) · `unclassified`

| # | กลุ่ม error | แหล่ง | จำนวน 14 วัน | กระทบ (ผู้ใช้/ticket) | Error Source Class | แนะนำ | Linear ที่มี / ร่างใหม่ |
|---|---|---|---|---|---|---|---|
| 1 | **ติดคิวเขียน SQLite ตัวเดียว** — slow transaction ≥ 5 s, `Socket timeout`, `P1008`, `Transaction already closed` | PM2 | **ai-content** 217 slow-tx ≥ 5 s · **story-film-system-worker** 152 slow-tx ≥ 5 s + `lease failed` 102 (ทั้งสองชุดนี้คือ **2.40 วัน**) · marker: `Socket timeout` 73, `Transaction already closed` 101, `P1008` 23 (นับจากไฟล์ log ทั้งหมดที่มีบนเครื่อง คือตั้งแต่ 2026-09-07 ไม่ใช่ 14 วัน) | 54 จาก 219 (25 %) ของ slow-tx มี error ที่ผู้ใช้เห็นภายใน ±2 s · p50 hold 25.2 s, p90 30.2 s, max 46.3 s | `ours` | **แก้** | **HERO-10** → ร่าง `linear-drafts/HERO-10-reopen-comment.md` + `linear-drafts/perf-audit-umbrella.json` |
| 2 | **WebView/ส่วนขยายของเบราว์เซอร์ผู้เข้าชม** — `Error invoking postMessage: Java object is gone`, `Failed to connect to MetaMask`, `window.webkit.messageHandlers` | Sentry + telemetry | Sentry **183 จาก 226 events (81 %)** (7 groups) · `TelemetryEvent` **413 จาก 520 frontend_error (79 %)** | 0 บัญชีที่ล็อกอิน, 0 ticket · แต่ทำให้ตัวเลข error ฝั่ง `/admin/insights` ผิด | `third-party-noise` | **noise** (ต้องกรองฝั่ง telemetry) | ร่างใหม่ `linear-drafts/frontend-error-telemetry-noise.json` |
| 3 | **Hero AI Image RunPod `OUTPUT_INVALID`** | telemetry | `hero_ai_image_video_scene_error` 69 + `fetch_stock_server_error` 15 = **84** (7 วัน 09-05 → 09-11) | **20 บัญชี** · แนวโน้มขึ้น (09-05 = 1 → 09-09 = 23) | `ours` | **แก้** | ร่างใหม่ `linear-drafts/hero-ai-image-output-invalid.json` (ต่อจาก HERO-9 / HERO-12 ที่ Done แล้ว) |
| 4 | **brand visual preflight ถูกปฏิเสธ** — `schema_invalid` 27, `empty_provider_response` 13, ไม่ระบุ 1 | telemetry | **41** (+ `beat_count_mismatch` 6 ซึ่งเป็นของ HERO-26) · `pipeline_step_error` step `captions` 9 ครั้งที่ผู้ใช้เห็นข้อความ "ผลวิเคราะห์แนวภาพยังไม่สมบูรณ์" | **13 บัญชี** (captions 5 บัญชี) · 09-11 = 12 events (สูงสุดของช่วง) | `ours` | **แก้** | ร่างใหม่ `linear-drafts/brand-visual-preflight-invalid.json` · ส่วน `beat_count_mismatch` → **HERO-26** (Done, เฝ้าดู) |
| 5 | **401 บน endpoint ที่ poll อยู่เบื้องหลัง** (`auth_request_recovery`) | telemetry | **1,730 events** (`refreshing` 1,121 · `signed_out` 551 · `done` 495 · `refresh_failed` 56 · `retry_failed` 2) | 6–9 บัญชี/วัน · `/api/notifications` 981, `/api/editor-projects` 352, `/api/videos/usage` 338, `/api/credits/balance` 329 | `ours` | **แก้** | ร่างใหม่ `linear-drafts/auth-session-refresh-401-storm.json` |
| 6 | **เบราว์เซอร์ผู้เข้าชมต่อ CDN ของ Clerk ไม่ได้** — `failed_to_load_clerk_ui/js`, `ClerkJS: Network error` | Sentry + telemetry | Sentry **11** (5 groups) · telemetry **10** (`failed_to_load_clerk_ui` 9, `failed_to_load_clerk_js` 1) | 0 บัญชี · ไม่มี ticket | `clerk-network` | **เฝ้าดู** — **ห้ามใส่ `beforeSend`** ตามข้อบังคับของแผน | **HERO-19** (Done, เฝ้าดูถึง 09-18) |
| 7 | **MCP transport `Error: aborted`** (`POST /api/[transport]`) | Sentry + PM2 | Sentry **12 events** = PM2 **24 บรรทัด** `unhandledRejection: Error: aborted` (ตรงกันพอดี 2 บรรทัด/event) | 0 บัญชี · ล่าสุด 2026-09-11T21:03:39Z บน release `84e4d8c2` | `ours` | **เฝ้าดู** | ยังไม่มี issue — เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json`; เปิดใหม่ถ้าเกิน 5/วัน |
| 8 | **RSC stream ปิดก่อนเวลา** — `The destination stream closed early.` (`GET /ai-studio`) + `router state header ... could not be parsed` (`GET /(auth)/login`) | Sentry | 3 + 2 = **5** | 0 บัญชี | `ours` | **เฝ้าดู** | ยังไม่มี issue — เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 9 | **stream controller ปิดแล้วยัง enqueue** (fatal, `GET /api/renders/*.mp4`) | Sentry | **2** (ล่าสุด 2026-09-08T03:43Z) | 0 บัญชี | `ours` | **เฝ้าดู** | **HERO-7** (Ready to Deploy) |
| 10 | **`play()` ถูก `pause()` ขัด** บน `/video-editor` | Sentry + telemetry | Sentry **3** · telemetry **13** · event สุดท้าย 2026-09-11T04:42Z **ก่อน** deploy ของ HERO-27 (09-11 19:08Z) · หลัง deploy = **0** | 1 session ต่อครั้ง | `ours` | **เฝ้าดู** (ตรงกับที่คาดหลัง fix) | **HERO-27** (Done, เฝ้าดูถึง 09-18) |
| 11 | **HeyGen avatar ผลลัพธ์ไม่ทราบสถานะ** — `avatar generate has unknown provider outcome` | telemetry | **2** (09-03, 09-09) | **2 บัญชี** · ticket `cmtvcdmm` (ปิดแล้ว, คืนเงินไม่ต้องเพราะเป็น label ค้าง) | `ours` | **เฝ้าดู** | **HERO-18** (Done, เฝ้าดูถึง 09-17) |
| 12 | **ชนเพดานแผน** — นาที AI-audio 15, ความยาวคลิปเกินแผน PRO 5 | telemetry | **20** | **4 บัญชี** | `ours` (กติกาธุรกิจ ไม่ใช่บั๊ก) | **เฝ้าดู** | **HERO-25** (Done) |
| 13 | **เครดิต/allowance หมด** — fetch-stock `402` 11, `insufficient_credits` 9, `ALLOWANCE_EXHAUSTED` 12, `ai_image_credit_reservation_rejected` 7 | telemetry | **39** | ~**9 บัญชี** (ทั้งหมด `fundingPolicy=conversion-trial`) | `ours` (กติกาธุรกิจ) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 14 | **คีย์ลูกค้าเต็มโควต้า** — ElevenLabs `401 quota_exceeded` | telemetry | **1** | **1 บัญชี** | `customer-key` | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 15 | **b-roll coverage ไม่ครบ** — `broll_coverage_rejected` 3 + `render 422 broll_coverage_incomplete` 3 | telemetry | **6** | **3 บัญชี** | `ours` | **เฝ้าดู** | **HERO-12** (Done) |
| 16 | **`POST /api/videos` 500 ที่ข้อความไม่บอกสาเหตุ** + `render failed: Cannot find module .../@remotion/bun...` | telemetry | 9 + 1 = **10** (ทั้งหมด 2026-08-30) | **1 บัญชี** | `unclassified` (ข้อความ 500 ถูกกลบ จึงระบุสาเหตุจากข้อมูลที่มีไม่ได้) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` — ถ้ากลับมาซ้ำ ต้องเปิด issue เพราะ `Cannot find module` บน prod คือ defect จริง |
| 17 | **ไคลเอนต์ค้างเวอร์ชันเก่าหลัง deploy** — `ChunkLoadError` 6, `Server Action ... was not found on the server` 2 | telemetry | **8** (09-09 5, 09-10 2, 08-30/09-04 1) | 3 sessions | `ours` | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 18 | **`Script error.` (cross-origin ทึบ)** | telemetry | **37** | — | `third-party-noise` | **noise** (ถูกกรองโดย `benignTelemetryReason` แล้ว) | `linear-drafts/frontend-error-telemetry-noise.json` (ครอบคลุมอยู่แล้ว ไม่ต้องเปิด issue แยก) |
| 19 | **เน็ตผู้ใช้หลุดกลาง fetch** — `TypeError: Load failed` / `Failed to fetch` | Sentry + telemetry | Sentry **4** · telemetry **6** | 1–2 บัญชี | `unclassified` (ไม่มี stack ฝั่งเรา แยก "เน็ตผู้ใช้" กับ "เราตอบช้า" ไม่ได้) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 20 | **`frontend_error` ที่ไม่มีข้อความเลย** (`message` ว่าง, `errorName=Error`) | telemetry | **14** | 9 sessions / 6 หน้า | `unclassified` | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` — ควรเก็บ `source`/`stack` ให้ครบก่อนจึงจะจัดชั้นได้ |
| 21 | **error เฉพาะจุดบน `/video-editor`** — `NotFoundError` 6 (มี frame ของเราเอง), `SyntaxError` 4, `ReferenceError: Can't find variable: EmptyRanges` 5 (`EmptyRanges` ไม่มีอยู่ใน `src/` เลย) | telemetry | 6 + 4 = **10** (`ours`) · 5 (`third-party-noise`) | 2–3 บัญชี · แต่ละกลุ่มเกิดวันเดียว | `ours` (NotFoundError/SyntaxError) · `third-party-noise` (EmptyRanges) | **เฝ้าดู** | เฝ้าดูใต้ `linear-drafts/perf-audit-umbrella.json` |
| 22 | **event ที่เราสร้างเองเพื่อทดสอบ / ไม่ใช่ error** — `HTTP/1.1 Overhead` (level `info`) 5, smoke test ที่ ignore ไว้ 3, `Sentry.captureException is not a function` จาก `eval` 1 | Sentry | **9** | 0 บัญชี | `ours` (เราเป็นคนยิงเอง) | **noise** | `linear-drafts/perf-audit-umbrella.json` (บันทึกไว้เฉย ๆ ไม่ควรเปิด issue แยก) |

**รวม**: Sentry 226 events / 23 groups (unresolved) + 3 groups ที่ ignore ไว้ · telemetry `frontend_error` 520 rows · telemetry `category='error'` ทั้งหมด 2,537 rows · PM2 (2.40 วัน) 369 slow-tx ≥ 5 s สองแอปรวมกัน · ticket 19 ใบ

**§2 Support ticket 14 วัน (ticket census)** (source: A5 §2)

### 2. Support ticket 14 วัน (id 8 ตัวแรกเท่านั้น)

19 ใบ ระหว่าง 2026-08-30 → 2026-09-11 (ไม่มีใบใหม่ใน 09-12 ถึงเวลาที่วัด)

| category | จำนวน | ที่ยังเปิด |
|---|---:|---:|
| `BUG_CONFIRMED` | 10 | 0 |
| (ยังไม่ได้จัดหมวด) | 6 | 1 |
| `USER_CONFUSION` | 1 | 0 |
| `NEED_MORE_INFO` | 1 | 1 |
| `FEATURE_REQUEST` | 1 | 0 |

| severity | status | จำนวน |
|---|---|---:|
| HIGH | CLOSED | 8 |
| (ว่าง) | CLOSED | 5 |
| LOW | CLOSED | 2 |
| MEDIUM | CLOSED | 2 |
| MEDIUM | OPEN | 1 |
| (ว่าง) | OPEN | 1 |

ต่อวัน (กรุงเทพฯ): 08-30 = 5 · 08-31 = 4 · 09-02 = 1 · 09-04 = 2 · 09-05 = 1 · 09-07 = 2 · 09-09 = 1 · 09-10 = 2 · 09-11 = 1

ใบที่ผูกกับ Linear แล้ว: `cmtqxfam` → HERO-9 · `cmtr1o4p` → HERO-8 · `cmtvut72` → HERO-20 (ทั้งสาม Done)
**ที่ยังเปิดอยู่ 2 ใบ**: `cmtgs2r2` (`NEED_MORE_INFO`/MEDIUM, 08-31) และ `cmtm2hvc` (ยังไม่จัดหมวด, 09-04) — ทั้งคู่ไม่มี Linear และไม่แมปกับกลุ่ม error ใดในตารางที่ 1 ได้จากข้อมูลที่อนุญาตให้อ่าน (ห้ามอ่านเนื้อความ)

บริบท job: 14 วันมี VideoJob 1,119 งาน — `done` 991, `failed` **95 (8.5 %)**, `canceled` 33 · วันที่แย่สุด 08-30 (26/124) และ 09-11 (18/133)

**§3 Cross-check: Sentry ต่ำกว่าความจริงตรงไหน** (source: A5 §3)

### 3. Cross-check: Sentry ต่ำกว่าความจริงตรงไหน (A1 PM2 census)

| ชั้น | Sentry เห็น | PM2 เห็น (2.40 วัน) | อธิบาย |
|---|---:|---:|---|
| ติดคิวเขียน SQLite | **0 events** | 369 slow-tx ≥ 5 s (2.40 วัน) + 197 บรรทัด `Socket timeout`/`P1008`/`Transaction already closed` (ไฟล์ตั้งแต่ 09-07) | Prisma error ถูก catch แล้วตอบเป็น HTTP error ไม่เคย throw ออกไปถึง handler ของ Sentry — **Sentry จึงมองไม่เห็นปัญหาใหญ่ที่สุดของระบบเลย** |
| `unhandledRejection: Error: aborted` | 12 events | 24 บรรทัด | ตรงกันพอดี (1 event = 2 บรรทัด: `⨯ unhandledRejection` + `[instrumentation] unhandledRejection`) |
| `uncaughtException` | 0 | 2 บรรทัด | นอกช่วง timestamp จึงระบุวันไม่ได้ |
| `[API Error] ... ERROR_SYSTEM (capacity)` | 0 | 26 × `GET /api/brand-library`, 8 × `user/me`, 6 × `POST /api/scripts/generate`, 6 × `GET /api/credits/balance` ฯลฯ | ปลายทางของแถวที่ 1 ที่ผู้ใช้เห็นจริง ไม่มีอันไหนขึ้น Sentry |

**สรุป**: Sentry ครอบคลุมเฉพาะ error ฝั่งเบราว์เซอร์และ exception ฝั่ง Node ที่หลุดขึ้นไปถึง top level เท่านั้น ห้ามใช้ event count ของ Sentry เป็นตัวชี้วัดสุขภาพระบบ — ต้องอ่านคู่กับ PM2 และ `TelemetryEvent` เสมอ

**ตัวกรอง noise: Sentry ทำแล้ว แต่ `TelemetryEvent` ยังไม่ทำ** (source: A5 §4)

### 4. ตัวกรอง noise: Sentry ทำแล้ว แต่ `TelemetryEvent` ยังไม่ทำ

PR #463 (`5b861bf8`, merge 2026-09-09T14:29 +07 = 07:29 UTC) เริ่มทิ้ง third-party browser noise ก่อนส่งขึ้น Sentry

| | ก่อน 2026-09-09T07:45Z | หลัง 2026-09-09T07:45Z |
|---|---:|---:|
| Sentry — WebView bridge / MetaMask (event สุดท้าย 09-09T07:44Z) | มี | **0** |
| `TelemetryEvent` — WebView bridge | 331 | **62** |
| `TelemetryEvent` — MetaMask | 8 | **10** |
| `TelemetryEvent` — iOS bridge | 1 | **1** |
| `TelemetryEvent` — `frontend_error` ทั้งหมด | 418 | 102 |

หลังตัวกรองลง prod แล้ว **73 จาก 102 แถว (72 %)** ที่ `TelemetryEvent` ยังเขียนอยู่คือ noise ชุดเดียวกับที่ Sentry ทิ้งไปแล้ว
`src/components/telemetry/telemetry-provider.tsx` ไม่มีตัวกรองใด ๆ และ `benignTelemetryReason()` (`src/app/api/admin/insights/route.ts:288`) ไม่มีกฎสำหรับ WebView bridge หรือ extension frame → **413 จาก 520 แถว (79.4 %) ถูกนับเป็น error ของเราบน `/admin/insights`**

ย้ำข้อบังคับ: **ห้าม** ใส่ `failed_to_load_clerk_js` หรือ error ของ sign-in/sign-up ลง `beforeSend` ไม่ว่าในกรณีใด (แถวที่ 6)

---

**HERO-10 — ทำไมจึงร่างให้เปิดใหม่** (source: A5 §5)

### 5. HERO-10 — ทำไมจึงร่างให้เปิดใหม่

เกณฑ์ปิดเดิม: *contention signature ใน PM2 error log < 5 ครั้ง/วัน ติดกัน 7 วัน* — **ยังไม่ผ่าน ไม่ว่าจะนับแบบไหน**

| วัน (กรุงเทพฯ) | slow-tx (1 บรรทัด = 1 event) | ที่ ≥ 5 s | p50 | p90 | max | `Socket timeout` + `Tx closed` + `P1008` (บรรทัด) |
|---|---:|---:|---:|---:|---:|---:|
| 09-09 (ตั้งแต่ 18:31) | 42 | 42 | 29,497 ms | 39,215 ms | 45,572 ms | 26 |
| 09-10 | 99 | 98 | 20,241 ms | 30,147 ms | 46,302 ms | 18 |
| 09-11 | 72 | 71 | 27,035 ms | 30,137 ms | 45,284 ms | 9 |
| 09-12 (ถึง 03:47) | 4 | 4 | 20,701 ms | 30,062 ms | 30,089 ms | — |

รวม 2.40 วัน (n = 217): p50 **25,166 ms** · p90 **30,191 ms** · max **46,302 ms** · 150 จาก 219 (68.5 %) ตกอยู่ภายใน ±500 ms ของ timeout ที่ตั้งไว้

- เกณฑ์คือ < 5/วัน แต่วัดได้ **42 / 98 / 71** ต่อวัน (นับแบบ 1 บรรทัด = 1 event ไม่มีการพองจาก stack)
- แม้หารบรรทัด marker ด้วย 3 ตามที่ comment เดิมเตือนไว้ ก็ยังได้ ≈ 8.7 / 6.0 / 3.0 ต่อวัน → 2 ใน 3 วันยังไม่ผ่าน
- เกณฑ์ข้อสาม (telemetry ไม่โต) ก็ยังไม่ผ่าน: `TelemetryEvent` = 149.41 MB = **28.3 %** ของ DB, 305,452 แถว, **66 % เก่ากว่า 30 วัน**, ยังไม่มี retention job ใน `ecosystem.config.js`

ร่าง comment: `docs/plans/reports/linear-drafts/HERO-10-reopen-comment.md`

คำสั่งที่ **ตั้งใจจะรัน** (ยังไม่ได้รัน และห้ามรันจนกว่า Mew จะสั่ง):

```bash
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social-perf-audit-reports
LINEAR_CLI=.agents/skills/hero-studio-ops/scripts/linear.mjs
node "$LINEAR_CLI" comment HERO-10 --file docs/plans/reports/linear-drafts/HERO-10-reopen-comment.md   # preview
node "$LINEAR_CLI" transition HERO-10 "Triage"                                                          # preview
# --apply เฉพาะเมื่อ Mew สั่งในข้อความนั้น ๆ
```

---

**§6 ร่าง Linear ทั้งหมด — six draft files** (source: A5 §6)

### 6. ร่าง Linear ทั้งหมด (ยังไม่ apply อะไรเลย)

| ไฟล์ | ชนิด | state / priority | labels | แถวที่อ้างถึง |
|---|---|---|---|---|
| `linear-drafts/HERO-10-reopen-comment.md` | comment + `transition HERO-10 "Triage"` | — | — | 1 |
| `linear-drafts/perf-audit-umbrella.json` | issue ใหม่ | Triage / P2 | Improvement · Area / Infra · Execution / Agent-ready · Risk / Production | 1, 7, 8, 13, 14, 16, 17, 19, 20, 21 |
| `linear-drafts/hero-ai-image-output-invalid.json` | issue ใหม่ | Triage / P2 | Bug · Area / B-roll · Execution / Agent-ready · Risk / Production | 3 |
| `linear-drafts/brand-visual-preflight-invalid.json` | issue ใหม่ | Triage / P3 | Bug · Area / Brand · Execution / Agent-ready · Risk / Production | 4 |
| `linear-drafts/auth-session-refresh-401-storm.json` | issue ใหม่ | Triage / P3 | Improvement · Area / Infra · Execution / Agent-ready · Risk / Production | 5 |
| `linear-drafts/frontend-error-telemetry-noise.json` | issue ใหม่ | Triage / P3 | Improvement · Area / Infra · Execution / Agent-ready · Risk / Production | 2, 18 |

## 5. Fix map

| Cause (§2) | Task | Change | Expected gain (measured basis) | Policy |
|---|---|---|---|---|
| 3 (storage half only) | **B1** | `getStorageHealth` cached 10 min per `cwd`; `?refresh=1` bypasses; export `readDisk` | `/api/admin/storage` 269 ms → ~1 ms warm (estimate); the `du` walk runs ≤ 6×/h instead of per open. **Does not touch the 10 s `/api/admin/cleanup` walk** (relocated by C3; bounding it = follow-up) | quick-win (cache) |
| 9 | **B2** | `getConfigs(keys)` one explicit `IN` query | none measurable — Prisma already batches the 32 `findUnique` calls into one `IN` query; kept as a code-clarity quick-win that removes the batching assumption | quick-win (fewer duplicate queries) |
| 2, 1a | **B3** | pass the loaded `User` row into `syncUserEntitlement` / bundle / paid-equivalent; `/api/user/me` reuses `authUser` | auth prefix 8 → 5 statements on every request; `/api/user/me` 34 → ~10 (with per-request memo); ~40–50 fewer statements per dashboard load | quick-win (fewer duplicate queries); the 1a write elimination is B6 row 3 and needs Mew |
| 6 | **B4** | subtitle font sheet only on routes that draw subtitles; root keeps Inter + Bai Jamjuree | non-editor routes 107 KB → 11 KB blocking CSS (−90 %); editor 107 → 70 KB | quick-win (per-route fonts) |
| 8 | **B5** | updates summary fetched once per session | −1 request per navigation | quick-win |
| 7 | **B6 row 1** | `@@index` on `Notification` for the `/api/notifications` shape | SCAN → SEARCH on 16.5 k rows (the 226–1,170 ms cold figure is total request time; DB-time saving unquantified until measured) | quick-win (additive index) |
| 1b | **B6 row 2** (Mew decides) | `leaseStoryFilmGenerationJobs`: cheap read-only pre-check outside the transaction; open the write transaction only when there is expired-lease or queued work; body unchanged | removes ~21,000 idle write-lock acquisitions/day; `P1008` lease failures 25/day → ~0 | outside the decision table → Gate A question |
| 1a | **B6 row 3** (Mew decides) | `syncUserEntitlement`: skip the `UPDATE User` when every computed field equals the stored value (outcome-neutral; golden test with a sixth fixture proves it) | removes 1–2 write-lock acquisitions per request for 107 accounts (43 % of paid) | B3 says "no early returns" → Gate A question |
| 1c | advisory | `PRISMA_TX_MAX_WAIT_MS` / socket budgets (the decision table's row-5 remedy) — fail fast instead of 20–40 s | shorter stalls, same contention; changes failure timing for every process → needs its own measurement window, so not chosen while 1a/1b remove the contention at its source | HERO-10 comment; not in this plan |
| 5 | **C5 fix 4** | bound the insights telemetry queries (aggregate server-side, `orderBy` on the previous window, `truncated` flag) | `/api/admin/insights` 826 ms → target < 350 ms; numbers become 30-day, not 4-day | high-assurance (numbers) |
| 4 | follow-up | cache / window the Stripe pagination on `/api/admin/revenue` | 1,704 ms → target; money route, ask Mew | out of this plan |
| 3 (scans) | follow-up | `take:` on the six cleanup graph scans | bounded DB time inside the walk | out of this plan |
| 10 | out of scope | code-splitting `/video-editor` | target already met (880 ms) | own plan if ever missed |
| — | Mew's hand | delete 64 stale `prisma/dev.db.*` snapshots (19 GB); set `BACKUP_RSYNC_TARGET` | −19 GB (disk 66 % → ~61 %); off-box copy exists | ops, listed in §1.1 |

Number-accuracy fixes (C5, ≤ 6, from A4 §9) and the admin re-organisation (C1–C4) are in the plan's Phase C; §3 carries the per-number evidence.


## 6. Render pipeline — read-only review (A3 §A3.6)

(source: A3 §A3.6)

### §A3.6 Render pipeline — read-only review (findings only, nothing enters Phase B/C)

Read: `src/lib/render/run-render.ts`, `scripts/render-worker.ts`, `scripts/mcp-video-worker.ts`, and the render/stock env objects in `ecosystem.config.js`. **Nothing under `src/remotion/**`, `src/lib/render/run-render.ts` or `ecosystem.config.js` was modified.**

#### Concurrency and timeouts as configured

| Setting | Value | Source |
|---|---|---|
| `ai-content` (web) PM2 instances | **1** (no `instances` key → fork, single process) | `ecosystem.config.js:140` |
| web heap | `--max-old-space-size=3072`, `max_memory_restart: 4G` | `ecosystem.config.js:152-153,167` |
| `render-worker` instances | **2** (`exec_mode: fork`) | `ecosystem.config.js:459-460` |
| render-worker heap | `--max-old-space-size=4096`, `max_memory_restart: 5G` | `ecosystem.config.js:476,464` |
| `RENDER_CONCURRENCY` (frame threads per job) | **3** → 2 × 3 = 6 threads on 8 vCPU | `renderRuntimeEnv`, `ecosystem.config.js:45` |
| `RENDER_JOB_CONCURRENCY` (slots per process) | clamped to `[1, min(4, cpus)]`, default **1** | `run-render.ts:132-137` |
| `RENDER_OFFTHREAD_CACHE_MB` / `RENDER_JPEG_QUALITY` | 128 / 90 | `ecosystem.config.js:47-48` |
| `selectComposition` timeout | 120 000 ms | `run-render.ts:336` |
| `renderMedia` timeout | 7 200 000 ms (2 h) | `run-render.ts:468` |
| worker stall watchdog | `RENDER_STALL_MS` 120 000 ms (progress-derived) | `render-worker.ts:29` |
| worker wall-clock cap | `RENDER_WALLCLOCK_MS` 45 min | `render-worker.ts:30` |
| dead-job sweep threshold | `STALL_MS + 3×WATCHDOG_MS` = 150 s | `render-worker.ts:35` |
| worker poll | `RENDER_WORKER_POLL_MS` 3000 ms | `render-worker.ts:28` |
| PM2 `kill_timeout` (graceful drain) | 30 000 ms | `ecosystem.config.js:463` |
| `mcp-video-worker` concurrency | `MCP_WORKER_CONCURRENCY` default **2**, clamped `[1,4]`, **single PM2 instance by design** | `mcp-video-worker.ts:34-39`, `ecosystem.config.js:415` |
| mcp worker poll / stall sweep / refund retry | 4000 ms / 60 000 ms / ≥15 000 ms | `mcp-video-worker.ts:12-21` |
| `STOCK_NORMALIZE_CONCURRENCY` / preset | 1 / `ultrafast` (runs in **`ai-content`**, not the worker) | `ecosystem.config.js:54-55` |

#### Findings (follow-ups only — no proposals)

1. **F1 — one web process, four writer processes, one SQLite file.** `ai-content` runs a single Node process (no `instances`), and shares `prisma/dev.db` with 2 × `render-worker`, 1 × `mcp-video-worker` (2 in-process orchestrations) and `story-film-system-worker`. Every `BEGIN IMMEDIATE` from §A3.1 competes with those. This is the structural context A1b needs for the HERO-10 write-lock question; the render side is not the source of the extra transactions, the auth path is.
2. **F2 — stock normalisation runs in the web process.** `STOCK_NORMALIZE_CONCURRENCY=1` / `STOCK_NORMALIZE_PRESET=ultrafast` are deliberately pinned, and the comment states this runs "in the ai-content fetch-stock route, not render-worker". ffmpeg work therefore lands in the same single process that serves `/api/user/me`. Recorded as an observation only; touching it is out of scope under Global Constraints.
3. **F3 — `/api/admin/cleanup` blocks the web event loop with synchronous filesystem recursion.** `src/lib/media-cleanup.ts` uses `fs.readdirSync` / `fs.lstatSync` recursively (lines 177, 192, 265, 354, 521, 531, 577, 660, 670). On the single web process this is a hard block for the duration of the walk — it stalls every other request, including renders' status polls. `maxDuration = 120` is declared on the route.
4. **F4 — `/api/admin/cleanup` also runs 6 unbounded `findMany` scans.** `src/lib/media-reference-graph.ts` reads `video`, `videoJob`, `editorProject` (drafts), `renderJob`, `generatedImage`, `aiGenerationJob` with **no `take:` on any of them** — full-table reads that grow with the database.
5. **F5 — `/api/admin/storage` shells out.** `getStorageHealth` runs `df -kP` (5 s timeout) and `du -sk` per target path (15 s timeout each) via `execFile`. On a large media directory the `du` walk is the whole cost of that endpoint (its DB cost is literally 0 statements beyond the auth prefix). The 15 s timeout is the ceiling per path.
6. **F6 — `/api/admin/revenue` performs unbounded Stripe pagination per request.** `for await (const charge of stripe.charges.list(...))` and the same for refunds, plus `stripe.invoices.list()` per bundle subscription inside a `Promise.all`. Latency is proportional to Stripe history, not to local data, and there is no cache.
7. **F7 — render-worker cancellation policy is deliberate and correct-looking.** Stall / wall-clock / user cancel are terminal (no retry); only genuine render errors requeue; `requeueForShutdown` decrements `attempts` so a deploy consumes none. `makeCancelSignal` tears down Chromium. No orphan-child surface inside the worker (ffmpeg/probe children live in the route's pre-enqueue asset resolution). No finding.
8. **F8 — `mcp-video-worker` cannot be scaled to multiple PM2 instances** as written: `recoverProcessingJobsAfterWorkerRestart` requeues/fails *all* `processing` jobs at boot with no worker-id or heartbeat guard, so a second instance restarting mid-job would double-run a live sibling's job. Documented in the source; recorded here so nobody "fixes" throughput by bumping `instances`.
9. **F9 — the render queue's hot claim query does not use `@@index([status, type])`.** `claimNextRenderJob` issues `WHERE status = ? ORDER BY createdAt ASC LIMIT 1` (no `type` predicate); the only `status`-and-`type` pair in the codebase is not on a hot path. A1b should `EXPLAIN QUERY PLAN` the claim shape given in §A3.7, not a `status,type` pair.

## 7. Positives (do not touch)

- **The render pipeline is not the bottleneck and was not touched.** `render-worker` (both instances): 0 slow-tx; `[Render]` lines appear in slow-tx windows at 0.97× baseline. Remotion loads its own fonts (`captionStyles.ts`, `SubtitleOverlayComposition.tsx`, `VideoComposition.tsx`) and imports nothing from the app layout — B4 cannot affect rendered output.
- **Nightly backup is harmless to latency** — `VACUUM INTO` overlaps 0 of 217 slow-tx windows (1 of 219 events *started* inside a VACUUM, on 1 of 6 nights — A1's verdict: negligible); `cleanup-videos` (03:00 UTC) overlaps none. Keep both schedules.
- **The host is healthy**: 8 vCPU / 32 GB, load ≤ 1.09, event-loop p95 2.26 ms, HTTP mean 18 ms, freelist 0.47 %. No hardware or Postgres discussion is warranted by this evidence.
- **The North Star arithmetic is exact** — the independent replay reproduces 20 / 28 / 15 / 7 / 13 identically; `NorthStarDailySnapshot` has 30 rows with no gaps. Only the wording in CONTEXT.md and the cron hour are off.
- **Most page medians already meet Q3 when the writer queue is quiet** (§2) — the fix list is about removing the stalls and the two slow admin routes, not rewriting pages.
- **Sentry's noise filter works** (Remotion shutdown, third-party browser, Clerk `/touch`); `failed_to_load_clerk_js` stays visible by design. 10 of 14 API routes sit at warm p50 < 200 ms (11 of 14 meet the 350 ms median target).
- **`prisma-slow-tx` instrumentation (HERO-10, PRs #462/#465) is what made this audit possible** — keep it; the follow-up is to log queue-wait separately from held time, not to remove it.


## 8. Before / after

| surface / metric | before (A1/A2, 2026-09-12) | after D1–D3 (Gate B) | after D5 (C-gate) | after 7-day watch |
|---|---|---|---|---|
| `/admin` (cold / warm ms) | 1038 / 747 | — | — | — |
| `/dashboard` (cold / warm ms) | 674 / 3342 | — | — | — |
| `/videos` (cold / warm ms) | 684 / 546 | — | — | — |
| `/admin/insights` (cold / warm ms) | 874 / 746 | — | — | — |
| `/video-editor` (cold / warm ms) | 880 / 860 | — | — | — |
| `/api/user/me` (warm p50/max ms) | 182 / 219 | — | — | — |
| `/api/updates?summary=1` (warm p50/max ms) | 95 / 163 | — | — | — |
| `/api/notifications` (warm p50/max ms) | 104 / 182 | — | — | — |
| `/api/admin/stats` (warm p50/max ms) | 190 / 209 | — | — | — |
| `/api/admin/settings` (warm p50/max ms) | 100 / 232 | — | — | — |
| `/api/admin/storage` (warm p50/max ms) | 269 / 528 | — | — | — |
| `/api/admin/cleanup` (warm p50/max ms) | 10,164–10,738 (cold, one-shot ×3; no warm series by design) | — | — | — |
| `/api/admin/support?status=OPEN` (warm p50/max ms) | 93 / 169 | — | — | — |
| `/api/admin/music` (warm p50/max ms) | 91 / 160 | — | — | — |
| `/api/admin/insights?days=30` (warm p50/max ms) | 826 / 996 | — | — | — |
| `/api/user/stats` (warm p50/max ms) | 100 / 188 | — | — | — |
| `/api/videos` (warm p50/max ms) | 99 / 160 | — | — | — |
| `/api/editor-projects` (warm p50/max ms) | 93 / 155 | — | — | — |
| `/api/admin/revenue` (warm p50/max ms) | 1704 / 1853 | — | — | — |
| Slow-tx ≥ 5 s per day (ai-content, 09-09/09-10/09-11/09-12) | 42 / 98 / 71 / 4 (09-09 partial from 18:31 · 09-10 full · 09-11 full · 09-12 partial to 03:47; **judge AC3 against full days: 98, 71**) | — | — | — |
| Socket timeout per day (ai-content, 09-09/09-10/09-11; total incl. untimestamped era) | 17 / 11 / 5 (total 73) | — | — | — |
| P1008 per day (all apps: ai-content / story-film / mcp-video-worker / render-worker-12 / render-worker-13; ai-content total incl. untimestamped era) | ai-content 7 / 3 / 3 (total 23) · story-film 25 / 24 / 25 (total 102) · mcp-video-worker 1 / 2 / 1 (total 5) · render-worker-12 total 1 · render-worker-13 total 2 | — | — | — |
| WAL high-water | 35,201,312 B (8.54×) | — | — | — |
| DB file size | 555,753,472 B (555.75 MB) | — | — | — |
| TelemetryEvent MB | 149.41 MB (28.3 % of DB) | — | — | — |

## 9. Commands run on production

#### A1

### Commands run on production

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

#### A1b

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

### A2 (browser — read-only GETs from the logged-in admin session)

(source: A2 process report — Method per number, Incident section; task-A2-report.md)

### Method per number

- **Nav timing** (TTFB/DCL/load): `performance.getEntriesByType('navigation')[0]`, read once per navigation.
- **Time-to-usable**: identified the one `fetch`/`xhr` resource-timing entry per page whose data drives the page's headline numbers/list (documented per page in the main report), used its `responseEnd` (cold: relative to navigation start; warm: relative to a `performance.now()` mark taken immediately before the link's `.click()`, since Next.js client transitions don't create a new Navigation Timing entry).
- **Per-endpoint timing (Step 2)**: `for` loop of `fetch(url, {credentials:'include', cache:'no-store'})` wrapped in `performance.now()`, executed from the browser console of an already-authenticated tab (not necessarily the page that normally calls that endpoint — cookies are shared across same-origin tabs, so this is equivalent). n=20 per the brief, run 1 reported separately as "cold", runs 2-20 sorted for p50/p95/max, for 12 of the 14 routes. See "What could not be measured" for the other two.
- **Response bodies for A4**: captured from the same fetch loop's first response, sanitized in-page (recursive strip of `email/name/script/prompt/url/title/message/subject/avatar/image/thumbnail/key/fingerprint` keys, any string matching an email or `http(s)://`/`data:` pattern, and any string matching an absolute filesystem path e.g. `/var/www/...` — the last one added ad hoc after `/api/admin/cleanup`'s response turned out to be an inventory of server file paths), arrays collapsed to `{_arrayTruncated, _originalLength}`, objects capped to depth 2 and 10 keys per level to keep the JS-tool-to-text round trip from truncating mid-JSON. Saved as 14 files under `docs/plans/reports/2026-09-12-A2-api-json/`.
- **Lighthouse**: not run — see below.
- **LCP/CLS/long tasks**: attempted via both direct `performance.getEntriesByType()` and a fresh `PerformanceObserver({buffered:true})` per type, immediately after each cold load. Both returned empty arrays consistently, including for `paint` (`first-paint`/`first-contentful-paint`), which is normally always populated. Diagnosis: Chrome's Paint Timing / LCP / CLS / long-task APIs are suppressed for background (non-visible) tabs, and the automation tabs opened via `claude-in-chrome` are not the foreground tab of the browser window. This is a tool/environment limitation, not a page issue — confirmed because Nav Timing and Resource Timing (which are not visibility-gated) worked normally throughout.

### Incident: concurrent load on `/api/admin/cleanup` and collateral slowdown

While measuring `/api/admin/cleanup` with the planned n=20 loop, a single `await fetch()` loop call exceeded the `javascript_tool`'s ~45s synchronous-return timeout (the CDP `Runtime.evaluate` call itself timed out, with a "renderer may be frozen" message — this was a tool-call-timeout artifact, not an actual frozen renderer, confirmed because immediately-following quick JS calls on the same tab returned instantly). The fix attempted was to fire the loop without awaiting it in the tool call (`promise.then(...)`) and poll a flag — this avoided the tool timeout but the loop itself did not finish within ~5.5 minutes of waiting (multiple `sleep` background timers totaling ~325s). A second, bounded version (`AbortController`, 20s per-request timeout, n=6) was started in the same tab without first confirming the original loop had actually stopped — so for a period, **two concurrent loops were both hitting `/api/admin/cleanup`**.

During this window, an isolated single fetch to `/api/admin/stats` (normally 100-400ms) measured 20,955ms and then 23,494ms. This is a real, reproducible finding, not a measurement artifact: `/api/admin/cleanup`'s own response body shows it walks 35,091 files (~159GB) on every call with no caching, and Node.js is single-threaded, so synchronous or long-running I/O in that route handler would block the event loop for every other concurrent request on the process. This should be flagged prominently for A3.

**Corrective action taken:** the tab was navigated away (a real top-level `navigate()`), which aborts client-side fetches and destroys the JS realm, killing both loops. A quick recovery check (`/api/admin/stats` in isolation) showed 1,062ms then 23,494ms again, then a clean 204ms after ~90 more seconds — consistent with residual server-side load draining rather than an instant fix. From that point on, `/api/admin/cleanup` and `/api/admin/insights?days=30` were each measured with a single request (not 20×) to avoid repeating the load; `/api/admin/insights?days=30` turned out to be fast and safe (see main report), so it was subsequently run for the full n=20 after all.

**Side effect / data loss:** navigating the tab away also destroyed the in-memory `window.__store` object that held the sanitized response bodies for the 10 endpoints measured just before the incident (their timing numbers were already printed to the conversation and are not lost, but their bodies had to be re-fetched once, single-shot, afterward — an acceptable low-cost redo since it's one extra GET per route, not 20).

**Endpoints measured (14, from audit §1.2, first column)**

- `/api/user/me`
- `/api/updates?summary=1`
- `/api/notifications`
- `/api/admin/stats`
- `/api/admin/settings`
- `/api/admin/storage`
- `/api/admin/cleanup?olderThanDays=3&includeStocks=false&includeTmp=false`
- `/api/admin/support?status=OPEN`
- `/api/admin/music`
- `/api/admin/insights?days=30`
- `/api/user/stats`
- `/api/videos`
- `/api/editor-projects`
- `/api/admin/revenue`

**Fetch-loop snippet:** Exact console snippet not preserved by A2; method described above.

#### A4

### 10. Commands run on production (A4)

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
SELECT "admin_id_prefix", substr(id,1,8), role, plan, usageCount, usageLimit, minutesUsed, minutesLimit, datetime(usagePeriodStartedAt/1000,"unixepoch","+7 hours") FROM User WHERE id="cmoycf2v…";
SELECT "admin_videoCount", COUNT(*) FROM Video WHERE userId="cmoycf2v…";
SELECT "admin_video_completed", COUNT(*) FROM Video WHERE userId="cmoycf2v…" AND status="COMPLETED";
SELECT "admin_styleCount", COUNT(*) FROM Style WHERE userId="cmoycf2v…";
SELECT "admin_contentCount", COUNT(*) FROM Content WHERE userId="cmoycf2v…";
SELECT "admin_videoJobs_all", COUNT(*) FROM VideoJob WHERE userId="cmoycf2v…";
SELECT "admin_videoJobs_done", COUNT(*) FROM VideoJob WHERE userId="cmoycf2v…" AND status="done";
SELECT "admin_renderJob_RENDER_DONE", COUNT(*) FROM RenderJob WHERE userId="cmoycf2v…" AND type="RENDER" AND status="DONE";
SELECT "admin_chargedClips_30d_minutes", IFNULL(SUM(chargedMinutes),0) FROM ChargedClip WHERE userId="cmoycf2v…" AND createdAt >= strftime("%s","now")*1000 - 30*86400000;
SELECT "admin_chargedClips_sinceUsagePeriod_minutes", IFNULL(SUM(chargedMinutes),0) FROM ChargedClip WHERE userId="cmoycf2v…" AND createdAt >= (SELECT usagePeriodStartedAt FROM User WHERE id="cmoycf2v…");
SELECT "admin_chargedClips_count_sinceUsagePeriod", COUNT(*) FROM ChargedClip WHERE userId="cmoycf2v…" AND createdAt >= (SELECT usagePeriodStartedAt FROM User WHERE id="cmoycf2v…");
SELECT "usagePeriod_age_days", ROUND((strftime("%s","now")*1000 - (SELECT usagePeriodStartedAt FROM User WHERE id="cmoycf2v…"))/86400000.0, 2);
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

#### A5

### Commands run on production (A5)

ทุกคำสั่งรันผ่าน `ssh -o ConnectTimeout=20 -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 'bash -s' <<'EOF' … EOF` — ด้านล่างคือ body ของ remote script ตามจริง

**A5-1 — schema ของ `SupportTicket` และ `TelemetryEvent`**
```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'; TZ=Asia/Bangkok date '+%Y-%m-%d %H:%M:%S %Z'
sqlite3 --version
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" ".schema SupportTicket"
echo '--- TelemetryEvent schema ---'
sqlite3 -readonly "file:/var/www/ai-content/prisma/dev.db?mode=ro" ".schema TelemetryEvent"
```

**A5-2 — ticket census + telemetry shape (คำสั่ง 1–7)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT substr(id,1,8) AS id8, COALESCE(category,'(null)') AS category, COALESCE(severity,'(null)') AS severity, status, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, CASE WHEN linearIssueIdentifier IS NULL THEN '-' ELSE linearIssueIdentifier END AS linear FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' ORDER BY createdAt;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(category,'(null)') AS category, COUNT(*) AS n, SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open_n FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(severity,'(null)') AS severity, status, COUNT(*) AS n FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n FROM SupportTicket WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='frontend_error' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COUNT(*) AS events, COUNT(DISTINCT userId) AS users, COUNT(DISTINCT sessionId) AS sessions, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';"
sqlite3 -readonly "$DB" -header -column "SELECT name, category, source, COUNT(*) AS n FROM TelemetryEvent WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (name LIKE '%error%' OR name LIKE '%fail%' OR category='error') GROUP BY 1,2,3 ORDER BY n DESC;"
```

**A5-3 — `frontend_error` grouping (คำสั่ง 8–11)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT json_extract(properties,'\$.errorName') AS errorName, json_extract(properties,'\$.signature') AS signature, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT userId) AS users, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC LIMIT 60;"
sqlite3 -readonly -noheader -separator $'\t' "$DB" "SELECT COALESCE(json_extract(properties,'\$.message'),'(no message)') FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';" \
 | sed -E 's#(https?://|blob:|data:|chrome-extension://|webkit-masked-url:|file://).*$# <URL>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<EMAIL>#g; s#\b[0-9a-f]{8,}\b#<ID>#g; s#\bsess_[A-Za-z0-9_-]+#sess_…#g; s#\b[A-Za-z0-9_-]{20,}\b#<ID>#g; s#[0-9]+#N#g' \
 | cut -c1-80 | sort | uniq -c | sort -rn | head -40
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(path,'(null)') AS path, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC LIMIT 25;"
```

**A5-4 — third-party marker counts (คำสั่ง 12–17)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT
 SUM(CASE WHEN properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%' THEN 1 ELSE 0 END) AS webview_java_bridge,
 SUM(CASE WHEN properties LIKE '%MetaMask%' THEN 1 ELSE 0 END) AS metamask,
 SUM(CASE WHEN properties LIKE '%chrome-extension://%' THEN 1 ELSE 0 END) AS chrome_ext_frame,
 SUM(CASE WHEN properties LIKE '%webkit-masked-url%' THEN 1 ELSE 0 END) AS webkit_masked,
 SUM(CASE WHEN properties LIKE '%window.webkit.messageHandlers%' THEN 1 ELSE 0 END) AS webkit_handlers,
 SUM(CASE WHEN properties LIKE '%Script error.%' THEN 1 ELSE 0 END) AS script_error_opaque,
 SUM(CASE WHEN properties LIKE '%Clerk%' THEN 1 ELSE 0 END) AS clerk_any,
 SUM(CASE WHEN properties LIKE '%Loading chunk%' OR properties LIKE '%ChunkLoadError%' THEN 1 ELSE 0 END) AS chunk_load,
 SUM(CASE WHEN properties LIKE '%play() request was interrupted%' THEN 1 ELSE 0 END) AS play_abort,
 SUM(CASE WHEN properties LIKE '%Server Action%' THEN 1 ELSE 0 END) AS server_action_missing,
 COUNT(*) AS total
 FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';"
sqlite3 -readonly "$DB" -header -column "SELECT COUNT(*) AS no_own_frame FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND properties NOT LIKE '%/_next/%' AND properties NOT LIKE '%studio.heroaiengine.com%';"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'(null)') AS errorName, COUNT(*) AS n FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.message'),'')='' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(path,'(null)') AS path, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%') GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT name, COUNT(*) AS n, COUNT(DISTINCT userId) AS users, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day FROM TelemetryEvent WHERE category='error' AND source='server' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
```

**A5-5 — property keys ของ event ฝั่ง server (คำสั่ง 18–20)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='auth_request_recovery' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(status,'(null)') AS status, COALESCE(step,'(null)') AS step, COALESCE(path,'(null)') AS path, COUNT(*) AS n FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC LIMIT 20;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(step,'(null)') AS step, COALESCE(status,'(null)') AS status, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='pipeline_step_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='pipeline_step_error' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
for N in hero_ai_image_video_scene_error fetch_stock_server_error brand_visual_preflight_invalid ai_image_credit_reservation_rejected; do
  echo "--- $N ---"
  sqlite3 -readonly "$DB" -header -column "SELECT je.key AS prop_key, COUNT(*) AS n FROM TelemetryEvent te, json_each(te.properties) je WHERE te.name='$N' AND date(te.createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
done
```

**A5-6 — error code breakdown (คำสั่ง 21–27)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.initialStatus'),'-') AS initialStatus, COALESCE(json_extract(properties,'\$.retryStatus'),'-') AS retryStatus, COALESCE(status,'-') AS status, COUNT(*) AS n FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC LIMIT 25;"
sqlite3 -readonly "$DB" -noheader "SELECT COALESCE(path,'(null)') FROM TelemetryEvent WHERE name='auth_request_recovery' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';" | sed -E 's#/(c[a-z0-9]{20,}|[0-9a-f-]{16,})#/<id>#g' | sort | uniq -c | sort -rn | head -20
sqlite3 -readonly "$DB" -noheader -separator '|' "SELECT COALESCE(step,'-'), COALESCE(json_extract(properties,'\$.message'),'(none)') FROM TelemetryEvent WHERE name='pipeline_step_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30';" | sed -E 's#(https?://)[^ ]*#<URL>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+#<EMAIL>#g; s#\b(c[a-z0-9]{20,}|[0-9a-f]{16,})\b#<ID>#g' | cut -c1-100 | sort | uniq -c | sort -rn | head -30
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorCode'),'-') AS errorCode, COALESCE(json_extract(properties,'\$.aiProvider'),'-') AS provider, COALESCE(json_extract(properties,'\$.systemicProviderFailure'),'-') AS systemic, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='hero_ai_image_video_scene_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.providerErrorCode'),'-') AS providerErrorCode, COALESCE(json_extract(properties,'\$.errorProvider'),'-') AS errorProvider, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='fetch_stock_server_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.reason'),'-') AS reason, COALESCE(json_extract(properties,'\$.sourceKind'),'-') AS sourceKind, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='brand_visual_preflight_invalid' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.fundingPolicy'),'-') AS fundingPolicy, COALESCE(json_extract(properties,'\$.provider'),'-') AS provider, COALESCE(json_extract(properties,'\$.surface'),'-') AS surface, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='ai_image_credit_reservation_rejected' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2,3 ORDER BY n DESC;"
```

**A5-7 — PM2 crash-class cross-check (คำสั่ง 28–31)**
```bash
cd /root/.pm2/logs
for m in 'uncaughtException' 'unhandledRejection' 'UnhandledPromiseRejection' 'FATAL' 'ECONNREFUSED' 'ETIMEDOUT' 'out of memory' 'JavaScript heap'; do
  n=$(grep -c "$m" ai-content-error*.log ai-content-out*.log 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
  echo "$m = $n"
done
wc -l ai-content-error*.log | tail -20
cat ai-content-error*.log 2>/dev/null | sed -E 's#^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?:? ##' | sed -E 's#(https?://)[^ ]*#<URL>#g; s#\b(c[a-z0-9]{20,}|[0-9a-f]{16,})\b#<ID>#g; s#[0-9]+#N#g' | cut -c1-90 | sort | uniq -c | sort -rn | head -30
pm2 status
```

**A5-8 — `[API Error]` census + log coverage (คำสั่ง 32–35)**
```bash
cd /root/.pm2/logs
grep -h '\[API Error\]' ai-content-error*.log ai-content-out*.log 2>/dev/null | sed -E 's#^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+0-9:]*: ##' | sed -E 's#/(c[a-z0-9]{20,}|[0-9a-f-]{16,})#/<id>#g' | cut -c1-80 | sort | uniq -c | sort -rn | head -30
grep -hE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*\[API Error\]' ai-content-error*.log ai-content-out*.log 2>/dev/null | cut -c1-13 | sort | uniq -c | awk '{print $2, $1}' | head -60
ls -la ai-content-out*.log ai-content-error*.log
grep -hc 'ECONNRESET' ai-content-error*.log 2>/dev/null | awk '{s+=$1} END{print "ECONNRESET lines:", s+0}'
grep -h 'unhandledRejection' ai-content-error*.log ai-content-out*.log 2>/dev/null | cut -c1-100 | sort | uniq -c | sort -rn | head -10
```

**A5-9 — insights benign-filter replay + daily series (คำสั่ง 36–39)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "WITH fe AS (SELECT properties AS p FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30'),
 c AS (SELECT p,
  CASE WHEN p LIKE '%play() request was interrupted by a call to pause%' THEN 'benign: play/pause'
       WHEN p LIKE '%__SUPERSEDED__%' OR p LIKE '%superseded%' THEN 'benign: superseded'
       WHEN p LIKE '%AbortError%' OR p LIKE '%aborted%' OR p LIKE '%cancelled%' OR p LIKE '%canceled%' OR p LIKE '%Request closed%' OR p LIKE '%cancelSignal%' THEN 'benign: cancel'
       WHEN trim(COALESCE(json_extract(p,'\$.message'),'')) IN ('Script error.','Script error') THEN 'benign: opaque script error'
       ELSE 'counted as an error by insights' END AS verdict,
  CASE WHEN p LIKE '%Java object is gone%' OR p LIKE '%Java exception was raised%' THEN 'webview-bridge'
       WHEN p LIKE '%MetaMask%' THEN 'metamask-extension'
       WHEN p LIKE '%chrome-extension://%' THEN 'chrome-extension-frame'
       WHEN p LIKE '%window.webkit.messageHandlers%' THEN 'ios-webview-bridge'
       ELSE 'not-obviously-third-party' END AS third_party
  FROM fe)
 SELECT verdict, third_party, COUNT(*) AS n FROM c GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%') GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -noheader "SELECT COALESCE(json_extract(properties,'\$.errorName'),'?')||' :: '||COALESCE(json_extract(properties,'\$.message'),'(empty)')||' :: '||COALESCE(path,'-') FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND properties NOT LIKE '%Java object is gone%' AND properties NOT LIKE '%Java exception was raised%' AND properties NOT LIKE '%MetaMask%' AND properties NOT LIKE '%chrome-extension://%' AND properties NOT LIKE '%window.webkit.messageHandlers%';" | sed -E 's#(https?://|blob:|data:|file://)[^ "]*#<URL>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<EMAIL>#g; s#\b(c[a-z0-9]{20,}|[0-9a-f]{12,})\b#<ID>#g' | cut -c1-110 | sort | uniq -c | sort -rn | head -40
sqlite3 -readonly "$DB" -header -column "SELECT category, COUNT(*) AS n FROM TelemetryEvent WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
```

**A5-10 — Clerk / play-abort / our-code detail (คำสั่ง 40–44)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'-') AS errorName, CASE WHEN properties LIKE '%failed_to_load_clerk_ui%' THEN 'failed_to_load_clerk_ui' WHEN properties LIKE '%failed_to_load_clerk_js%' THEN 'failed_to_load_clerk_js' WHEN properties LIKE '%Clerk%' THEN 'other-clerk' ELSE '-' END AS clerk_code, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND (properties LIKE '%Clerk%' OR properties LIKE '%clerk%') GROUP BY 1,2,3 ORDER BY bkk_day;"
sqlite3 -readonly "$DB" -header -column "SELECT strftime('%Y-%m-%dT%H',createdAt/1000,'unixepoch') AS utc_hour, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND properties LIKE '%play() request was interrupted%' GROUP BY 1,2 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'-') AS errorName, date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COALESCE(path,'-') AS path, COUNT(*) AS n, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.errorName'),'') IN ('ChunkLoadError','NotFoundError','ReferenceError','SyntaxError','TypeError','UnrecognizedActionError') GROUP BY 1,2,3 ORDER BY errorName, bkk_day;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COALESCE(path,'-') AS path, COALESCE(json_extract(properties,'\$.source'),'-') AS src_basename, COUNT(*) AS n FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.message'),'')='' GROUP BY 1,2,3 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT COALESCE(json_extract(properties,'\$.errorName'),'-') AS errorName, CASE WHEN properties LIKE '%/_next/%' THEN 'own-origin-frame' WHEN properties LIKE '%webkit-masked-url%' OR properties LIKE '%chrome-extension%' THEN 'injected-frame' ELSE 'no-frame-info' END AS origin, COUNT(*) AS n FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' AND COALESCE(json_extract(properties,'\$.errorName'),'') IN ('ChunkLoadError','NotFoundError','ReferenceError','SyntaxError','TypeError','UnrecognizedActionError','AbortError') GROUP BY 1,2 ORDER BY 1;"
```

**A5-11 — pipeline error buckets + daily series + job census (คำสั่ง 45–48)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "SELECT step, CASE
  WHEN properties LIKE '%fetch-stock%503%' THEN 'fetchStock 503 (provider/system)'
  WHEN properties LIKE '%fetch-stock%402%' THEN 'fetchStock 402 (credits)'
  WHEN properties LIKE '%/api/videos%500%' THEN 'render POST /api/videos 500 (opaque)'
  WHEN properties LIKE '%broll_coverage_incomplete%' THEN 'render 422 broll_coverage_incomplete'
  WHEN properties LIKE '%Cannot find module%' THEN 'render Cannot find module'
  WHEN properties LIKE '%renderMedia() got cancelled%' THEN 'burnSubtitles renderMedia cancelled'
  WHEN properties LIKE '%เกินเพดานแผน%' THEN 'plan cap: clip length'
  WHEN properties LIKE '%ครบ%' OR properties LIKE '%QUOTA_AI_AUDIO%' THEN 'plan cap: AI-audio minutes'
  WHEN properties LIKE '%แนวภาพ%' THEN 'brand visual analysis incomplete'
  WHEN properties LIKE '%unknown provider outcome%' THEN 'avatar unknown provider outcome'
  WHEN properties LIKE '%ElevenLabs failed%' THEN 'customer key: ElevenLabs quota'
  ELSE 'other' END AS klass, COUNT(*) AS n, COUNT(DISTINCT userId) AS users, MIN(date(createdAt/1000,'unixepoch','+7 hours')) AS first_day, MAX(date(createdAt/1000,'unixepoch','+7 hours')) AS last_day
 FROM TelemetryEvent WHERE name='pipeline_step_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1,2 ORDER BY n DESC;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='hero_ai_image_video_scene_error' AND json_extract(properties,'\$.errorCode')='OUTPUT_INVALID' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, COUNT(*) AS n, COUNT(DISTINCT userId) AS users FROM TelemetryEvent WHERE name='brand_visual_preflight_invalid' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
sqlite3 -readonly "$DB" -header -column "SELECT status, COUNT(*) AS n FROM VideoJob WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY n DESC;"
```

**A5-12 — before/after ตัวกรอง Sentry (คำสั่ง 49–50, รันซ้ำเป็น 49b เพราะรอบแรกคำนวณ epoch ผิด)**
```bash
DB="file:/var/www/ai-content/prisma/dev.db?mode=ro"
sqlite3 -readonly "$DB" -header -column "WITH k(cut) AS (SELECT strftime('%s','2026-09-09T07:45:00')*1000)
SELECT CASE WHEN createdAt >= (SELECT cut FROM k) THEN 'after 2026-09-09T07:45Z' ELSE 'before' END AS era,
 SUM(CASE WHEN properties LIKE '%Java object is gone%' OR properties LIKE '%Java exception was raised%' THEN 1 ELSE 0 END) AS webview,
 SUM(CASE WHEN properties LIKE '%MetaMask%' THEN 1 ELSE 0 END) AS metamask,
 SUM(CASE WHEN properties LIKE '%window.webkit.messageHandlers%' THEN 1 ELSE 0 END) AS ios_bridge,
 COUNT(*) AS all_frontend_error
 FROM TelemetryEvent WHERE name='frontend_error' AND date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1;"
sqlite3 -readonly "$DB" "SELECT 'cutoff = '||datetime(strftime('%s','2026-09-09T07:45:00'),'unixepoch')||' UTC';"
sqlite3 -readonly "$DB" -header -column "SELECT date(createdAt/1000,'unixepoch','+7 hours') AS bkk_day, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, COUNT(*) AS total FROM VideoJob WHERE date(createdAt/1000,'unixepoch','+7 hours') >= '2026-08-30' GROUP BY 1 ORDER BY 1;"
```

#### คำสั่ง read-only นอกเครื่อง production (เพื่อความครบถ้วนของ trail)

```bash
# Linear — อ่านอย่างเดียว ไม่มี create/comment/transition และไม่มี --apply
cd /Users/mewsocialmacmini/projects/AI_content_Mew_social-perf-audit-reports
cp ../AI_content_Mew_social/.env .env          # .env* อยู่ใน .gitignore อยู่แล้ว ไม่เคย print ค่า
node .agents/skills/hero-studio-ops/scripts/linear.mjs --help
node .agents/skills/hero-studio-ops/scripts/linear.mjs list --limit 100
node .agents/skills/hero-studio-ops/scripts/linear.mjs issue HERO-10

# git — อ่านอย่างเดียว ในโฟลเดอร์ baseline
git log --oneline --date=short --pretty='%h %ad %s' -20 -- src/lib/sentry-config.ts
git log --format='%h | %cI | %s' --since=2026-09-09T00:00:00Z --until=2026-09-09T23:59:59Z main

# Sentry — GET เท่านั้น ผ่าน Chrome ที่ล็อกอินอยู่ (แท็บที่สร้างเองและปิดแล้ว)
GET /api/0/organizations/mew-social-k0/issues/?query=is:unresolved environment:production&statsPeriod=14d&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/?query=is:resolved environment:production&statsPeriod=14d&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/?query=is:ignored environment:production&statsPeriod=14d&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/?query=environment:production&statsPeriod=14d|3d|24h&project=4512028555804672&limit=100&sort=freq
GET /api/0/organizations/mew-social-k0/issues/<issueId>/     # 10 กลุ่ม เพื่อดู firstRelease/lastRelease
```

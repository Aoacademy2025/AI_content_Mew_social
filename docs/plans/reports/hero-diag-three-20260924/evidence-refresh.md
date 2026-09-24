# HERO-10 → HERO-41 → HERO-51: production evidence refresh

Observed 2026-09-24, approximately 12:04–12:11 Asia/Bangkok (05:04–05:11 UTC).

## Scope and method

Mew explicitly approved SSH reads of production logs, natural cleanup results and aggregate long-clip evidence. All production actions were read-only. No cleanup was triggered; no generation, replay, media download, provider request, deploy, restart, database/configuration mutation, Linear update or customer communication occurred.

Production HEAD was `3d2c27a65a96f88435bc4e9df45c26b493df0b35`; tracked-file status was clean. Source history confirms the deployed eviction implementation commit `ab227993` and Prisma diagnostic commit `e408ee5f`. SQLite used `mode=ro`, `PRAGMA query_only=ON`, a 2-second connection timeout and a 6–8-second query deadline. Queries were limited to 501 rows; only 36 eligible rows were returned. Customer content and record identifiers stayed on the host.

Log inspection used current and September 24 rotated web/MCP/Story Film logs, plus current/recent render-worker error logs. Each file was bounded to 8 MiB; none reached that bound. Observed timestamp offsets were UTC. Counts are signature-line counts, not unique incidents, and do not establish Sentry clearance or a seven-day acceptance window.

## 1. HERO-10: corrected caller observed; holder remains unknown

Issue: https://linear.app/mew-social/issue/HERO-10
Delivered diagnostic: https://github.com/Aoacademy2025/AI_content_Mew_social/pull/541
Historical Sentry references: HERO-STUDIO-WEB-11 / HERO-STUDIO-WEB-W; not queried in this refresh.

For 2026-09-23 18:04:36 UTC through 2026-09-24 05:08:50 UTC, the inspected files contained one slow-transaction event:

- 2026-09-23 19:49:44.337 UTC / September 24 02:49:44 Bangkok.
- Elapsed 20,065 ms; invoking source `app/api/videos/render/route.js:1`.
- Zero matches for `Socket timeout`, `Transaction already closed`, `P1008`, `SQLITE_BUSY`, `database is locked`, and `OUTPUT_INVALID` in this bounded window.

This confirms that the corrected diagnostic can identify a natural render invocation. It does not distinguish time before callback entry from time inside the transaction, identify the lock holder, or show that this slow call failed. No production failure was newly reproduced. The observation is roughly eleven hours, not seven days.

Database files at the sample were 670,617,600 bytes (DB) and 35,205,432 bytes (WAL). These sizes alone do not establish checkpoint lag or contention cause.

Disposition: retain **In Progress**. Next discriminating scope: a synthetic, isolated contention regression followed by minimal sanitized instrumentation separating transaction queue time and callback duration. Do not change transaction budgets, retry policy or database platform from this evidence.

## 2. HERO-41: two post-release rounds still exhaust 90-minute budget

Issue: https://linear.app/mew-social/issue/HERO-41
Delivered batching change: https://github.com/Aoacademy2025/AI_content_Mew_social/pull/540
No correlated support ticket or Sentry group established.

The two natural cleanup rounds that started after the batching release reported:

| Start–finish UTC | Wall time | CPU time | Scanned | Catalog unverified | Evicted / eligible | Evicted bytes | Result |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Sep 23 21:39:05–23:09:18 | 90m13s | 93m02s | 19,450 | 18,186 | 341 / 500 | 3,650,606,891 | runtime_budget, errors 0 |
| Sep 24 01:38:42–03:10:13 | 91m30s | 89m27s | 19,287 | 18,232 | 307 / 500 | 3,185,207,347 | runtime_budget, errors 0 |

Both exited successfully. Reported `restore_failed`, `operation_failed`, `catalog_changed` and `changed` counts were zero. These are reported outcomes, not a separate file-integrity audit. The earlier round finishing September 23 19:03:49 began before the release and is excluded from this post-release comparison.

The shared-lock reconcile service failed at September 23 22:49:12 and September 24 02:55:16 UTC, each approximately 3,600 seconds after starting. The installed command uses the same storage `flock --wait 3600`. The timing, exit status 1, and concurrent cleanup interval strongly support lock-wait expiry; no direct lock-owner trace was collected. Later natural reconcile rounds succeeded; its sampled current state was success/inactive. Remote GC also completed successfully, with wall times including waiting; those wall times must not be called active GC processing time.

One Gemini create interval (02:17:16–02:41:39 UTC) overlaps the latter cleanup round. This is a reason to examine busy-yield coverage, not proof that the relevant activity count stayed positive throughout: historical status transitions and gate polling are not recorded here. The existing activity query counts processing VideoJobs and queued/running RenderJobs.

Conclusion: local catalog-read reduction has not established production wall-time acceptance. Both measured rounds still stop at the runtime ceiling, and sibling scheduling remains affected. No phase timings exist in these cleanup summaries to attribute the remaining cost to planning, per-object safety work, remote verification, or catalog writes.

Disposition: retain current **Ready to Deploy** as deployed-but-unverified; do not mark Done. Next scope: an offline production-shaped fixture with phase/operation counters and work arriving during the apply loop, followed by a bounded profiling proposal. Preserve checksums, remote verification, CAS, quarantine and restore behavior. Production cleanup execution or changing its runtime budget is outside this read-only authorization.

## 3. HERO-51: two natural long Gemini outputs still use estimated timing

Issue: https://linear.app/mew-social/issue/HERO-51
Delivered cancellation/partial-result change: https://github.com/Aoacademy2025/AI_content_Mew_social/pull/536
No correlated support ticket or Sentry group established.

Read window: completed `type=create` jobs from September 23 03:36:30 UTC through September 24 05:06:26 UTC. All 36 returned jobs also have startedAt after that cutoff. This is a time-window cohort spanning subsequent releases, not exact per-job release attribution.

- 36 completed jobs: 9 below 60 seconds, 22 at 60–119 seconds, 5 at or above 120 seconds.
- All 36 have usable duration; none lacked output or usable duration.
- Of the five long jobs, three use upload transcription (147.930, 147.930 and 123.900 seconds) and are excluded from long generated-narration acceptance. These are job counts, not necessarily distinct audio assets.
- The remaining two identify Gemini as voice provider and use `tts_segment_timing`, with `warning/unverified_alignment`.

| Audio length | Verification | Acoustic result | Content-free phase log |
| --- | --- | --- | --- |
| 197.208 s | failed / incomplete_alignment after 152,263 ms | timeout after 60,030 ms; applied=false | Sep 24 00:55:43 UTC, bucket 120_239s, timeoutPhase=emissions |
| 266.510 s | failed / text_mismatch after 178,156 ms | timeout after 60,013 ms; applied=false | Sep 24 02:23:21 UTC, bucket 240_360s, timeoutPhase=emissions |

The second verification also records `transcribe_incomplete` from 132,476 to 266,510 ms. Do not treat this as permission to accept an independently disqualifying text mismatch.

These are not two verification-budget timeouts: verification returned failed quality results; the acoustic fallback then timed out. The acoustic diagnostic says each worker had reached emissions when killed. It rules out being stuck in startup/lock/model-load at the instant of timeout, but does not quantify earlier phase time or prove that emissions alone used the whole 60 seconds. Correlation is by content-free timestamp, bucket and job interval, without persistent identity in phase logs.

A shorter natural partial-alignment event at 03:43:29 UTC recorded lockWait=0, modelLoad=4,067 ms, audioDecode=532 ms, emissions=23,398 ms and alignment=137 ms. That one short sample does not predict the long-job latency or isolate the effect of concurrent cleanup.

No media was downloaded or assessed. No new measured subtitle drift, independent ASR result, or human perceptual acceptance is claimed. The historical seven-second drift observation belongs to the old 171-second sample and must not be transferred to these outputs.

Disposition: retain **In Progress**. Next scope: a bounded offline long-audio experiment isolating emissions runtime, with explicit quality/latency acceptance and independent timing assessment of separately authorized existing media. Keep current 180s/60s budgets, ADR 0056 fail-open behavior, no paid replay/TTS regeneration and no export realignment. A larger budget or warmed worker is not justified by these reads alone.

## Delivery state

This local report is the only new artifact. Code and external records are unchanged. The three Linear states remain HERO-10 In Progress, HERO-41 Ready to Deploy, HERO-51 In Progress. Existing releases were not repeated. The next implementation should use isolated Orca worktrees, observed failing regressions and the applicable planning/review workflow; no production change is authorized by the read-only approval.

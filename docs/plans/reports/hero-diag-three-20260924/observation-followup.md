# Approved production evidence follow-up — 2026-09-24

Observed 12:32–12:39 UTC / 19:32–19:39 Bangkok. This continues Mew's approved SQLite → cleanup → long-caption investigation and build-memory advisory. Production remains `fdc4b984a64592a15f35821023d7dbdb8655f2f9`, build `cTfjlkCjs4AUifjFCUJRI`; no source/config/deployment change was made in this pass.

## Outcomes

| Track | New evidence | Remaining gate |
| --- | --- | --- |
| HERO-10 | Four natural slow transactions: two without callback entry, one with both pre-entry and callback delays, one dominated by callback time. Expanded error markers remain zero. | Actual writer/operation attribution; seven-day acceptance. |
| HERO-41 | Natural busy-yield succeeded after 130 objects, 2.751 GB, zero reported integrity/operation errors. Run took 40m17s, 97.9% of one CPU. | Measure repeated full reference-graph work directly before optimizing the integrity path. |
| HERO-51 | Completed the five-case offline matrix on the VPS. Short/121s aligned; 200/272/302s timed out during emissions. | Controlled computation experiment preserving timing quality and the 60s budget; natural long-output and human timing acceptance. |
| Build | Installed Next does not consume `NEXT_PRIVATE_WORKER_OPTIONS`; compiler workers inherit parent 4096MB old-space instead of the advertised 512MB. | Persist PSS/private/host-memory measurements with stage attribution on the next necessary build. |

## SQLite

The private baseline spans 07:41:40Z–12:35:31Z without rotation/truncation. Four slow transaction events were observed; P2028, SQLite busy/locked, transaction-closed, Socket timeout, P1008, application heap OOM and OUTPUT_INVALID counters were zero. These are separate metrics: zero error markers is not zero contention or proof of recovery.

At 10:17:05Z, fetch-stock bundle events reported 29.8s before callback entry (twice, callback never entered) and 20.1s before entry plus 10.1s in callback. At 10:59:46Z, the jobs bundle entered in 2ms and spent 20.0s in callback. A callback may be waiting on a database operation; it is not a measured lock-holding interval. The generated column is absent, so source maps cannot recover the specific original operation from the enormous bundled line.

No actual lock holder has been established. A future live-lock probe must first prove its interpretation of WAL/shared-memory lock ranges against a disposable known holder; PID attribution alone will not identify an operation within a shared process. See [SQLite report](sqlite-natural-followup.md).

The earliest seven-day boundary remains approximately October 1 at 14:38 Bangkok. No continuous monitor or scheduled daily job was installed, and this pass does not promise autonomous observation after the session ends.

## Cleanup

The natural 09:35:06–10:15:23Z run selected 500 objects and yielded with `customer_media_active` after 130 complete objects. Missing-local reconciliation plus planning took about 32.5s; eviction selection/apply took about 39m42s. All reported errors, restore failures and catalog/remote-integrity failure counters were zero.

Source tracing shows that each eviction rebuilds the entire media-reference graph. This explains a concrete repeated-work mechanism and is the leading CPU-cost candidate, but no timer separates graph construction from hashing and other apply work yet. Reusing a stale graph would weaken safety and is not justified. The earliest inferred slow-transaction invocation above began roughly 72s after cleanup exited, so those measured intervals do not overlap. See [cleanup report](cleanup-natural-followup.md).

## Acoustic matrix

The approved package passed checksums and the delayed-process-group cancellation canary before one fresh attempt. The same pinned model, engine, synthetic fixtures and isolated cache were used, with two threads, CPU quota 200%, RAM maximum 6G, offline network isolation and 60s per-case deadlines. The customer/cleanup guard remained enabled; no retry was made.

| Synthetic duration | Result | Harness wall time | Sampled peak process RSS |
| --- | --- | ---: | ---: |
| 6.050s | aligned | 8.847s | 2,639,327,232 bytes |
| 120.996s | aligned | 53.453s | 2,896,601,088 bytes |
| 199.644s | timeout: emissions | 60.264s | 2,573,991,936 bytes |
| 272.242s | timeout: emissions | 60.301s | 3,292,520,448 bytes |
| 302.491s | timeout: emissions | 60.295s | 3,293,278,208 bytes |

The 121s case spent 0ms waiting for the private lock, 5,282ms loading the model, 601ms decoding, 45,670ms computing emissions, and 576ms aligning. It covered all 1,440 eligible character spans with no missing/duplicate/unexpected spans, all 20 known boundaries, monotonic timings, maximum boundary error 57ms and drift 14ms. These synthetic boundaries are not human Thai speech acceptance.

At 12:37:16Z, the unit had 387.17 CPU seconds and 56.26 seconds in the cgroup throttling counter, with 1,724 throttled periods out of 2,062; memory high/max/OOM event counters were zero. Thus this is a two-core-capped operational benchmark, not unrestricted production latency. All three inspected production worker classes configure two acoustic threads, but that alone does not equate their scheduling to this benchmark's hard quota.

The unit finished exit0 in 4m7.277s, CPU 7m44.148s. Exit0 means the bounded matrix completed and recorded its timeout outcomes; it does not mean all alignments passed. The benchmark cgroup was absent afterward. Numeric results are retained privately at `/Users/mewsocialmacmini/.codex/artifacts/hero-diag-three-release-20260924/acoustic-host-results.json`. See the [independent acoustic analysis](acoustic-host-followup.md) for validation and the next controlled experiment.

A read-only completion cohort since 07:38:38Z through 12:36:34Z contained 14 completed create jobs, all under 120s, no missing/invalid output or duration, and no long cases. Nine report partial forced alignment, one forced alignment, four an unknown/missing top-level timing source. This does not establish improved long-clip quality or exact release attribution for jobs begun earlier. No customer media was fetched or processed.

## Build and operational closure

Worker lifecycle isolation is verified, but the 512MB worker flag is ineffective in installed Next. The saved 26.65GiB figure is summed RSS without peak timestamp, process identities or PSS; physical pressure and peak stage remain unknown. No diagnostic build or heap change was performed. See [build-memory report](build-memory-followup.md).

At 12:38:50Z, tracked production files were clean, video/render queues were 0/0, cleanup services inactive, maintenance off, drain0, and all critical workers online with unchanged restart counts and zero unstable restarts. Available memory was 30,199,492KiB. Public and internal health returned HTTP200.

Linear was read, not changed: [HERO-10](https://linear.app/mew-social/issue/HERO-10) In Progress; [HERO-41](https://linear.app/mew-social/issue/HERO-41) Ready to Deploy; [HERO-51](https://linear.app/mew-social/issue/HERO-51) In Progress. HERO-41's recorded state has not been synchronized with the deployed safe-yield evidence; the parent runtime outcome remains open. Related deployed PRs are [543](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/543), [544](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/544), [545](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/545) and [546](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/546). No new support-ticket correlation, Sentry-clearance claim, customer reply/closure, financial mutation, provider replay or parent Done transition occurred.

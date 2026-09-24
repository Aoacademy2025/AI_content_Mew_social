# Approved discriminating probes — 2026-09-24

Production remains `fdc4b984a64592a15f35821023d7dbdb8655f2f9` with build ID `cTfjlkCjs4AUifjFCUJRI`. The three new diagnostic PRs have not been merged or deployed. No cleanup was manually triggered, customer media processed, provider called, or production tuning changed.

## SQLite

PR [547](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/547), head `2bc836c5`, adds generated caller columns and an opt-in bounded WAL observer. Independent reviews exposed and fixed raw argparse error echo, a final-snapshot inode replacement race, and an event cap enforced too late. RED regressions now cover each; actual Linux disposable writer/read-only reader/checkpointer verification passes. The observer identifies OS holders, not business operations.

Two natural observations used the then-reviewed `8dfe4347` standalone observer outside the application:

| UTC window | Samples | Intervals | Result |
| --- | ---: | ---: | --- |
| 13:09:12–13:11:12 | 1,028 | 14 | main/read/deadman only |
| 13:19:41–13:24:41 | 2,545 | 163 | 68 write and 2 checkpoint intervals |

Both exited zero with no unsupported lock range. The second writer was PID1560025, start ticks715040575. Its journal metadata matches `heroai-r2-reconcile.service`; that natural unit ran13:20:06–13:20:51 and exited success. Writer observations span13:20:08–13:20:51; the longest continuously observed interval was244ms. This is sampled duration, not a proven maximum lock duration. The process had exited before ancestry inspection; the process-class field remains `unknown` in the original evidence. Journal timing/unit metadata supports the reconcile association, not attribution of an earlier slow transaction.

The postrelease baseline now contains **8 slow transactions**, plus **1 Socket timeout and1 P1008**; P2028 and OUTPUT_INVALID counts were zero at13:20:57. Four new slow events logged13:11:55 and13:12:15 concern credits/balance and voices, with20–30s elapsed and mixed pre-callback/callback delays. The first inferred invocation began about13:11:25, before the quota benchmark began about13:11:34. No lock sample covers that slow incident. Temporal overlap does not establish causation. The observed short reconcile writes do not explain these delays.

Eight events already exceed the fewer-than-five/day target for Sep24; a fixed Oct1 closure date is unsupported. The seven consecutive passing days must be demonstrated after remediation, with actual slow-holder correlation still outstanding.

## Cleanup

PR [548](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/548), head `caea7b2d`, adds aggregate counts/timings for graph rebuild, hash bytes/time, catalog, remote verification, and remaining apply work. Recovery catalog writes are included after a reviewer-found omission was fixed with a deterministic unlink-failure regression. Integrity, freshness, CAS, quarantine/restore, and customer busy-yield semantics remain unchanged.

Three synthetic326-object runs each recorded326 graph rebuilds,326 hashes,652 catalog calls,326 remote checks and zero errors. This proves attribution and repetition, not production cost share. Eviction/reference-graph/purge-disabled/cleanup-mode checks pass. The separate media-quarantine verifier still fails its pre-existing admin-page static assertion; neither implicated file changed from baseline. A future natural pass after delivery must identify the dominant cost before optimizing.

## Long subtitle controls

The private quota400%/two-thread control completed with no memory-event counter increments and unchanged exact synthetic quality:

| Synthetic duration | Total runtime | Emissions | Outcome |
| --- | ---: | ---: | --- |
| short | 8.721s | 1.976s | aligned |
| 120.996s | 46.059s | 38.894s | aligned,1,440/1,440 spans |
| 199.644s | 60.253s | timed out | stopped in emissions |

The120s boundary maximum remained57ms and drift14ms. Raising quota improved that single control by about13.8%, but did not make200s fit the deadline. The target kernel lacks `memory.peak`; evidence explicitly uses bounded100ms `memory.current` sampling, not a true peak.

The private40s geometry candidate was stopped before any VPS run: paired local120s emissions increased38.9% and RSS increased about515MB, with identical quality. Production20s geometry remains unchanged.

The remaining four-thread/original20s package passed local quality, independent review, target Linux9 fixtures, checksum/shell checks, and delayed process-group cancellation. Local120s emissions improved8.5% in one sample. Package SHA256: `b7b1f79b1db28c6ea7ed946aeba75cdaa53497011b8ada97dfdeb1a41cfa1ba1`. Fresh admission at13:35:24 showed one in-flight customer VideoJob, with natural cleanup due13:35:56. **Host inference was deferred, never launched, and not automatically retried**, in accordance with the package's changed-admission rule. Production remains two threads. Synthetic results do not satisfy natural long-clip Thai timing acceptance.

## Build memory and final verification

PR [549](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/549), head `5e335d53`, adds the opt-in sampler. Review fixes cover Node CLI precedence/aliases and a late root-PID reuse race. All14 blank-environment tests pass locally and on Linux. A disposable live Linux process yielded six samples with positive PSS and a bounded5,011-byte0600 output plus final summary; no build was launched on production.

Combined integration `720106d0` built successfully with an empty application environment: compile14.8s, TypeScript passed,193 pages, exit0. Previous26.65GiB summedRSS is still not unique physical memory. The existing512MB worker option still has no effective installed Next consumer; no heap/policy change is claimed.

Independent final correctness review cleared both lifecycle fixes. Nonblocking advisories: the existing interruption test can race slow observer startup when tests run concurrently; one synthetic heap fixture accepts a separate CLI form that Node26 rejects before a worker can start.

At13:36:09 the bounded log baseline still counted8slowTX,1Socket timeout,1P1008,0P2028,0OUTPUT_INVALID,0SQLitebusy and0OOM, with no file rotation/truncation. These counters are observed markers, not a blanket production health claim.

Fresh final security review cleared exact integration `720106d068f8183a00c4da50dd8e805bd4fe8830`, with no blocking privacy/security/integrity findings. Two hardening advisories remain: bind initial WAL header validation to the pinned file descriptor, and bound host-wide input traversal within each sample rather than only enforcing output/deadline checks around samples. Neither tool is automatically active in production.

Local and public health endpoints returned HTTP200 at13:37UTC. Natural local eviction started and finished successfully at13:35:59UTC; no manual invocation occurred. Customer activity had already failed the acoustic admission check, so no automatic reattempt was made after cleanup exited.

All three exact-head CI runs passed: PR547/2bc836c5 run36006171368; PR548/caea7b2d run36004601471; PR549/5e335d53 run36006171387. All three PRs are ready for review. No merge or deployment was performed. Report artifacts contain only synthetic or sanitized operational evidence; raw production payloads remain private.

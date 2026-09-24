# HERO diagnostic release — 2026-09-24

Status: **deployed and smoke-verified** at approximately 07:38:38 UTC / 14:38 Bangkok. Main `fdc4b984a64592a15f35821023d7dbdb8655f2f9`; live build ID `cTfjlkCjs4AUifjFCUJRI`. Parent issue outcomes remain open.

## Delivered

| Change | GitHub record | Remaining outcome |
| --- | --- | --- |
| SQLite transaction phase diagnostics | [PR543](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/543), squash `54da6f27` | Identify the actual holder using natural events; seven-day acceptance. |
| Cleanup polling at safe object boundaries | [PR544](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/544), squash `d04329be` | Observe natural busy yield and explain the existing 90-minute runtime. |
| Offline long-acoustic benchmark | [PR545](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/545), squash `bf0fbf82` | Complete the VPS matrix during an idle window, then evaluate permitted natural audio. |
| Release-blocking build recovery | [PR546](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/546), squash `fdc4b984` | Further assess production build memory headroom. |

PR543–545's merged tree matched reviewed integration `e639dca1`. PR546's final main tree matched independently reviewed head `e5b6b303` (empty diff). PR-head [CI35967039226](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35967039226) and exact-main [CI35968319517](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35968319517) both passed. No CI override was used.

## Production verification

- Native deployment exited 0. Render admission drain, empty-queue checks, private build media mounts, maintenance barrier, atomic build swap, and health rollback gates remained enabled.
- Two SQLite online backups stayed private on host with mode 0600. Both were 670617600 bytes and `quick_check=ok`; latest at 07:18:28Z took 3.46s. No production database or customer media was copied off host.
- At 07:39:32Z: exact HEAD above, tracked files clean, queues 0/0, maintenance off and drain 0. At 07:44:01Z: one new customer video job was progressing; all critical workers remained online with zero unstable restarts. Planned restart counts increased exactly once: render instances 313→314, web/MCP/story workers 2→3.
- Local and public health both returned HTTP200, including the final 07:44 check. No kernel OOM entries were found from07:25 through post-release verification.
- Isolated host smoke passed `verify:prisma-slow-tx`, `verify:media-local-eviction`, and missing-local reconciliation. A transient unit used private `/tmp`, no network, CPU 100%, RAM 2G, and temporary databases/synthetic files. It exited 0 in 29.399s.
- Release-window logs 07:22:41–07:40:51Z contained no P2028, SQLite busy/locked, transaction-closed, application OOM or slow-TX matches. Fresh post-release baseline 07:41:40–07:44:01Z also contained zero matches. No log rotation/truncation occurred. These short windows do not satisfy seven-day acceptance and contain no natural phase event yet.

## Build interruption and recovery

The first native deployment did not swap the live build. A 4096MB-heap build compiled in 7.5min, reached TypeScript, and had observed process RSS above 22GB while host available memory fell to 1087772KiB. The operator stopped only build processes. The native 3072MB retry then failed with V8 heap OOM. The script cleared its guards; the old build and workers kept serving HTTP200.

PR546 explicitly enables `experimental.webpackBuildWorker` while retaining serial/process controls, native externals/rules, Sentry, TypeScript and deploy safeguards. Installed Next 16.3's custom-webpack default disables the worker, while the explicit worker path ends each compiler process. See [Next memory guidance](https://nextjs.org/docs/app/guides/memory-usage) and [custom-webpack worker opt-out](https://nextjs.org/docs/messages/webpack-build-worker-opt-out). This mechanism is verified; it is not a complete attribution of every byte of production RSS.

Effective-config RED/GREEN, scoped deploy checks, TypeScript, independent review and a secret-free local full build passed. Local build 73.28s and reported max RSS ~3.68GiB. Production diagnostics confirmed `useBuildWorker=true`; the second native deploy succeeded without retry.

**Production memory remains an advisory:** sampling 07:32:17–07:38:38Z recorded peak summed build-process-tree RSS 27940988KiB (~26.65GiB), 181 samples. Summed RSS may double-count shared mappings and is not unique host physical usage; sampling began after build start. Do not claim the local 3.68GiB figure represents production. The separate SSH memory-guard connection reset, so its complete minimum-memory series is unavailable. The persisted deploy log and independent on-host resource summary completed, workers stayed healthy, and no kernel OOM was recorded. Further measurement/reduction of build memory is warranted before treating headroom as solved.

## Acoustic package and bounded attempt

Package: `/Users/mewsocialmacmini/.codex/artifacts/hero-diag-three-release-20260924/hero51-acoustic-package.tar.gz`.
SHA256: `72823fc65373938b775e6a0ad341aaed13ab6878ea4900b06f4069c8381b645d`.
Operational instructions: [acoustic-run-plan.md](/Users/mewsocialmacmini/.codex/artifacts/hero-diag-three-release-20260924/acoustic-run-plan.md).

The package uses existing host Python/pinned weights, synthetic Thai WAVs only, private cache/lock, no network, two CPU cores, 6G maximum RAM, 60s per case and 480s total. No production acoustic algorithm or budget changed. Local checks and the target-Linux delayed-process-group cancellation canary passed; a separate busy admission check rejected an existing customer job as expected.

After smoke checks, 07:41:40Z preflight showed no in-flight jobs, cleanup inactive and ~29.8GiB available. One bounded attempt started the short canary. A customer job then arrived; the watcher returned `customer_queue_active:1` and stopped the unit after 10.123s (exit 75). Final inspection found zero result JSON files and no surviving benchmark cgroup. **No completed short or long timing result exists from this attempt.** No automatic retry was made. The five-case package remains ready for a future idle window.

## Next gates

1. HERO-10: collect natural phase events after this release, correlate contenders and establish the actual holder. Before release, old-code observations at 06:35:39Z and06:57:47Z showed 21412ms/20105ms invocations from the jobs route but no phase fields. They do not identify a holder. The seven-day post-release window runs to approximately 2026-10-01 14:38 Bangkok; no continuous seven-day monitoring job was installed.
2. HERO-41: next observed natural eviction timer is 2026-09-24 16:35:03 Bangkok (09:35:03Z). Verify safe yield when customer work arrives and measure the remaining 90-minute phase costs. No cleanup was manually triggered and no post-release natural eviction has been observed yet.
3. HERO-51: rerun the same bounded matrix during a fresh idle window, then evaluate approved natural audio/perceptual subtitle timing. Local synthetic success is not customer timing acceptance.
4. Build: investigate measured production memory and make the temporary guard persistent across SSH loss if reused; avoid inferring resource headroom from local results.

No Linear state was mutated or parent issue marked Done. Latest previously read states remain HERO-10 In Progress, HERO-41 Ready to Deploy and HERO-51 In Progress; these are not a claim of a new final Linear read. No customer ticket, reply, provider replay, financial mutation, or Sentry-clearance claim was made.

## Workspace handoff

Four clean, exact reviewed issue/recovery worktrees were removed through Orca after successful deployment. The control worktree and all reports, fixture/model artifacts and benchmark package were retained. The control worktree is the historical integration/report branch; use a fresh Orca worktree from current `origin/main` for further production-code work.

Related reports: [build recovery](build-recovery.md), [independent build review](build-recovery-review.md), [combined verification](combined-verification.md), [final correctness](final-correctness.md), [final security](final-security.md).

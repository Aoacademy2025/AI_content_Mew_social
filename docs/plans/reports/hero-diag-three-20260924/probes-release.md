# Diagnostic probes release — 2026-09-24

Authorization: Mew explicitly requested commit, push, merge and deploy. **Deployed successfully at2026-09-24 14:35:37UTC /21:35:37Bangkok**, native exit0. Production main is `9c0fd51cf8403a5d075168ec2c9f1d52ea6c14c7`, live buildID `dFhcZ6HAeEblnJc6zI_5P`.

## Reviewed release

| PR | Reviewed head | Squash on main |
| --- | --- | --- |
| [547: SQLite diagnostics](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/547) | `2bc836c5` | `2d75e0d6` |
| [548: cleanup cost attribution](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/548) | `caea7b2d` | `025868a7` |
| [549: opt-in build memory sampler](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/549) | `5e335d53` | `9c0fd51c` |

All exact PR-head CI runs passed before merge. Final main `9c0fd51cf8403a5d075168ec2c9f1d52ea6c14c7` has an empty tree diff against reviewed/built integration `720106d0`. Exact-main [CI36008751211](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/36008751211) passed before launch. No CI override was used. Prisma reported the database already in sync. No schema or production acoustic/heap setting changes are part of this release.

The report/archive branch was committed and pushed separately; it is not merged into production. Root checkout remains read-only.

## Admission and backup

Despite the user's expectation of empty queues, fresh13:52:16UTC inspection found2VideoJobs and2RenderJobs in flight. No job was canceled. At13:55:09 this fell to1/1. All critical workers remained online, cleanup units inactive, maintenance off and drain0; production was stillfdc4b984 with buildIDcTfjlkCjs4AUifjFCUJRI.

Online SQLite backup completed13:55:01UTC,672,845,824bytes,29.79s,quick_check=ok. It remains mode0600 on host at `/var/backups/heroai/probes-20260924/pre-9c0fd51c.sqlite`; no database or customer media left the server.

## Deployment procedure

The native deploy script retains exact-head CI, render admission drain, empty-queue checks before dependency changes and before swap, private build media mounts, staged build, maintenance barrier, health-gated restart and rollback. Existing4096/512 nominal heap inputs and3072/512 fallback inputs are retained. The512worker option remains ineffective in the installed Next consumer; it is not presented as an enforced limit.

Private launcher and sampler use `/var/lib/heroai/releases/probes-20260924`. The launcher persists independently of SSH and records deployment/sampler exit codes. The sampler tracks the deployment child PID into a bounded0600JSONL for at most2hours; raw command lines, environment and logs are not emitted. Staged sampler SHA256 matches reviewed code: `2effecf3221ad24023c5c222d18c389758601f1800b058b92ee1c9ff71035689`.

After release, verify exactHEAD/buildID, tracked cleanliness, queue/guard state, expected worker restart counts, local/public health and fresh error baseline. Symptom-specific tests use an isolated private temporary tree, temporary databases and synthetic files, with networking disabled. No manual production cleanup, paid generation, customer reply, ticket closure or acoustic benchmark is included.

## Verified outcome

- Deployment launched around14:06:57UTC, then waited about16minutes for pre-existing customer work. The remaining render progressed normally and completed without cancellation. Dependencies changed only after the native empty-queue gate passed.
- Native deploy completed14:35:37UTC, exit0, no retry, no build errors. Compile took6.9minutes; TypeScript, page generation, tracing, staged swap and health-gated restarts passed. Guard cleanup succeeded.
- At14:36:07UTC, exactHEAD/buildID above, trackedclean, queues0/0, maintenanceoff, drain0, all four cleanup units inactive. Web/MCP/story workers each restarted once(3→4); both render instances once(314→315). All critical workers online, unstable restarts0.
- Local and public health returned HTTP200. Kernel journal from14:06:49 through postrelease inspection had0OOM matches.
- Isolated host smoke passed `verify:prisma-slow-tx`, `verify:media-local-eviction`, `verify:sqlite-lock-observer`, and missing-local reconciliation. Unit exit0,29.233s. It used private temporary files/databases, no network, CPU100%, memory2G; no production cleanup was triggered.
- Deployment-window logs contained one20.055s jobs-route transaction logged14:30:23, while the old build was still serving. Callback time20.047s; source had the old line-only format. This is the known unresolved symptom, not evidence that new diagnostics fixed it or a demonstrated deployment-induced cause. Other tracked P2028/SQLitebusy/closed/OOM/Sockettimeout/P1008 markers were0 in that observation. Fresh postrelease baseline14:36:49–14:40:14 had0tracked markers and no rotation/truncation. This short window is not seven-day acceptance.

Final14:40:14UTC check retained the exact release, clean tracked files, maintenanceoff/drain0 and unchanged healthy worker restart counts. Two new VideoJobs and two RenderJobs were active after admission reopened; this shows new work admitted, not completed-job acceptance. Local/publicHTTP200 and postrelease tracked error counts remained zero.

## Measured build memory

The sampler exited0 with `root_exited`,1,634samples over1,719.92s including the drain wait. The private0600JSONL is2,741,220bytes and retained on host plus the private local release-artifact directory. These are sampled process-tree peaks, not guaranteed instantaneous maxima.

| Measurement | Observed value | Stage |
| --- | ---: | --- |
| Tree PSS peak | 26,718,016KiB /25.48GiB | webpack |
| Tree RSS peak | 26,909,796KiB /25.66GiB | webpack |
| Tree private peak | 26,701,740KiB | webpack |
| Tree swap peak | 1,754,024KiB /1.67GiB | webpack |
| Host minimum available | 2,379,860KiB /2.27GiB | webpack |

The dominant individual process was one webpack compiler(PID1722210,startticks715455650), peakPSS26,679,365KiB at14:32:58.993UTC. Its effective old-space flag was4096MiB. The large peak is predominantly private/PSS memory; summed-RSS double counting does not explain it. An old-space flag is not a total process-memory limit, and these samples do not yet attribute the allocations within the compiler.

After compiler exit, available memory returned above25GiB; at postrelease inspection it was about29.8GiB. No operator kill, fallback retry or OOM occurred. Build memory remains a material follow-up: identify the compiler allocation source and reduce the measured25.48GiB peak before treating headroom as resolved. Do not label the sampler itself a RAM optimization.

## Remaining scope and housekeeping

Parent HERO-10/41/51 outcomes remain open: diagnostic deployment is not proof of SQLite root-cause resolution, cleanup performance improvement or natural long-clip subtitle acceptance. No Linear state, customer ticket or Sentry resolution was changed. No acoustic benchmark or production thread change ran during this deployment.

The three clean merged issue worktrees were removed through Orca. The integration worktree and control/report archive remain. All code commits and the report archive are pushed; root checkout remains read-only.

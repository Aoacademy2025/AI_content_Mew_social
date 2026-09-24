# Discriminating probes execution ledger

Plan: [2026-09-24-hero-discriminating-probes.md](../../2026-09-24-hero-discriminating-probes.md)
Profile: high-assurance; risk: cleanup integrity and root-host diagnostic privacy.
Ceiling: 12 new agent runs, 2 fix rounds per task. Usage dashboard unavailable.

## Wave 1
- Task1 worker: SQLite caller column + bounded lock observer; own Orca `hero10-lock-probe-20260924`.
- Task2 worker: cleanup aggregate cost diagnostics; own Orca `hero41-cost-probe-20260924`.
- Task3 worker: reuse acoustic author for private quota-control package.
- Task4 build sampler waits for a free slot; own Orca `hero-build-memory-probe-20260924` prepared.
- Fresh integration worktree `hero-probes-integration-20260924` prepared from fdc4b984; dependencies installed. Copied ignored environment quarantined before checks. Root checkout remains read-only.

## Rulings
- This is execution of the user's explicit follow-up approval; no new interview or redundant approval question.
- Previous source worktrees were removed after deployment. New code uses fresh origin/main fdc4b984, not the historical report branch.
- Host workloads are serialized by root. Natural R2 reconcile ran12:46:37–12:47:21Z and ended success. No acoustic inference overlapped it.
- A bounded benchmark timeout is a valid RED result, not permission to increase production budgets or weaken quality gates.
- SQLite OS lock ownership is not business-operation attribution. Validate the inode/range parser against known disposable WAL holders before natural observation.
- No new deploy/cleanup is required merely to collect measurement. Build sampler stays opt-in for a necessary build; cleanup probes require reviewed delivery before a future natural pass.

## Current verification
- Production12:46:50Z: exact fdc4b984, trackedclean, queues0/0, maintenanceoff/drain0, workersstable.
- Existing postrelease baseline still contains4slowTX and no new P2028/SQLitebusy/closed/OOM marker; unchanged from prior pass.
- Implementation and independent review pending.
- Root ran Task1's disposable Linux WAL regression in a private temporary directory under a30s timeout, emptyenv, Pythonstdlib only. It failed with `unsupported SQLite WAL lock range`; no production DB was opened. The Linux known-holder RED exposed an omitted normal shared-memory lock range. Worker is correcting exact classification and fixture failure cleanup before re-run; no natural observer used.
- After exact shared-memory deadman-switch support and bounded fixture cleanup, root re-ran the same Linux regression: `verify-sqlite-lock-observer-linux: ALL PASS`, exit0. Writer/read-only reader/checkpointer roles passed on the target kernel. This establishes parser capability only, not a production holder.
- Task3 quota-control package entered independent review. Read-only target capability check shows `memory.peak` absent in system.slice and PM2 cgroups, while `memory.current` and `memory.events` exist. Review must ensure missing peak is handled explicitly, not reported as measured.
- Task1 committed b504590e; draft PR547 and CI started. Task2 committed3ba065c0; draft PR548 and CI started. Both are in fresh independent-review flow.
- Combined integration79baa181 (Task1+Task2) built successfully with blank environment and4096MB parent heap. Compile37.8s, TypeScript18.6s,193staticpages. Log retained privately as `hero-probes-20260924/combined-build.log`; clean integrationtree. No claim that the ineffective512MB worker option now works.
- Task4 initial standard worker failed before execution because model capacity was unavailable. Re-dispatched to heavy worker for root-host proc/env privacy; no task output was lost.
- Task1 Tier1 identified an argparse-error privacy blocker (raw malformedCLI value echo). Worker fix round1 is active, requiring RED secret-canary coverage and fixed static parser errors. Natural observation remains unlaunched.
- Task3 review blocker was missing target `memory.peak`. Author supplied explicit `sampledCurrent` fallback and8fixtures; scoped re-review of archive4535f642 is active. No inference started yet.
- Task1 privacyfix8dfe4347 independentlycleared and pushed; integrationf26d0090 includes it (Python/test-only delta after fullbuild). Reviewed natural observer ran13:09:12.731–13:11:12.780Z: exit0,1028samples,14read/main/deadman intervals,0unsupported. No WAL writer/checkpoint role was observed; this is not proof the historical slow holder was absent outside sampled instants.
- Task3 archive4535f642 independentlycleared. TargetLinux checksum,8fixtures and delayedprocessgroupcancelcanary passed. Fresh13:11:26Z preflight q0/0, cleanupinactive,~30.1millionKiBavailable, workersstable. One quota400%/threads2 control started; no productionsettings changed.
- Quota400 control completedexit0, runtime1m58.070s. Short8.721s/12046.059s alignedwithsameexactquality;200timedout60.253s inemissions. 120caseemissions38.894s, throttle0.330s;200throttle0.600s. Allpercase memoryeventdeltaszero. Privategeometry40s authoring/localqualitycontrol nowactive, conditionalhostrunonlyafterreview.
- Ruling: original linked acoustic recommendations explicitly include a third private thread-scaling control after quota/geometry separation. The user's approval covers that experiment; clarified Task3 rather than inventing another approval gate. Productionthreads remain2 and anyfailed/abortedvariant stops withoutautomaticretry.
- Task1 final correctness fix2bc836c5 closes final-snapshot inode replacement and enforces1000events while parsing; exactLinux known-holder regression passes again. Task4fixaffab99c corrects heap precedence/aliases and late rootPIDreuse;14tests plus bounded liveLinuxPSS smoke pass. Task2caea7b2d includes recovery catalog timings. Integration720106d0 passes final blank-envbuild193pages; finalcorrectnesscleared.
- Second natural SQLite observation13:19:41–13:24:41 captured68write/2checkpoint intervals. Journalmetadata associates the writer with natural R2reconcile13:20:06–13:20:51; longest observed continuous interval244ms. It does not identify the holder during earlier20–30s slowTX. Baseline now8slowTX,1Sockettimeout,1P1008 (unchanged at13:36:09), so daily acceptance is not met.
- Geometry40 stopped locally after38.9%slower emissions and~515MBmoreRSS with noqualitygain. Threads4/original20package independentlycleared and targetLinuxchecksum/9tests/cancelcanarypass. Fresh13:35:24admission saw1customerVideoJob and cleanupdue13:35:56: nohostinference, noautomaticretry. Productionthreads2 unchanged.
- Finalsecurityreview dispatched fresh, heavyprofile. New-agent budget remainswithin12; authorfixrounds Task1two, Task2one, Task4one. One unavailable rolealias was retried with the mandated heavy model; no extra agent was created by the failed alias call.

- Final security cleared720106d0 with no blockers. All three exact-head GitHub CI runs passed; PRs547–549 marked ready. Approved tools/PRs and evidence delivered; four-thread host execution explicitly deferred on failed customer-idle admission. No merge/deploy or parent closure.

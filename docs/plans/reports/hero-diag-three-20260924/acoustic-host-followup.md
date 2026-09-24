# HERO-51 deployment-host acoustic follow-up — 2026-09-24

Status: **deployment hardware reproduces the long-input timeout under the bounded two-core experiment.** The 6.050-second canary and 120.996-second case aligned; the 199.644, 272.242 and 302.491-second cases reached the 60-second deadline with `emissions` as the last phase. This supplies the missing deployment-hardware RED. It does not establish unrestricted production latency or human Thai timing quality, and no production tuning, retry, budget, model, worker or source change was applied.

## Evidence and controls

The matrix used the deployed `thai-ctc-v1` engine and harness, pinned model revision `3155938c549b23eee16b1d4b55dcb161b7fe4bcf`, the approved noncustomer Kanya fixtures, two Torch threads and a private cache/lock. The transient unit retained `CPUQuota=200%`, `CPUWeight=1`, `Nice=19`, idle I/O scheduling, `MemoryHigh=5G`, `MemoryMax=6G`, a 60,000ms deadline per case, offline Hugging Face/Transformers state, no network namespace and the customer/cleanup abort guard. The package checksum and delayed-process-group cancellation canary passed before inference.

The five result JSON files were read independently from the restricted host result directory after completion, then preserved locally as numeric-only evidence at:

```text
/Users/mewsocialmacmini/.codex/artifacts/hero-diag-three-release-20260924/acoustic-host-results.json
```

Every report records the expected engine version, pinned model revision, two threads, 60,000ms deadline and synthetic-only qualification. No customer media, transcript, provider call or production acoustic cache entered this run. The unit completed in 4m7.277s with 7m44.148s CPU time, exit 0. Exit 0 means the harness completed the bounded matrix and saved timeout results; it does not mean all cases aligned. The cgroup was absent afterward.

## Independently validated matrix

| Audio | Result | Harness wall | Engine phases: load / decode / emissions / align | Time after emissions marker before exit | Sampled child peak RSS | Synthetic completeness |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 6.050s | aligned | 8.847s | 4.842 / 0.522 / 2.173 / 0.007s | 3.317s, including completed emissions/alignment and harness overhead | 2.458GiB | 72/72 spans; 1/1 boundary |
| 120.996s | aligned | 53.453s | 5.282 / 0.601 / 45.670 / 0.576s | 47.380s, including completed emissions/alignment and harness overhead | 2.698GiB | 1,440/1,440 spans; 20/20 boundaries |
| 199.644s | timeout, last phase `emissions` | 60.264s | incomplete; emissions marker at 5.739s | 54.525s without reaching the alignment marker | 2.397GiB | no completed clock to assess |
| 272.242s | timeout, last phase `emissions` | 60.301s | incomplete; emissions marker at 5.720s | 54.581s without reaching the alignment marker | 3.066GiB | no completed clock to assess |
| 302.491s | timeout, last phase `emissions` | 60.295s | incomplete; emissions marker at 5.747s | 54.548s without reaching the alignment marker | 3.067GiB | no completed clock to assess |

The 264–301ms termination overhang is harness sampling/kill/wait overhead after the configured deadline, not an increased inference budget. For timeout cases, the marker proves that alignment was never announced before termination. It does not prove every intervening CPU cycle was model computation, so the report does not label the whole 54.5-second interval as pure emissions CPU time.

The 120.996-second completed case retained only 6.547 seconds of wall-clock deadline margin. Emissions accounted for 45.670 seconds, or 85.4% of its harness wall time. Its output had:

- valid model identity, complete expected text spans, monotonic timestamps and exact audio duration;
- 1,440 emitted eligible spans in exact order, with zero missing, duplicate or unexpected spans;
- all 20 known synthetic boundaries;
- boundary absolute median/max 50/57ms and cumulative drift median/max 6/14ms.

The short canary likewise had complete spans and its one boundary at 43ms absolute error. These machine-known repetition boundaries are operational invariants, not human-reviewed natural Thai acceptance. The three timeout cases produced no final character clock, so no quality conclusion is available for them.

For context, the same 120.996-second fixture on the Apple M4 task host took 9.080 seconds in emissions and 11.350 seconds total. The VPS figures are 5.03× and 4.71× those values. The short emissions figure is 5.52× the local value. Hardware, operating system and scheduler controls differ, so these ratios establish an environment effect but do not attribute it to one cause. The completed VPS case reproduced the local aggregate span and boundary metrics.

## CPU and memory interpretation

At 12:37:16Z, while the matrix was still running, the unit reported:

```text
cpu.max                 200000 100000
cpu.stat usage_usec     387166267
cpu.stat throttled_usec 56260088
cpu.stat nr_periods     2062
cpu.stat nr_throttled   1724
memory.events           all counters 0
```

Thus 83.6% of recorded CFS periods had at least one throttle event, with 56.260 seconds in the cgroup throttling counter. That is material scheduler evidence. `throttled_usec` is not a direct wall-time penalty and cannot predict the speedup from a different quota. The benchmark was hard-capped at two CPUs and deliberately deprioritized; its absolute wall times must not be reported as unrestricted PM2 latency.

The observed web, MCP and story PM2 configurations all allowlist `SUBTITLE_ACOUSTIC_THREADS=2`, matching the benchmark's Torch thread setting. Matching thread count does not make PM2 scheduling equivalent to the transient unit's hard quota and low priority.

Maximum sampled child RSS was 3.067GiB, below the 5G high and 6G maximum controls. Every cgroup memory-event counter was zero at the 12:37:16Z snapshot, ruling out such recorded events up to that snapshot. The final counters were not retained before the unit was collected. These observations do not measure unique full-cgroup PSS or prove memory can never contribute under concurrent production load.

## Natural release cohort

The read-only completion cohort from release completion at 07:38:38Z through 12:36:34Z contained 14 completed create jobs, all shorter than 120 seconds, with zero missing/invalid output or duration. Nine reported partial forced alignment, one forced alignment and four an unknown/missing top-level timing source. There were no natural long cases and no long numeric acoustic phases. This is operational safety evidence only; it does not validate the long path or provide human timing acceptance.

## Ranked minimal experiments

These are experiment proposals, not approved production settings. Every step retains the exact model, 60-second deadline, current quality predicate, private synthetic fixtures/cache, memory ceiling, low scheduling priority, offline/network isolation and customer/cleanup abort guard. Stop at the first failed short/quality/resource gate and do not retry automatically.

1. **Remove the benchmark-only quota confounder with one bounded control.** Run the short canary and 120.996-second case at a temporary `CPUQuota=400%`, still with two Torch threads; proceed once to 199.644 seconds only if both are operationally clean. Capture per-run `cpu.stat` deltas rather than cumulative counters. The control succeeds only if the completed cases retain exact spans/boundaries and emissions wall time falls with materially less throttling. This does not authorize a PM2 CPU or thread change; it determines whether optimizing the engine from the 200%-quota result would target the wrong mechanism.
2. **If the two-thread control still misses 200 seconds, A/B the existing chunk geometry in an experimental engine copy.** The current engine already uses 20-second interiors with two seconds of context on each side; “add chunking” is not a finding. Compare that baseline with 40-second interiors while retaining two-second context, sample-exact convolution offsets and the same source-indexed Viterbi path. Run short, 120 and 200 seconds only. Require the existing exact span counts, 20/20 and 33/33 known boundaries, boundary max no worse than 57ms, drift max no worse than 14ms, no memory events and RSS below the existing ceiling. Fewer overlapped context frames/forward calls may reduce emissions, but the observed data do not prove enough gain to clear 60 seconds.
3. **Only if quota and geometry are separated, test thread scaling as a resource experiment.** Compare two versus four Torch threads under the same temporary four-CPU cap on short/120, then 200 only after quality passes. Record emissions time, CPU usage/throttling and host contention. The deployed value remains two; a faster four-thread synthetic run would still require natural-load safety evidence before any configuration proposal.

A budget increase would hide the reproduced failure. Retries would add contention. A persistent model worker would primarily remove the roughly five-second load phase while emissions is the measured dominant phase, and it introduces lifecycle/concurrency work not tested here. Model replacement, quantization and weaker coverage/boundary rules would change quality risk. None is supported as a fix by this matrix.

## Decision

HERO-51 remains open. The deployment host now supplies a real-engine, noncustomer RED at 199.644 seconds and above under the bounded two-core unit, with emissions as the incomplete phase and no memory-limit event in the retained snapshot. The immediate evidence gate is the quota-control experiment above, followed by strict quality-preserving geometry evaluation only if needed. Natural long-output observation and human-reviewed Thai timing remain required before an apply decision.

Related evidence: [Task 3 offline evaluation](task-3.md), [release follow-up](release-followup.md), [cross-track observation](observation-followup.md), and the private [operational run plan](/Users/mewsocialmacmini/.codex/artifacts/hero-diag-three-release-20260924/acoustic-run-plan.md).

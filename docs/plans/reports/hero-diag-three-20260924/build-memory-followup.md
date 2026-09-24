# Production build-memory follow-up

Date: 2026-09-24 (Asia/Bangkok)

Scope: retrospective diagnosis from persisted release evidence and read-only source/host inspection. No production build, deploy, process mutation, application edit, environment dump, or customer-data read was performed.

## Finding

The successful production build is not attributable to a 512 MB compiler-worker heap. That setting was never applied.

At commit `fdc4b984a64592a15f35821023d7dbdb8655f2f9`, `scripts/build.js` constructs:

- parent `NODE_OPTIONS=--max-old-space-size=4096`;
- `NEXT_PRIVATE_WORKER_OPTIONS=--max-old-space-size=512`.

The installed Next 16.3 tree contains no consumer of `NEXT_PRIVATE_WORKER_OPTIONS`. Its worker wrapper parses the parent `NODE_OPTIONS`, and because the webpack compiler worker is created with `isolatedMemory: false`, it preserves that max-old-space-size and writes the formatted value back into the child’s `NODE_OPTIONS`. The server, edge-server, and client compiler children therefore inherited the 4096 MB old-space limit. Confidence: **high**, based on the exact deployed source and installed Next implementation.

PR546 still changed an important lifecycle property: Next created one disposable process for each compiler and called `worker.end()` after each. The production build completed, and the compiler CPU-profile filenames prove the server, edge-server, and client worker sequence occurred. What remains unproved is how much physical memory each process and stage used.

The reported `27,940,988 KiB` peak is a sum of per-process RSS, not a measurement of unique physical memory. RSS counts a shared resident page in every process that maps it. The saved figure can therefore be materially higher than aggregate proportional or private memory. It must not be described as a 26.65 GiB physical allocation.

## Persisted evidence

Private release record:

`/var/lib/heroai/releases/diag-three-20260924-recovery/build-resource-summary.json`

```json
{
  "buildSamples": 181,
  "deployExit": "0",
  "start": "2026-09-24T07:32:17.728312+00:00",
  "end": "2026-09-24T07:38:38.651788+00:00",
  "sampledBuildTreePeakRssKiB": 27940988
}
```

The file stores no raw samples, peak timestamp, PID list, process roles, per-process RSS, PSS, private memory, host `MemAvailable`, or swap series.

A red-capable feedback loop cannot be reconstructed from these surviving artifacts: the per-sample process state is gone, and the approved scope forbids creating a new production build workload. The sampler specified below is the minimal loop for the next already-authorized deploy.

The allowlisted build log establishes this order:

| Evidence | Approximate boundary |
| --- | --- |
| RSS sampling started | 07:32:17Z |
| server compiler profile saved | 07:33:06Z |
| edge-server compiler profile saved | 07:33:18Z |
| client compiler profile saved | 07:36:03Z |
| webpack reported success | after client profile; 5.0-minute compile |
| TypeScript | next; 61 seconds |
| page data and static generation | next; one worker, 193 pages, 2.0 seconds for static generation |
| final optimization and build tracing | after static generation |
| parent CPU profile saved | 07:38:22Z |
| sampling ended and deploy exited 0 | 07:38:38Z |

The profile timestamps are approximate process boundaries encoded in filenames; they are not memory samples. The sampler window covered compiler, TypeScript, page-data, static-generation, optimization, and tracing phases, but the missing peak timestamp prevents assignment of the RSS peak to any one phase.

The host is x86_64, Node `v22.22.2`, with `32,861,504 kB` total memory. The only sysstat memory point near the release is 07:40:06Z, after the build ended: `31,246,096 KiB` available and `81,636 KiB` swap used. That proves recovery after the build, not build-time headroom. There is no atop archive, no per-process sysstat history, and no persisted cgroup memory peak.

## What the evidence supports

1. **Compiler isolation ran.** Next diagnostics and three compiler profiles agree with the explicit worker path.
2. **Compiler workers were sequential and disposable.** Next’s exact implementation loops over server, edge-server, and client, creating one process and ending it before advancing.
3. **The printed 512 MB worker heap was ineffective.** The compiler child inherited the 4096 MB parent old-space option.
4. **The full deploy succeeded without retry or kernel OOM.** This is an outcome, not proof of comfortable memory headroom.
5. **The RSS sum is advisory only.** It is neither aggregate PSS nor cgroup-accounted physical memory.

The evidence does not support:

- a claim that webpack compilation caused the recorded peak;
- a claim that TypeScript or tracing caused the peak;
- a claim that the build physically consumed 26.65 GiB;
- a claim that the host retained a particular minimum `MemAvailable`;
- a before/after production-memory comparison with the pre-PR546 build.

## Ranked, falsifiable explanations

1. **Shared mappings inflated the RSS sum.** Prediction: at the next measured build, summed RSS again rises sharply while aggregate PSS/private resident memory and the fall in host `MemAvailable` remain substantially smaller.
2. **Compiler workers used the inherited 4096 MB allowance and contributed real private memory.** Prediction: a compiler `processChild.js` process records the largest PSS/private peak, and its allowlisted effective max-old-space-size is 4096.
3. **A post-webpack phase dominated the peak.** Prediction: the aggregate PSS peak occurs after all `build-webpack-*` compiler workers exit, during TypeScript, page-data, optimization, or tracing.
4. **The whole build tree created genuine host pressure despite RSS overcount.** Prediction: aggregate PSS rises with a matching fall in host `MemAvailable` and/or increasing per-process swap during the same sample.

The current evidence cannot rank explanations 1–4 beyond the source-proven ineffective 512 MB limit.

## Minimal next measurement

Do not launch a diagnostic build solely for this question while the acoustic work or customer jobs are active. Instrument the next already-authorized deployment instead; this adds measurement without another workload.

Before that deployment, prepare and review one standalone sampler outside the application tree. Start it before the deploy and persist mode-0600 JSONL under that release’s private record. Every second it should:

1. Resolve the deploy PID and descendants, recording PID, PPID and `/proc/<pid>/stat` start time so PID reuse cannot corrupt the series.
2. Classify only allowlisted roles: deploy shell, npm/build wrapper, `next-build` parent, webpack `processChild.js`, and other Next workers. Never persist full command lines.
3. For compiler children, read `/proc/<pid>/environ` only in memory and retain two allowlisted derived values: `__NEXT_PRIVATE_CPU_PROFILE` reduced to server/edge-server/client, and the numeric `max-old-space-size` parsed from `NODE_OPTIONS`. Discard every other environment entry.
4. Read `/proc/<pid>/smaps_rollup` and record `Rss`, `Pss`, `Private_Clean`, `Private_Dirty`, `Shared_Clean`, `Shared_Dirty`, and `Swap`. Missing/exited PIDs are normal and should be marked, not retried noisily.
5. Record host `MemAvailable`, `SwapFree`, and `SwapTotal` from `/proc/meminfo`.
6. Attach an allowlisted stage derived only from known deploy-log markers: webpack, TypeScript, page-data, static-generation, optimization, tracing, or complete. Never copy arbitrary log text.
7. On completion, write a summary containing peak timestamps/stages for tree RSS, aggregate PSS, aggregate private resident memory, aggregate swap, lowest host `MemAvailable`, and the top processes by PSS. Preserve raw samples so the summary is auditable.

The decisive comparisons are:

- **RSS accounting inflation:** `sum(RSS) - sum(PSS)`;
- **unique/private pressure:** `sum(Private_Clean + Private_Dirty)`;
- **host impact:** baseline `MemAvailable - minimum MemAvailable`;
- **stage attribution:** the stage and process role at aggregate-PSS peak;
- **heap-limit truth:** the parsed max-old-space-size for each compiler child.

If a dedicated transient cgroup is approved for a later reproduction, cgroup `memory.current` provides a second accounting boundary. This host exposes cgroup v2 but does not expose a root `memory.peak` file, so per-process `smaps_rollup` plus host memory remains the minimal portable measurement.

## Minimal reproduction if deployment evidence is still ambiguous

Only after the acoustic task is complete and the host is idle, run one secret-free build from an exact-main disposable checkout with the same Node version, copied compile cache, empty private views of runtime media, and the same 4096/512 inputs. Use the sampler above and keep application workers outside the measured process tree. Do not change heap settings during that run. A later differential run is justified only if the first PSS trace identifies a specific stage or ineffective limit worth testing.

No production code change is justified from the existing RSS summary alone. Operationally, treat the worker heap as 4096 MB, retain the low-memory guard for future deploys, and keep build-memory headroom open until a persisted PSS/private/host-memory series identifies the peak.

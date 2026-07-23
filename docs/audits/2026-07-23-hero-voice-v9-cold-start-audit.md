# Hero AI Voice v9 cold-start audit

Date: 2026-07-23 (Asia/Bangkok)

> Production canary update, 09:02 Asia/Bangkok: release commit `57ef586` was
> deployed to the production application and the allowlisted Hero Voice route
> was switched to v9 endpoint `k69fz253b59st4`. The production allowlist now
> contains 17 explicit user IDs, includes `duckyhero@gmail.com`, and contains no
> wildcard. The same 17-account cohort can use Hero AI Image through RunPod
> Public Z-Image; ordinary-user policy checks remain false and the editor keeps
> the disabled “เร็ว ๆ นี้” presentation. Post-deploy health, queue/drain,
> four PM2 process, 48-voice catalog, image-readiness, and scale-to-zero checks
> passed. The pre-change environment backup is
> `.env.pre-hero-ai-v9-20260723T015038Z` on the production host.

## Outcome

The v9 staging candidate meets the seconds-level target when RunPod resumes an
already-cached worker image. Across three independently verified scale-to-zero
cycles, first-request queue delay was 1.170–1.933 seconds (median 1.830 seconds),
and execution was 0.607–0.782 seconds. Immediate warm requests queued for
0.092–0.096 seconds and executed in 0.469–0.620 seconds.

The guarantee has an important boundary: the first pull/start of the new v9
image took 158.989 seconds before execution. That is about 50% faster than the
318.306-second v8 first-start observation, but a similar multi-minute wait can
recur after a RunPod host cache eviction. The validated seconds-level results
are FlashBoot/cache-resume results, not a guarantee for every uncached host.

Hero AI Voice remains allowlist-only. Production endpoint `xbn9a1ynd6byeu` and
production template `u7pyxacp1a` were not modified or cut over.

## Release candidate

| Item | Value |
| --- | --- |
| Image | `ghcr.io/mewic/heroai-omnivoice:staging-20260723-v9-lazy-slim-amd64-be5eba77` |
| Registry digest | `sha256:c6f8ade96807b4c0c2ed953f08ae4b6a7eb01dca7b4fae4b3a3a19782a5049b8` |
| Platform | `linux/amd64` |
| Container user | `worker` |
| RunPod template | `cb4kazlwbj` |
| RunPod endpoint | `k69fz253b59st4` |
| Scale policy | min 0, max 1, idle timeout 60 seconds, FlashBoot enabled |
| Worker version | `heroai-omnivoice-runpod-v4-lazy-prompt-cache` |

The registry reports 6,454,818,785 compressed bytes (6.45 GB), down from the
approximately 9.97 GB local v8 image, a reduction of about 35%.

## Root cause and implementation

Two independent costs were found:

1. Worker boot eagerly prepared all 48 voice prompts even though a request uses
   only one voice. v9 validates the complete manifest at boot, then prepares
   only the selected prompt on first use and caches it for the worker lifetime.
2. The earlier image ownership flow duplicated a large model layer during a
   recursive ownership change. v9 creates the non-root user and destination
   ownership before downloading the model, so no copy-on-write model duplicate
   is produced.

The prompt cache is a small thread-safe module with one public operation,
`get(voice_id)`. Regression coverage proves that boot creates zero prompts,
only the selected prompt is created, repeated calls reuse it, unknown voices do
not invoke the factory, and simultaneous requests create a prompt once.

## Measurements

### First deployment of the v9 image

| Request | Queue delay | Execution | Model generation |
| --- | ---: | ---: | ---: |
| First image pull/start, voice01 | 158.989 s | 1.835 s | 0.626 s |
| Immediate warm, voice01 | 0.093 s | 0.507 s | — |

### Three verified scale-to-zero cycles

Each cold submission was made only after the RunPod REST worker state reported
`desiredStatus=EXITED` twice. The public `/health` endpoint was not used for this
assertion because it continued to report stale ready/idle counts after the
worker had exited.

| Cycle | Cold queue | Cold execution | Warm queue | Warm execution |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.170 s | 0.607 s | 0.092 s | 0.620 s |
| 2 | 1.830 s | 0.782 s | 0.092 s | 0.608 s |
| 3 | 1.933 s | 0.700 s | 0.096 s | 0.469 s |

One early 1.08-second measurement was discarded because the worker had not
actually reached `EXITED`; it is not included in the table or median.

## Thai and catalog checks

A live v9 quality probe generated `voice01`, `voice32`, `voice33`, and
`voice48`. Every response reported Thai (`th`) and the v9 worker version.
Quality-floor voices `voice32` and `voice33` used 16 inference steps; `voice48`
proved that the tail of the 48-voice manifest was available.

The complete offline audit processed 48 references and 48 clone previews:

| Gate | Result |
| --- | --- |
| Total FAIL findings | **0** |
| Confirmed two-model duplicate consensus | **0** |
| REVIEW findings | 71 |
| Maximum preview Thai CER | 9.62%, `voice33` |

REVIEW is not the same as a pass for launch quality. `voice33` is closest to the
10% automated failure boundary and must be prioritized in human listening.
Detailed evidence is in
`docs/audits/2026-07-23-hero-voice-catalog-quality-audit.md` and its JSON peer.

## Capacity and cost decision

The staging endpoint is left at min 0 and the retained worker was observed in
`EXITED` state after testing, so no GPU is intentionally kept running between
requests. The observed worker rate is USD 0.25/hour. Keeping one worker active
continuously would be about USD 6/day before request-dependent charges; v9 does
not enable that mode.

The recommended next state is an allowlist canary on v9 with min 0 and FlashBoot.
This preserves margin and gives seconds-level startup on cached resumes. If an
uncached multi-minute first request proves unacceptable in real traffic, the
next trade-off is either provider-backed cached/network-volume model storage or
min 1; min 1 should be chosen only with an explicit USD 6/day budget decision.

## Staging cleanup

RunPod account quota was full at five workers. The obsolete v2 staging endpoint
`hvzgdz0h1mdkcj` and template `s3x8bt3u8u` were confirmed unused (min 0, no
queued or in-progress work, and not configured in the application), then
deleted to create the v9 staging candidate. Their old configuration and RunPod
log history are no longer recoverable from those resources.

No allowlist expansion or production endpoint/template mutation was performed.

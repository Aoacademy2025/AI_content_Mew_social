# Hero AI Voice v11 durable-queue audit — 2026-07-24

## Release decision

The failure was an application timeout, not a broken voice or v11 inference worker.
Production deliberately canceled RunPod jobs that remained queued for 120 seconds, while
observed healthy cold starts extended beyond that boundary. The remediation keeps every
accepted job on its original voice/provider/endpoint and makes RunPod polling durable
across request and MCP-worker lifetimes.

There is no Hero Voice → Gemini/ElevenLabs fallback or recommendation in the failure
contract. Gemini jobs likewise remain Gemini jobs. A different provider requires a new,
explicit user submission.

## Production evidence

Production was initially on application commit `87e2bb9` with
`OMNIVOICE_QUEUE_WAIT_BUDGET_MS` unset, so the 120,000 ms source default applied. The
RunPod endpoint was:

- endpoint `txvrmtzfc8au3b`
- template `jnzhscxted`
- image `ghcr.io/mewic/heroai-omnivoice:staging-20260723-v11-all32-amd64-68a4123f`
- worker contract `heroai-omnivoice-runpod-v6-all-voices-32`, Thai, 32 steps
- scale-to-zero, min 0, max 1, FlashBoot on, idle timeout 60 seconds

Two earlier failures at approximately 15:10 and 15:34 ICT ended after about 121–122
seconds. Successful jobs on the same release later showed provider delay values of 20,
57, 58, and 83 seconds. The same failure reproduced during this audit:

- VideoJob `cmryps9zr02g9lcfpckj6tq7h` entered TTS at 16:04 ICT.
- The application returned `OMNIVOICE_QUEUE_TIMEOUT` and failed the VideoJob at 16:06
  ICT.
- RunPod reported one queued/throttled job before the failure, then zero queued jobs and
  one ready worker immediately after the application canceled it.

This is the signature of an application-side cutoff racing a valid late worker allocation.

## Implemented design

Release code commit: `4981c4c`.

Hero Voice now uses the existing `AiGenerationJob` and `AiGenerationAttempt` durability
model instead of holding an HTTP request or MCP worker slot:

1. Validate and normalize the script before provider spend.
2. Reserve the exact managed-audio/package quota class.
3. Submit exactly once and persist the RunPod job ID, endpoint, voice ID, backend, and
   absolute provider deadline.
4. Park the VideoJob as `waiting_provider` at TTS 10%.
5. Reclaim it only when the next poll is due.
6. Resume the same provider job after process restart.
7. Save multi-chunk WAV parts deterministically and settle quota atomically on completion.
8. Clear the TTS checkpoint before later pipeline stages.

Unknown POST outcomes are not automatically replayed because doing so could create a
second paid RunPod job. User cancellation attempts to cancel the persisted RunPod job and
settles the reserved quota. Terminal provider failures are written to the VideoJob as
structured `errorCode`/`errorProvider` fields instead of exposing the internal API response.

The authoritative durable deadline is the configured request budget (840 seconds in
production), not the legacy synchronous queue guard. The synchronous compatibility route
now defaults to a five-minute queue guard and emits structured timeout/failure telemetry.

## Provider pin invariant

An accepted generation persists all of the following:

- provider product: Hero Voice / OmniVoice
- backend: RunPod
- endpoint ID
- provider job ID
- selected Hero voice ID
- normalization version and privacy-safe risk categories

Polling reconstructs its configuration from the persisted endpoint and state. Changing a
later rollout default cannot move an in-flight job. Endpoint/provider mismatches fail
closed. Customer-facing failure copy only recommends retrying the same Hero Voice job
type; it does not recommend or return another provider.

## Production control-plane changes

The legacy production environment now explicitly contains:

```text
OMNIVOICE_QUEUE_WAIT_BUDGET_MS=300000
```

Only `ai-content` was restarted for that environment change, after all VideoJob,
RenderJob, and durable voice queues were empty. Health returned HTTP 200. The pre-change
environment backup is:

```text
/root/heroai-env-backups/ai-content.env.pre-hero-voice-wait300-20260724T091600Z
```

The RunPod GPU fallback pool changed from:

```text
NVIDIA RTX A4000
NVIDIA L4
NVIDIA A40
```

to the nine-GPU list already validated by the v5 staging candidate:

```text
NVIDIA RTX A4000
NVIDIA RTX A4500
NVIDIA RTX 4000 Ada Generation
NVIDIA RTX 2000 Ada Generation
NVIDIA L4
NVIDIA GeForce RTX 3090
NVIDIA A40
NVIDIA RTX A6000
NVIDIA GeForce RTX 4090
```

The template, image, min/max workers, FlashBoot, and 60-second idle timeout did not
change. The endpoint had no queued or in-progress voice job when patched.

## v11 benchmark

The original benchmark tool still submitted eight steps and was correctly rejected by
the all-32-step v11 contract. It was fixed to pin and report `--num-step=32`; the rejected
probe produced no audio and is excluded from the measurements.

| Configuration | Run | Wall | RunPod delay | Execution | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Original 3-GPU pool | cold | 5.474 s | 1.334 s | 1.647 s | Thai, voice_01, 32 steps |
| Original 3-GPU pool | warm | 7.458 s | 0.089 s | 6.169 s | Thai, voice_01, 32 steps |
| Expanded 9-GPU pool | cold tail | 165.169 s | 161.793 s | 2.364 s | Thai, voice_01, 32 steps |
| Expanded 9-GPU pool | warm | 3.148 s | 0.129 s | 1.339 s | Thai, voice_01, 32 steps |

The post-change cold run is the decisive release gate: it remained healthy after crossing
120 seconds and completed with the correct worker contract. GPU diversity reduces
capacity concentration but cannot guarantee cold-start latency; durable polling is the
primary fix.

Both benchmark sequences ended with the worker recorded as `EXITED`, preserving
scale-to-zero.

## Verification

- `npm run verify:omnivoice` — passed, including a temporary-DB runtime that holds a
  queued job with 180,001 ms provider delay, resumes the same endpoint/job, and never
  calls cross-provider fallback.
- `scripts/verify-mcp-videojob.ts` — 42/42 checks passed, including park/reclaim,
  worker-restart recovery, and stale-checkpoint clearing.
- `npm run verify:ai-studio` — passed.
- `npm run verify:mcp-parity` — passed.
- `npx tsc --noEmit` — passed.
- Local `npm run build` — passed and included `/api/ai-studio/voices`.

## Deployment and rollback

The source commit was pushed to `main` and pulled on the production host. Repeated
production build attempts were stopped before `.next` swap because new customer render
work entered during the build. The first overlapping build/render exposed excessive
combined memory pressure; all later attempts were terminated as soon as a new RenderJob
appeared. An inherited low-memory retry from the first deploy script was found and stopped
together with its parent before a single clean build was attempted. Process-tree checks
confirmed that no deploy/build process remained afterward.

The old `.next` remained live throughout, health stayed HTTP 200, PM2 was not restarted,
and customer renders kept progressing. The durable-code PM2 rollout must therefore be
recorded separately after an operationally quiet deployment window succeeds.

Rollback controls:

1. Application: revert `4981c4c`, deploy with empty queues.
2. Legacy wait budget: restore the environment backup above and restart `ai-content`.
3. RunPod capacity: PATCH endpoint `txvrmtzfc8au3b` back to the original three-GPU list.

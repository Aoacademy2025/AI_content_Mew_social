# OmniVoice / Hero AI Voice RunPod audit — 2026-07-22

## Staging follow-up — 2026-07-23

Mew approved keeping Hero AI Voice as the highlighted recommended voice provider while
retaining Gemini and ElevenLabs as explicit alternatives. The Video Editor implementation
now leads with `Hero AI Voice`, labels it `แนะนำ · 48 เสียง`, and removes RunPod
infrastructure wording from customer-facing selection. The selected provider is still a
user choice; the application does not silently switch voice providers.

RunPod staging was changed from a five-second idle timeout to 60 seconds with
`workersMin=0`, `workersMax=1`, FlashBoot enabled, and the same A4000/A4500/RTX 4000 Ada
fallback list. Production endpoint `xbn9a1ynd6byeu` was not changed.

The stable v2 endpoint `hvzgdz0h1mdkcj` produced the following measured sequence:

| State | Wall time | RunPod delay | Execution |
| --- | ---: | ---: | ---: |
| First job after the configuration change | 66.30 s | 62.12 s | 0.87 s |
| Immediate warm job | 3.40 s | 0.10 s | 0.57 s |
| FlashBoot after the 60-second worker shutdown | 3.20 s | 1.01 s | 0.50 s |

This separates fresh deployment/capacity latency from ordinary scale-to-zero reuse. The
normal post-FlashBoot path is now measured in seconds; a brand-new endpoint/image still
has a materially slower first launch.

An immutable quality-floor candidate was pushed as
`ghcr.io/mewic/heroai-omnivoice:staging-20260723-v3-th-qualityfloor-374971df4b1b`
(registry index digest
`sha256:545428cfa1d6de69e2b3c2ddcac451fb31511cfa79a9043a40481f3e57b88ee9`). It is attached
only to template `9yk7mb3i95` and endpoint `cmqzzcfxsinwtd`. The worker retains the
eight-step baseline but raises voices 32 and 33 to 16 steps and returns the effective
step count for telemetry.

The new endpoint's first job took 246.60 seconds, of which 243.60 seconds was RunPod
delay; warm jobs completed in 3.29–3.35 seconds. Both `voice_32` and `voice_33` confirmed
an effective 16 steps. After the worker shut down, FlashBoot completed the next job in
5.32 seconds. Local Whisper classified both outputs as Thai and found them intelligible,
although `voice_32` still made a larger substitution around `การทดสอบ` than `voice_33`.
They remain subject to human listening approval.

The two benchmark sequences reduced the prepaid RunPod balance by approximately $0.024
in total; the account returned to $0/hour after scale-down.

### Final 48-voice staging candidate

The exact `young adult, male, very high pitch` Voice Design combination was reproduced
with four independent seeds and always collapsed to the English phrase `Thank you.`.
Following the model's documented guidance for failing attribute combinations, the
recovery removed only the age constraint and retained `male, very high pitch`. Four
additional seeds showed that three were still unusable; seed 4424 produced the requested
Thai reference exactly, with a 4.88-second duration and an estimated median fundamental
frequency of about 407 Hz. The selected reference SHA-256 is
`ac84a04cd2b7fc34cb573c2231c4453f8983659fc67449def41e37c365e3d72b`.

The resulting immutable clone image is
`ghcr.io/mewic/heroai-omnivoice:staging-20260723-v5-48-th-qualityfloor-voice44-ac84a04c`
(registry index digest
`sha256:7b64af340e520fb89ebe43a9858a740aaee8e86c28d5b771c69cd32037ac1bf9`).
It is attached only to staging template `la4az7i8ay` and endpoint `zcqf6wc1e848v0`.
Production endpoint `xbn9a1ynd6byeu` remains unchanged.

The v5 endpoint loaded the complete 48-voice manifest and measured:

| Gate | Wall time | RunPod delay | Execution | Result |
| --- | ---: | ---: | ---: | --- |
| Fresh v5 image | 23.57 s | 21.13 s | 0.93 s | Thai, 8 steps |
| Immediate warm | 3.26 s | 0.09 s | 0.82 s | Thai, 8 steps |
| `voice_32` quality floor | 3.26 s | 0.10 s | 0.98 s | Thai, 16 steps |
| `voice_33` quality floor | 3.35 s | 0.09 s | 0.84 s | Thai, 16 steps |
| Recovered `voice_44` clone | 5.58 s | 1.60 s | 0.82 s | 5.84-second WAV, Thai CER 0% |

The initial three-GPU fallback pool still reproduced a 145.66-second throttled resume.
After expanding the staging fallback pool to compatible RTX 2000 Ada, L4, RTX 3090,
A40, A6000 and RTX 4090 capacity in addition to the original three choices, two
consecutive jobs submitted only after RunPod recorded the worker as `EXITED` completed
in 5.49 and 3.11 seconds. The endpoint remains `workersMin=0`, `workersMax=1`,
`idleTimeout=60`, and FlashBoot enabled.

The complete catalog now passes its automated staging gates. The current release decision
is still **no production cutover** until Mew performs the final human listening review;
no replacement recording or code blocker remains.

The design-recovery and v5 validation runs spent approximately `$0.0883` from the prepaid
RunPod balance in total (`$7.9132169246` to `$7.8249221449`). The account returned to
`$0/hour`, both recovery and final workers recorded `EXITED`, and the temporary recovery
endpoint/template (`leny2tkxy7354y` / `5jxz40zbln`) were deleted after promotion. The
recovery image remains immutable in the registry so the process is reproducible.

The final 48 reference assets and canonical manifest were archived separately at
`/root/heroai-voice-assets-backups/heroai-omnivoice-v5-refs-20260723.tar.gz` with mode
`0600`. Local and remote SHA-256 both equal
`0fb60b3bad37fefca71404bd11739e454c7f6dad099ca496756adf98206797d2`; the older v2
archive was retained unchanged for forensic history.

## Approved implementation update

At 2026-07-22 21:23 ICT, after Mew's explicit approval, production
`OMNIVOICE_NUM_STEP` was raised from 4 to 8 and only the `ai-content` process was
restarted. Both render queues were empty before the change; the public health
probe returned HTTP 200 after restart and the persisted runtime setting reports
8. The prior `.env` was retained at
`/root/heroai-env-backups/ai-content.env.pre-omnivoice-step8-20260722T142338Z`.

The 48-voice RunPod v2 image was built and pushed separately and is not considered
released until its reference-audio, Thai ASR, cold/warm endpoint and catalog
parity gates pass. The original three-voice endpoint remains the production and
rollback target.

The immutable release candidate is
`ghcr.io/mewic/heroai-omnivoice:staging-20260722-v2-48-th8-346bb75-c5fdb5c`
(registry index digest
`sha256:1b70594972c28e81d8cc08d45c7ec9622cf95056dadef9039a98b4871542f702`).
It is attached only to staging template `s3x8bt3u8u` and endpoint
`hvzgdz0h1mdkcj`; production endpoint `xbn9a1ynd6byeu` was not changed.

The candidate contains one canonical 48-item manifest, 48 mono 24 kHz reference
WAVs, `language=th`, and an eight-step default. Its first real endpoint canary
completed with worker version `heroai-omnivoice-runpod-v2`, confirmed `th`, and
produced a valid 3.58-second WAV. Local Whisper screening measured 2 edits over
70 normalized Thai characters (CER 2.86%). RunPod spent 839.54 seconds waiting
for a host and 1.252 seconds executing the request. A later representative job
spent 1,569.40 seconds queued and 0.747 seconds executing. Once the worker was
warm, jobs waited about 0.1 seconds and executed in roughly 0.7–1.6 seconds.
RunPod reported throttled capacity during the long queues, with zero unhealthy
workers and zero provider-failed jobs.

All 48 v2-candidate reference assets and the manifest were archived on the production
host under `/root/heroai-voice-assets-backups/` with mode `0600`; archive SHA-256
is `e7efb757e769815a9f1e7187fc29608fe781b75ae562c9b30063f098d257c26d`.

### V2 audio release-gate result

The exact v2 image generated the canonical Thai preview for all 48 voice IDs.
Forty-seven outputs passed the structural and 2–15 second duration gate, with
durations from 3.45 to 7.08 seconds. `voice_44` repeatedly produced a
49.69–49.86 second output for the same short sentence and was rejected locally.

Whisper screening of the 47 duration-valid eight-step outputs found:

| Gate | Result |
| --- | ---: |
| Exact normalized transcript | 35/47 |
| CER at most 5% | 40/47 |
| CER at most 10% | 45/47 |
| Mean CER | 1.92% |
| CER above 10% | `voice_32` 25.00%, `voice_33` 15.38% |

At 16 steps, `voice_32` improved to 3.85% CER and `voice_33` to 1.92%.
`voice_44` remained about 50 seconds and unintelligible at both 8 and 16 steps.
Three additional English reference attempts from the original voice-design
worker also collapsed to the same two-word output, `Thank you.`, regardless of
the requested sentence. This isolates `voice_44` to an unusable source profile/
reference, not the RunPod Thai-language setting.

The retained `voice_44` reference at that stage was then checked at every available
source. The local preview, the RunPod service reference, and the production-host backup
archive were byte-identical (SHA-256
`161fd58c3866148a114cc6490028225919112d6730282b72bf906ff5db3ce2c9`). The
manifest says that the six-second recording contains the Japanese transcript
`ばいばい`, but local Whisper instead detected a pathological Thai phrase with one
word repeating for most of the file. No older or alternate `voice_44` recording was
present in the production backup locations. Rebuilding or restarting that endpoint
could not repair the asset; the final staging recovery and replacement are recorded
above.

**V2 release decision at that time: no production cutover.** The v2 image was a staged
candidate, not a 48-voice production release. Production remains on the original
three-voice endpoint with the approved eight-step application containment. A
usable, consented 3–10 second recording plus exact transcript is required for
`voice_44`; the 32/33 policy must use 16 steps or new references; and human
listening must approve the remaining voices before the endpoint is switched.

## Executive finding

Two separate regressions are present, and both reproduce from the deployed production
configuration.

1. **The 48-voice catalog was not migrated to RunPod.** The retired Hostinger worker is
   still healthy and returns `voice_01` through `voice_48`, but the RunPod image, application
   catalog, static previews, and regression test intentionally contain only `voice_01`
   through `voice_03`.
2. **Thai generation quality is being traded away by the four-step canary setting.** All
   five production RunPod voice jobs completed technically, but ASR-backcheck measured
   Thai character error rates of 14.3–21.0%. Re-running the same 1,033-character production
   script through the same worker at eight steps reduced Thai CER from 18.3% to 4.3%.

The production application, database, and Hostinger worker were inspected read-only. The
quality A/B submitted four successful synthesis jobs (one short 16-step, one short 8-step,
and two long-script 8-step chunks) plus one contract-rejected over-800-character probe to
the existing RunPod staging endpoint. No feature flag, RunPod template, endpoint, image,
application file, database row, or service process was changed during this audit.

## Deployed state

Checked against production commit `6398411` and the RunPod control plane.

| Layer | Deployed state |
| --- | --- |
| Production application | `OMNIVOICE_ENABLED=1`, `NEXT_PUBLIC_OMNIVOICE_ENABLED=1` |
| Selected backend | `OMNIVOICE_BACKEND=runpod` |
| RunPod endpoint | `xbn9a1ynd6byeu` |
| RunPod template | `u7pyxacp1a` |
| Worker image | `ghcr.io/mewic/heroai-omnivoice:staging-20260721-346bb75-c5fdb5c` |
| Image digest recorded by the rollout | `sha256:decd00cc9ade9bc34b09eec3a6036e80b416f3f2c3a9530d4cfeca7e0ab7b1e2` |
| RunPod scaling | Flex, min 0, max 1, idle timeout 5 seconds |
| Application setting at audit start | `OMNIVOICE_NUM_STEP=4`, max chunk 700 characters |
| Application setting after approved P0 | `OMNIVOICE_NUM_STEP=8`, max chunk 700 characters |
| Hostinger worker retained | Healthy, ready, version 1.1, `num_voices=48` |

At audit start there was one OmniVoice endpoint/template in the inspected RunPod
account. The approved follow-up created the separate v2 staging resources recorded
above; the production v1 template has no `TTS_VOICE_IDS` override, so its image
default remains authoritative.

## Why Video Editor shows only three voices

This is not a picker rendering limit. `HeroVoicePicker` already supports search, scrolling,
and an arbitrary array length. The reduction occurs before the picker:

- `services/omnivoice-runpod/Dockerfile` bakes only `voice_01.wav`, `voice_02.wav`, and
  `voice_03.wav`, and sets `TTS_VOICE_IDS=voice_01,voice_02,voice_03`.
- `services/omnivoice-runpod/handler.py` loads only those IDs into reusable clone prompts.
- `src/lib/hero-voice-preview.ts` defines a three-item server-owned catalog.
- `GET /api/omnivoice/voices` returns that static catalog whenever backend is RunPod; it no
  longer requests the 48-item catalog from the Hostinger worker.
- `GET /api/omnivoice/preview/[voiceId]` rejects every RunPod voice not present in the same
  three-item allowlist.
- `scripts/verify-hero-voice-ui.ts` explicitly asserts that the RunPod preview allowlist has
  length 3. The current regression suite therefore protects the reduced catalog.

The exact symptom has a deterministic red-capable reproduction:

```text
npx tsx -e '<assert RUNPOD_HERO_VOICES.length === 48>'
AssertionError: Video Editor RunPod catalog must expose 48 voices, got 3
```

By contrast, the current repository verification passes because it expects three:

```text
npm run verify:hero-voice-ui
Hero Voice UI regression checks passed.
```

## How the RunPod voices differ from Mew's original 48

| Property | Original Hostinger worker | Current RunPod worker |
| --- | --- | --- |
| Catalog size | 48 IDs | 3 IDs |
| Catalog source | Live `/voices` response with 48 `desc`/`instruct` profiles | Static application allowlist |
| Available IDs | `voice_01`–`voice_48` | `voice_01`–`voice_03` |
| Prompt contract exposed by catalog | Voice-design metadata such as gender, age, pitch, whisper, and accent | Reusable voice-clone prompts made from three Thai reference WAVs |
| Preview source | Existing cached worker previews | New static previews generated by RunPod at four steps |
| Thai language hint | Not observable through the retired worker API | Not supplied; model receives language-agnostic `None` |
| Diffusion steps | Hostinger canary used 4 for CPU capacity | RunPod still uses 4 despite GPU capacity |

The first three RunPod clone references came from the original managed worker. Their
manifest transcripts match the corresponding Hostinger previews exactly. The current UI
previews, however, are newly generated four-step clone outputs, so they are not the same
audio behavior as the original voice-design profiles.

### Automated screening of the 48 retained previews

All 48 cached Hostinger preview files were fetched read-only. They have 48 unique hashes,
so the catalog does not point every ID to one audio file. Durations range from 1.74 to
4.43 seconds (average 2.62 seconds).

Because ground-truth preview transcripts are not exposed for IDs 04–48, the following is
a language/intelligibility screening, not a final human MOS score:

- **34 mostly intelligible Thai previews:** 01–15, 17–26, 32–37, 45–47.
- **6 English previews:** 16, 28, 31, 41, 43, 48. Several are accent profiles, so English
  may be deliberate, but they do not prove Thai readiness.
- **6 mixed-language or severely garbled previews:** 29, 30, 38, 39, 40, 42.
- **2 degraded/needs human review:** 27 and 44.

Restoring all 48 labels without a Thai listening gate would therefore restore catalog
coverage but not guarantee 48 production-quality Thai voices.

## Thai quality diagnosis

The pinned upstream model does support Thai. Its official language table lists Thai ID
`th` and substantial Thai training data. The pinned source also states that specifying the
language performs slightly better than language-agnostic mode. More importantly, upstream
generation defaults to 32 diffusion steps and documents 16 as the faster alternative;
higher step counts improve quality.

Primary sources:

- [OmniVoice repository and Python API](https://github.com/k2-fsa/OmniVoice)
- [Supported languages](https://github.com/k2-fsa/OmniVoice/blob/master/docs/languages.md)
- [Generation parameters](https://github.com/k2-fsa/OmniVoice/blob/master/docs/generation-parameters.md)

The HERO AI path diverges from those defaults in three places:

1. The RunPod worker defaults to 4 steps and clamps requests to at most 16.
2. The application clamps `OMNIVOICE_NUM_STEP` to at most 8, so production cannot request
   16 or 32 without a code change.
3. The worker calls `MODEL.generate(...)` without `language="th"`. At the pinned source
   revision this emits the language token as `None`.

### Existing RunPod output backcheck

Two independent local Whisper models were used for the short canonical checks. The larger
model was then used to backcheck the five production outputs against their stored source
scripts. Scripts were processed locally for comparison and were not included in this
report.

| Production result | Voice | Script chars | App chunks | Audio | Thai CER | Technical status |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Short run A | 02 | 158 | 158 | 12.33 s | 14.3% | done |
| Short run B | 02 | 158 | 158 | 12.53 s | 14.3% | done |
| Short run C | 01 | 172 | 172 | 10.19 s | 16.9% | done |
| Long run A | 03 | 1,033 | 536 + 497 | 78.55 s | 18.3% | done |
| Long run B | 03 | 1,031 | 552 + 479 | 79.34 s | 21.0% | done |

All five jobs were counted as successful because the application validates only the WAV
container/layout and upstream status. It has no pronunciation or transcript-fidelity gate.

### Step-count A/B

The tests used the current immutable worker image and the same voice/text on RunPod.

| Test | Steps | Result | Worker generation | Provider execution | Queue/cold delay |
| --- | ---: | --- | ---: | ---: | ---: |
| Canonical `voice_02` preview already deployed | 4 | Both ASR models found material Thai errors | not retained | not retained | not retained |
| Same canonical text | 8 | Exact in large ASR; only `วิดีโอ/วีดีโอ` spelling difference in medium ASR | 0.343 s | 0.616 s | 1.155 s warm |
| Same canonical text | 16 | Exact in large ASR; only `วิดีโอ/วีดีโอ` spelling difference in medium ASR | 0.934 s | 1.333 s | 36.265 s cold |
| Same 1,033-character production script | 4 | Thai CER 18.3% | existing production run | existing production run | existing production run |
| Same script and same 536 + 497 chunks | 8 | **Thai CER 4.3%** | 1.818 + 1.332 s | 2.239 + 1.710 s | 239.386 s cold, then 0.099 s warm |

For the long production fixture, eight steps reduced measured Thai errors by approximately
76.5% while preserving essentially the same output duration (78.55 versus 78.74 seconds).
The dominant operational latency was cold queue/startup, not inference.

### Other contributing factors

- The smoke phrase was most inaccurate around the English product/provider names. The
  current OmniVoice path sends exact chunk text and does not apply a Thai pronunciation
  lexicon or provider-specific loanword normalization.
- Voice design is not a safe route to assume for all 48 Thai profiles. Upstream documents
  voice design as trained on Chinese and English and potentially unstable in other
  languages; voice cloning is the more stable mode.
- Four steps were an explicit Hostinger CPU canary compromise. Carrying that same compromise
  to the GPU worker preserved the capacity setting after its original reason changed.

## Root causes and confidence

| Finding | Confidence | Evidence |
| --- | --- | --- |
| Three voices are an intentional migration subset, not a frontend bug | Confirmed | Docker image, handler default, static app catalog, preview allowlist, regression assertion, RunPod template |
| Four inference steps are the main Thai quality regression | Confirmed | Same model/voice/text A/B at 4, 8, and 16 steps; production-script A/B at 4 and 8 |
| Missing `language="th"` leaves quality on the table | High, not yet A/B tested | Pinned upstream source and current handler call |
| Long input/chunking makes the four-step error more visible | Confirmed for observed jobs | Production CER rises from 14.3–16.9% short to 18.3–21.0% long |
| English names/loanwords are a separate pronunciation weakness | Confirmed in smoke sample | Errors concentrated around English product/provider names |
| All original 48 are ready for Thai production | Rejected | Automated preview screening found English and mixed/garbled groups |

## Recommended recovery sequence

### P0 — immediate containment

1. Raise production `OMNIVOICE_NUM_STEP` from 4 to 8 and restart only the application.
   Eight is already accepted by both the app and deployed worker, and the production-script
   A/B supports it. Keep the feature on the internal allowlist until human listening passes.
2. Do not advertise or expose the current RunPod catalog as the completed 48-voice product.
   Label it as a three-voice canary until catalog parity is restored.
3. Add an internal Thai fixture check to release approval so a technically valid WAV cannot
   be mistaken for a usable voice.

P0 item 1 was applied after the audit with explicit approval, as recorded above.
The remaining items stay release gates for the separate v2 rollout.

### P1 — correct RunPod voice migration

1. Build a new immutable worker image and manifest rather than mutating the current staging
   tag/template in place.
2. Curate consented 3–10 second Thai reference audio plus exact Thai transcript for every
   voice intended for Thai cloning. Do not synthesize all 48 solely from English accent
   `instruct` strings and assume Thai stability.
3. Pass `language="th"` to `MODEL.generate(...)` and A/B it against language-agnostic mode.
4. Decide the production step policy from benchmarks: retain 8 only if it passes human and
   ASR gates; otherwise allow 16 through the application clamp. Do not jump to 32 without a
   cost/latency comparison.
5. Generate previews from the exact production image, language, step, and speed settings.
6. Make one canonical manifest drive image assets, served IDs, app metadata, and preview
   files. Assert full ID parity and the intended count in CI.
7. Keep the picker unchanged unless human QA calls for grouping/filter improvements; it is
   already structurally capable of 48 entries.

### P2 — quality and observability

1. Create a Thai benchmark suite covering pure Thai, numerals/dates/currency, English
   loanwords, names, short copy, and 500–700 character chunks. Run at least three generations
   per voice because generation can vary.
2. Record worker version, requested step count, language hint, voice manifest version, and
   per-chunk provider job ID in internal telemetry.
3. Set release thresholds for Thai CER, human pronunciation, prosody, timbre consistency,
   cross-chunk consistency, and silence artifacts. ASR is a screening tool, not the sole
   quality judge.
4. Add provider-specific Thai pronunciation normalization for known English product terms
   after the base model configuration is corrected.
5. Investigate the 239-second cold queue before broad rollout. Higher quality steps add
   little measured execution time compared with current cold-start/availability variance.

## Verification completed

```text
npm run verify:hero-voice-ui     PASS (protects exactly ordered voice_01–voice_48)
npm run verify:omnivoice         PASS
npx tsc --noEmit                 PASS
npm run build                    PASS
(cd services/omnivoice-runpod && python3 -m unittest test_contract.py)  PASS (6 tests)
```

The suite now proves static catalog parity and the v2 Thai/step/image contract. It
does not replace ASR screening or human listening; those remain audio release gates.

# Hero AI Voice redesign and staging release audit

Date: 2026-07-23 (Asia/Bangkok)

> Follow-up: the v8 staging candidate below was superseded by the lazy-load,
> slim v9 staging candidate documented in
> `docs/audits/2026-07-23-hero-voice-v9-cold-start-audit.md`. This historical
> report is retained for the catalog redesign evidence.

## Outcome

The redesigned 48-voice Hero AI Voice catalog passes the automated staging
release gates with **0 FAIL findings**. Hero AI Voice remains restricted by the
application allowlist. Production endpoint `xbn9a1ynd6byeu` was not modified,
and the new catalog was not opened to non-allowlisted users.

The final candidate is staging-only:

| Item | Value |
| --- | --- |
| Image | `ghcr.io/mewic/heroai-omnivoice:staging-20260723-v8-48-unique-th-amd64-fa4c2ee6` |
| Registry digest | `sha256:175fdf7fff6acd21d0e1e4717cf9a850218f5e037e44afa08f92cdc0e38be9bd` |
| RunPod template | `tzkr5atq74` |
| RunPod endpoint | `xl6hhpijenyj3e` |
| Scale policy | min 0, max 1, idle timeout 60 seconds, FlashBoot enabled |

## Baseline and redesign

The reproducible baseline audit found 18 FAIL findings and 35 REVIEW findings.
Confirmed defects included duplicate speaker clusters, pitch/profile mismatches,
and Thai ASR failures in both reference and clone-preview audio.

Fifteen references were redesigned and selected through an exact whole-catalog
constraint search:

`voice_02`, `voice_04`, `voice_09`, `voice_15`, `voice_18`, `voice_23`,
`voice_29`, `voice_31`, `voice_32`, `voice_33`, `voice_34`, `voice_36`,
`voice_37`, `voice_41`, and `voice_45`.

The selected reference set has a maximum Resemblyzer similarity of 0.897715
against a hard limit of 0.90, and a maximum ECAPA similarity of 0.731744 against
a hard limit of 0.75. Selection seeds and reference hashes are pinned in
`services/omnivoice-runpod/assets/voices/redesign-selection.json`.

Several collapsed personas were replaced rather than relabeled inaccurately:

- `voice_02`: female Japanese-accent profile instead of a generic female profile
  that repeatedly collapsed into existing voices.
- `voice_23`: young-adult male, high pitch instead of a female profile that
  collapsed into `voice_06`.
- `voice_34`: middle-aged female, very low pitch instead of a teenager profile
  whose generated pitch did not match the label.
- `voice_37`: elderly male, high pitch instead of a child profile that collapsed
  into `voice_07`.

## Final automated results

The final audit processed all 48 references and all 48 RunPod clone previews.

| Gate | Result |
| --- | --- |
| Catalog completeness | 48/48 |
| WAV structure and duration | PASS |
| Clipping | PASS |
| Explicit pitch/whisper profile | PASS |
| Reference-to-preview clone consistency | PASS |
| Two-model duplicate consensus | PASS; no consensus duplicate |
| Thai Whisper ASR, fail threshold greater than 10% CER | PASS; maximum preview CER 9.62% |
| Total FAIL findings | **0** |
| REVIEW findings | 71 |

The REVIEW set is intentionally retained. Most speaker reviews are triggered by
one embedding model only and did not meet the two-model duplicate consensus gate.
Thai ASR reviews remain for `voice_03`, `voice_09`, `voice_17`, `voice_20`, and
`voice_33`. `voice_33` (female whisper) is closest to the fail boundary and must
be prioritized in human listening.

The machine-readable and detailed per-voice reports are:

- `docs/audits/2026-07-23-hero-voice-catalog-quality-audit.json`
- `docs/audits/2026-07-23-hero-voice-catalog-quality-audit.md`

## Thai quality floors

Initial v7 previews failed Thai ASR for `voice_06`, `voice_26`, and `voice_33`.
Three independent 16-step samples per voice then produced:

| Voice | CER across three samples |
| --- | --- |
| `voice_06` | 0.00%, 0.00%, 3.85% |
| `voice_26` | 0.00%, 0.00%, 5.77% |
| `voice_33` | 7.69%, 9.62%, 7.69% |

The v8 worker therefore enforces 16 steps for `voice_06`, `voice_26`,
`voice_32`, and `voice_33`; other voices keep the 8-step baseline. A release
probe requested 8 steps for all four and received 16 steps from the worker for
every request. Their final preview CER values were 1.92%, 1.92%, 3.85%, and
9.62%, respectively.

## Runtime observations

The v8 scale-to-zero cold job spent 318.306 seconds in RunPod delay/startup and
1.110 seconds executing. The immediately following warm job spent 0.098 seconds
in delay and 0.887 seconds executing. The worker rate reported by RunPod was
$0.25/hour; treating the entire cold delay as billable at that rate gives a
conservative compute estimate of about $0.022 for the cold job, while one warm
inference is roughly $0.00006 before platform-specific billing rules.

This confirms that synthesis is fast once warm, but initializing the model and
48 clone prompts is still measured in minutes. The staging endpoint uses
workersMin=0. A final RunPod REST check reported the only retained worker with
`desiredStatus=EXITED`, so staging does not intentionally hold an always-on GPU.

## Packaging incident found during audit

The first v6 build was published with an ARM64 platform descriptor and could not
start on RunPod GPU hosts. Its queued job was cancelled and the broken staging
endpoint/template were deleted. v7 and v8 were rebuilt with an explicit
`linux/amd64` platform and their remote manifests were verified before use.
Production was unaffected.

## Rebuild custody

The 48 audited reference WAV files are embedded in the immutable v8 image and
their selected hashes are pinned, but the source WAV files remain intentionally
ignored by Git under `services/omnivoice-runpod/assets/voices/.gitignore`.
Cloning the repository alone is therefore not sufficient to rebuild the image.
An operator must restore the audited `voice_01.wav` through `voice_48.wav` files
to that directory first; the Docker build then validates all 48 assets before it
can succeed. The complete set remains present in this workspace.

## Release decision

Automated catalog quality is ready for an allowlisted listening canary, but this
audit does **not** authorize global access or production endpoint cutover.
Subjective age, warmth, gender presentation, and accent labels still require
human listening. The next operational decision is whether to accept the current
five-minute scale-to-zero startup, keep a standby session during expected usage,
or add a reusable model/voice-prompt cache before wider use.

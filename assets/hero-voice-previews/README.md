# Hero AI Voice previews

Authenticated, static previews for the fixed RunPod OmniVoice catalog. They are
generated once so the Video Editor can play a sample without cold-starting a GPU,
spending package minutes, or submitting a paid job on every click.

Regenerate deliberately with:

```bash
RUNPOD_OMNIVOICE_ENDPOINT_ID=<endpoint> npm run generate:hero-voice-previews -- --apply --force
```

Generation settings: `language=th`, `num_step=8`, `speed=1`, 24 kHz mono PCM WAV.
The audited worker raises `voice_06`, `voice_26`, `voice_32`, and `voice_33` to
`num_step=16` automatically.
The canonical 48-voice manifest lives at
`services/omnivoice-runpod/assets/voices/voices.json`; both the worker image and
application catalog consume it so their IDs cannot drift.

Release-candidate generation on 2026-07-22 saved valid v2 outputs for 47 IDs.
The original `voice_44` reference was rejected because a short Thai fixture expanded
to about 50 seconds and was unintelligible. On 2026-07-23 it was replaced on staging
with a bounded Voice Design recovery that retained the `male, very high pitch`
profile. Its final clone preview is 5.84 seconds, 24 kHz mono PCM, and matched the
canonical Thai fixture exactly in local Whisper screening (CER 0%).

On 2026-07-23, the v8 amd64 staging candidate regenerated the audited catalog.
Fifteen damaged, duplicate, or profile-mismatched references were replaced, and
the final 48 references plus 48 previews passed the enforced structural, pitch,
Thai ASR, clone-consistency, and two-model speaker-consensus gates with zero FAIL
findings. Human listening remains required before any production cutover.

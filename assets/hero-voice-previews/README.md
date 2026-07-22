# Hero AI Voice previews

Authenticated, static previews for the fixed RunPod OmniVoice catalog. They are
generated once so the Video Editor can play a sample without cold-starting a GPU,
spending package minutes, or submitting a paid job on every click.

Regenerate deliberately with:

```bash
RUNPOD_OMNIVOICE_ENDPOINT_ID=<endpoint> npm run generate:hero-voice-previews -- --apply --force
```

Generation settings: `num_step=4`, `speed=1`, 24 kHz mono PCM WAV. The canonical
Thai text for each voice is defined in `src/lib/hero-voice-preview.ts`.

Initial generation on 2026-07-22:

- `voice_01.wav`: RunPod job `56645698-1f76-404f-9fdf-5b718e75e596-e2`
- `voice_02.wav`: RunPod job `63380351-f880-48f1-90ab-6b5c0c188ab1-e2`
- `voice_03.wav`: RunPod job `d0621a74-1a80-4c0c-8d68-15f950ceb6cd-e2`

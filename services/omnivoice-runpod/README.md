# Hero AI Voice v2

Production RunPod Serverless worker for HERO AI Creator Studio. The voice engine and
48-voice catalog come from the completed `Hero-Voice-Ai` repository; the surrounding
contract is adapted to the app's durable RunPod job system.

## Ownership seam

The worker owns synthesis only: stock TTS, voice design, mixed Thai/English generation,
and best-of-N one-shot voice cloning. The Next.js application remains responsible for
Clerk authentication, plan access, minute reservations, retries, cancellation, final WAV
assembly, captions, telemetry, storage, and refunds.

## RunPod contract

Stock TTS:

```json
{
  "input": {
    "contract_version": 2,
    "mode": "tts",
    "voice_id": "voice_01",
    "text": "ข้อความสำหรับสร้างเสียง",
    "speed": 1.0,
    "num_step": 32,
    "mixed_language": true
  }
}
```

One-shot cloning uses `mode: "clone"` with `ref_audio_b64`, `ref_text`, and `text`.
Reference audio is normalized to mono 24 kHz WAV and must be 3–15 seconds.

Successful output is a 24 kHz mono PCM WAV in `audio_base64` plus duration,
generation time, worker version, catalog version, language, and effective `num_step`.
Invalid requests raise a coded exception so RunPod marks the job failed instead of
returning a successful job containing an error object.

Limits:

- 800 text characters per RunPod job
- speed 0.3–3.0
- num_step 4–64; the application currently sends 32
- 8 MB decoded reference input
- 7 MB WAV output, below RunPod async payload limits after base64 overhead
- one active model generation per worker

## Verify and build

```bash
python3 -m unittest test_contract.py
docker build --platform linux/amd64 -t <registry>/hero-voice-ai:v2 .
```

The image pins the PyTorch parent image, OmniVoice source commit, model revision, and
model checksum. Build with an immutable tag and deploy to a new staging endpoint before
changing `RUNPOD_OMNIVOICE_ENDPOINT_ID` in the application.

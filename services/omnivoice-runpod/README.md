# HERO AI OmniVoice Runpod worker

Queue-based Runpod Serverless worker derived from the audited KVM worker in
`/opt/omnivoice`. It performs audio inference only; the HERO AI application remains
responsible for quotas, chunking, captions, rendering and final media retention.

## Pinned supply chain

- Base image: PyTorch 2.4.1, CUDA 12.1, cuDNN 9, pinned by digest.
- OmniVoice source: `k2-fsa/OmniVoice` commit
  `346bb75330980a236540d61a0808d00767c0973b`.
- OmniVoice model: Hugging Face revision
  `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`.
- Model `model.safetensors` SHA-256:
  `730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa`.
- Source and model metadata declare Apache-2.0.

The 48 stock voice WAV files are intentionally not committed. Before building, place the
audited `voice_01.wav` through `voice_48.wav` reference files in `assets/voices/`.
`voices.json` is the canonical worker/application catalog, and the Docker build fails if
its ordered IDs are not exactly `voice_01` through `voice_48` or any reference is absent.

## Contract

Submit one application-generated chunk per Runpod job:

```json
{
  "input": {
    "operation": "tts",
    "voice_id": "voice_01",
    "text": "ข้อความสำหรับสร้างเสียง",
    "num_step": 8,
    "speed": 1.0
  }
}
```

Successful output preserves the existing application fields except that it does not echo
the input text:

```json
{
  "voice_id": "voice_01",
  "audio_base64": "UklGR...",
  "format": "wav",
  "sample_rate": 24000,
  "duration": 4.2,
  "generation_time": 1.1,
  "worker_version": "heroai-omnivoice-runpod-v4-lazy-prompt-cache",
  "language": "th",
  "num_step": 8
}
```

The worker pins Thai generation with `language=th`, defaults to eight diffusion steps,
and applies the audited 16-step quality floor to `voice_06`, `voice_26`, `voice_32`, and
`voice_33`. The model loads at worker startup, while each voice-clone prompt is created
only on that voice's first request and then reused for the lifetime of the worker. It accepts
at most 800 characters. Raw WAV output is capped at 7 MB so the base64 JSON
remains below Runpod's 10 MB async payload limit. The worker never logs text or audio.

## Verify and build

```bash
python3 -m unittest test_contract.py
docker build --platform linux/amd64 -f Dockerfile.v3 -t <registry>/heroai-omnivoice:staging .
```

`Dockerfile.v3` and the full-source `Dockerfile` create the runtime user before
downloading the model, preventing a later recursive ownership change from
duplicating the multi-gigabyte model layer. `Dockerfile.v2` remains only as the
audited v8 rollback path that inherits the original model/dependency image.

Push the immutable image tag, create a Runpod Serverless template from it, then create a
queue endpoint with Flex workers, `workersMin=0`, `workersMax=1`, FlashBoot enabled and a
fallback pool of compatible 16–48 GB GPUs. The current low-volume staging baseline uses
`idleTimeout=60` so back-to-back chunks stay warm while the worker still scales to zero
between sessions. A narrow A4000/A4500-only pool reproduced capacity throttling; the
audited staging pool also includes RTX 2000 Ada, L4, RTX 3090, A40, A6000 and RTX 4090.
Do not enable the Video Editor provider until a real cold/warm benchmark passes.

## Staging-only reference recovery

`Dockerfile.design-recovery` and `design_handler.py` are a bounded internal tool for
replacing a damaged stock reference. The handler accepts only supported Voice Design
attributes, 16–32 steps, a short text and a deterministic seed. It is not included in
`Dockerfile.v2`, must never receive application traffic, and must remain on a separate
`workersMin=0` staging endpoint. Promote only the reviewed WAV and its exact transcript
into the normal clone image.

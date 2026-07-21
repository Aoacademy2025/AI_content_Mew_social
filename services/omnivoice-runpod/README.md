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

The first three stock voice WAV files are intentionally not committed. Before building,
place the audited `voice_01.wav`, `voice_02.wav` and `voice_03.wav` files from the current
managed worker in `assets/voices/`. The Docker build fails if any required asset is absent.

## Contract

Submit one application-generated chunk per Runpod job:

```json
{
  "input": {
    "operation": "tts",
    "voice_id": "voice_01",
    "text": "ข้อความสำหรับสร้างเสียง",
    "num_step": 4,
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
  "worker_version": "heroai-omnivoice-runpod-v1"
}
```

The worker accepts at most 800 characters, while the application currently defaults to
450-character chunks. Raw WAV output is capped at 7 MB so the base64 JSON remains below
Runpod's 10 MB async payload limit. The worker never logs text or audio.

## Verify and build

```bash
python3 -m unittest test_contract.py
docker build --platform linux/amd64 -t <registry>/heroai-omnivoice:staging .
```

Push the immutable image tag, create a Runpod Serverless template from it, then create a
queue endpoint with Flex workers, `workersMin=0`, `workersMax=1`, FlashBoot enabled and one
16–24 GB GPU option. Do not enable the Video Editor provider until a real cold/warm
benchmark passes.

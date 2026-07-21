"""Runpod queue worker for the existing HERO AI OmniVoice model and stock voices."""

import base64
import io
import json
import logging
import os
from pathlib import Path
import threading
import time

import runpod
import soundfile as sf
import torch
from omnivoice import OmniVoice

from contract import InputError, parse_tts_input


VERSION = "heroai-omnivoice-runpod-v1"
SAMPLE_RATE = 24_000
MODEL_DIR = Path(os.environ.get("TTS_MODEL_DIR", "/app/model"))
VOICES_DIR = Path(os.environ.get("TTS_VOICES_DIR", "/app/voices"))
SERVED_VOICE_IDS = tuple(
    item.strip()
    for item in os.environ.get("TTS_VOICE_IDS", "voice_01,voice_02,voice_03").split(",")
    if item.strip()
)
MAX_TEXT_LENGTH = max(100, min(800, int(os.environ.get("TTS_MAX_TEXT_LENGTH", "800"))))
DEFAULT_NUM_STEP = max(4, min(16, int(os.environ.get("TTS_DEFAULT_NUM_STEP", "4"))))
MAX_WAV_BYTES = max(1_000_000, min(7_000_000, int(os.environ.get("TTS_MAX_WAV_BYTES", "7000000"))))

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("heroai-omnivoice")
GENERATE_LOCK = threading.Lock()


def load_runtime():
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is required")
    if not MODEL_DIR.is_dir():
        raise RuntimeError("TTS model directory is missing")
    manifest_path = VOICES_DIR / "voices.json"
    if not manifest_path.is_file():
        raise RuntimeError("voice manifest is missing")

    LOGGER.info("loading model version=%s device=cuda", VERSION)
    started = time.monotonic()
    model = OmniVoice.from_pretrained(
        str(MODEL_DIR),
        device_map="cuda",
        dtype=torch.float16,
        low_cpu_mem_usage=True,
    )
    model.eval()

    with manifest_path.open(encoding="utf-8") as source:
        manifest = {item["id"]: item for item in json.load(source)}
    voices = {}
    for voice_id in SERVED_VOICE_IDS:
        metadata = manifest.get(voice_id)
        if not metadata:
            raise RuntimeError(f"voice manifest is missing {voice_id}")
        reference_path = VOICES_DIR / metadata["ref_audio"]
        if not reference_path.is_file():
            raise RuntimeError(f"reference audio is missing for {voice_id}")
        voices[voice_id] = model.create_voice_clone_prompt(
            ref_audio=str(reference_path),
            ref_text=metadata["ref_text"],
        )
    LOGGER.info(
        "runtime ready version=%s voices=%s load_ms=%d",
        VERSION,
        ",".join(SERVED_VOICE_IDS),
        round((time.monotonic() - started) * 1000),
    )
    return model, voices


MODEL, VOICES = load_runtime()


def handler(job):
    job_id = str(job.get("id", "unknown"))
    try:
        request = parse_tts_input(job.get("input"), MAX_TEXT_LENGTH, DEFAULT_NUM_STEP)
    except InputError as error:
        LOGGER.warning("job rejected job_id=%s code=%s", job_id, error.code)
        raise ValueError(f"{error.code}: {error}") from error

    voice_prompt = VOICES.get(request.voice_id)
    if voice_prompt is None:
        raise ValueError("VOICE_NOT_SERVED: requested voice is unavailable")

    LOGGER.info(
        "generation started job_id=%s voice_id=%s chars=%d steps=%d",
        job_id,
        request.voice_id,
        len(request.text),
        request.num_step,
    )
    runpod.serverless.progress_update(job, "generating_audio")
    started = time.monotonic()
    with GENERATE_LOCK, torch.inference_mode():
        audio = MODEL.generate(
            text=request.text,
            voice_clone_prompt=voice_prompt,
            num_step=request.num_step,
            speed=request.speed,
        )[0]
    if isinstance(audio, torch.Tensor):
        audio = audio.detach().float().cpu().numpy()
    duration = len(audio) / SAMPLE_RATE
    buffer = io.BytesIO()
    sf.write(buffer, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    wav = buffer.getvalue()
    if not wav or len(wav) > MAX_WAV_BYTES:
        raise RuntimeError("OUTPUT_TOO_LARGE: reduce TTS_MAX_TEXT_LENGTH")

    generation_time = time.monotonic() - started
    LOGGER.info(
        "generation completed job_id=%s duration_ms=%d generation_ms=%d bytes=%d",
        job_id,
        round(duration * 1000),
        round(generation_time * 1000),
        len(wav),
    )
    return {
        "voice_id": request.voice_id,
        "audio_base64": base64.b64encode(wav).decode("ascii"),
        "format": "wav",
        "sample_rate": SAMPLE_RATE,
        "duration": round(duration, 3),
        "generation_time": round(generation_time, 3),
        "worker_version": VERSION,
    }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})

"""Runpod queue worker for the existing HERO AI OmniVoice model and stock voices."""

import base64
import io
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
import time

import runpod
import soundfile as sf
import torch
from omnivoice import OmniVoice

from contract import InputError, parse_tts_input
from prompt_cache import VoicePromptCache


VERSION = "heroai-omnivoice-runpod-v8-all-voices-32-temp-dynref"
SAMPLE_RATE = 24_000
MODEL_DIR = Path(os.environ.get("TTS_MODEL_DIR", "/app/model"))
VOICES_DIR = Path(os.environ.get("TTS_VOICES_DIR", "/app/voices"))
CONFIGURED_VOICE_IDS = tuple(
    item.strip()
    for item in os.environ.get("TTS_VOICE_IDS", "").split(",")
    if item.strip()
)
MAX_TEXT_LENGTH = max(100, min(800, int(os.environ.get("TTS_MAX_TEXT_LENGTH", "800"))))
DEFAULT_NUM_STEP = 32
DEFAULT_LANGUAGE = os.environ.get("TTS_LANGUAGE", "th")
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
        manifest_items = json.load(source)
    if not isinstance(manifest_items, list) or not manifest_items:
        raise RuntimeError("voice manifest must be a non-empty list")
    manifest = {item["id"]: item for item in manifest_items}
    if len(manifest) != len(manifest_items):
        raise RuntimeError("voice manifest contains duplicate IDs")
    served_voice_ids = CONFIGURED_VOICE_IDS or tuple(manifest)
    served_manifest = {}
    for voice_id in served_voice_ids:
        metadata = manifest.get(voice_id)
        if not metadata:
            raise RuntimeError(f"voice manifest is missing {voice_id}")
        reference_path = VOICES_DIR / metadata["ref_audio"]
        if not reference_path.is_file():
            raise RuntimeError(f"reference audio is missing for {voice_id}")
        served_manifest[voice_id] = metadata

    def prepare_voice_prompt(voice_id, metadata):
        reference_path = VOICES_DIR / metadata["ref_audio"]
        prompt_started = time.monotonic()
        LOGGER.info("voice prompt loading version=%s voice_id=%s", VERSION, voice_id)
        with GENERATE_LOCK, torch.inference_mode():
            prompt = model.create_voice_clone_prompt(
                ref_audio=str(reference_path),
                ref_text=metadata["ref_text"],
            )
        LOGGER.info(
            "voice prompt ready version=%s voice_id=%s load_ms=%d",
            VERSION,
            voice_id,
            round((time.monotonic() - prompt_started) * 1000),
        )
        return prompt

    voice_prompts = VoicePromptCache(served_manifest, prepare_voice_prompt)
    LOGGER.info(
        "runtime ready version=%s voice_count=%d prompt_policy=lazy load_ms=%d",
        VERSION,
        len(served_voice_ids),
        round((time.monotonic() - started) * 1000),
    )
    return model, voice_prompts


MODEL, VOICE_PROMPTS = load_runtime()


def handler(job):
    job_id = str(job.get("id", "unknown"))
    try:
        request = parse_tts_input(job.get("input"), MAX_TEXT_LENGTH)
    except InputError as error:
        LOGGER.warning("job rejected job_id=%s code=%s", job_id, error.code)
        raise ValueError(f"{error.code}: {error}") from error

    effective_num_step = DEFAULT_NUM_STEP
    payload_ref_tmp_path = None

    LOGGER.info(
        "generation started job_id=%s voice_id=%s chars=%d steps=%d language=%s class_temperature=%s ref_source=%s",
        job_id,
        request.voice_id,
        len(request.text),
        effective_num_step,
        DEFAULT_LANGUAGE,
        request.class_temperature,
        request.ref_source,
    )
    runpod.serverless.progress_update(job, "generating_audio")
    started = time.monotonic()
    try:
        if request.ref_source == "payload":
            # T5 (v13) clone-from-payload: voice_id is telemetry-only here —
            # the clone prompt is built fresh from the request's own
            # ref_audio_bytes/ref_text, never cached, never written under the
            # baked VOICES_DIR tree.
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
                tmp_file.write(request.ref_audio_bytes)
                payload_ref_tmp_path = tmp_file.name
            with GENERATE_LOCK, torch.inference_mode():
                voice_prompt = MODEL.create_voice_clone_prompt(
                    ref_audio=payload_ref_tmp_path,
                    ref_text=request.ref_text,
                )
        else:
            try:
                voice_prompt = VOICE_PROMPTS.get(request.voice_id)
            except KeyError:
                raise ValueError("VOICE_NOT_SERVED: requested voice is unavailable")

        with GENERATE_LOCK, torch.inference_mode():
            audio = MODEL.generate(
                text=request.text,
                language=DEFAULT_LANGUAGE,
                voice_clone_prompt=voice_prompt,
                num_step=effective_num_step,
                speed=request.speed,
                class_temperature=request.class_temperature,
            )[0]
    finally:
        if payload_ref_tmp_path is not None:
            try:
                os.unlink(payload_ref_tmp_path)
            except OSError:
                pass
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
        "language": DEFAULT_LANGUAGE,
        "num_step": effective_num_step,
        "class_temperature": request.class_temperature,
        "ref_source": request.ref_source,
    }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})

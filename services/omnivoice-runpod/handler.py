"""RunPod Serverless adapter for the Hero-Voice-Ai v2 engine."""

import base64
import binascii
import io
import os
import tempfile
import threading
import time

import numpy as np
import soundfile as sf
import torch

from contract import CloneInput, InputError, TtsInput, parse_worker_input
from server import (
    OmniVoiceEngine,
    SAMPLE_RATE,
    _BEST_OF_CLASS_TEMPERATURE,
    _CLONE_BEST_OF,
    clean_instruct,
)
from text_utils import split_by_language


VERSION = "hero-voice-ai-v2-565d0e6"
CATALOG_VERSION = "hero-voice-ai-v2-2026-08-24"
MAX_TEXT_LENGTH = max(100, min(800, int(os.environ.get("TTS_MAX_TEXT_LENGTH", "800"))))
MAX_WAV_BYTES = max(1_000_000, min(7_000_000, int(os.environ.get("TTS_MAX_WAV_BYTES", "7000000"))))
GENERATION_LOCK = threading.Lock()


print(f"[hero-voice] loading worker_version={VERSION}")
if not torch.cuda.is_available():
    raise RuntimeError("CUDA GPU is required for the RunPod worker")
ENGINE = OmniVoiceEngine()
ENGINE.load()
print(f"[hero-voice] ready worker_version={VERSION} voices={len(ENGINE.voices)} device={ENGINE.device}")


def _resolve_stock_prompt(voice_id: str):
    if voice_id not in ENGINE.voices:
        raise ValueError("VOICE_NOT_SERVED: requested voice is unavailable")
    prompt = ENGINE.cache_get(voice_id)
    if prompt is None:
        voice = ENGINE.voices[voice_id]
        prompt = ENGINE.build_prompt(voice["ref_audio"], voice["meta"]["ref_text"])
        ENGINE.cache_put(voice_id, prompt)
    return prompt


def _generate_audio(
    *,
    text: str,
    clone_prompt,
    instruct: str | None,
    language: str | None,
    mixed_language: bool,
    speed: float,
    num_step: int,
    guidance_scale: float | None,
    class_temperature: float | None = None,
) -> tuple[np.ndarray, str]:
    if mixed_language:
        segments = split_by_language(text)
    else:
        segments = [(text, language)]

    wavs: list[np.ndarray] = []
    languages: list[str] = []
    for segment, segment_language in segments:
        kwargs = {
            "clone_prompt": clone_prompt,
            "instruct": instruct,
            "language": segment_language,
            "speed": speed,
            "num_step": num_step,
            "guidance_scale": guidance_scale,
        }
        if class_temperature is not None:
            kwargs["class_temperature"] = class_temperature
        wav, _ = ENGINE._run(segment, **kwargs)
        wavs.append(wav)
        languages.append(segment_language or "auto")

    if not wavs:
        raise RuntimeError("EMPTY_AUDIO: the engine returned no audio segments")
    audio = np.concatenate(wavs) if len(wavs) > 1 else wavs[0]
    if audio.size == 0:
        raise RuntimeError("EMPTY_AUDIO: the engine returned empty audio")
    language_label = ",".join(dict.fromkeys(languages))
    return audio, language_label


def _encode_wav(audio: np.ndarray) -> tuple[bytes, float]:
    buffer = io.BytesIO()
    sf.write(buffer, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    wav = buffer.getvalue()
    if not wav:
        raise RuntimeError("EMPTY_AUDIO: WAV encoding produced no bytes")
    if len(wav) > MAX_WAV_BYTES:
        raise RuntimeError("OUTPUT_TOO_LARGE: reduce the text length")
    return wav, len(audio) / SAMPLE_RATE


def _response(audio: np.ndarray, *, mode: str, generation_time: float, language: str, num_step: int, **extra):
    wav, duration = _encode_wav(audio)
    return {
        "contract_version": 2,
        "mode": mode,
        "audio_base64": base64.b64encode(wav).decode("ascii"),
        "format": "wav",
        "sample_rate": SAMPLE_RATE,
        "duration": round(duration, 3),
        "generation_time": round(generation_time, 3),
        "worker_version": VERSION,
        "catalog_version": CATALOG_VERSION,
        "language": language,
        "num_step": num_step,
        **extra,
    }


def _do_tts(request: TtsInput) -> dict:
    try:
        instruct = clean_instruct(request.instruct)
    except Exception as error:
        detail = getattr(error, "detail", str(error))
        raise ValueError(f"INVALID_INSTRUCT: {detail}") from error

    started = time.monotonic()
    with GENERATION_LOCK:
        clone_prompt = _resolve_stock_prompt(request.voice_id) if request.voice_id else None
        audio, language = _generate_audio(
            text=request.text,
            clone_prompt=clone_prompt,
            instruct=instruct,
            language=request.language,
            mixed_language=request.mixed_language,
            speed=request.speed,
            num_step=request.num_step,
            guidance_scale=request.guidance_scale,
        )
    generation_time = time.monotonic() - started
    return _response(
        audio,
        mode="tts",
        generation_time=generation_time,
        language=language,
        num_step=request.num_step,
        voice_id=request.voice_id or "voice_design",
    )


def _decode_reference_audio(encoded: str) -> str:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("INVALID_REF_AUDIO: ref_audio_b64 is not valid base64") from error
    if not raw:
        raise ValueError("INVALID_REF_AUDIO: reference audio is empty")

    from pydub import AudioSegment

    try:
        reference = AudioSegment.from_file(io.BytesIO(raw))
    except Exception as error:
        raise ValueError("INVALID_REF_AUDIO: unsupported or corrupt reference audio") from error
    duration_seconds = len(reference) / 1_000
    if not 3 <= duration_seconds <= 15:
        raise ValueError("INVALID_REF_DURATION: reference audio must be 3 to 15 seconds")

    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    try:
        reference.set_channels(1).set_frame_rate(SAMPLE_RATE).export(handle.name, format="wav")
    except Exception:
        try:
            os.remove(handle.name)
        except OSError:
            pass
        raise
    return handle.name


def _do_clone(request: CloneInput) -> dict:
    reference_path = None
    try:
        reference_path = _decode_reference_audio(request.ref_audio_b64)
        from voice_similarity import cosine_sim, embed_array, embed_file

        reference_embedding = embed_file(reference_path)
        started = time.monotonic()
        best_audio = None
        best_score = -1.0
        best_language = "auto"
        with GENERATION_LOCK:
            prompt = ENGINE.model.create_voice_clone_prompt(
                ref_audio=reference_path,
                ref_text=request.ref_text,
            )
            for _ in range(_CLONE_BEST_OF):
                audio, language = _generate_audio(
                    text=request.text,
                    clone_prompt=prompt,
                    instruct=None,
                    language=request.language,
                    mixed_language=request.mixed_language,
                    speed=request.speed,
                    num_step=request.num_step,
                    guidance_scale=request.guidance_scale,
                    class_temperature=_BEST_OF_CLASS_TEMPERATURE,
                )
                score = cosine_sim(reference_embedding, embed_array(audio, SAMPLE_RATE))
                if score > best_score:
                    best_audio = audio
                    best_score = score
                    best_language = language
        generation_time = time.monotonic() - started
        if best_audio is None:
            raise RuntimeError("EMPTY_AUDIO: cloning produced no candidate")
        return _response(
            best_audio,
            mode="clone",
            generation_time=generation_time,
            language=best_language,
            num_step=request.num_step,
            similarity_score=round(best_score, 4),
        )
    finally:
        if reference_path and os.path.exists(reference_path):
            os.remove(reference_path)


def handler(job):
    job_id = str(job.get("id", "unknown")) if isinstance(job, dict) else "unknown"
    try:
        request = parse_worker_input(job.get("input") if isinstance(job, dict) else None, MAX_TEXT_LENGTH)
    except InputError as error:
        raise ValueError(f"{error.code}: {error}") from error

    print(f"[hero-voice] generation started job_id={job_id} mode={'clone' if isinstance(request, CloneInput) else 'tts'}")
    result = _do_clone(request) if isinstance(request, CloneInput) else _do_tts(request)
    print(
        f"[hero-voice] generation completed job_id={job_id} mode={result['mode']} "
        f"duration_ms={round(result['duration'] * 1000)} generation_ms={round(result['generation_time'] * 1000)}"
    )
    return result


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})

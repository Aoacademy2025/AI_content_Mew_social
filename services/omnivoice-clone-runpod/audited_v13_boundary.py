"""Frozen executable oracle extracted from the audited v13 clone boundary.

Provenance:
- application commit 24fc72d99576da94bd93bf8827f7d5e351609c0d
- services/omnivoice-runpod/handler.py::_decode_reference_audio,
  _do_clone, and _generate_audio
- services/omnivoice-runpod/server.py::OmniVoiceEngine._run
- services/omnivoice-runpod/voice_similarity.py::cosine_sim

This test-only module makes the old behavior executable without importing its
stock catalog, FastAPI server, global CUDA engine, or customer assets.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any
import wave

import numpy as np
from pydub import AudioSegment


AUDITED_APPLICATION_COMMIT = "24fc72d99576da94bd93bf8827f7d5e351609c0d"
SAMPLE_RATE = 24_000
BASE_SPEED = 1.4


def preprocess_reference(raw: bytes) -> np.ndarray:
    reference = AudioSegment.from_file(io.BytesIO(raw))
    canonical = reference.set_channels(1).set_frame_rate(SAMPLE_RATE)
    samples = np.asarray(canonical.get_array_of_samples())
    denominator = float(1 << (8 * canonical.sample_width - 1))
    return np.ascontiguousarray(samples.astype(np.float32) / denominator)


def exported_reference_pcm16(raw: bytes) -> tuple[bytes, np.ndarray]:
    """Expose the exact v13 file-backed ranking/prompt domain for PCM16 fixtures."""
    reference = AudioSegment.from_file(io.BytesIO(raw))
    canonical = reference.set_channels(1).set_frame_rate(SAMPLE_RATE)
    output = io.BytesIO()
    canonical.export(output, format="wav")
    wav_bytes = output.getvalue()
    with wave.open(io.BytesIO(wav_bytes), "rb") as reader:
        if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError("fixture is not exported PCM16 mono 24 kHz")
        frames = reader.readframes(reader.getnframes())
    decoded = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return frames, np.ascontiguousarray(decoded)


def create_prompt(model: Any, reference_path: Path, ref_text: str) -> Any:
    return model.create_voice_clone_prompt(ref_audio=str(reference_path), ref_text=ref_text)


def effective_speed(speed: float) -> float:
    return max(0.31, min(2.99, speed * BASE_SPEED))


def cosine_similarity(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.dot(left, right) / (np.linalg.norm(left) * np.linalg.norm(right) + 1e-8))

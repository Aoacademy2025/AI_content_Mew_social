"""Pure input contract for the HERO AI OmniVoice Runpod worker."""

import base64
from dataclasses import dataclass
import io
import re
from typing import Any, Optional
import wave


VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# T5 (v13): optional clone-from-payload reference audio. Kept intentionally
# narrow — this worker only ever produces/consumes its own 24kHz mono PCM16
# WAV output (SAMPLE_RATE in handler.py, sf.write(..., subtype="PCM_16")), so
# "accept 24 kHz PCM16" is read as an exact match, not a range, avoiding any
# resampling/format-conversion code in a worker that's meant to stay pure.
REF_AUDIO_MAX_DECODED_BYTES = 2 * 1024 * 1024  # 2 MB decoded-size cap (brief)
REF_AUDIO_MIN_DURATION_SECONDS = 3.0
REF_AUDIO_MAX_DURATION_SECONDS = 20.0
REF_AUDIO_REQUIRED_CHANNELS = 1
REF_AUDIO_REQUIRED_SAMPLE_WIDTH_BYTES = 2  # PCM16
REF_AUDIO_REQUIRED_FRAME_RATE = 24_000
REF_TEXT_MAX_LENGTH = 300

# Upstream (pinned commit 346bb75330980a236540d61a0808d00767c0973b,
# docs/generation-parameters.md) documents class_temperature as "Temperature for
# token sampling at each step. 0 = greedy (deterministic). Higher values increase
# randomness." — no explicit upper bound is documented anywhere in that pinned
# source (docs, CLI argparse, or the Gradio demo, which does not expose this
# parameter at all). The floor of 0.0 is upstream-documented and load-bearing:
# omnivoice/models/omnivoice.py:1312 only enters the temperature-sampling branch
# when class_temperature > 0.0, so 0.0 is the exact greedy/v11 code path.
# The ceiling below is an engineering decision filling that documented gap: it
# mirrors the upstream default of position_temperature (omnivoice.py:103, default
# 5.0), the sibling parameter that shares the identical _gumbel_sample transform
# (omnivoice.py:1502-1506) — the closest same-mechanism evidence upstream provides
# for what magnitude of temperature the model family treats as a normal operating
# value.
CLASS_TEMPERATURE_MIN = 0.0
CLASS_TEMPERATURE_MAX = 5.0


class InputError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TtsInput:
    voice_id: str
    text: str
    num_step: int
    speed: float
    class_temperature: float
    ref_audio_bytes: Optional[bytes]
    ref_text: Optional[str]
    ref_source: str  # "payload" | "baked"


@dataclass(frozen=True)
class DesignInput:
    text: str
    instruct: str
    num_step: int
    seed: int


_DESIGN_ATTRIBUTE_CATEGORIES = {
    "male": "gender",
    "female": "gender",
    "child": "age",
    "teenager": "age",
    "young adult": "age",
    "middle-aged": "age",
    "elderly": "age",
    "very low pitch": "pitch",
    "low pitch": "pitch",
    "moderate pitch": "pitch",
    "high pitch": "pitch",
    "very high pitch": "pitch",
    "whisper": "style",
    "american accent": "accent",
    "british accent": "accent",
    "australian accent": "accent",
    "canadian accent": "accent",
    "indian accent": "accent",
    "chinese accent": "accent",
    "korean accent": "accent",
    "japanese accent": "accent",
    "portuguese accent": "accent",
    "russian accent": "accent",
}


def parse_design_input(payload: Any, max_text_length: int) -> DesignInput:
    """Validate the tightly bounded, staging-only voice-reference recovery input."""
    if not isinstance(payload, dict):
        raise InputError("INVALID_INPUT", "input must be an object")
    if payload.get("operation") != "design":
        raise InputError("INVALID_OPERATION", "operation must be design")

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise InputError("INVALID_TEXT", "text is required")
    text = text.strip()
    if len(text) > max_text_length:
        raise InputError("TEXT_TOO_LONG", f"text exceeds {max_text_length} characters")

    raw_instruct = payload.get("instruct")
    if not isinstance(raw_instruct, str):
        raise InputError("INVALID_INSTRUCT", "instruct is invalid")
    attributes = [item.strip().lower() for item in raw_instruct.split(",") if item.strip()]
    categories = [_DESIGN_ATTRIBUTE_CATEGORIES.get(item) for item in attributes]
    if (
        not attributes
        or len(attributes) > 4
        or any(category is None for category in categories)
        or len(set(categories)) != len(categories)
    ):
        raise InputError("INVALID_INSTRUCT", "instruct contains unsupported or conflicting attributes")

    raw_num_step = payload.get("num_step", 32)
    if isinstance(raw_num_step, bool) or not isinstance(raw_num_step, int) or not 16 <= raw_num_step <= 32:
        raise InputError("INVALID_NUM_STEP", "num_step must be an integer from 16 to 32")

    raw_seed = payload.get("seed", 0)
    if isinstance(raw_seed, bool) or not isinstance(raw_seed, int) or not 0 <= raw_seed <= 2_147_483_647:
        raise InputError("INVALID_SEED", "seed must be an integer from 0 to 2147483647")

    return DesignInput(
        text=text,
        instruct=", ".join(attributes),
        num_step=raw_num_step,
        seed=raw_seed,
    )


def _parse_ref_audio(payload: Any) -> tuple[Optional[bytes], Optional[str]]:
    """Validate the optional v13 clone-from-payload reference. Returns
    (decoded_wav_bytes, ref_text) or (None, None) when absent (v12 behavior)."""
    raw_ref_audio_b64 = payload.get("ref_audio_b64")
    raw_ref_text = payload.get("ref_text")

    if raw_ref_audio_b64 is None:
        if raw_ref_text is not None:
            raise InputError("INVALID_REF_TEXT", "ref_text requires ref_audio_b64 to be present")
        return None, None

    if not isinstance(raw_ref_audio_b64, str) or not raw_ref_audio_b64.strip():
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 must be a non-empty base64 string")

    try:
        decoded = base64.b64decode(raw_ref_audio_b64, validate=True)
    except (ValueError, TypeError) as error:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 is not valid base64") from error

    if not decoded:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 decoded to empty audio")
    if len(decoded) > REF_AUDIO_MAX_DECODED_BYTES:
        raise InputError(
            "INVALID_REF_AUDIO",
            f"ref_audio_b64 decoded size exceeds {REF_AUDIO_MAX_DECODED_BYTES} bytes",
        )

    try:
        with wave.open(io.BytesIO(decoded), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            frame_rate = wav_file.getframerate()
            frame_count = wav_file.getnframes()
    except (wave.Error, EOFError) as error:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 is not a readable WAV file") from error

    if channels != REF_AUDIO_REQUIRED_CHANNELS:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 must be mono")
    if sample_width != REF_AUDIO_REQUIRED_SAMPLE_WIDTH_BYTES:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 must be 16-bit PCM")
    if frame_rate != REF_AUDIO_REQUIRED_FRAME_RATE:
        raise InputError("INVALID_REF_AUDIO", f"ref_audio_b64 must be {REF_AUDIO_REQUIRED_FRAME_RATE} Hz")
    if frame_rate <= 0:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 has an invalid frame rate")

    duration_seconds = frame_count / frame_rate
    if not REF_AUDIO_MIN_DURATION_SECONDS <= duration_seconds <= REF_AUDIO_MAX_DURATION_SECONDS:
        raise InputError(
            "INVALID_REF_AUDIO",
            f"ref_audio_b64 duration must be {REF_AUDIO_MIN_DURATION_SECONDS}-"
            f"{REF_AUDIO_MAX_DURATION_SECONDS} seconds",
        )

    if not isinstance(raw_ref_text, str) or not raw_ref_text.strip():
        raise InputError("INVALID_REF_TEXT", "ref_text is required when ref_audio_b64 is present")
    ref_text = raw_ref_text.strip()
    if len(ref_text) > REF_TEXT_MAX_LENGTH:
        raise InputError("INVALID_REF_TEXT", f"ref_text exceeds {REF_TEXT_MAX_LENGTH} characters")

    return decoded, ref_text


def parse_tts_input(payload: Any, max_text_length: int) -> TtsInput:
    if not isinstance(payload, dict):
        raise InputError("INVALID_INPUT", "input must be an object")

    operation = payload.get("operation", "tts")
    if operation != "tts":
        raise InputError("INVALID_OPERATION", "operation must be tts")

    voice_id = payload.get("voice_id")
    if not isinstance(voice_id, str) or not VOICE_ID_RE.fullmatch(voice_id):
        raise InputError("INVALID_VOICE_ID", "voice_id is invalid")

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise InputError("INVALID_TEXT", "text is required")
    text = text.strip()
    if len(text) > max_text_length:
        raise InputError("TEXT_TOO_LONG", f"text exceeds {max_text_length} characters")

    raw_num_step = payload.get("num_step", 32)
    if isinstance(raw_num_step, bool) or raw_num_step != 32:
        raise InputError("INVALID_NUM_STEP", "num_step must be 32")

    raw_speed = payload.get("speed", 1.0)
    if isinstance(raw_speed, bool) or not isinstance(raw_speed, (int, float)):
        raise InputError("INVALID_SPEED", "speed must be a number from 0.3 to 3.0")
    speed = float(raw_speed)
    if not 0.3 <= speed <= 3.0:
        raise InputError("INVALID_SPEED", "speed must be a number from 0.3 to 3.0")

    raw_class_temperature = payload.get("class_temperature", 0.0)
    if isinstance(raw_class_temperature, bool) or not isinstance(raw_class_temperature, (int, float)):
        raise InputError(
            "INVALID_CLASS_TEMPERATURE",
            f"class_temperature must be a number from {CLASS_TEMPERATURE_MIN} to {CLASS_TEMPERATURE_MAX}",
        )
    class_temperature = float(raw_class_temperature)
    if not CLASS_TEMPERATURE_MIN <= class_temperature <= CLASS_TEMPERATURE_MAX:
        raise InputError(
            "INVALID_CLASS_TEMPERATURE",
            f"class_temperature must be a number from {CLASS_TEMPERATURE_MIN} to {CLASS_TEMPERATURE_MAX}",
        )

    ref_audio_bytes, ref_text = _parse_ref_audio(payload)

    return TtsInput(
        voice_id=voice_id,
        text=text,
        num_step=raw_num_step,
        speed=speed,
        class_temperature=class_temperature,
        ref_audio_bytes=ref_audio_bytes,
        ref_text=ref_text,
        ref_source="payload" if ref_audio_bytes is not None else "baked",
    )

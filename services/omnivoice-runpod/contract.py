"""Pure input contract for the HERO AI OmniVoice Runpod worker."""

from dataclasses import dataclass
import re
from typing import Any


VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

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

    return TtsInput(
        voice_id=voice_id,
        text=text,
        num_step=raw_num_step,
        speed=speed,
        class_temperature=class_temperature,
    )

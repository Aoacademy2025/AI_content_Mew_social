"""Pure input contract for the HERO AI OmniVoice Runpod worker."""

from dataclasses import dataclass
import re
from typing import Any


VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


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


def parse_tts_input(payload: Any, max_text_length: int, default_num_step: int) -> TtsInput:
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

    raw_num_step = payload.get("num_step", default_num_step)
    if isinstance(raw_num_step, bool) or not isinstance(raw_num_step, int) or not 4 <= raw_num_step <= 16:
        raise InputError("INVALID_NUM_STEP", "num_step must be an integer from 4 to 16")

    raw_speed = payload.get("speed", 1.0)
    if isinstance(raw_speed, bool) or not isinstance(raw_speed, (int, float)):
        raise InputError("INVALID_SPEED", "speed must be a number from 0.3 to 3.0")
    speed = float(raw_speed)
    if not 0.3 <= speed <= 3.0:
        raise InputError("INVALID_SPEED", "speed must be a number from 0.3 to 3.0")

    return TtsInput(voice_id=voice_id, text=text, num_step=raw_num_step, speed=speed)

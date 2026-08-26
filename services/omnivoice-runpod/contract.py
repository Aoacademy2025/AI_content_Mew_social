"""Validated RunPod contract for Hero AI Voice v2."""

from dataclasses import dataclass
import re
from typing import Any, Union


CONTRACT_VERSION = 2
VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_REF_AUDIO_BYTES = 8_000_000
# Base64 expands bytes by roughly 4/3. Leave a small allowance for padding.
MAX_REF_AUDIO_BASE64_CHARS = ((MAX_REF_AUDIO_BYTES + 2) // 3) * 4


class InputError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TtsInput:
    text: str
    voice_id: str | None
    instruct: str | None
    num_step: int
    speed: float
    guidance_scale: float | None
    language: str | None
    mixed_language: bool


@dataclass(frozen=True)
class CloneInput:
    text: str
    ref_audio_b64: str
    ref_text: str
    num_step: int
    speed: float
    guidance_scale: float
    language: str | None
    mixed_language: bool


WorkerInput = Union[TtsInput, CloneInput]


def _require_payload(payload: Any, expected_mode: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise InputError("INVALID_INPUT", "input must be an object")
    if payload.get("contract_version") != CONTRACT_VERSION:
        raise InputError("INVALID_CONTRACT_VERSION", f"contract_version must be {CONTRACT_VERSION}")
    if payload.get("mode") != expected_mode:
        raise InputError("INVALID_MODE", f"mode must be {expected_mode}")
    return payload


def _parse_text(payload: dict[str, Any], max_text_length: int) -> str:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise InputError("INVALID_TEXT", "text is required")
    text = text.strip()
    if len(text) > max_text_length:
        raise InputError("TEXT_TOO_LONG", f"text exceeds {max_text_length} characters")
    return text


def _parse_num_step(payload: dict[str, Any], default: int) -> int:
    raw = payload.get("num_step", default)
    if isinstance(raw, bool) or not isinstance(raw, int) or not 4 <= raw <= 64:
        raise InputError("INVALID_NUM_STEP", "num_step must be an integer from 4 to 64")
    return raw


def _parse_speed(payload: dict[str, Any]) -> float:
    raw = payload.get("speed", 1.0)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise InputError("INVALID_SPEED", "speed must be a number from 0.3 to 3.0")
    value = float(raw)
    if not 0.3 <= value <= 3.0:
        raise InputError("INVALID_SPEED", "speed must be a number from 0.3 to 3.0")
    return value


def _parse_guidance(payload: dict[str, Any], default: float | None) -> float | None:
    raw = payload.get("guidance_scale", default)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise InputError("INVALID_GUIDANCE", "guidance_scale must be a number from 0.1 to 10.0")
    value = float(raw)
    if not 0.1 <= value <= 10.0:
        raise InputError("INVALID_GUIDANCE", "guidance_scale must be a number from 0.1 to 10.0")
    return value


def _parse_language(payload: dict[str, Any]) -> str | None:
    raw = payload.get("language")
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip() or len(raw.strip()) > 32:
        raise InputError("INVALID_LANGUAGE", "language must be a non-empty string up to 32 characters")
    return raw.strip()


def _parse_mixed_language(payload: dict[str, Any]) -> bool:
    raw = payload.get("mixed_language", True)
    if not isinstance(raw, bool):
        raise InputError("INVALID_MIXED_LANGUAGE", "mixed_language must be a boolean")
    return raw


def parse_tts_input(payload: Any, max_text_length: int) -> TtsInput:
    payload = _require_payload(payload, "tts")
    text = _parse_text(payload, max_text_length)

    raw_voice_id = payload.get("voice_id")
    voice_id = raw_voice_id.strip() if isinstance(raw_voice_id, str) else None
    if voice_id and not VOICE_ID_RE.fullmatch(voice_id):
        raise InputError("INVALID_VOICE_ID", "voice_id is invalid")

    raw_instruct = payload.get("instruct")
    instruct = raw_instruct.strip() if isinstance(raw_instruct, str) else None
    if instruct and len(instruct) > 240:
        raise InputError("INVALID_INSTRUCT", "instruct is too long")
    if bool(voice_id) == bool(instruct):
        raise InputError("INVALID_VOICE_SELECTION", "provide exactly one of voice_id or instruct")

    return TtsInput(
        text=text,
        voice_id=voice_id,
        instruct=instruct,
        num_step=_parse_num_step(payload, 24),
        speed=_parse_speed(payload),
        guidance_scale=_parse_guidance(payload, None),
        language=_parse_language(payload),
        mixed_language=_parse_mixed_language(payload),
    )


def parse_clone_input(payload: Any, max_text_length: int) -> CloneInput:
    payload = _require_payload(payload, "clone")
    text = _parse_text(payload, max_text_length)

    ref_audio_b64 = payload.get("ref_audio_b64")
    if not isinstance(ref_audio_b64, str) or not ref_audio_b64:
        raise InputError("INVALID_REF_AUDIO", "ref_audio_b64 is required")
    if len(ref_audio_b64) > MAX_REF_AUDIO_BASE64_CHARS:
        raise InputError("REF_AUDIO_TOO_LARGE", f"reference audio exceeds {MAX_REF_AUDIO_BYTES} bytes")

    ref_text = payload.get("ref_text")
    if not isinstance(ref_text, str) or not ref_text.strip():
        raise InputError("INVALID_REF_TEXT", "ref_text is required")
    ref_text = ref_text.strip()
    if len(ref_text) > 2_000:
        raise InputError("REF_TEXT_TOO_LONG", "ref_text exceeds 2000 characters")

    return CloneInput(
        text=text,
        ref_audio_b64=ref_audio_b64,
        ref_text=ref_text,
        num_step=_parse_num_step(payload, 32),
        speed=_parse_speed(payload),
        guidance_scale=_parse_guidance(payload, 2.5) or 2.5,
        language=_parse_language(payload),
        mixed_language=_parse_mixed_language(payload),
    )


def parse_worker_input(payload: Any, max_text_length: int) -> WorkerInput:
    if not isinstance(payload, dict):
        raise InputError("INVALID_INPUT", "input must be an object")
    mode = payload.get("mode")
    if mode == "tts":
        return parse_tts_input(payload, max_text_length)
    if mode == "clone":
        return parse_clone_input(payload, max_text_length)
    raise InputError("INVALID_MODE", "mode must be tts or clone")

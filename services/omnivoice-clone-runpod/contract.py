"""Strict, clone-only RunPod contract v3.

This module intentionally uses only the Python standard library.  Request parsing
does not import the model stack and never rewrites either transcript.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from enum import Enum
import hashlib
import io
import json
import math
import re
import struct
import wave
from typing import Any


CONTRACT_VERSION = 3
MODE = "clone"
MAX_REF_AUDIO_BYTES = 8_000_000
MAX_REF_AUDIO_BASE64_CHARS = ((MAX_REF_AUDIO_BYTES + 2) // 3) * 4
MIN_REF_DURATION_SECONDS = 5.0
MAX_REF_DURATION_SECONDS = 15.0
MAX_REF_TEXT_CHARACTERS = 2_000
MAX_TEXT_CHARACTERS = 800
OUTPUT_SAMPLE_RATE = 24_000
OUTPUT_CHANNELS = 1
OUTPUT_SUBTYPE = "PCM_16"
LOWER_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+/@:-]{0,127}$")

EXPERIMENT_PROFILES = frozenset(
    {
        "control-v1",
        "reference-enhancement-v1",
        "text-normalization-v1",
        "guidance-ranking-v1",
        "watermark-v1",
        "combined-quality-v1",
    }
)

REQUEST_FIELDS = frozenset(
    {
        "contract_version",
        "mode",
        "ref_audio_b64",
        "ref_text",
        "text",
        "speed",
        "num_step",
        "mixed_language",
        "seed",
        "experiment_profile",
        "normalizer_version",
        "request_commitment_sha256",
        "matched_settings_sha256",
    }
)


class ErrorCode(str, Enum):
    INVALID_INPUT = "INVALID_INPUT"
    INVALID_FIELDS = "INVALID_FIELDS"
    INVALID_CONTRACT_VERSION = "INVALID_CONTRACT_VERSION"
    INVALID_MODE = "INVALID_MODE"
    INVALID_REF_AUDIO = "INVALID_REF_AUDIO"
    REF_AUDIO_TOO_LARGE = "REF_AUDIO_TOO_LARGE"
    INVALID_REF_AUDIO_FORMAT = "INVALID_REF_AUDIO_FORMAT"
    INVALID_REF_DURATION = "INVALID_REF_DURATION"
    INVALID_REF_TEXT = "INVALID_REF_TEXT"
    REF_TEXT_TOO_LONG = "REF_TEXT_TOO_LONG"
    INVALID_TEXT = "INVALID_TEXT"
    TEXT_TOO_LONG = "TEXT_TOO_LONG"
    INVALID_SPEED = "INVALID_SPEED"
    INVALID_NUM_STEP = "INVALID_NUM_STEP"
    INVALID_MIXED_LANGUAGE = "INVALID_MIXED_LANGUAGE"
    INVALID_SEED = "INVALID_SEED"
    INVALID_EXPERIMENT_PROFILE = "INVALID_EXPERIMENT_PROFILE"
    INVALID_NORMALIZER_VERSION = "INVALID_NORMALIZER_VERSION"
    INVALID_COMMITMENT = "INVALID_COMMITMENT"
    REQUEST_COMMITMENT_MISMATCH = "REQUEST_COMMITMENT_MISMATCH"
    MATCHED_SETTINGS_MISMATCH = "MATCHED_SETTINGS_MISMATCH"
    WORKER_IDENTITY_UNAVAILABLE = "WORKER_IDENTITY_UNAVAILABLE"
    MODEL_MANIFEST_INVALID = "MODEL_MANIFEST_INVALID"
    REFERENCE_STAGE_FAILED = "REFERENCE_STAGE_FAILED"
    PROMPT_STAGE_FAILED = "PROMPT_STAGE_FAILED"
    SYNTHESIS_STAGE_FAILED = "SYNTHESIS_STAGE_FAILED"
    RANKING_STAGE_FAILED = "RANKING_STAGE_FAILED"
    WATERMARK_STAGE_FAILED = "WATERMARK_STAGE_FAILED"
    OUTPUT_INVALID = "OUTPUT_INVALID"
    OUTPUT_TOO_LARGE = "OUTPUT_TOO_LARGE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


ERROR_MESSAGES = {
    ErrorCode.INVALID_INPUT: "input must be an object",
    ErrorCode.INVALID_FIELDS: "input fields do not match contract v3",
    ErrorCode.INVALID_CONTRACT_VERSION: "contract_version must be 3",
    ErrorCode.INVALID_MODE: "mode must be clone",
    ErrorCode.INVALID_REF_AUDIO: "reference audio must be canonical base64",
    ErrorCode.REF_AUDIO_TOO_LARGE: "reference audio exceeds 8000000 bytes",
    ErrorCode.INVALID_REF_AUDIO_FORMAT: "reference audio must be an uncompressed PCM WAV",
    ErrorCode.INVALID_REF_DURATION: "reference audio duration must be 5 to 15 seconds",
    ErrorCode.INVALID_REF_TEXT: "ref_text is required",
    ErrorCode.REF_TEXT_TOO_LONG: "ref_text exceeds 2000 characters",
    ErrorCode.INVALID_TEXT: "text is required",
    ErrorCode.TEXT_TOO_LONG: "text exceeds 800 characters",
    ErrorCode.INVALID_SPEED: "speed must be a finite number from 0.3 to 3.0",
    ErrorCode.INVALID_NUM_STEP: "num_step must be an integer from 4 to 64",
    ErrorCode.INVALID_MIXED_LANGUAGE: "mixed_language must be true",
    ErrorCode.INVALID_SEED: "seed must be an integer from 0 to 2147483647",
    ErrorCode.INVALID_EXPERIMENT_PROFILE: "experiment_profile is not supported",
    ErrorCode.INVALID_NORMALIZER_VERSION: "normalizer_version is invalid",
    ErrorCode.INVALID_COMMITMENT: "commitments must be lowercase SHA-256 hex",
    ErrorCode.REQUEST_COMMITMENT_MISMATCH: "request commitment does not match input",
    ErrorCode.MATCHED_SETTINGS_MISMATCH: "matched settings commitment does not match input",
    ErrorCode.WORKER_IDENTITY_UNAVAILABLE: "worker identity is unavailable",
    ErrorCode.MODEL_MANIFEST_INVALID: "model manifest validation failed",
    ErrorCode.REFERENCE_STAGE_FAILED: "reference stage failed",
    ErrorCode.PROMPT_STAGE_FAILED: "clone prompt stage failed",
    ErrorCode.SYNTHESIS_STAGE_FAILED: "synthesis stage failed",
    ErrorCode.RANKING_STAGE_FAILED: "ranking stage failed",
    ErrorCode.WATERMARK_STAGE_FAILED: "watermark stage failed",
    ErrorCode.OUTPUT_INVALID: "generated audio is invalid",
    ErrorCode.OUTPUT_TOO_LARGE: "generated WAV exceeds 7000000 bytes",
    ErrorCode.INTERNAL_ERROR: "worker failed",
}


class ContractError(ValueError):
    def __init__(self, code: ErrorCode):
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


@dataclass(frozen=True)
class CloneRequest:
    ref_audio: bytes
    ref_audio_sha256: str
    ref_duration_samples: int
    ref_text: str
    text: str
    speed: float
    num_step: int
    mixed_language: bool
    seed: int
    experiment_profile: str
    normalizer_version: str
    request_commitment_sha256: str
    matched_settings_sha256: str


@dataclass(frozen=True)
class PcmWavInfo:
    channels: int
    sample_width: int
    sample_rate: int
    frame_count: int
    frames: bytes


def _jcs_number(value: int | float) -> str:
    """Serialize the bounded numeric domain used by this contract as RFC 8785."""
    if isinstance(value, bool) or not math.isfinite(float(value)):
        raise ValueError("non-finite number")
    if float(value).is_integer():
        return str(int(value))
    # Contract numbers are bounded decimal inputs. Python's shortest-roundtrip
    # representation matches ECMAScript for this non-exponential range.
    return repr(float(value))


def jcs_bytes(value: Any) -> bytes:
    """Canonicalize the JSON types used in commitment descriptors.

    It is intentionally small and rejects unsupported types instead of silently
    inventing a representation.
    """
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _jcs_number(value).encode("ascii")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if isinstance(value, list):
        return b"[" + b",".join(jcs_bytes(item) for item in value) + b"]"
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        members = []
        for key in sorted(value):
            members.append(jcs_bytes(key) + b":" + jcs_bytes(value[key]))
        return b"{" + b",".join(members) + b"}"
    raise TypeError("unsupported JCS value")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def matched_settings_descriptor(*, speed: float, num_step: int) -> dict[str, Any]:
    return {
        "speed": speed,
        "numStep": num_step,
        "mixedLanguage": True,
        "outputRate": OUTPUT_SAMPLE_RATE,
        "outputChannels": OUTPUT_CHANNELS,
        "outputSubtype": OUTPUT_SUBTYPE,
    }


def request_commitment_descriptor(
    *,
    ref_audio_sha256: str,
    ref_text: str,
    text: str,
    speed: float,
    num_step: int,
    seed: int,
    experiment_profile: str,
    normalizer_version: str,
) -> dict[str, Any]:
    return {
        "contractVersion": CONTRACT_VERSION,
        "mode": MODE,
        "refAudioSha256": ref_audio_sha256,
        "refTextSha256": sha256_hex(ref_text.encode("utf-8")),
        "textSha256": sha256_hex(text.encode("utf-8")),
        "speed": speed,
        "numStep": num_step,
        "mixedLanguage": True,
        "seed": seed,
        "experimentProfile": experiment_profile,
        "normalizerVersion": normalizer_version,
    }


def compute_matched_settings_sha256(*, speed: float, num_step: int) -> str:
    return sha256_hex(jcs_bytes(matched_settings_descriptor(speed=speed, num_step=num_step)))


def compute_request_commitment_sha256(
    *,
    ref_audio_sha256: str,
    ref_text: str,
    text: str,
    speed: float,
    num_step: int,
    seed: int,
    experiment_profile: str,
    normalizer_version: str,
) -> str:
    descriptor = request_commitment_descriptor(
        ref_audio_sha256=ref_audio_sha256,
        ref_text=ref_text,
        text=text,
        speed=speed,
        num_step=num_step,
        seed=seed,
        experiment_profile=experiment_profile,
        normalizer_version=normalizer_version,
    )
    return sha256_hex(jcs_bytes(descriptor))


def _require_exact_fields(payload: dict[str, Any]) -> None:
    if set(payload) != REQUEST_FIELDS:
        raise ContractError(ErrorCode.INVALID_FIELDS)


def _require_text(payload: dict[str, Any], name: str, maximum: int) -> str:
    value = payload[name]
    empty_code = ErrorCode.INVALID_REF_TEXT if name == "ref_text" else ErrorCode.INVALID_TEXT
    long_code = ErrorCode.REF_TEXT_TOO_LONG if name == "ref_text" else ErrorCode.TEXT_TOO_LONG
    if not isinstance(value, str) or not value or not value.strip():
        raise ContractError(empty_code)
    if len(value) > maximum:
        raise ContractError(long_code)
    return value


def inspect_pcm_wav(raw: bytes) -> PcmWavInfo:
    """Parse one complete RIFF/PCM stream and consume every declared frame.

    ``wave.open`` alone accepts bytes after the RIFF boundary and can report a
    forged frame count without proving that the data chunk is complete.  The
    explicit RIFF walk closes both gaps before the standard decoder is used.
    """
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
    declared_end = struct.unpack_from("<I", raw, 4)[0] + 8
    if declared_end != len(raw):
        raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)

    offset = 12
    format_fields: tuple[int, int, int, int, int, int] | None = None
    data: bytes | None = None
    while offset < declared_end:
        if offset + 8 > declared_end:
            raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
        chunk_id = raw[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", raw, offset + 4)[0]
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        padded_end = chunk_end + (chunk_size & 1)
        if chunk_end > declared_end or padded_end > declared_end:
            raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
        if chunk_id == b"fmt ":
            if format_fields is not None or chunk_size < 16:
                raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
            format_fields = struct.unpack_from("<HHIIHH", raw, chunk_start)
        elif chunk_id == b"data":
            if data is not None:
                raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
            data = raw[chunk_start:chunk_end]
        offset = padded_end
    if offset != declared_end or format_fields is None or data is None:
        raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)

    audio_format, channels, sample_rate, byte_rate, block_align, bits_per_sample = format_fields
    sample_width = bits_per_sample // 8
    valid_format = (
        audio_format == 1
        and 1 <= channels <= 8
        and sample_width in {1, 2, 3, 4}
        and bits_per_sample == sample_width * 8
        and 8_000 <= sample_rate <= 192_000
        and block_align == channels * sample_width
        and byte_rate == sample_rate * block_align
        and len(data) % block_align == 0
    )
    if not valid_format:
        raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
    frame_count = len(data) // block_align
    try:
        with wave.open(io.BytesIO(raw), "rb") as reader:
            if (
                reader.getcomptype() != "NONE"
                or reader.getnchannels() != channels
                or reader.getsampwidth() != sample_width
                or reader.getframerate() != sample_rate
                or reader.getnframes() != frame_count
            ):
                raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
            decoded = reader.readframes(frame_count)
            if len(decoded) != len(data) or decoded != data or reader.readframes(1) != b"":
                raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT)
    except (EOFError, wave.Error):
        raise ContractError(ErrorCode.INVALID_REF_AUDIO_FORMAT) from None
    return PcmWavInfo(
        channels=channels,
        sample_width=sample_width,
        sample_rate=sample_rate,
        frame_count=frame_count,
        frames=data,
    )


def _decode_reference(value: Any) -> tuple[bytes, int]:
    if not isinstance(value, str) or not value or len(value) > MAX_REF_AUDIO_BASE64_CHARS:
        code = ErrorCode.REF_AUDIO_TOO_LARGE if isinstance(value, str) and len(value) > MAX_REF_AUDIO_BASE64_CHARS else ErrorCode.INVALID_REF_AUDIO
        raise ContractError(code)
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise ContractError(ErrorCode.INVALID_REF_AUDIO) from None
    if not raw or base64.b64encode(raw).decode("ascii") != value:
        raise ContractError(ErrorCode.INVALID_REF_AUDIO)
    if len(raw) > MAX_REF_AUDIO_BYTES:
        raise ContractError(ErrorCode.REF_AUDIO_TOO_LARGE)
    wav = inspect_pcm_wav(raw)
    duration = wav.frame_count / wav.sample_rate
    if not MIN_REF_DURATION_SECONDS <= duration <= MAX_REF_DURATION_SECONDS:
        raise ContractError(ErrorCode.INVALID_REF_DURATION)
    return raw, round(duration * OUTPUT_SAMPLE_RATE)


def parse_request(payload: Any) -> CloneRequest:
    if not isinstance(payload, dict):
        raise ContractError(ErrorCode.INVALID_INPUT)
    _require_exact_fields(payload)
    if isinstance(payload["contract_version"], bool) or payload["contract_version"] != CONTRACT_VERSION:
        raise ContractError(ErrorCode.INVALID_CONTRACT_VERSION)
    if payload["mode"] != MODE:
        raise ContractError(ErrorCode.INVALID_MODE)

    ref_audio, ref_duration_samples = _decode_reference(payload["ref_audio_b64"])
    ref_audio_sha256 = sha256_hex(ref_audio)
    ref_text = _require_text(payload, "ref_text", MAX_REF_TEXT_CHARACTERS)
    text = _require_text(payload, "text", MAX_TEXT_CHARACTERS)

    speed_raw = payload["speed"]
    if isinstance(speed_raw, bool) or not isinstance(speed_raw, (int, float)) or not math.isfinite(float(speed_raw)):
        raise ContractError(ErrorCode.INVALID_SPEED)
    speed = float(speed_raw)
    if not 0.3 <= speed <= 3.0:
        raise ContractError(ErrorCode.INVALID_SPEED)

    num_step = payload["num_step"]
    if isinstance(num_step, bool) or not isinstance(num_step, int) or not 4 <= num_step <= 64:
        raise ContractError(ErrorCode.INVALID_NUM_STEP)
    if payload["mixed_language"] is not True:
        raise ContractError(ErrorCode.INVALID_MIXED_LANGUAGE)
    seed = payload["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647:
        raise ContractError(ErrorCode.INVALID_SEED)
    profile = payload["experiment_profile"]
    if not isinstance(profile, str) or profile not in EXPERIMENT_PROFILES:
        raise ContractError(ErrorCode.INVALID_EXPERIMENT_PROFILE)
    normalizer_version = payload["normalizer_version"]
    if not isinstance(normalizer_version, str) or not SAFE_VERSION.fullmatch(normalizer_version):
        raise ContractError(ErrorCode.INVALID_NORMALIZER_VERSION)
    request_commitment = payload["request_commitment_sha256"]
    matched_commitment = payload["matched_settings_sha256"]
    if not isinstance(request_commitment, str) or not isinstance(matched_commitment, str):
        raise ContractError(ErrorCode.INVALID_COMMITMENT)
    if not LOWER_HEX_64.fullmatch(request_commitment) or not LOWER_HEX_64.fullmatch(matched_commitment):
        raise ContractError(ErrorCode.INVALID_COMMITMENT)

    expected_request = compute_request_commitment_sha256(
        ref_audio_sha256=ref_audio_sha256,
        ref_text=ref_text,
        text=text,
        speed=speed,
        num_step=num_step,
        seed=seed,
        experiment_profile=profile,
        normalizer_version=normalizer_version,
    )
    if request_commitment != expected_request:
        raise ContractError(ErrorCode.REQUEST_COMMITMENT_MISMATCH)
    expected_settings = compute_matched_settings_sha256(speed=speed, num_step=num_step)
    if matched_commitment != expected_settings:
        raise ContractError(ErrorCode.MATCHED_SETTINGS_MISMATCH)

    return CloneRequest(
        ref_audio=ref_audio,
        ref_audio_sha256=ref_audio_sha256,
        ref_duration_samples=ref_duration_samples,
        ref_text=ref_text,
        text=text,
        speed=speed,
        num_step=num_step,
        mixed_language=True,
        seed=seed,
        experiment_profile=profile,
        normalizer_version=normalizer_version,
        request_commitment_sha256=request_commitment,
        matched_settings_sha256=matched_commitment,
    )


def failure_envelope(code: ErrorCode) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code.value, "message": ERROR_MESSAGES[code]}}

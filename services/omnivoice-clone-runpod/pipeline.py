"""Profile-driven clone pipeline with fail-closed optional stages."""

from __future__ import annotations

from dataclasses import dataclass, fields
import hashlib
import math
from pathlib import Path
import tempfile
import time
from typing import Any, Callable

from contract import CloneRequest, ErrorCode, inspect_pcm_wav


SAMPLE_RATE = 24_000
MAX_WAV_BYTES = 7_000_000
MAX_WATERMARK_FRAME_PROBABILITIES = 4_096
MIN_REFERENCE_SAMPLES_24K = 5 * SAMPLE_RATE - 2
MAX_REFERENCE_SAMPLES_24K = 15 * SAMPLE_RATE
MAX_REFERENCE_SAMPLES_44K = 15 * 44_100 + 8
MAX_OUTPUT_SAMPLES_24K = (MAX_WAV_BYTES - 44) // 2
MAX_OUTPUT_SAMPLES_16K = math.ceil(MAX_OUTPUT_SAMPLES_24K * 16_000 / SAMPLE_RATE) + 8
MAX_PIPELINE_TIMING_MS = 540_000
BEST_OF = 3
CLASS_TEMPERATURE = 0.8
CONTROL_GUIDANCE = 2.5
QUALITY_GUIDANCE = 2.0
PITCH_WEIGHT = 0.15
CANDIDATE_AUDIO_HASH_DOMAIN = "float32-le-mono-24000-v1"
WATERMARK_INTERNAL_HASH_DOMAIN = "float32-le-mono-16000-v1"
DELIVERED_AUDIO_HASH_DOMAIN = "pcm-s16le-mono-24000-wav-data-v1"
WATERMARK_EVIDENCE_VERSION = 1

OMNIVOICE_SOURCE_COMMIT = "346bb75330980a236540d61a0808d00767c0973b"
OMNIVOICE_MODEL_REVISION = "c5fdb5ccb189668d56333f77ba2629f4cd7535f4"
DEMUCS_SOURCE_COMMIT = "e976d93ecc3865e5757426930257e200846a520a"
DEMUCS_SIGNATURE = "955717e8"
AUDIOSEAL_SOURCE_COMMIT = "e63a8a0e5cdf7bb797159c92ba15961557fe9bd2"
AUDIOSEAL_MODEL_REVISION = "3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba"


STAGE_IDENTITIES = {
    "speech_text_attestation": "application-speech-text/no-worker-rewrite-v1",
    "reference_decode": "riff-wave/mono-24000-pcm16-v1",
    "reference_peak_normalize": "float32/peak-0.95-v1",
    "reference_resample_24000": "scipy-resample-poly/mono-24000-v1",
    "demucs_reference_enhancement": (
        f"demucs/{DEMUCS_SOURCE_COMMIT}/{DEMUCS_SIGNATURE}/"
        "shifts-0_split-true_overlap-0.25_segment-7/vocals-mean-mono"
    ),
    "omnivoice_prompt": f"omnivoice/{OMNIVOICE_SOURCE_COMMIT}/zero-shot-clone-prompt",
    "omnivoice_generate_three": (
        f"omnivoice/{OMNIVOICE_MODEL_REVISION}/best-of-3/temperature-0.8/seed-sequence-v1"
    ),
    "speaker_cosine_rank": "resemblyzer/cosine/max-v1",
    "thai_dominant_segmentation": "thai-english-v13/merge-english-runs-max4words-into-thai-v1",
    "speaker_pitch_rank": "resemblyzer+librosa.pyin-C2-C6/cosine+0.15*pitch-v1",
    "audioseal_resample_16000": "scipy-resample-poly/mono-16000-v1",
    "audioseal_embed": (
        f"audioseal-0.2.0/{AUDIOSEAL_SOURCE_COMMIT}/{AUDIOSEAL_MODEL_REVISION}/"
        "16bits/message-1011001011010110/alpha-1.0"
    ),
    "audioseal_resample_24000": "scipy-resample-poly/mono-24000/preserve-samples-v1",
    "audioseal_detect": "audioseal-0.2.0/threshold-0.5/message-threshold-0.5/positive-gt-0.5",
    "output_validate_pcm16": "wave/mono-24000-pcm16/max-7000000-v1",
}

_CONTROL_STAGES = (
    "speech_text_attestation",
    "reference_decode",
    "reference_resample_24000",
    "omnivoice_prompt",
    "omnivoice_generate_three",
    "speaker_cosine_rank",
    "output_validate_pcm16",
)

PROFILE_STAGES = {
    "control-v1": _CONTROL_STAGES,
    "reference-enhancement-v1": (
        "speech_text_attestation",
        "reference_decode",
        "demucs_reference_enhancement",
        "reference_peak_normalize",
        "reference_resample_24000",
        "omnivoice_prompt",
        "omnivoice_generate_three",
        "speaker_cosine_rank",
        "output_validate_pcm16",
    ),
    "text-normalization-v1": _CONTROL_STAGES,
    "guidance-ranking-v1": (
        *_CONTROL_STAGES[:-2],
        "speaker_pitch_rank",
        "output_validate_pcm16",
    ),
    "watermark-v1": (
        *_CONTROL_STAGES[:-1],
        "audioseal_resample_16000",
        "audioseal_embed",
        "audioseal_resample_24000",
        "audioseal_detect",
        "output_validate_pcm16",
    ),
    "combined-quality-v1": (
        "speech_text_attestation",
        "reference_decode",
        "demucs_reference_enhancement",
        "reference_peak_normalize",
        "reference_resample_24000",
        "omnivoice_prompt",
        "omnivoice_generate_three",
        "speaker_pitch_rank",
        "output_validate_pcm16",
    ),
    "combined-quality-thai-dominant-v1": (
        "speech_text_attestation",
        "thai_dominant_segmentation",
        "reference_decode",
        "demucs_reference_enhancement",
        "reference_peak_normalize",
        "reference_resample_24000",
        "omnivoice_prompt",
        "omnivoice_generate_three",
        "speaker_pitch_rank",
        "output_validate_pcm16",
    ),
}

CONTROL_PARITY = {
    "workerBoundary": "audited-v13-clone",
    "status": "fixture-ready",
    "speechTextPolicy": "application-owned-exact-bytes",
    "baseSpeedMultiplier": 1.4,
    "candidateCount": BEST_OF,
    "classTemperature": CLASS_TEMPERATURE,
    "guidance": CONTROL_GUIDANCE,
    "ranking": "maximum-speaker-cosine",
    "rankingReferenceDomain": "final-reference-wav/decoded-pcm16-mono-24000",
    "mixedLanguageSegmentation": "thai-english-v13",
    "output": {"rate": SAMPLE_RATE, "channels": 1, "subtype": "PCM_16"},
    "watermark": False,
    "referencePreprocessing": "audited-v13-pydub-downmix-resample-without-peak-normalization",
    "paidAblationGate": "requires-real-gpu-audio-parity-fixture",
}


class PipelineError(RuntimeError):
    def __init__(self, code: ErrorCode):
        self.code = code
        super().__init__(code.value)


@dataclass
class ReferenceArtifact:
    path: Path
    audio: Any
    input_sha256: str
    canonical_sha256: str
    effective_sha256: str
    input_samples_24000: int
    effective_samples_24000: int
    enhanced: bool
    pre_peak: float
    post_peak: float
    pre_rms: float
    post_rms: float
    pre_samples: int
    post_samples: int
    pre_clipping_samples: int
    post_clipping_samples: int


@dataclass
class WatermarkArtifact:
    audio: Any
    detect_fraction: float
    decoded_message: str
    pre_embed_sha256: str
    watermarked_16k_sha256: str
    delivered_24k_sha256: str
    samples_16k_pre_embed: int
    samples_16k_post_embed: int
    samples_24k_output: int
    frame_probabilities: list[float]
    bit_probabilities: list[float]
    bit_error_rate: float


@dataclass
class PipelineResult:
    wav_bytes: bytes
    num_samples: int
    stages: list[dict[str, str]]
    metrics: dict[str, Any]
    timing_ms: dict[str, Any]


def _elapsed_ms(started: float, clock: Callable[[], float]) -> int:
    finished = clock()
    if type(started) is not float or type(finished) is not float:
        raise PipelineError(ErrorCode.INTERNAL_ERROR)
    elapsed = (finished - started) * 1_000
    if not math.isfinite(elapsed) or not 0 <= elapsed <= MAX_PIPELINE_TIMING_MS:
        raise PipelineError(ErrorCode.INTERNAL_ERROR)
    return round(elapsed)


def _require_finite_score(value: Any, code: ErrorCode) -> float:
    if type(value) is not float or not math.isfinite(value):
        raise PipelineError(code)
    return value


def _bounded_metric(value: Any, *, minimum: float, maximum: float, code: ErrorCode) -> float:
    metric = _require_finite_score(value, code)
    if not minimum <= metric <= maximum:
        raise PipelineError(code)
    return metric


def _serialized_metric(value: float) -> float:
    return round(value, 8)


def _bounded_counter(value: Any, *, minimum: int, maximum: int, code: ErrorCode) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise PipelineError(code)
    return value


def _require_exact_dataclass(value: Any, expected_type: type, code: ErrorCode) -> None:
    expected_fields = {field.name for field in fields(expected_type)}
    if type(value) is not expected_type or set(vars(value)) != expected_fields:
        raise PipelineError(code)


def run_pipeline(
    request: CloneRequest,
    runtime: Any,
    *,
    temp_root: str | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> PipelineResult:
    profile = request.experiment_profile
    expected_stages = PROFILE_STAGES[profile]
    enhance_reference = profile in {
        "reference-enhancement-v1",
        "combined-quality-v1",
        "combined-quality-thai-dominant-v1",
    }
    pitch_ranking = profile in {
        "guidance-ranking-v1",
        "combined-quality-v1",
        "combined-quality-thai-dominant-v1",
    }
    apply_watermark = profile == "watermark-v1"
    segmentation = (
        "thai-dominant-v1"
        if profile == "combined-quality-thai-dominant-v1"
        else "thai-english-v13"
    )
    guidance = QUALITY_GUIDANCE if pitch_ranking else CONTROL_GUIDANCE
    timings = {
        "reference": 0,
        "prompt": 0,
        "synthesis": 0,
        "ranking": 0,
        "watermark": 0,
        "encode": 0,
    }
    total_started = clock()
    reference: ReferenceArtifact | None = None
    prompt: Any = None
    candidates: list[Any] = []
    selected: Any = None
    candidate: Any = None
    watermark_artifact: WatermarkArtifact | None = None
    primary_error: BaseException | None = None

    try:
        with tempfile.TemporaryDirectory(prefix="hero-clone-", dir=temp_root) as temp_dir:
            started = clock()
            try:
                reference = runtime.prepare_reference(
                    request.ref_audio,
                    Path(temp_dir),
                    enhance=enhance_reference,
                )
            except Exception as error:
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED) from error
            timings["reference"] = _elapsed_ms(started, clock)
            _require_exact_dataclass(reference, ReferenceArtifact, ErrorCode.REFERENCE_STAGE_FAILED)
            if type(reference.enhanced) is not bool or reference.enhanced is not enhance_reference:
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)
            # Both hashes commit the final PCM16 frame bytes in the exact prompt
            # WAV domain. Float-only differences that quantize identically are a
            # real model-input no-op and must invalidate an enhancement arm.
            if enhance_reference and reference.canonical_sha256 == reference.effective_sha256:
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)
            input_samples_24000 = _bounded_counter(
                reference.input_samples_24000,
                minimum=MIN_REFERENCE_SAMPLES_24K,
                maximum=MAX_REFERENCE_SAMPLES_24K,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            effective_samples_24000 = _bounded_counter(
                reference.effective_samples_24000,
                minimum=MIN_REFERENCE_SAMPLES_24K - 1,
                maximum=MAX_REFERENCE_SAMPLES_24K + 1,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            if abs(input_samples_24000 - request.ref_duration_samples) > 2:
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)
            for digest in (reference.input_sha256, reference.canonical_sha256, reference.effective_sha256):
                if (
                    not isinstance(digest, str)
                    or len(digest) != 64
                    or any(character not in "0123456789abcdef" for character in digest)
                ):
                    raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)
            if abs(input_samples_24000 - effective_samples_24000) > 1:
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)
            pre_peak = _bounded_metric(
                reference.pre_peak,
                minimum=0.0,
                maximum=64.0,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            post_peak = _bounded_metric(
                reference.post_peak,
                minimum=0.0,
                maximum=1.0,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            pre_rms = _bounded_metric(
                reference.pre_rms,
                minimum=0.0,
                maximum=64.0,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            post_rms = _bounded_metric(
                reference.post_rms,
                minimum=0.0,
                maximum=1.0,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            pre_samples = _bounded_counter(
                reference.pre_samples,
                minimum=MIN_REFERENCE_SAMPLES_24K,
                maximum=MAX_REFERENCE_SAMPLES_44K if enhance_reference else MAX_REFERENCE_SAMPLES_24K,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            post_samples = _bounded_counter(
                reference.post_samples,
                minimum=MIN_REFERENCE_SAMPLES_24K - 1,
                maximum=MAX_REFERENCE_SAMPLES_24K + 1,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            pre_clipping_samples = _bounded_counter(
                reference.pre_clipping_samples,
                minimum=0,
                maximum=pre_samples,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            post_clipping_samples = _bounded_counter(
                reference.post_clipping_samples,
                minimum=0,
                maximum=post_samples,
                code=ErrorCode.REFERENCE_STAGE_FAILED,
            )
            expected_pre_samples = (
                round(input_samples_24000 * 44_100 / SAMPLE_RATE)
                if enhance_reference
                else input_samples_24000
            )
            if abs(pre_samples - expected_pre_samples) > (8 if enhance_reference else 0):
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)
            if post_samples != effective_samples_24000:
                raise PipelineError(ErrorCode.REFERENCE_STAGE_FAILED)

            started = clock()
            try:
                runtime.seed(request.seed)
                prompt = runtime.create_prompt(reference.path, request.ref_text)
            except Exception as error:
                raise PipelineError(ErrorCode.PROMPT_STAGE_FAILED) from error
            timings["prompt"] = _elapsed_ms(started, clock)
            if prompt is None:
                raise PipelineError(ErrorCode.PROMPT_STAGE_FAILED)

            started = clock()
            try:
                candidates = runtime.generate_candidates(
                    prompt=prompt,
                    text=request.text,
                    speed=request.speed,
                    num_step=request.num_step,
                    guidance=guidance,
                    class_temperature=CLASS_TEMPERATURE,
                    mixed_language=True,
                    segmentation=segmentation,
                    count=BEST_OF,
                )
            except Exception as error:
                raise PipelineError(ErrorCode.SYNTHESIS_STAGE_FAILED) from error
            timings["synthesis"] = _elapsed_ms(started, clock)
            if type(candidates) is not list or len(candidates) != BEST_OF:
                raise PipelineError(ErrorCode.SYNTHESIS_STAGE_FAILED)

            started = clock()
            candidate_metrics: list[dict[str, Any]] = []
            raw_ranking_scores: list[float] = []
            try:
                for index, candidate in enumerate(candidates):
                    _bounded_counter(
                        runtime.num_samples(candidate),
                        minimum=1,
                        maximum=MAX_OUTPUT_SAMPLES_24K,
                        code=ErrorCode.RANKING_STAGE_FAILED,
                    )
                    speaker = _bounded_metric(
                        runtime.speaker_cosine(reference.audio, candidate),
                        minimum=-1.0,
                        maximum=1.0,
                        code=ErrorCode.RANKING_STAGE_FAILED,
                    )
                    pitch = None
                    score = speaker
                    if pitch_ranking:
                        pitch = _bounded_metric(
                            runtime.pitch_similarity(reference.audio, candidate),
                            minimum=0.0,
                            maximum=1.0,
                            code=ErrorCode.RANKING_STAGE_FAILED,
                        )
                        score = speaker + PITCH_WEIGHT * pitch
                    raw_ranking_scores.append(score)
                    candidate_metrics.append(
                        {
                            "index": index,
                            "audio_sha256": runtime.audio_sha256(candidate),
                            "audio_sha256_domain": CANDIDATE_AUDIO_HASH_DOMAIN,
                            "samples_24k": runtime.num_samples(candidate),
                            # JSON preserves these Python binary64 numbers on the
                            # boundary. Keeping all ranking operands unrounded lets
                            # an independent validator reproduce near-tie selection.
                            "speaker_cosine": speaker,
                            "pitch_similarity_normalized": pitch,
                            "ranking_score": score,
                        }
                    )
            except PipelineError:
                raise
            except Exception as error:
                raise PipelineError(ErrorCode.RANKING_STAGE_FAILED) from error
            if any(
                not isinstance(metric["audio_sha256"], str)
                or len(metric["audio_sha256"]) != 64
                or any(character not in "0123456789abcdef" for character in metric["audio_sha256"])
                for metric in candidate_metrics
            ):
                raise PipelineError(ErrorCode.RANKING_STAGE_FAILED)
            # max() visits indices in ascending order, so an exact score tie is
            # deterministically awarded to the lowest candidate index.
            selected_index = max(range(BEST_OF), key=lambda index: raw_ranking_scores[index])
            selected = candidates[selected_index]
            timings["ranking"] = _elapsed_ms(started, clock)

            watermark_metrics: dict[str, Any] | None = None
            if apply_watermark:
                started = clock()
                try:
                    watermark_artifact = runtime.apply_watermark(selected)
                except Exception as error:
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED) from error
                timings["watermark"] = _elapsed_ms(started, clock)
                _require_exact_dataclass(
                    watermark_artifact,
                    WatermarkArtifact,
                    ErrorCode.WATERMARK_STAGE_FAILED,
                )
                fraction = _bounded_metric(
                    watermark_artifact.detect_fraction,
                    minimum=0.0,
                    maximum=1.0,
                    code=ErrorCode.WATERMARK_STAGE_FAILED,
                )
                if type(watermark_artifact.frame_probabilities) is not list:
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                frame_probabilities = [
                    _bounded_metric(
                        probability,
                        minimum=0.0,
                        maximum=1.0,
                        code=ErrorCode.WATERMARK_STAGE_FAILED,
                    )
                    for probability in watermark_artifact.frame_probabilities
                ]
                if type(watermark_artifact.bit_probabilities) is not list:
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                bit_probabilities = [
                    _bounded_metric(
                        probability,
                        minimum=0.0,
                        maximum=1.0,
                        code=ErrorCode.WATERMARK_STAGE_FAILED,
                    )
                    for probability in watermark_artifact.bit_probabilities
                ]
                bit_error_rate = _bounded_metric(
                    watermark_artifact.bit_error_rate,
                    minimum=0.0,
                    maximum=1.0,
                    code=ErrorCode.WATERMARK_STAGE_FAILED,
                )
                if (
                    not frame_probabilities
                    or len(frame_probabilities) > MAX_WATERMARK_FRAME_PROBABILITIES
                    or len(bit_probabilities) != 16
                    or fraction <= 0.5
                    or watermark_artifact.decoded_message != "1011001011010110"
                    or bit_error_rate != 0.0
                ):
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                for digest in (
                    watermark_artifact.pre_embed_sha256,
                    watermark_artifact.watermarked_16k_sha256,
                    watermark_artifact.delivered_24k_sha256,
                ):
                    if (
                        not isinstance(digest, str)
                        or len(digest) != 64
                        or any(character not in "0123456789abcdef" for character in digest)
                    ):
                        raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                observed_fraction = sum(value > 0.5 for value in frame_probabilities) / len(frame_probabilities)
                decoded_from_probabilities = "".join("1" if value >= 0.5 else "0" for value in bit_probabilities)
                observed_bit_error_rate = sum(
                    left != right
                    for left, right in zip(decoded_from_probabilities, "1011001011010110")
                ) / 16
                if (
                    abs(observed_fraction - fraction) > 1e-6
                    or decoded_from_probabilities != watermark_artifact.decoded_message
                    or abs(observed_bit_error_rate - bit_error_rate) > 1e-12
                    or watermark_artifact.pre_embed_sha256 == watermark_artifact.watermarked_16k_sha256
                ):
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                samples_16k_pre_embed = _bounded_counter(
                    watermark_artifact.samples_16k_pre_embed,
                    minimum=1,
                    maximum=MAX_OUTPUT_SAMPLES_16K,
                    code=ErrorCode.WATERMARK_STAGE_FAILED,
                )
                samples_16k_post_embed = _bounded_counter(
                    watermark_artifact.samples_16k_post_embed,
                    minimum=1,
                    maximum=MAX_OUTPUT_SAMPLES_16K,
                    code=ErrorCode.WATERMARK_STAGE_FAILED,
                )
                samples_24k_output = _bounded_counter(
                    watermark_artifact.samples_24k_output,
                    minimum=1,
                    maximum=MAX_OUTPUT_SAMPLES_24K,
                    code=ErrorCode.WATERMARK_STAGE_FAILED,
                )
                if samples_16k_pre_embed != samples_16k_post_embed:
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                original_samples = _bounded_counter(
                    runtime.num_samples(selected),
                    minimum=1,
                    maximum=MAX_OUTPUT_SAMPLES_24K,
                    code=ErrorCode.WATERMARK_STAGE_FAILED,
                )
                if (
                    samples_24k_output != original_samples
                    or samples_16k_pre_embed != math.ceil(original_samples * 16_000 / SAMPLE_RATE)
                ):
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)
                selected = watermark_artifact.audio
                watermark_metrics = {
                    "evidence_version": WATERMARK_EVIDENCE_VERSION,
                    "message": "1011001011010110",
                    "alpha": 1.0,
                    "detection_threshold": 0.5,
                    "message_threshold": 0.5,
                    "detect_fraction": _serialized_metric(fraction),
                    "positive": True,
                    "decoded_message": watermark_artifact.decoded_message,
                    "frame_probabilities": [_serialized_metric(value) for value in frame_probabilities],
                    "bit_probabilities": [_serialized_metric(value) for value in bit_probabilities],
                    "bit_error_rate": _serialized_metric(bit_error_rate),
                    "selected_candidate_24k_sha256": candidate_metrics[selected_index]["audio_sha256"],
                    "selected_candidate_24k_sha256_domain": CANDIDATE_AUDIO_HASH_DOMAIN,
                    "pre_embed_sha256": watermark_artifact.pre_embed_sha256,
                    "pre_embed_sha256_domain": WATERMARK_INTERNAL_HASH_DOMAIN,
                    "watermarked_16k_sha256": watermark_artifact.watermarked_16k_sha256,
                    "watermarked_16k_sha256_domain": WATERMARK_INTERNAL_HASH_DOMAIN,
                    "delivered_24k_sha256": watermark_artifact.delivered_24k_sha256,
                    "delivered_24k_sha256_domain": DELIVERED_AUDIO_HASH_DOMAIN,
                    "samples_24k_selected": original_samples,
                    "samples_16k_pre_embed": samples_16k_pre_embed,
                    "samples_16k_post_embed": samples_16k_post_embed,
                    "samples_24k_output": samples_24k_output,
                }

            started = clock()
            try:
                wav_bytes = runtime.encode_pcm16_wav(selected)
                num_samples = _bounded_counter(
                    runtime.num_samples(selected),
                    minimum=1,
                    maximum=MAX_OUTPUT_SAMPLES_24K,
                    code=ErrorCode.OUTPUT_INVALID,
                )
            except Exception as error:
                raise PipelineError(ErrorCode.OUTPUT_INVALID) from error
            timings["encode"] = _elapsed_ms(started, clock)
            if type(wav_bytes) is not bytes or not wav_bytes:
                raise PipelineError(ErrorCode.OUTPUT_INVALID)
            if len(wav_bytes) > MAX_WAV_BYTES:
                raise PipelineError(ErrorCode.OUTPUT_TOO_LARGE)
            try:
                runtime.validate_pcm16_wav(wav_bytes, expected_samples=num_samples)
            except Exception as error:
                raise PipelineError(ErrorCode.OUTPUT_INVALID) from error
            if watermark_metrics is not None:
                try:
                    delivered_pcm16_sha256 = hashlib.sha256(inspect_pcm_wav(wav_bytes).frames).hexdigest()
                except Exception as error:
                    raise PipelineError(ErrorCode.OUTPUT_INVALID) from error
                if delivered_pcm16_sha256 != watermark_metrics["delivered_24k_sha256"]:
                    raise PipelineError(ErrorCode.WATERMARK_STAGE_FAILED)

            stages = [{"name": name, "identity": STAGE_IDENTITIES[name]} for name in expected_stages]
            metrics = {
                "reference": {
                    "input_sha256": reference.input_sha256,
                    "canonical_sha256": reference.canonical_sha256,
                    "effective_sha256": reference.effective_sha256,
                    "input_samples_24000": input_samples_24000,
                    "effective_samples_24000": effective_samples_24000,
                    "enhanced": reference.enhanced,
                    "pre_peak": _serialized_metric(pre_peak),
                    "post_peak": _serialized_metric(post_peak),
                    "pre_rms": _serialized_metric(pre_rms),
                    "post_rms": _serialized_metric(post_rms),
                    "pre_samples": pre_samples,
                    "post_samples": post_samples,
                    "pre_clipping_samples": pre_clipping_samples,
                    "post_clipping_samples": post_clipping_samples,
                },
                "generation": {
                    "candidate_count": BEST_OF,
                    "guidance": guidance,
                    "class_temperature": CLASS_TEMPERATURE,
                },
                "candidates": candidate_metrics,
                "selected_candidate_index": selected_index,
                "ranking_formula": (
                    "speaker_cosine+0.15*pitch_similarity_normalized"
                    if pitch_ranking
                    else "speaker_cosine"
                ),
                "watermark": watermark_metrics,
            }
            timings["total"] = _elapsed_ms(total_started, clock)
            result = PipelineResult(
                wav_bytes=wav_bytes,
                num_samples=num_samples,
                stages=stages,
                metrics=metrics,
                timing_ms=timings,
            )
            return result
    except BaseException as error:
        primary_error = error
        raise
    finally:
        # Drop every request-scoped tensor reference before asking the runtime to
        # collect and empty CUDA caches. The cleanup hook deliberately receives
        # no sensitive objects, so it cannot extend their lifetime.
        reference = None
        prompt = None
        candidates = []
        selected = None
        candidate = None
        watermark_artifact = None
        try:
            runtime.release_sensitive()
        except Exception as cleanup_error:
            if primary_error is None:
                raise PipelineError(ErrorCode.INTERNAL_ERROR) from cleanup_error
            # Never replace the stage-specific primary failure with cleanup. The
            # note is fixed and contains no exception text or path.
            if hasattr(primary_error, "add_note"):
                primary_error.add_note("sensitive runtime cleanup also failed")

"""Concrete, stateless runtime for the clone-only experiment pipeline."""

from __future__ import annotations

import gc
import hashlib
import io
import math
import os
from pathlib import Path
import random
import wave
from typing import Any

import numpy as np

from contract import ContractError, inspect_pcm_wav
from identity import verify_model_artifacts
from language import split_by_language, split_thai_dominant
from pipeline import ReferenceArtifact, WatermarkArtifact


SAMPLE_RATE = 24_000
DEMUCS_RATE = 44_100
AUDIOSEAL_RATE = 16_000
BASE_SPEED_MULTIPLIER = 1.4
PEAK_TARGET = 0.95
FIXED_WATERMARK_BITS = (1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0)


def _float32_mono(audio: Any) -> np.ndarray:
    result = np.asarray(audio, dtype=np.float32)
    if result.ndim != 1 or result.size == 0 or not np.isfinite(result).all():
        raise ValueError("audio must be nonempty finite mono float32")
    return np.ascontiguousarray(result)


def _peak_normalize(audio: np.ndarray) -> np.ndarray:
    result = _float32_mono(audio).copy()
    peak = float(np.max(np.abs(result)))
    if peak > 1e-6:
        result *= PEAK_TARGET / peak
    return result


def _audio_stats(audio: np.ndarray) -> tuple[float, float, int, int]:
    values = _float32_mono(audio)
    peak = float(np.max(np.abs(values)))
    rms = float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))
    clipping = int(np.count_nonzero(np.abs(values) >= 1.0))
    if not math.isfinite(peak) or not math.isfinite(rms) or peak > 64.0 or rms > 64.0:
        raise ValueError("audio statistics are out of range")
    return peak, rms, clipping, int(values.size)


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return _float32_mono(audio).copy()
    from scipy.signal import resample_poly

    divisor = math.gcd(source_rate, target_rate)
    result = resample_poly(
        _float32_mono(audio),
        target_rate // divisor,
        source_rate // divisor,
        padtype="constant",
    )
    return _float32_mono(result)


def _decode_pcm_wav(raw: bytes) -> tuple[np.ndarray, int]:
    info = inspect_pcm_wav(raw)
    if info.sample_width == 1:
        values = (np.frombuffer(info.frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif info.sample_width == 2:
        values = np.frombuffer(info.frames, dtype="<i2").astype(np.float32) / 32768.0
    elif info.sample_width == 3:
        octets = np.frombuffer(info.frames, dtype=np.uint8).reshape(-1, 3)
        integers = (
            octets[:, 0].astype(np.int32)
            | (octets[:, 1].astype(np.int32) << 8)
            | (octets[:, 2].astype(np.int32) << 16)
        )
        integers = np.where(integers & 0x800000, integers - 0x1000000, integers)
        values = integers.astype(np.float32) / 8388608.0
    else:
        values = np.frombuffer(info.frames, dtype="<i4").astype(np.float32) / 2147483648.0
    channels = values.reshape(-1, info.channels)
    return _float32_mono(channels.mean(axis=1, dtype=np.float32)), info.sample_rate


def _v13_reference_audio(raw: bytes) -> np.ndarray:
    """Reproduce audited-v13 pydub downmix/resample on a validated PCM WAV."""
    inspect_pcm_wav(raw)
    from pydub import AudioSegment

    segment = AudioSegment.from_file(io.BytesIO(raw), format="wav")
    canonical = segment.set_channels(1).set_frame_rate(SAMPLE_RATE)
    samples = np.asarray(canonical.get_array_of_samples())
    denominator = float(1 << (8 * canonical.sample_width - 1))
    return _float32_mono(samples.astype(np.float32) / denominator)


def _effective_speed(speed: float) -> float:
    return max(0.31, min(2.99, speed * BASE_SPEED_MULTIPLIER))


def _pcm16_bytes(audio: np.ndarray) -> bytes:
    bounded = np.clip(_float32_mono(audio), -1.0, 32767.0 / 32768.0)
    return np.rint(bounded * 32768.0).astype("<i2").tobytes()


def _decode_pcm16_frames(frames: bytes) -> np.ndarray:
    if not frames or len(frames) % 2:
        raise ValueError("invalid PCM16 frame bytes")
    return np.ascontiguousarray(np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0)


def _prompt_pcm16_sha256(audio: np.ndarray) -> str:
    """Commit the exact PCM16 frames consumed after the prompt WAV is decoded."""
    return hashlib.sha256(_pcm16_bytes(audio)).hexdigest()


def _wav_bytes(audio: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(SAMPLE_RATE)
        writer.setcomptype("NONE", "not compressed")
        writer.writeframes(_pcm16_bytes(audio))
    return buffer.getvalue()


def _audio_sha256(audio: np.ndarray) -> str:
    canonical = _float32_mono(audio).astype("<f4", copy=False)
    return hashlib.sha256(canonical.tobytes()).hexdigest()


class CloneRuntime:
    """Loads only model code/checkpoints needed for zero-shot cloning."""

    def __init__(self, *, model_root: Path = Path("/opt/models"), verify_artifacts: bool = True):
        self.model_root = model_root
        if verify_artifacts:
            verify_model_artifacts(model_root)
        self.device = self._require_cuda()
        self.model = self._load_omnivoice()
        self._speaker_encoder = None
        self._demucs_separator = None
        self._watermark_generator = None
        self._watermark_detector = None

    @staticmethod
    def _require_cuda() -> str:
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required")
        return "cuda"

    def _load_omnivoice(self):
        import torch
        from omnivoice import OmniVoice

        model = OmniVoice.from_pretrained(
            str(self.model_root / "omnivoice"),
            device_map=self.device,
            dtype=torch.float16,
            low_cpu_mem_usage=True,
        )
        model.eval()
        return model

    def _get_demucs(self):
        if self._demucs_separator is None:
            from demucs.api import Separator

            # The image carries only the hash-verified single htdemucs model,
            # so resolve it by signature without a network-backed model list.
            self._demucs_separator = Separator(
                model="955717e8",
                repo=self.model_root / "demucs",
                device=self.device,
                shifts=0,
                split=True,
                overlap=0.25,
                segment=7,
                jobs=0,
                progress=False,
            )
        return self._demucs_separator

    def _get_speaker_encoder(self):
        if self._speaker_encoder is None:
            from resemblyzer import VoiceEncoder

            self._speaker_encoder = VoiceEncoder(
                device=self.device,
                verbose=False,
                weights_fpath=self.model_root / "resemblyzer" / "pretrained.pt",
            )
        return self._speaker_encoder

    def _get_audioseal(self):
        if self._watermark_generator is None or self._watermark_detector is None:
            import torch
            from audioseal import AudioSeal

            torch._dynamo.config.disable = True
            self._watermark_generator = AudioSeal.load_generator(
                str(self.model_root / "audioseal" / "generator_base.pth"),
                nbits=16,
                device=self.device,
            )
            self._watermark_detector = AudioSeal.load_detector(
                str(self.model_root / "audioseal" / "detector_base.pth"),
                nbits=16,
                device=self.device,
            )
            self._watermark_generator.eval()
            self._watermark_detector.eval()
        return self._watermark_generator, self._watermark_detector

    def prepare_reference(self, raw: bytes, temp_dir: Path, *, enhance: bool) -> ReferenceArtifact:
        original, source_rate = _decode_pcm_wav(raw)
        canonical_v13 = _v13_reference_audio(raw)
        canonical_effective = canonical_v13
        treatment_pre_normalization = canonical_v13
        if enhance:
            import torch

            separator = self._get_demucs()
            tensor = torch.from_numpy(original).to(self.device).reshape(1, -1)
            _, stems = separator.separate_tensor(tensor, sr=source_rate)
            if "vocals" not in stems:
                raise RuntimeError("vocals stem missing")
            vocals = stems["vocals"]
            if getattr(vocals, "ndim", 0) != 2 or vocals.shape[0] != 2 or vocals.shape[1] <= 0:
                raise RuntimeError("vocals stem invalid")
            treatment_pre_normalization = vocals.mean(dim=0).detach().cpu().numpy().astype(np.float32)
        pre_peak, pre_rms, pre_clipping, pre_samples = _audio_stats(treatment_pre_normalization)
        treatment = _peak_normalize(treatment_pre_normalization) if enhance else treatment_pre_normalization
        effective = _resample(treatment, DEMUCS_RATE if enhance else SAMPLE_RATE, SAMPLE_RATE)
        reference_path = temp_dir / "reference.wav"
        reference_wav = _wav_bytes(effective)
        reference_info = inspect_pcm_wav(reference_wav)
        if (
            reference_info.channels != 1
            or reference_info.sample_width != 2
            or reference_info.sample_rate != SAMPLE_RATE
        ):
            raise RuntimeError("prompt reference WAV is not exact PCM16 mono 24 kHz")
        prompt_audio = _decode_pcm16_frames(reference_info.frames)
        post_peak, post_rms, post_clipping, post_samples = _audio_stats(prompt_audio)
        reference_path.write_bytes(reference_wav)
        os.chmod(reference_path, 0o600)
        return ReferenceArtifact(
            path=reference_path,
            audio=prompt_audio,
            input_sha256=hashlib.sha256(raw).hexdigest(),
            canonical_sha256=_prompt_pcm16_sha256(canonical_effective),
            effective_sha256=hashlib.sha256(reference_info.frames).hexdigest(),
            input_samples_24000=int(canonical_v13.size),
            effective_samples_24000=int(reference_info.frame_count),
            enhanced=enhance,
            pre_peak=pre_peak,
            post_peak=post_peak,
            pre_rms=pre_rms,
            post_rms=post_rms,
            pre_samples=pre_samples,
            post_samples=post_samples,
            pre_clipping_samples=pre_clipping,
            post_clipping_samples=post_clipping,
        )

    def seed(self, seed: int) -> None:
        import torch

        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True

    def create_prompt(self, reference_path: Path, ref_text: str):
        import torch

        with torch.no_grad():
            return self.model.create_voice_clone_prompt(
                ref_audio=str(reference_path),
                ref_text=ref_text,
            )

    def generate_candidates(
        self,
        *,
        prompt: Any,
        text: str,
        speed: float,
        num_step: int,
        guidance: float,
        class_temperature: float,
        mixed_language: bool,
        segmentation: str,
        count: int,
    ) -> list[np.ndarray]:
        import torch
        from omnivoice.models.omnivoice import OmniVoiceGenerationConfig

        if mixed_language is not True or count != 3:
            raise ValueError("invalid fixed generation settings")
        if segmentation == "thai-english-v13":
            split = split_by_language
        elif segmentation == "thai-dominant-v1":
            split = split_thai_dominant
        else:
            raise ValueError("invalid segmentation policy")
        candidates: list[np.ndarray] = []
        for _ in range(count):
            segments: list[np.ndarray] = []
            for segment, language in split(text):
                config = OmniVoiceGenerationConfig(num_step=num_step)
                config.guidance_scale = guidance
                config.class_temperature = class_temperature
                with torch.no_grad():
                    generated = self.model.generate(
                        text=segment,
                        speed=_effective_speed(speed),
                        language=language,
                        voice_clone_prompt=prompt,
                        generation_config=config,
                    )
                segments.append(_float32_mono(generated[0]))
            if not segments:
                raise RuntimeError("no generated segments")
            candidates.append(np.ascontiguousarray(np.concatenate(segments)))
        return candidates

    def _speaker_embedding(self, audio: np.ndarray) -> np.ndarray:
        from resemblyzer import preprocess_wav

        processed = preprocess_wav(_float32_mono(audio), source_sr=SAMPLE_RATE)
        embedding = self._get_speaker_encoder().embed_utterance(processed)
        return np.asarray(embedding, dtype=np.float32)

    def speaker_cosine(self, reference: np.ndarray, candidate: np.ndarray) -> float:
        left = self._speaker_embedding(reference)
        right = self._speaker_embedding(candidate)
        denominator = float(np.linalg.norm(left) * np.linalg.norm(right)) + 1e-8
        if denominator <= 1e-8:
            raise ValueError("invalid speaker embedding")
        return float(np.dot(left, right) / denominator)

    @staticmethod
    def _pitch_summary(audio: np.ndarray) -> tuple[float, float]:
        import librosa

        pitches, _voiced, _probability = librosa.pyin(
            _float32_mono(audio),
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C6"),
            sr=SAMPLE_RATE,
        )
        voiced = np.asarray(pitches, dtype=np.float64)
        voiced = voiced[np.isfinite(voiced) & (voiced > 0)]
        if voiced.size == 0:
            raise ValueError("unvoiced pitch")
        midi = 69.0 + 12.0 * np.log2(voiced / 440.0)
        return float(np.median(midi)), float(np.percentile(midi, 75) - np.percentile(midi, 25))

    def pitch_similarity(self, reference: np.ndarray, candidate: np.ndarray) -> float:
        reference_median, reference_iqr = self._pitch_summary(reference)
        candidate_median, candidate_iqr = self._pitch_summary(candidate)
        distance = abs(reference_median - candidate_median) + 0.5 * abs(reference_iqr - candidate_iqr)
        return max(0.0, min(1.0, 1.0 - distance / 24.0))

    def apply_watermark(self, audio: np.ndarray) -> WatermarkArtifact:
        import torch

        generator, detector = self._get_audioseal()
        original = _float32_mono(audio)
        master_16k = _resample(original, SAMPLE_RATE, AUDIOSEAL_RATE)
        message = torch.tensor([FIXED_WATERMARK_BITS], dtype=torch.int64, device=self.device)
        tensor = torch.from_numpy(master_16k).to(self.device).reshape(1, 1, -1)
        with torch.no_grad():
            marked_tensor = generator(tensor, message=message, alpha=1.0)
        marked_16k = _float32_mono(marked_tensor.reshape(-1).detach().cpu().numpy())
        if marked_16k.size != master_16k.size:
            raise RuntimeError("watermark changed sample count")
        delivered = _resample(marked_16k, AUDIOSEAL_RATE, SAMPLE_RATE)
        if delivered.size > original.size:
            delivered = delivered[: original.size]
        elif delivered.size < original.size:
            delivered = np.pad(delivered, (0, original.size - delivered.size))
        detect_input = _resample(delivered, SAMPLE_RATE, AUDIOSEAL_RATE)
        detect_tensor = torch.from_numpy(detect_input).to(self.device).reshape(1, 1, -1)
        with torch.no_grad():
            detect_fraction, decoded = detector.detect_watermark(
                detect_tensor,
                detection_threshold=0.5,
                message_threshold=0.5,
            )
            frame_scores, bit_scores = detector(detect_tensor)
        decoded_array = np.asarray(decoded.detach().cpu().numpy()).reshape(-1)
        decoded_message = "".join("1" if float(bit) >= 0.5 else "0" for bit in decoded_array[:16])
        frame_array = np.asarray(frame_scores.detach().cpu().numpy(), dtype=np.float64)
        bit_array = np.asarray(bit_scores.detach().cpu().numpy(), dtype=np.float64).reshape(-1)
        if frame_array.ndim != 3 or frame_array.shape[0] != 1 or frame_array.shape[1] != 2:
            raise RuntimeError("invalid watermark frame score shape")
        frame_probabilities = frame_array[0, 1, :].tolist()
        bit_probabilities = bit_array[:16].tolist()
        if len(bit_probabilities) != 16:
            raise RuntimeError("invalid watermark bit score shape")
        bit_error_rate = sum(
            int((probability >= 0.5) != bool(expected))
            for probability, expected in zip(bit_probabilities, FIXED_WATERMARK_BITS)
        ) / len(FIXED_WATERMARK_BITS)
        return WatermarkArtifact(
            audio=delivered,
            detect_fraction=float(detect_fraction.detach().cpu().item()),
            decoded_message=decoded_message,
            pre_embed_sha256=_audio_sha256(master_16k),
            watermarked_16k_sha256=_audio_sha256(marked_16k),
            # This is the exact byte domain returned to callers: the little-endian
            # PCM16 frames embedded in the final WAV, not the internal float32
            # resampling buffer.
            delivered_24k_sha256=hashlib.sha256(_pcm16_bytes(delivered)).hexdigest(),
            samples_16k_pre_embed=int(master_16k.size),
            samples_16k_post_embed=int(marked_16k.size),
            samples_24k_output=int(delivered.size),
            frame_probabilities=frame_probabilities,
            bit_probabilities=bit_probabilities,
            bit_error_rate=bit_error_rate,
        )

    @staticmethod
    def audio_sha256(audio: np.ndarray) -> str:
        return _audio_sha256(audio)

    @staticmethod
    def num_samples(audio: np.ndarray) -> int:
        return int(_float32_mono(audio).size)

    @staticmethod
    def encode_pcm16_wav(audio: np.ndarray) -> bytes:
        return _wav_bytes(audio)

    @staticmethod
    def validate_pcm16_wav(raw: bytes, *, expected_samples: int) -> None:
        try:
            info = inspect_pcm_wav(raw)
        except ContractError as error:
            raise ValueError("invalid output WAV") from error
        valid = (
            info.channels == 1
            and info.sample_width == 2
            and info.sample_rate == SAMPLE_RATE
            and info.frame_count == expected_samples
        )
        if not valid:
            raise ValueError("invalid output WAV")

    @staticmethod
    def release_sensitive() -> None:
        gc.collect()
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()

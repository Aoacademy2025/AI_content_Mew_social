from __future__ import annotations

import base64
import copy
from dataclasses import replace
import hashlib
import io
import json
import logging
import math
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import types
import unittest
import wave
import weakref
from unittest.mock import patch

import numpy as np


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import identity as identity_module  # noqa: E402
from contract import (  # noqa: E402
    CONTRACT_VERSION,
    ContractError,
    ErrorCode,
    EXPERIMENT_PROFILES,
    MAX_REF_AUDIO_BASE64_CHARS,
    compute_matched_settings_sha256,
    compute_request_commitment_sha256,
    jcs_bytes,
    matched_settings_descriptor,
    parse_request,
    request_commitment_descriptor,
)
from audited_v13_boundary import (  # noqa: E402
    cosine_similarity as v13_cosine_similarity,
    create_prompt as v13_create_prompt,
    effective_speed as v13_effective_speed,
    exported_reference_pcm16 as v13_exported_reference_pcm16,
    preprocess_reference as v13_preprocess_reference,
)
from handler import handle_job  # noqa: E402
from identity import (  # noqa: E402
    APPROVED_SOURCE_REVISION,
    WorkerIdentity,
    load_worker_identity,
    model_manifest_sha256,
    source_manifest_sha256,
)
from language import split_by_language  # noqa: E402
from pipeline import (  # noqa: E402
    BEST_OF,
    CLASS_TEMPERATURE,
    CONTROL_GUIDANCE,
    CONTROL_PARITY,
    PITCH_WEIGHT,
    PROFILE_STAGES,
    QUALITY_GUIDANCE,
    PipelineError,
    ReferenceArtifact,
    WatermarkArtifact,
    run_pipeline,
)
from runtime import (  # noqa: E402
    CloneRuntime,
    _audio_sha256,
    _effective_speed,
    _pcm16_bytes,
    _peak_normalize,
    _prompt_pcm16_sha256,
    _resample,
    _v13_reference_audio,
)
from verify_image import (  # noqa: E402
    ALLOWED_APP_FILES,
    _extract_authenticated_layer,
    _verify_extracted_rootfs,
    load_oci_image_evidence,
    main as verify_image_main,
    scan_oci_layer_blob,
    scan_filesystem,
    verify_rootfs,
    verify_static,
)


def pcm16_wav(samples: int = 5 * 24_000, *, rate: int = 24_000, channels: int = 1, width: int = 2) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(width)
        writer.setframerate(rate)
        writer.writeframes(b"\x01\x00" * samples * channels)
    return buffer.getvalue()


def valid_payload(*, profile: str = "combined-quality-v1", **overrides):
    raw = overrides.pop("ref_audio", pcm16_wav())
    payload = {
        "contract_version": CONTRACT_VERSION,
        "mode": "clone",
        "ref_audio_b64": base64.b64encode(raw).decode("ascii"),
        "ref_text": "ข้อความอ้างอิง",
        "text": "ข้อความสำหรับสร้างเสียง OpenAI",
        "speed": 1,
        "num_step": 32,
        "mixed_language": True,
        "seed": 20260901,
        "experiment_profile": profile,
        "normalizer_version": "hero-thai-normalizer@abc123",
        "request_commitment_sha256": "0" * 64,
        "matched_settings_sha256": "0" * 64,
    }
    payload.update(overrides)
    raw_decoded = base64.b64decode(payload["ref_audio_b64"], validate=True)
    payload["request_commitment_sha256"] = compute_request_commitment_sha256(
        ref_audio_sha256=hashlib.sha256(raw_decoded).hexdigest(),
        ref_text=payload["ref_text"],
        text=payload["text"],
        speed=float(payload["speed"]),
        num_step=payload["num_step"],
        seed=payload["seed"],
        experiment_profile=payload["experiment_profile"],
        normalizer_version=payload["normalizer_version"],
    )
    payload["matched_settings_sha256"] = compute_matched_settings_sha256(
        speed=float(payload["speed"]),
        num_step=payload["num_step"],
    )
    return payload


def synthetic_oci_layout(
    root: Path,
    *,
    layer_count: int = 2,
    layer_files: dict[int, tuple[str, bytes]] | None = None,
    layer_entries: dict[int, list[tuple[str, str, bytes | str]]] | None = None,
    config_architecture: str = "amd64",
    config_environment: list[str] | None = None,
    config_diff_ids: list[str] | None = None,
    config_history: list[dict] | None = None,
) -> tuple[Path, tuple[str, ...]]:
    layout = root / "oci"
    blob_root = layout / "blobs" / "sha256"
    blob_root.mkdir(parents=True)
    (layout / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}', encoding="utf-8")

    def store(value, media_type):
        raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(raw).hexdigest()
        (blob_root / digest).write_bytes(raw)
        return {"mediaType": media_type, "digest": f"sha256:{digest}", "size": len(raw)}

    layers = []
    diff_ids = []
    for index in range(layer_count):
        archive_bytes = io.BytesIO()
        with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
            entries = (layer_entries or {}).get(index)
            if entries is None:
                relative, content = (layer_files or {}).get(index, (f"clean-{index}.txt", b"clean"))
                entries = [("file", relative, content)]
            for kind, relative, value in entries:
                info = tarfile.TarInfo(relative)
                if kind in {"file", "whiteout"}:
                    content = value if isinstance(value, bytes) else value.encode()
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
                elif kind == "dir":
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                elif kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = str(value)
                    archive.addfile(info)
                elif kind == "hardlink":
                    info.type = tarfile.LNKTYPE
                    info.linkname = str(value)
                    archive.addfile(info)
                elif kind == "character-device":
                    info.type = tarfile.CHRTYPE
                    archive.addfile(info)
                else:
                    raise AssertionError(f"unsupported test archive kind: {kind}")
        raw_layer = archive_bytes.getvalue()
        diff_ids.append("sha256:" + hashlib.sha256(raw_layer).hexdigest())
        layers.append(store(raw_layer, "application/vnd.oci.image.layer.v1.tar"))
    config = store(
        {
            "architecture": config_architecture,
            "os": "linux",
            "config": {"Env": [] if config_environment is None else config_environment},
            "rootfs": {"type": "layers", "diff_ids": diff_ids if config_diff_ids is None else config_diff_ids},
            "history": (
                [{"created_by": f"synthetic layer {index}"} for index in range(layer_count)]
                if config_history is None
                else config_history
            ),
        },
        "application/vnd.oci.image.config.v1+json",
    )
    manifest = store(
        {"schemaVersion": 2, "config": config, "layers": layers},
        "application/vnd.oci.image.manifest.v1+json",
    )
    manifest["platform"] = {"os": "linux", "architecture": "amd64"}
    (layout / "index.json").write_text(
        json.dumps({"schemaVersion": 2, "manifests": [manifest]}, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    return layout, tuple(layer["digest"] for layer in layers)


class ContractTests(unittest.TestCase):
    def assert_code(self, code: ErrorCode, payload) -> None:
        with self.assertRaises(ContractError) as caught:
            parse_request(payload)
        self.assertEqual(caught.exception.code, code)

    def test_exact_valid_contract_and_no_text_rewrite(self):
        payload = valid_payload(text="  คงช่องว่างนี้ไว้  ", ref_text="  อ้างอิงตรงตัว  ")
        request = parse_request(payload)
        self.assertEqual(request.text, payload["text"])
        self.assertEqual(request.ref_text, payload["ref_text"])
        self.assertEqual(request.ref_duration_samples, 120_000)
        self.assertTrue(request.mixed_language)

    def test_only_exact_fields_are_accepted(self):
        payload = valid_payload(extra="forbidden")
        self.assert_code(ErrorCode.INVALID_FIELDS, payload)
        payload = valid_payload()
        del payload["seed"]
        self.assert_code(ErrorCode.INVALID_FIELDS, payload)

    def test_clone_mode_and_version_are_literal(self):
        self.assert_code(ErrorCode.INVALID_MODE, valid_payload(mode="tts"))
        self.assert_code(ErrorCode.INVALID_CONTRACT_VERSION, valid_payload(contract_version=2))
        self.assert_code(ErrorCode.INVALID_CONTRACT_VERSION, valid_payload(contract_version=True))

    def test_base64_is_strict_canonical_and_bounded(self):
        payload = valid_payload()
        payload["ref_audio_b64"] = payload["ref_audio_b64"] + "\n"
        self.assert_code(ErrorCode.INVALID_REF_AUDIO, payload)
        payload = valid_payload()
        payload["ref_audio_b64"] = "A" * (MAX_REF_AUDIO_BASE64_CHARS + 1)
        self.assert_code(ErrorCode.REF_AUDIO_TOO_LARGE, payload)

    def test_supported_pcm_wav_is_duration_normalized_without_narrowing_input_format(self):
        request = parse_request(valid_payload(ref_audio=pcm16_wav(samples=5 * 16_000, rate=16_000)))
        self.assertEqual(request.ref_duration_samples, 5 * 24_000)
        request = parse_request(valid_payload(ref_audio=pcm16_wav(channels=2)))
        self.assertEqual(request.ref_duration_samples, 5 * 24_000)
        self.assert_code(ErrorCode.INVALID_REF_AUDIO_FORMAT, valid_payload(ref_audio=b"not audio"))

    def test_wav_must_be_fully_consistent_with_no_truncation_or_trailing_bytes(self):
        raw = pcm16_wav()
        self.assert_code(ErrorCode.INVALID_REF_AUDIO_FORMAT, valid_payload(ref_audio=raw[:-1]))
        self.assert_code(ErrorCode.INVALID_REF_AUDIO_FORMAT, valid_payload(ref_audio=raw + b"TRAIL"))
        inconsistent = bytearray(raw)
        data_offset = inconsistent.index(b"data")
        struct.pack_into("<I", inconsistent, data_offset + 4, len(raw))
        self.assert_code(ErrorCode.INVALID_REF_AUDIO_FORMAT, valid_payload(ref_audio=bytes(inconsistent)))
        bad_riff_size = bytearray(raw)
        struct.pack_into("<I", bad_riff_size, 4, len(raw))
        self.assert_code(ErrorCode.INVALID_REF_AUDIO_FORMAT, valid_payload(ref_audio=bytes(bad_riff_size)))

    def test_reference_duration_is_five_to_fifteen_seconds_inclusive(self):
        parse_request(valid_payload(ref_audio=pcm16_wav(samples=5 * 24_000)))
        parse_request(valid_payload(ref_audio=pcm16_wav(samples=15 * 24_000)))
        self.assert_code(ErrorCode.INVALID_REF_DURATION, valid_payload(ref_audio=pcm16_wav(samples=5 * 24_000 - 1)))
        self.assert_code(ErrorCode.INVALID_REF_DURATION, valid_payload(ref_audio=pcm16_wav(samples=15 * 24_000 + 1)))

    def test_text_bounds(self):
        self.assert_code(ErrorCode.INVALID_TEXT, valid_payload(text=" \t"))
        self.assert_code(ErrorCode.TEXT_TOO_LONG, valid_payload(text="ก" * 801))
        self.assert_code(ErrorCode.INVALID_REF_TEXT, valid_payload(ref_text=""))
        self.assert_code(ErrorCode.REF_TEXT_TOO_LONG, valid_payload(ref_text="ก" * 2001))

    def test_numeric_and_boolean_bounds_reject_coercion(self):
        for speed in (True, "1", float("nan"), 0.29, 3.01):
            payload = valid_payload()
            payload["speed"] = speed
            self.assert_code(ErrorCode.INVALID_SPEED, payload)
        for steps in (True, 3, 65, 32.0):
            self.assert_code(ErrorCode.INVALID_NUM_STEP, valid_payload(num_step=steps))
        for seed in (True, -1, 2_147_483_648, 1.0):
            self.assert_code(ErrorCode.INVALID_SEED, valid_payload(seed=seed))
        self.assert_code(ErrorCode.INVALID_MIXED_LANGUAGE, valid_payload(mixed_language=1))
        self.assert_code(ErrorCode.INVALID_MIXED_LANGUAGE, valid_payload(mixed_language=False))

    def test_profile_and_normalizer_are_server_enums_or_safe_identity(self):
        self.assertEqual(set(PROFILE_STAGES), set(EXPERIMENT_PROFILES))
        self.assert_code(ErrorCode.INVALID_EXPERIMENT_PROFILE, valid_payload(profile="future-profile"))
        self.assert_code(ErrorCode.INVALID_NORMALIZER_VERSION, valid_payload(normalizer_version="bad version"))

    def test_both_commitments_are_recomputed(self):
        payload = valid_payload()
        payload["request_commitment_sha256"] = "f" * 64
        self.assert_code(ErrorCode.REQUEST_COMMITMENT_MISMATCH, payload)
        payload = valid_payload()
        payload["matched_settings_sha256"] = "f" * 64
        self.assert_code(ErrorCode.MATCHED_SETTINGS_MISMATCH, payload)
        payload = valid_payload()
        payload["request_commitment_sha256"] = "A" * 64
        self.assert_code(ErrorCode.INVALID_COMMITMENT, payload)

    def test_jcs_numeric_form_treats_one_and_one_point_zero_identically(self):
        self.assertEqual(jcs_bytes({"speed": 1}), b'{"speed":1}')
        self.assertEqual(jcs_bytes({"speed": 1.0}), b'{"speed":1}')
        left = valid_payload(speed=1)
        right = valid_payload(speed=1.0)
        self.assertEqual(left["request_commitment_sha256"], right["request_commitment_sha256"])
        self.assertEqual(left["matched_settings_sha256"], right["matched_settings_sha256"])

    def test_commitment_descriptors_match_the_fixed_cross_language_wire_shape(self):
        reference_hash = "a" * 64
        descriptor = request_commitment_descriptor(
            ref_audio_sha256=reference_hash,
            ref_text="ref",
            text="text",
            speed=1,
            num_step=32,
            seed=1,
            experiment_profile="control-v1",
            normalizer_version="normalizer@1",
        )
        expected = (
            b'{"contractVersion":3,"experimentProfile":"control-v1","mixedLanguage":true,'
            b'"mode":"clone","normalizerVersion":"normalizer@1","numStep":32,'
            b'"refAudioSha256":"' + reference_hash.encode("ascii") + b'",'
            b'"refTextSha256":"' + hashlib.sha256(b"ref").hexdigest().encode("ascii") + b'",'
            b'"seed":1,"speed":1,"textSha256":"' + hashlib.sha256(b"text").hexdigest().encode("ascii") + b'"}'
        )
        self.assertEqual(jcs_bytes(descriptor), expected)
        settings = matched_settings_descriptor(speed=1, num_step=32)
        self.assertEqual(
            jcs_bytes(settings),
            b'{"mixedLanguage":true,"numStep":32,"outputChannels":1,"outputRate":24000,'
            b'"outputSubtype":"PCM_16","speed":1}',
        )


class FakeRuntime:
    def __init__(self):
        self.seed_value = None
        self.generate_call = None
        self.prepare_enhance = None
        self.reference_path = None
        self.released = False
        self.watermark_calls = 0
        self.fail_at = None
        self.oversize = False
        self.invalid_detection = False
        self.generated_text = None
        self.semantic_noop = False
        self.cleanup_failure = False
        self.speaker_scores = None
        self.pitch_scores = None
        self.sensitive_refs = []
        self.reference_metric_overrides = {}
        self.watermark_frame_probabilities = [0.75] * 9 + [0.25] * 3
        self.watermark_bit_probabilities = [0.9 if bit == "1" else 0.1 for bit in "1011001011010110"]
        self.reference_extra_metric = False
        self.watermark_extra_metric = False

    def prepare_reference(self, raw, temp_dir, *, enhance):
        if self.fail_at == "reference":
            raise RuntimeError("sensitive path /private/reference.wav")
        self.prepare_enhance = enhance
        self.reference_path = temp_dir / "reference.wav"
        self.reference_path.write_bytes(raw)
        audio = np.linspace(-0.25, 0.25, 2_400, dtype=np.float32)
        self.sensitive_refs.append(weakref.ref(audio))
        artifact = ReferenceArtifact(
            path=self.reference_path,
            audio=audio,
            input_sha256=hashlib.sha256(raw).hexdigest(),
            canonical_sha256="a" * 64,
            effective_sha256=("a" if self.semantic_noop or not enhance else "b") * 64,
            input_samples_24000=120_000,
            effective_samples_24000=120_000,
            enhanced=enhance,
            pre_peak=0.25,
            post_peak=0.95 if enhance else 0.25,
            pre_rms=0.12,
            post_rms=0.45 if enhance else 0.12,
            pre_samples=220_500 if enhance else 120_000,
            post_samples=120_000,
            pre_clipping_samples=0,
            post_clipping_samples=0,
        )
        artifact = replace(artifact, **self.reference_metric_overrides)
        if self.reference_extra_metric:
            artifact.unexpected_metric = 1
        return artifact

    def seed(self, seed):
        self.seed_value = seed

    def create_prompt(self, path, ref_text):
        if self.fail_at == "prompt":
            raise RuntimeError(ref_text)
        class Prompt:
            pass

        prompt = Prompt()
        self.sensitive_refs.append(weakref.ref(prompt))
        return prompt

    def generate_candidates(self, **kwargs):
        if self.fail_at == "synthesis":
            raise RuntimeError(kwargs["text"])
        self.generate_call = {key: value for key, value in kwargs.items() if key != "prompt"}
        self.generated_text = kwargs["text"]
        candidates = [np.full(2_400, (index + 1) / 10, dtype=np.float32) for index in range(BEST_OF)]
        self.sensitive_refs.extend(weakref.ref(candidate) for candidate in candidates)
        return candidates

    def speaker_cosine(self, _reference, candidate):
        if self.fail_at == "ranking":
            return float("nan")
        index = round(float(candidate[0]) * 10) - 1
        return self.speaker_scores[index] if self.speaker_scores is not None else float(candidate[0])

    def pitch_similarity(self, _reference, candidate):
        index = round(float(candidate[0]) * 10) - 1
        if self.pitch_scores is not None:
            return self.pitch_scores[index]
        return {0.1: 1.0, 0.2: 0.4, 0.3: 0.2}[round(float(candidate[0]), 1)]

    def audio_sha256(self, audio):
        return hashlib.sha256(np.asarray(audio, dtype="<f4").tobytes()).hexdigest()

    def apply_watermark(self, audio):
        self.watermark_calls += 1
        if self.fail_at == "watermark":
            raise RuntimeError("watermark details")
        selected = np.asarray(audio, dtype=np.float32)
        pre_embed = _resample(selected, 24_000, 16_000)
        marked_16k = pre_embed + np.float32(0.001)
        marked = _resample(marked_16k, 16_000, 24_000)
        if marked.size > selected.size:
            marked = marked[: selected.size]
        elif marked.size < selected.size:
            marked = np.pad(marked, (0, selected.size - marked.size))
        artifact = WatermarkArtifact(
            audio=marked,
            detect_fraction=0.49 if self.invalid_detection else 0.75,
            decoded_message="1011001011010110",
            pre_embed_sha256=_audio_sha256(pre_embed),
            watermarked_16k_sha256=_audio_sha256(marked_16k),
            delivered_24k_sha256=hashlib.sha256(_pcm16_bytes(marked)).hexdigest(),
            samples_16k_pre_embed=int(pre_embed.size),
            samples_16k_post_embed=int(marked_16k.size),
            samples_24k_output=int(marked.size),
            frame_probabilities=self.watermark_frame_probabilities,
            bit_probabilities=self.watermark_bit_probabilities,
            bit_error_rate=0.0,
        )
        if self.watermark_extra_metric:
            artifact.unexpected_metric = 1
        return artifact

    def num_samples(self, audio):
        return len(audio)

    def encode_pcm16_wav(self, audio):
        if self.oversize:
            return b"x" * 7_000_001
        values = np.rint(np.asarray(audio) * 32768).astype("<i2")
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(24_000)
            writer.writeframes(values.tobytes())
        return buffer.getvalue()

    def validate_pcm16_wav(self, raw, *, expected_samples):
        with wave.open(io.BytesIO(raw), "rb") as reader:
            if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getnframes()) != (
                1,
                2,
                24_000,
                expected_samples,
            ):
                raise ValueError("bad WAV")

    def release_sensitive(self):
        self.released = True
        if self.reference_path is not None and self.reference_path.exists():
            raise AssertionError("temporary reference still exists")
        if any(reference() is not None for reference in self.sensitive_refs):
            raise AssertionError("sensitive object was retained during GPU cleanup")
        if self.cleanup_failure:
            raise RuntimeError("private cleanup detail")


class PipelineTests(unittest.TestCase):
    def request(self, profile="control-v1"):
        return parse_request(valid_payload(profile=profile))

    def test_control_parity_fixture_is_exact(self):
        self.assertEqual(
            CONTROL_PARITY,
            {
                "workerBoundary": "audited-v13-clone",
                "status": "fixture-ready",
                "speechTextPolicy": "application-owned-exact-bytes",
                "baseSpeedMultiplier": 1.4,
                "candidateCount": 3,
                "classTemperature": 0.8,
                "guidance": 2.5,
                "ranking": "maximum-speaker-cosine",
                "rankingReferenceDomain": "final-reference-wav/decoded-pcm16-mono-24000",
                "mixedLanguageSegmentation": "thai-english-v13",
                "output": {"rate": 24_000, "channels": 1, "subtype": "PCM_16"},
                "watermark": False,
                "referencePreprocessing": "audited-v13-pydub-downmix-resample-without-peak-normalization",
                "paidAblationGate": "requires-real-gpu-audio-parity-fixture",
            },
        )
        runtime = FakeRuntime()
        result = run_pipeline(self.request(), runtime)
        self.assertEqual(runtime.generate_call["guidance"], CONTROL_GUIDANCE)
        self.assertEqual(runtime.generate_call["class_temperature"], CLASS_TEMPERATURE)
        self.assertEqual(runtime.generate_call["count"], 3)
        self.assertEqual(result.metrics["selected_candidate_index"], 2)
        self.assertEqual(result.metrics["ranking_formula"], "speaker_cosine")

    def test_real_synthetic_v13_boundary_fixtures_have_exact_reference_parity(self):
        samples = np.rint(np.sin(np.arange(5 * 16_000) * 0.017) * 8_000).astype("<i2")
        raw = pcm16_wav(samples=5 * 16_000, rate=16_000)
        raw = raw[:44] + samples.tobytes()
        self.assertTrue(np.array_equal(_v13_reference_audio(raw), v13_preprocess_reference(raw)))
        self.assertFalse(np.array_equal(_peak_normalize(_v13_reference_audio(raw)), v13_preprocess_reference(raw)))
        self.assertEqual(CONTROL_PARITY["status"], "fixture-ready")
        self.assertEqual(CONTROL_PARITY["paidAblationGate"], "requires-real-gpu-audio-parity-fixture")
        v13_frames, v13_ranking_reference = v13_exported_reference_pcm16(raw)
        with tempfile.TemporaryDirectory() as temp_dir:
            prepared = CloneRuntime.prepare_reference(
                object.__new__(CloneRuntime),
                raw,
                Path(temp_dir),
                enhance=False,
            )
            self.assertEqual(prepared.canonical_sha256, hashlib.sha256(v13_frames).hexdigest())
            self.assertEqual(prepared.effective_sha256, prepared.canonical_sha256)
            self.assertEqual(prepared.post_clipping_samples, 0)
            with wave.open(str(prepared.path), "rb") as reader:
                prepared_frames = reader.readframes(reader.getnframes())
            prepared_decoded = np.frombuffer(prepared_frames, dtype="<i2").astype(np.float32) / 32768.0
            self.assertTrue(np.array_equal(prepared.audio, prepared_decoded))
            self.assertEqual(prepared_frames, v13_frames)
            self.assertEqual(prepared.effective_sha256, hashlib.sha256(prepared_frames).hexdigest())

        self.assertEqual(hashlib.sha256(v13_frames).hexdigest(), _prompt_pcm16_sha256(v13_ranking_reference))
        self.assertTrue(np.array_equal(v13_ranking_reference, v13_preprocess_reference(raw)))
        self.assertEqual(CONTROL_PARITY["rankingReferenceDomain"], "final-reference-wav/decoded-pcm16-mono-24000")

        for speed in (0.3, 0.5, 1.0, 2.5, 3.0):
            self.assertEqual(_effective_speed(speed), v13_effective_speed(speed))

        class Model:
            def create_voice_clone_prompt(self, **kwargs):
                return kwargs

        class NoGrad:
            def __enter__(self):
                return None

            def __exit__(self, *_args):
                return False

        model = Model()
        minimal_runtime = types.SimpleNamespace(model=model)
        torch_stub = types.SimpleNamespace(no_grad=lambda: NoGrad())
        reference_path = Path("/tmp/synthetic-reference.wav")
        with patch.dict(sys.modules, {"torch": torch_stub}):
            observed_prompt = CloneRuntime.create_prompt(minimal_runtime, reference_path, "อ้างอิง")
        self.assertEqual(observed_prompt, v13_create_prompt(model, reference_path, "อ้างอิง"))

        left = np.array([0.125, 0.25, -0.5], dtype=np.float32)
        right = np.array([0.5, -0.125, 0.25], dtype=np.float32)

        class Embeddings:
            def _speaker_embedding(self, audio):
                return audio

        self.assertEqual(
            CloneRuntime.speaker_cosine(Embeddings(), left, right),
            v13_cosine_similarity(left, right),
        )
        valid_output = pcm16_wav(samples=2_400)
        CloneRuntime.validate_pcm16_wav(valid_output, expected_samples=2_400)
        with self.assertRaises(ValueError):
            CloneRuntime.validate_pcm16_wav(valid_output + b"trailing", expected_samples=2_400)

    def test_enhancement_rejects_same_domain_semantic_noop(self):
        canonical = np.array([0.125, -0.25, 0.5], dtype=np.float32)
        nextafter = np.nextafter(canonical, np.float32(1.0), dtype=np.float32)
        self.assertFalse(np.array_equal(canonical, nextafter))
        self.assertEqual(_prompt_pcm16_sha256(canonical), _prompt_pcm16_sha256(nextafter))

        runtime = FakeRuntime()
        runtime.semantic_noop = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request("reference-enhancement-v1"), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.REFERENCE_STAGE_FAILED)
        self.assertTrue(runtime.released)

    def test_real_runtime_demucs_uses_pinned_offline_configuration(self):
        calls = []

        class Separator:
            def __init__(self, **kwargs):
                calls.append(kwargs)

        api_stub = types.ModuleType("demucs.api")
        api_stub.Separator = Separator
        package_stub = types.ModuleType("demucs")
        package_stub.api = api_stub
        runtime = object.__new__(CloneRuntime)
        runtime.model_root = Path("/opt/models")
        runtime.device = "cuda"
        runtime._demucs_separator = None
        with patch.dict(sys.modules, {"demucs": package_stub, "demucs.api": api_stub}):
            first = runtime._get_demucs()
            second = runtime._get_demucs()
        self.assertIs(first, second)
        self.assertEqual(calls, [{
            "model": "955717e8", "repo": Path("/opt/models/demucs"), "device": "cuda",
            "shifts": 0, "split": True, "overlap": 0.25, "segment": 7,
            "jobs": 0, "progress": False,
        }])

    def test_every_profile_runs_only_its_predeclared_stages(self):
        for profile in sorted(EXPERIMENT_PROFILES):
            with self.subTest(profile=profile):
                runtime = FakeRuntime()
                result = run_pipeline(self.request(profile), runtime)
                self.assertEqual([stage["name"] for stage in result.stages], list(PROFILE_STAGES[profile]))
                self.assertEqual(runtime.prepare_enhance, profile in {"reference-enhancement-v1", "combined-quality-v1"})
                self.assertEqual(runtime.watermark_calls, int(profile == "watermark-v1"))
                self.assertEqual(
                    result.metrics["generation"],
                    {
                        "candidate_count": 3,
                        "guidance": 2.0 if profile in {"guidance-ranking-v1", "combined-quality-v1"} else 2.5,
                        "class_temperature": 0.8,
                    },
                )
                self.assertTrue(
                    all(
                        metric["audio_sha256_domain"] == "float32-le-mono-24000-v1"
                        and metric["samples_24k"] == 2_400
                        for metric in result.metrics["candidates"]
                    )
                )

    def test_combined_stage_order_and_no_watermark(self):
        runtime = FakeRuntime()
        result = run_pipeline(self.request("combined-quality-v1"), runtime)
        self.assertEqual(
            [stage["name"] for stage in result.stages],
            [
                "speech_text_attestation",
                "reference_decode",
                "demucs_reference_enhancement",
                "reference_peak_normalize",
                "reference_resample_24000",
                "omnivoice_prompt",
                "omnivoice_generate_three",
                "speaker_pitch_rank",
                "output_validate_pcm16",
            ],
        )
        self.assertEqual(runtime.generate_call["guidance"], QUALITY_GUIDANCE)
        self.assertIsNone(result.metrics["watermark"])

    def test_speech_text_stays_harness_owned_for_normalization_profile(self):
        payload = valid_payload(profile="text-normalization-v1", text="โอเพนเอไอ หนึ่งพันสองร้อยสี่สิบเก้าบาท")
        runtime = FakeRuntime()
        run_pipeline(parse_request(payload), runtime)
        self.assertEqual(runtime.generated_text, payload["text"])

    def test_seed_hook_and_output_are_deterministic(self):
        first_runtime = FakeRuntime()
        second_runtime = FakeRuntime()
        first = run_pipeline(self.request(), first_runtime)
        second = run_pipeline(self.request(), second_runtime)
        self.assertEqual(first_runtime.seed_value, 20260901)
        self.assertEqual(first.wav_bytes, second.wav_bytes)
        self.assertEqual(first.metrics["candidates"], second.metrics["candidates"])

    def test_pitch_ranking_formula_is_independently_recomputable(self):
        result = run_pipeline(self.request("guidance-ranking-v1"), FakeRuntime())
        for metric in result.metrics["candidates"]:
            expected = metric["speaker_cosine"] + PITCH_WEIGHT * metric["pitch_similarity_normalized"]
            self.assertEqual(metric["ranking_score"], expected)
        expected_selected = max(
            range(len(result.metrics["candidates"])),
            key=lambda index: result.metrics["candidates"][index]["ranking_score"],
        )
        self.assertEqual(result.metrics["selected_candidate_index"], expected_selected)
        self.assertEqual(result.metrics["selected_candidate_index"], 2)

    def test_cosine_near_tie_selection_uses_unrounded_values(self):
        runtime = FakeRuntime()
        runtime.speaker_scores = [0.5000000044, 0.5000000043, 0.1]
        result = run_pipeline(self.request("control-v1"), runtime)
        self.assertEqual(result.metrics["candidates"][0]["ranking_score"], 0.5000000044)
        self.assertEqual(result.metrics["candidates"][1]["ranking_score"], 0.5000000043)
        self.assertEqual(result.metrics["selected_candidate_index"], 0)

    def test_pitch_near_tie_selection_uses_unrounded_composite(self):
        runtime = FakeRuntime()
        runtime.speaker_scores = [0.4, 0.4, 0.1]
        runtime.pitch_scores = [0.500000029, 0.500000028, 0.1]
        result = run_pipeline(self.request("guidance-ranking-v1"), runtime)
        self.assertEqual(result.metrics["candidates"][0]["ranking_score"], 0.4 + PITCH_WEIGHT * 0.500000029)
        self.assertEqual(result.metrics["candidates"][1]["ranking_score"], 0.4 + PITCH_WEIGHT * 0.500000028)
        self.assertEqual(result.metrics["selected_candidate_index"], 0)

    def test_exact_ranking_tie_selects_lowest_index(self):
        runtime = FakeRuntime()
        runtime.speaker_scores = [0.5, 0.5, 0.1]
        result = run_pipeline(self.request("control-v1"), runtime)
        self.assertEqual(result.metrics["selected_candidate_index"], 0)

    def test_watermark_sample_preservation_and_positive_detection(self):
        result = run_pipeline(self.request("watermark-v1"), FakeRuntime())
        watermark = result.metrics["watermark"]
        selected = result.metrics["candidates"][result.metrics["selected_candidate_index"]]
        self.assertEqual(watermark["evidence_version"], 1)
        self.assertEqual(watermark["selected_candidate_24k_sha256"], selected["audio_sha256"])
        self.assertEqual(watermark["selected_candidate_24k_sha256_domain"], selected["audio_sha256_domain"])
        self.assertNotEqual(watermark["pre_embed_sha256"], selected["audio_sha256"])
        self.assertEqual(watermark["pre_embed_sha256_domain"], "float32-le-mono-16000-v1")
        self.assertEqual(watermark["watermarked_16k_sha256_domain"], "float32-le-mono-16000-v1")
        self.assertEqual(watermark["delivered_24k_sha256_domain"], "pcm-s16le-mono-24000-wav-data-v1")
        self.assertNotEqual(watermark["pre_embed_sha256"], watermark["watermarked_16k_sha256"])
        self.assertEqual(watermark["samples_24k_selected"], selected["samples_24k"])
        self.assertEqual(watermark["samples_16k_pre_embed"], watermark["samples_16k_post_embed"])
        self.assertEqual(watermark["samples_16k_pre_embed"], math.ceil(selected["samples_24k"] * 2 / 3))
        self.assertEqual(watermark["samples_24k_output"], result.num_samples)
        with wave.open(io.BytesIO(result.wav_bytes), "rb") as reader:
            delivered_frames = reader.readframes(reader.getnframes())
        self.assertEqual(watermark["delivered_24k_sha256"], hashlib.sha256(delivered_frames).hexdigest())
        self.assertGreater(watermark["detect_fraction"], 0.5)
        runtime = FakeRuntime()
        runtime.invalid_detection = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request("watermark-v1"), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

        for label, mutation in (
            ("same pre/marked hash", lambda artifact: replace(
                artifact,
                pre_embed_sha256=artifact.watermarked_16k_sha256,
            )),
            ("arbitrary delivered hash", lambda artifact: replace(
                artifact,
                delivered_24k_sha256="0" * 64,
            )),
            ("wrong exact pre count", lambda artifact: replace(
                artifact,
                samples_16k_pre_embed=artifact.samples_16k_pre_embed - 1,
            )),
            ("wrong selected/final count", lambda artifact: replace(
                artifact,
                samples_24k_output=artifact.samples_24k_output - 1,
            )),
        ):
            with self.subTest(label=label):
                runtime = FakeRuntime()
                original = runtime.apply_watermark
                runtime.apply_watermark = lambda audio, original=original, mutation=mutation: mutation(original(audio))
                with self.assertRaises(PipelineError) as caught:
                    run_pipeline(self.request("watermark-v1"), runtime)
                self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

    def test_reference_and_watermark_metrics_reject_nonfinite_or_out_of_range_values(self):
        runtime = FakeRuntime()
        runtime.reference_metric_overrides = {"pre_rms": float("nan")}
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request(), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.REFERENCE_STAGE_FAILED)

        runtime = FakeRuntime()
        runtime.watermark_frame_probabilities = [1.01]
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request("watermark-v1"), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

    def test_metric_types_bounds_and_exact_artifact_schemas_are_fail_closed(self):
        reference_cases = (
            {"enhanced": 1},
            {"input_samples_24000": 10**50, "effective_samples_24000": 10**50},
            {"pre_samples": 10**50, "pre_clipping_samples": 0},
            {"post_samples": 10**50, "post_clipping_samples": 0},
            {"pre_peak": True},
        )
        for overrides in reference_cases:
            with self.subTest(reference=overrides):
                runtime = FakeRuntime()
                runtime.reference_metric_overrides = overrides
                with self.assertRaises(PipelineError) as caught:
                    run_pipeline(self.request(), runtime)
                self.assertEqual(caught.exception.code, ErrorCode.REFERENCE_STAGE_FAILED)

        runtime = FakeRuntime()
        runtime.reference_extra_metric = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request(), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.REFERENCE_STAGE_FAILED)

        runtime = FakeRuntime()
        runtime.speaker_scores = [True, 0.2, 0.1]
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request(), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.RANKING_STAGE_FAILED)

        watermark_cases = (
            ("watermark_frame_probabilities", [True] * 9 + [False] * 3),
            ("watermark_bit_probabilities", [True if bit == "1" else False for bit in "1011001011010110"]),
        )
        for name, value in watermark_cases:
            with self.subTest(watermark=name):
                runtime = FakeRuntime()
                setattr(runtime, name, value)
                with self.assertRaises(PipelineError) as caught:
                    run_pipeline(self.request("watermark-v1"), runtime)
                self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

        runtime = FakeRuntime()
        runtime.watermark_extra_metric = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request("watermark-v1"), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

        runtime = FakeRuntime()
        huge = 10**50
        original_apply_watermark = runtime.apply_watermark

        def huge_counts(audio):
            return replace(
                original_apply_watermark(audio),
                samples_16k_pre_embed=huge,
                samples_16k_post_embed=huge,
            )

        runtime.apply_watermark = huge_counts
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request("watermark-v1"), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

        runtime = FakeRuntime()
        runtime.watermark_bit_probabilities = [0.9] * 15
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request("watermark-v1"), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.WATERMARK_STAGE_FAILED)

    def test_requested_optional_stages_fail_closed(self):
        cases = {
            "reference": ("reference-enhancement-v1", ErrorCode.REFERENCE_STAGE_FAILED),
            "prompt": ("control-v1", ErrorCode.PROMPT_STAGE_FAILED),
            "synthesis": ("control-v1", ErrorCode.SYNTHESIS_STAGE_FAILED),
            "ranking": ("guidance-ranking-v1", ErrorCode.RANKING_STAGE_FAILED),
            "watermark": ("watermark-v1", ErrorCode.WATERMARK_STAGE_FAILED),
        }
        for failure, (profile, code) in cases.items():
            with self.subTest(failure=failure):
                runtime = FakeRuntime()
                runtime.fail_at = failure
                with self.assertRaises(PipelineError) as caught:
                    run_pipeline(self.request(profile), runtime)
                self.assertEqual(caught.exception.code, code)
                self.assertTrue(runtime.released)

    def test_output_size_fails_closed_and_temp_files_are_cleaned(self):
        runtime = FakeRuntime()
        runtime.oversize = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request(), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.OUTPUT_TOO_LARGE)
        self.assertTrue(runtime.released)
        self.assertFalse(runtime.reference_path.exists())

    def test_cleanup_failure_blocks_success_but_never_overwrites_primary_failure(self):
        runtime = FakeRuntime()
        runtime.cleanup_failure = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request(), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.INTERNAL_ERROR)

        runtime = FakeRuntime()
        runtime.fail_at = "synthesis"
        runtime.cleanup_failure = True
        with self.assertRaises(PipelineError) as caught:
            run_pipeline(self.request(), runtime)
        self.assertEqual(caught.exception.code, ErrorCode.SYNTHESIS_STAGE_FAILED)
        self.assertIn("sensitive runtime cleanup also failed", getattr(caught.exception, "__notes__", []))


class HandlerTests(unittest.TestCase):
    @staticmethod
    def identity():
        return WorkerIdentity(
            worker_version="hero-voice-clone-contract-v3-internal-eval-2",
            worker_kind="clone-only",
            image_digest="sha256:" + "1" * 64,
            source_revision=APPROVED_SOURCE_REVISION,
            model_manifest_sha256=model_manifest_sha256(),
        )

    def test_success_envelope_has_one_exact_schema_and_echoes_commitments(self):
        payload = valid_payload()
        response = handle_job({"id": "opaque-job", "input": payload}, runtime=FakeRuntime(), identity=self.identity())
        self.assertEqual(
            set(response),
            {
                "ok", "contract_version", "mode", "worker_kind", "worker_version",
                "image_digest", "source_revision", "model_manifest_sha256",
                "experiment_profile", "normalizer_version", "mixed_language",
                "request_commitment_sha256", "matched_settings_sha256", "audio_base64",
                "format", "sample_rate", "channels", "subtype", "num_samples",
                "duration_ms", "stages", "metrics", "timing_ms",
            },
        )
        self.assertIs(response["ok"], True)
        self.assertEqual(response["worker_kind"], "clone-only")
        self.assertEqual(response["request_commitment_sha256"], payload["request_commitment_sha256"])
        self.assertEqual(response["matched_settings_sha256"], payload["matched_settings_sha256"])
        self.assertTrue(all(set(stage) == {"name", "identity"} for stage in response["stages"]))
        self.assertEqual(
            set(response["metrics"]),
            {"reference", "generation", "candidates", "selected_candidate_index", "ranking_formula", "watermark"},
        )
        self.assertEqual(
            response["metrics"]["generation"],
            {"candidate_count": 3, "guidance": 2.0, "class_temperature": 0.8},
        )
        self.assertEqual(
            set(response["metrics"]["reference"]),
            {
                "input_sha256", "canonical_sha256", "effective_sha256",
                "input_samples_24000", "effective_samples_24000", "enhanced",
                "pre_peak", "post_peak", "pre_rms", "post_rms",
                "pre_samples", "post_samples", "pre_clipping_samples", "post_clipping_samples",
            },
        )
        self.assertTrue(
            all(
                set(candidate)
                == {
                    "index", "audio_sha256", "audio_sha256_domain", "samples_24k",
                    "speaker_cosine", "pitch_similarity_normalized", "ranking_score",
                }
                for candidate in response["metrics"]["candidates"]
            )
        )
        self.assertIsNone(response["metrics"]["watermark"])
        self.assertEqual(
            set(response["timing_ms"]),
            {"reference", "prompt", "synthesis", "ranking", "watermark", "encode", "total"},
        )
        with wave.open(io.BytesIO(base64.b64decode(response["audio_base64"])), "rb") as reader:
            self.assertEqual((reader.getnchannels(), reader.getframerate(), reader.getsampwidth()), (1, 24_000, 2))

        watermark_response = handle_job(
            {"id": "opaque-watermark-job", "input": valid_payload(profile="watermark-v1")},
            runtime=FakeRuntime(),
            identity=self.identity(),
        )
        self.assertEqual(
            set(watermark_response["metrics"]["watermark"]),
            {
                "evidence_version", "message", "alpha", "detection_threshold", "message_threshold", "detect_fraction",
                "positive", "decoded_message", "frame_probabilities", "bit_probabilities", "bit_error_rate",
                "selected_candidate_24k_sha256", "selected_candidate_24k_sha256_domain",
                "pre_embed_sha256", "pre_embed_sha256_domain",
                "watermarked_16k_sha256", "watermarked_16k_sha256_domain",
                "delivered_24k_sha256", "delivered_24k_sha256_domain", "samples_24k_selected",
                "samples_16k_pre_embed", "samples_16k_post_embed", "samples_24k_output",
            },
        )
        reference_metrics = watermark_response["metrics"]["reference"]
        for key in ("pre_peak", "post_peak", "pre_rms", "post_rms"):
            self.assertTrue(math.isfinite(reference_metrics[key]))
            self.assertGreaterEqual(reference_metrics[key], 0.0)
        watermark_metrics = watermark_response["metrics"]["watermark"]
        self.assertTrue(1 <= len(watermark_metrics["frame_probabilities"]) <= 4_096)
        self.assertEqual(len(watermark_metrics["bit_probabilities"]), 16)
        self.assertTrue(all(0.0 <= value <= 1.0 and math.isfinite(value) for value in watermark_metrics["frame_probabilities"]))
        self.assertTrue(all(0.0 <= value <= 1.0 and math.isfinite(value) for value in watermark_metrics["bit_probabilities"]))
        self.assertEqual(watermark_metrics["bit_error_rate"], 0.0)
        self.assertNotEqual(watermark_metrics["pre_embed_sha256"], watermark_metrics["watermarked_16k_sha256"])
        watermark_wav = base64.b64decode(watermark_response["audio_base64"])
        with wave.open(io.BytesIO(watermark_wav), "rb") as reader:
            delivered_frames = reader.readframes(reader.getnframes())
        self.assertEqual(watermark_metrics["delivered_24k_sha256"], hashlib.sha256(delivered_frames).hexdigest())

    def test_failure_envelope_is_exact_and_never_partial_success(self):
        response = handle_job({"id": "x", "input": {"mode": "tts"}}, runtime=FakeRuntime(), identity=self.identity())
        self.assertEqual(response, {"ok": False, "error": {"code": "INVALID_FIELDS", "message": "input fields do not match contract v3"}})
        self.assertNotIn("audio_base64", response)
        runtime = FakeRuntime()
        runtime.fail_at = "synthesis"
        response = handle_job({"id": "x", "input": valid_payload()}, runtime=runtime, identity=self.identity())
        self.assertEqual(set(response), {"ok", "error"})
        self.assertEqual(set(response["error"]), {"code", "message"})
        self.assertEqual(response["error"]["code"], "SYNTHESIS_STAGE_FAILED")

    def test_logs_are_payload_free(self):
        payload = valid_payload(text="UNIQUE_TRANSCRIPT_SENTINEL", ref_text="UNIQUE_REFERENCE_SENTINEL")
        with self.assertLogs("hero_voice_clone", level=logging.INFO) as captured:
            response = handle_job({"id": "UNIQUE_JOB_SENTINEL", "input": payload}, runtime=FakeRuntime(), identity=self.identity())
        self.assertTrue(response["ok"])
        output = "\n".join(captured.output)
        self.assertNotIn("UNIQUE_TRANSCRIPT_SENTINEL", output)
        self.assertNotIn("UNIQUE_REFERENCE_SENTINEL", output)
        self.assertNotIn(payload["ref_audio_b64"][:100], output)
        self.assertNotIn("UNIQUE_JOB_SENTINEL", output)

    def test_worker_identity_requires_all_immutable_values_and_actual_manifest_hash(self):
        with self.assertRaises(PipelineError) as caught:
            load_worker_identity({})
        self.assertEqual(caught.exception.code, ErrorCode.WORKER_IDENTITY_UNAVAILABLE)
        environment = {
            "HERO_VOICE_CLONE_IMAGE_DIGEST": "sha256:" + "1" * 64,
        }
        attestation = {
            "schema_version": 1,
            "worker_version": "hero-voice-clone-contract-v3-internal-eval-2",
            "worker_kind": "clone-only",
            "source_revision": "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb",
            "source_manifest_sha256": source_manifest_sha256(),
            "model_manifest_sha256": model_manifest_sha256(),
            "base_image": json.loads((ROOT / "SOURCE_MANIFEST.json").read_text())["base_image"],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            attestation_path = Path(temp_dir) / "BUILD_ATTESTATION.json"
            attestation_path.write_text(json.dumps(attestation), encoding="utf-8")
            identity = load_worker_identity(environment, attestation_path=attestation_path)
            self.assertEqual(identity.worker_kind, "clone-only")

            forged_source = dict(attestation)
            forged_source["source_revision"] = "f" * 40
            attestation_path.write_text(json.dumps(forged_source), encoding="utf-8")
            with self.assertRaises(PipelineError) as caught:
                load_worker_identity(environment, attestation_path=attestation_path)
            self.assertEqual(caught.exception.code, ErrorCode.WORKER_IDENTITY_UNAVAILABLE)

            forged = dict(attestation)
            forged["model_manifest_sha256"] = "3" * 64
            attestation_path.write_text(json.dumps(forged), encoding="utf-8")
            with self.assertRaises(PipelineError) as caught:
                load_worker_identity(environment, attestation_path=attestation_path)
            self.assertEqual(caught.exception.code, ErrorCode.MODEL_MANIFEST_INVALID)

            attestation_path.write_text(json.dumps(attestation), encoding="utf-8")
            for override in (
                "HERO_VOICE_CLONE_SOURCE_REVISION",
                "HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256",
                "HERO_VOICE_CLONE_WORKER_VERSION",
                "HERO_VOICE_CLONE_WORKER_KIND",
                "HERO_VOICE_CLONE_BASE_IMAGE",
                "SOURCE_REVISION",
            ):
                with self.subTest(override=override):
                    poisoned = dict(environment)
                    poisoned[override] = "0" * 64
                    with self.assertRaises(PipelineError) as caught:
                        load_worker_identity(poisoned, attestation_path=attestation_path)
                    self.assertEqual(caught.exception.code, ErrorCode.WORKER_IDENTITY_UNAVAILABLE)

            tampered_runtime_manifest = Path(temp_dir) / "RUNTIME_MANIFEST.json"
            tampered_runtime_manifest.write_text('{"schema_version":1,"purpose":"runtime-source-attestation","files":{}}')
            with patch.object(identity_module, "RUNTIME_MANIFEST_PATH", tampered_runtime_manifest):
                with self.assertRaises(PipelineError) as caught:
                    load_worker_identity(environment, attestation_path=attestation_path)
                self.assertEqual(caught.exception.code, ErrorCode.WORKER_IDENTITY_UNAVAILABLE)

        forged_identity = replace(self.identity(), source_revision="f" * 40)
        response = handle_job(
            {"id": "identity-forgery", "input": valid_payload()},
            runtime=FakeRuntime(),
            identity=forged_identity,
        )
        self.assertEqual(response["error"]["code"], ErrorCode.WORKER_IDENTITY_UNAVAILABLE.value)


class StaticAndAbsenceTests(unittest.TestCase):
    def test_static_supply_chain_verifier_covers_pins_lock_sbom_and_demucs_block(self):
        verify_static()
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("ARG SOURCE_REVISION", dockerfile)
        self.assertNotIn("${SOURCE_REVISION}", dockerfile)
        self.assertGreaterEqual(dockerfile.count(APPROVED_SOURCE_REVISION), 2)
        source_manifest = json.loads((ROOT / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"))
        self.assertEqual(source_manifest["source_revision"], APPROVED_SOURCE_REVISION)
        self.assertEqual(source_manifest["application_base_revision"], APPROVED_SOURCE_REVISION)
        self.assertEqual(
            source_manifest["team_voice_source"],
            {
                "repository": "https://github.com/Aoacademy2025/Hero-Voice-Ai",
                "branch": "main",
                "revision": "f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37",
                "control_revision": "565d0e62e1d4269099a4c3fba8a2ecef9167eeea",
                "integration_policy": "selective-hardened-clone-only-port",
                "selected_files": [
                    "core/audio_enhance.py",
                    "core/server.py",
                    "core/text_utils.py",
                    "core/watermark.py",
                ],
            },
        )

    def test_layer_scanner_rejects_git_audio_secrets_stock_lao_and_unmanifested_models(self):
        cases = {
            ".git/config": b"clean",
            "tmp/reference.wav": b"clean",
            "tmp/disguised.bin": b"RIFF\x00\x00\x00\x00WAVE",
            "tmp/disguised-flac.bin": b"fLaC\x80\x00\x00\x22" + b"\x00" * 34,
            "tmp/late-audio.bin": b"x" * 8_192 + b"RIFF\x00\x00\x00\x00WAVE",
            "tmp/raw-mp3.bin": (b"\xff\xfb\x90\x64" + b"\x00" * 413) * 39,
            "tmp/opaque-primary.bin": b'[{"id":"voice_01","ref_audio":"sample.bin"}]',
            "tmp/opaque-lao.bin": b'[{"id":"lao_01","language":"Lao"}]',
            "root/.env.production": b"TOKEN=not-printed",
            "app/voices.json": b"[]",
            "app/lao_voice.dat": b"clean",
            "app/voice-stock-premium.dat": b"clean",
            "opt/models/extra.pth": b"weights",
            "tmp/config.txt": b'api_key="abcdefghijklmnopqrstuvwxyz012345"',
            "tmp/embedded_secret.py": b'api_key = "abcdefghijklmnopqrstuvwxyz012345"',
            "tmp/late-secret.txt": b"x" * 8_192 + b'client_secret="abcdefghijklmnopqrstuvwxyz012345"',
            "tmp/key.txt": (
                b"-----BEGIN PRIVATE KEY-----\n"
                + b"A" * 64
                + b"\n"
                + b"B" * 64
                + b"\n-----END PRIVATE KEY-----\n"
            ),
            "root/.docker/config.json": b"{}",
        }
        for relative, content in cases.items():
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                offender = root / relative
                offender.parent.mkdir(parents=True, exist_ok=True)
                offender.write_bytes(content)
                with self.assertRaises(SystemExit):
                    scan_filesystem(root, label="adversarial-layer", model_artifacts={})

    def test_layer_scanner_does_not_mistake_private_key_parser_literals_for_key_material(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            library = root / "usr/lib/libcrypto-parser.so"
            library.parent.mkdir(parents=True)
            library.write_bytes(
                b"\x7fELF\x00-----BEGIN PRIVATE KEY-----\x00parser literal\x00-----END PRIVATE KEY-----\x00"
            )
            scan_filesystem(root, label="synthetic-base-layer", model_artifacts={})

    def test_layer_scanner_does_not_mistake_python_attribute_assignment_for_secret(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "opt/conda/lib/python3.11/distutils/command/upload.py"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"self.password = self.distribution.password\n")
            scan_filesystem(root, label="synthetic-base-layer", model_artifacts={})

    def test_layer_scanner_does_not_mistake_aws_environment_variable_name_for_token_value(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "opt/venv/lib/python3.11/site-packages/botocore/credentials.py"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"ENV_VAR_AUTH_TOKEN = 'AWS_CONTAINER_AUTHORIZATION_TOKEN'\n")
            scan_filesystem(root, label="synthetic-worker-layer", model_artifacts={})

    def test_layer_scanner_does_not_mistake_utf16_bom_for_raw_mp3(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            text = root / "opt/conda/lib/python3.11/site-packages/example/utf-16.file"
            text.parent.mkdir(parents=True)
            text.write_bytes("Hello, UTF-16 world".encode("utf-16"))
            scan_filesystem(root, label="synthetic-base-layer", model_artifacts={})

    def test_layer_scanner_does_not_mistake_flac_parser_literal_for_streaminfo(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            library = root / "usr/lib/libsndfile.so"
            library.parent.mkdir(parents=True)
            library.write_bytes(b"\x7fELF\x00fLaC\x00Flac0\x00PCM\x00")
            scan_filesystem(root, label="synthetic-base-layer", model_artifacts={})

    def test_layer_scanner_accepts_only_manifested_model_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            model = root / "opt/models/allowed/model.safetensors"
            model.parent.mkdir(parents=True)
            model.write_bytes(b"weights")
            path_config = root / "opt/venv/lib/python3.11/site-packages/base-runtime.pth"
            path_config.parent.mkdir(parents=True)
            path_config.write_text("/opt/conda/lib/python3.11/site-packages\n", encoding="utf-8")
            scan_filesystem(
                root,
                label="synthetic-layer",
                model_artifacts={"allowed/model.safetensors": {"path": "allowed/model.safetensors"}},
            )
            hidden_model = root / "tmp/hidden.pth"
            hidden_model.parent.mkdir()
            hidden_model.write_bytes(b"binary model weights")
            with self.assertRaises(SystemExit):
                scan_filesystem(
                    root,
                    label="adversarial-layer",
                    model_artifacts={"allowed/model.safetensors": {"path": "allowed/model.safetensors"}},
                )

    def test_final_verifier_uses_only_authenticated_oci_layers_not_unrelated_rootfs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            forged_root = temp / "caller-forged-merged"
            app = forged_root / "app"
            app.mkdir(parents=True)
            (app / "MODEL_MANIFEST.json").write_bytes((ROOT / "MODEL_MANIFEST.json").read_bytes())
            layout, digests = synthetic_oci_layout(temp)
            evidence = load_oci_image_evidence(layout)
            self.assertEqual(evidence.layer_digests, digests)
            with self.assertRaisesRegex(SystemExit, "manifest digest mismatch"):
                verify_rootfs(
                    layout,
                    expected_manifest_digest="sha256:" + "f" * 64,
                )
            with self.assertRaisesRegex(SystemExit, "/app missing"):
                verify_rootfs(
                    layout,
                    expected_manifest_digest=evidence.manifest_digest,
                )
            self.assertTrue((forged_root / "app" / "MODEL_MANIFEST.json").is_file())

            with patch.object(
                sys,
                "argv",
                [
                    "verify_image.py", "--rootfs", str(forged_root), "--oci-layout", str(layout),
                    "--expected-manifest-digest", evidence.manifest_digest,
                ],
            ), patch("sys.stderr", new=io.StringIO()), self.assertRaises(SystemExit) as caught:
                verify_image_main()
            self.assertEqual(caught.exception.code, 2)

            blob = layout / "blobs" / "sha256" / digests[1][7:]
            blob.write_bytes(b"tampered")
            with self.assertRaisesRegex(SystemExit, "size mismatch|digest mismatch"):
                load_oci_image_evidence(layout)

    def test_authenticated_config_platform_diff_ids_env_and_history_are_bound(self):
        cases = (
            ({"config_architecture": "arm64"}, "platform"),
            ({"config_environment": ["RUNPOD_API_KEY=abcdefghijklmnopqrstuvwxyz012345"]}, "secret/payload"),
            ({"config_history": [{"created_by": "RUN ref_audio_b64=forbidden"}]}, "secret/payload"),
            ({"config_diff_ids": ["sha256:" + "0" * 64]}, "diff_ids"),
            ({"config_history": [{"created_by": "metadata only", "empty_layer": True}]}, "history/layer count"),
        )
        for options, message in cases:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temp_dir:
                layout, _digests = synthetic_oci_layout(Path(temp_dir), layer_count=1, **options)
                with self.assertRaisesRegex(SystemExit, message):
                    load_oci_image_evidence(layout)

    def test_authenticated_layer_extraction_rejects_traversal_whiteout_symlink_and_devices(self):
        attacks = (
            ({0: [("file", "../escaped", b"bad")]}, "unsafe archive path"),
            (
                {
                    0: [("symlink", "pivot", "/tmp/outside")],
                    1: [("file", "pivot/escaped", b"bad")],
                },
                "parent is not a real directory",
            ),
            (
                {
                    0: [("symlink", "pivot", "/tmp/outside")],
                    1: [("whiteout", "pivot/.wh.victim", b"")],
                },
                "parent is not a real directory",
            ),
            ({0: [("character-device", "dev/escape", b"")]}, "device/FIFO/unsupported"),
        )
        for entries, message in attacks:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temp_dir:
                layer_count = max(entries) + 1
                layout, _digests = synthetic_oci_layout(
                    Path(temp_dir),
                    layer_count=layer_count,
                    layer_entries=entries,
                )
                evidence = load_oci_image_evidence(layout)
                with self.assertRaisesRegex(SystemExit, message):
                    verify_rootfs(layout, expected_manifest_digest=evidence.manifest_digest)

    def test_authenticated_whiteout_is_applied_to_lower_layer_before_new_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            layout, digests = synthetic_oci_layout(
                temp,
                layer_count=2,
                layer_entries={
                    0: [("file", "data/old", b"old"), ("file", "data/also-old", b"old")],
                    1: [
                        ("whiteout", "data/.wh..wh..opq", b""),
                        ("file", "data/new", b"new"),
                    ],
                },
            )
            evidence = load_oci_image_evidence(layout)
            extracted = temp / "extracted"
            extracted.mkdir()
            for index, digest in enumerate(digests):
                _extract_authenticated_layer(
                    layout / "blobs" / "sha256" / digest[7:],
                    extracted,
                    label=f"test-layer[{index}]",
                )
            self.assertEqual((extracted / "data" / "new").read_bytes(), b"new")
            self.assertFalse((extracted / "data" / "old").exists())
            self.assertFalse((extracted / "data" / "also-old").exists())
            self.assertEqual(len(evidence.layer_diff_ids), 2)

    def test_rootfs_manifests_and_runtime_files_are_anchored_to_checked_in_bytes(self):
        for tampered_name in ("MODEL_MANIFEST.json", "SOURCE_MANIFEST.json", "RUNTIME_MANIFEST.json"):
            with self.subTest(tampered_name=tampered_name), tempfile.TemporaryDirectory() as temp_dir:
                rootfs = Path(temp_dir)
                app = rootfs / "app"
                app.mkdir()
                for name in ALLOWED_APP_FILES:
                    (app / name).write_bytes(b"clean")
                for name in ("MODEL_MANIFEST.json", "SOURCE_MANIFEST.json", "RUNTIME_MANIFEST.json"):
                    (app / name).write_bytes((ROOT / name).read_bytes())
                (app / tampered_name).write_bytes(b"{}")
                with self.assertRaisesRegex(SystemExit, "bytes differ from checked-in expectation"):
                    _verify_extracted_rootfs(rootfs)

        with tempfile.TemporaryDirectory() as temp_dir:
            rootfs = Path(temp_dir)
            app = rootfs / "app"
            app.mkdir()
            for name in ALLOWED_APP_FILES:
                (app / name).write_bytes(b"clean")
            for name in ("MODEL_MANIFEST.json", "SOURCE_MANIFEST.json", "RUNTIME_MANIFEST.json"):
                (app / name).write_bytes((ROOT / name).read_bytes())
            with self.assertRaisesRegex(SystemExit, "runtime source differs from checked-in manifest"):
                _verify_extracted_rootfs(rootfs)

    def test_verified_oci_layer_content_cannot_be_hidden_by_clean_extraction(self):
        cases = (
            ("renamed-catalog.bin", b'[{"id":"voice_01","ref_audio":"renamed.bin"}]'),
            ("embedded.bin", b"x" * 8_192 + b"RIFF\x00\x00\x00\x00WAVE"),
        )
        for relative, content in cases:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temp_dir:
                temp = Path(temp_dir)
                layout, digests = synthetic_oci_layout(
                    temp,
                    layer_count=1,
                    layer_files={0: (relative, content)},
                )
                evidence = load_oci_image_evidence(layout)
                self.assertEqual(evidence.layer_digests, digests)
                blob = layout / "blobs" / "sha256" / digests[0][7:]
                with self.assertRaises(SystemExit):
                    scan_oci_layer_blob(blob, label="verified-layer", model_artifacts={})

    def test_layer_scanner_rejects_sensitive_and_model_symlinks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            target = root / "plain"
            target.write_bytes(b"clean")
            credential = root / ".env"
            credential.symlink_to(target)
            with self.assertRaises(SystemExit):
                scan_filesystem(root, label="adversarial-layer", model_artifacts={})
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            target = root / "plain"
            target.write_bytes(b"clean")
            model = root / "opt/models/allowed/model.safetensors"
            model.parent.mkdir(parents=True)
            model.symlink_to(target)
            with self.assertRaises(SystemExit):
                scan_filesystem(
                    root,
                    label="adversarial-layer",
                    model_artifacts={"allowed/model.safetensors": {"path": "allowed/model.safetensors"}},
                )

    def test_no_catalog_lao_source_audio_or_persistence_files_exist(self):
        relative_files = [path.relative_to(ROOT).as_posix().lower() for path in ROOT.rglob("*") if path.is_file()]
        banned_suffixes = {".wav", ".mp3", ".m4a", ".flac", ".sqlite", ".db"}
        self.assertFalse([name for name in relative_files if Path(name).suffix in banned_suffixes])
        self.assertFalse([name for name in relative_files if "voices_lao" in name or "voice_01" in name or "studio.html" in name])

    def test_runtime_path_has_no_http_server_network_rewrite_or_tenancy_imports(self):
        runtime_sources = "\n".join(
            (ROOT / name).read_text(encoding="utf-8").lower()
            for name in ("contract.py", "handler.py", "identity.py", "language.py", "pipeline.py", "runtime.py")
        )
        for forbidden in (
            "from fastapi", "import fastapi", "import requests", "from urllib", "import sqlite3",
            "gemini", "voice_library", "creditstore", "studio.html", "mode == \"tts\"",
        ):
            self.assertNotIn(forbidden, runtime_sources)

    def test_language_parity_preserves_every_input_character(self):
        text = "วันนี้ใช้ OpenAI และ RunPod ทำงาน"
        segments = split_by_language(text)
        self.assertEqual("".join(segment for segment, _language in segments), text)
        self.assertEqual([language for _segment, language in segments], ["Thai", "English", "Thai", "English", "Thai"])

    def test_model_manifest_and_spdx_are_well_formed_and_internal_only(self):
        manifest = json.loads((ROOT / "MODEL_MANIFEST.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["purpose"], "internal-evaluation-only")
        self.assertEqual(len(manifest["artifacts"]), 12)
        self.assertTrue(all(len(artifact["sha256"]) == 64 for artifact in manifest["artifacts"]))
        sbom = json.loads((ROOT / "SBOM.spdx.json").read_text(encoding="utf-8"))
        self.assertEqual(sbom["spdxVersion"], "SPDX-2.3")
        source_manifest = json.loads((ROOT / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"))
        self.assertEqual(
            source_manifest["requirements_lock_sha256"],
            hashlib.sha256((ROOT / "requirements.lock").read_bytes()).hexdigest(),
        )
        packages = {package["SPDXID"]: package for package in sbom["packages"]}
        self.assertEqual(len(packages), len(sbom["packages"]))
        self.assertEqual(
            len([identifier for identifier in packages if identifier.startswith("SPDXRef-Python-")]),
            source_manifest["requirements_lock_package_count"],
        )
        self.assertEqual(
            len([identifier for identifier in packages if identifier.startswith("SPDXRef-BuildPython-")]),
            source_manifest["build_requirements_lock_package_count"],
        )
        for identifier in (
            "SPDXRef-Package-OmniVoice-Source",
            "SPDXRef-Package-AudioSeal-Source",
            "SPDXRef-Package-Demucs-Source",
            *(f"SPDXRef-Model-{index:02d}" for index in range(1, 13)),
        ):
            self.assertIn(identifier, packages)
        relationship_set = {
            (item["spdxElementId"], item["relationshipType"], item["relatedSpdxElement"])
            for item in sbom["relationships"]
        }
        self.assertIn(
            ("SPDXRef-Package-Worker", "DEPENDS_ON", "SPDXRef-Python-pydub"),
            relationship_set,
        )
        self.assertIn(
            ("SPDXRef-BuildPython-hatchling", "BUILD_DEPENDENCY_OF", "SPDXRef-Package-OmniVoice-Source"),
            relationship_set,
        )
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("internal evaluation only", notices)
        self.assertIn("Commercial use is\n  blocked", notices)


if __name__ == "__main__":
    unittest.main()

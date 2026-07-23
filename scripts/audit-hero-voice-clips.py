#!/usr/bin/env python3
"""Audit real Hero AI Voice outputs against their source script and voice reference.

The metadata input is a pipe-separated, private diagnostic file with columns:
job_id|email|voice_id|script_utf8_hex|voice_url|audio_duration_ms|timing_utf8_hex

Example:
  uv run --with resemblyzer --with librosa --with soundfile \
    --with openai-whisper --with 'setuptools<81' \
    python scripts/audit-hero-voice-clips.py \
      --metadata /tmp/jobs.psv \
      --clip JOB_ID=/tmp/clip.wav \
      --enforce
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import wave

import librosa
import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav


ROOT = Path(__file__).resolve().parents[1]
VOICE_ROOT = ROOT / "services" / "omnivoice-runpod" / "assets" / "voices"
PREVIEW_ROOT = ROOT / "assets" / "hero-voice-previews"
EXPECTED_SAMPLE_RATE = 24_000
ASR_FAIL_CER = 0.10
SPEAKER_FAIL_SIMILARITY = 0.75
SPEAKER_REVIEW_SIMILARITY = 0.85
# Whisper may spell a correctly spoken brand in Thai while the script uses its
# Latin trademark. Compare those audited equivalents as the same token so the
# CER gate measures pronunciation errors rather than writing-system choice.
ASR_EQUIVALENT_ALIASES = (
    ("tiktok", ("ติ๊กต็อก", "ติ๊กตอก", "ติกต็อก", "ติกตอก")),
    ("facebook", ("เฟซบุ๊ก", "เฟซบุก", "เฟสบุก", "เฟียสบุก")),
    ("igreels", ("ig reels", "ไอจีรีลส์", "ไอจีรีล")),
)


@dataclass(frozen=True)
class ClipMetadata:
    job_id: str
    email: str
    voice_id: str
    script: str
    voice_url: str
    audio_duration_ms: int


@dataclass(frozen=True)
class AudioMetrics:
    duration_seconds: float
    sample_rate: int
    channels: int
    sample_width_bytes: int
    peak_dbfs: float
    rms_dbfs: float
    clipping_ratio: float
    max_adjacent_jump: float
    large_jump_count: int
    spectral_flatness: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument(
        "--clip",
        action="append",
        default=[],
        metavar="JOB_ID=PATH",
        help="map a production job ID to its downloaded WAV; repeat for every clip",
    )
    parser.add_argument("--asr-model", default="large-v3-turbo")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument(
        "--job-id",
        action="append",
        default=[],
        help="audit only these metadata job IDs; repeat to select multiple rows",
    )
    parser.add_argument(
        "--allow-duration-change",
        action="store_true",
        help="report but do not fail a regenerated candidate whose duration differs from production metadata",
    )
    parser.add_argument("--enforce", action="store_true")
    return parser.parse_args()


def decode_hex(value: str) -> str:
    return bytes.fromhex(value).decode("utf-8") if value else ""


def read_metadata(path: Path) -> dict[str, ClipMetadata]:
    rows: dict[str, ClipMetadata] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        columns = raw_line.split("|")
        if len(columns) != 7:
            raise ValueError(f"{path}:{line_number}: expected 7 columns, got {len(columns)}")
        job_id, email, voice_id, script_hex, voice_url, duration_ms, _timing_hex = columns
        rows[job_id] = ClipMetadata(
            job_id=job_id,
            email=email,
            voice_id=voice_id,
            script=decode_hex(script_hex),
            voice_url=voice_url,
            audio_duration_ms=int(duration_ms),
        )
    return rows


def read_clip_map(values: list[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for value in values:
        job_id, separator, raw_path = value.partition("=")
        if not separator or not job_id or not raw_path:
            raise ValueError(f"invalid --clip mapping: {value}")
        result[job_id] = Path(raw_path)
    return result


def dbfs(value: float) -> float:
    return 20 * math.log10(max(value, 1e-12))


def load_wav(path: Path) -> tuple[np.ndarray, AudioMetrics]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        pcm = source.readframes(frame_count)

    if sample_width != 2:
        audio = np.zeros(0, dtype=np.float32)
    else:
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if channels > 1 and audio.size % channels == 0:
            audio = audio.reshape(-1, channels).mean(axis=1)

    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
    clipping_ratio = float(np.mean(np.abs(audio) >= 0.999)) if audio.size else 0.0
    adjacent = np.abs(np.diff(audio)) if audio.size > 1 else np.zeros(0)
    max_adjacent_jump = float(np.max(adjacent)) if adjacent.size else 0.0
    # A full-scale step over one sample is a useful deterministic click/pop signal.
    large_jump_count = int(np.sum(adjacent >= 0.80)) if adjacent.size else 0
    spectral = librosa.feature.spectral_flatness(y=audio, n_fft=1024, hop_length=256)[0] if audio.size else np.zeros(0)
    flatness = float(np.median(spectral)) if spectral.size else 0.0
    duration = frame_count / sample_rate if sample_rate else 0.0
    return audio, AudioMetrics(
        duration_seconds=round(duration, 4),
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bytes=sample_width,
        peak_dbfs=round(dbfs(peak), 3),
        rms_dbfs=round(dbfs(rms), 3),
        clipping_ratio=round(clipping_ratio, 8),
        max_adjacent_jump=round(max_adjacent_jump, 6),
        large_jump_count=large_jump_count,
        spectral_flatness=round(flatness, 7),
    )


def normalized_text(value: str, canonicalize_asr_equivalents: bool = True) -> str:
    normalized = value.lower()
    if canonicalize_asr_equivalents:
        for canonical, aliases in ASR_EQUIVALENT_ALIASES:
            for alias in aliases:
                normalized = normalized.replace(alias, canonical)
    return "".join(character for character in normalized if character.isalnum())


def character_error_rate(
    expected: str,
    actual: str,
    canonicalize_asr_equivalents: bool = True,
) -> float:
    left = normalized_text(expected, canonicalize_asr_equivalents)
    right = normalized_text(actual, canonicalize_asr_equivalents)
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_character != right_character),
            ))
        previous = current
    return previous[-1] / max(1, len(left))


def main() -> int:
    args = parse_args()
    metadata = read_metadata(args.metadata)
    if args.job_id:
        unknown = sorted(set(args.job_id) - set(metadata))
        if unknown:
            raise ValueError(f"unknown --job-id values: {unknown}")
        metadata = {job_id: metadata[job_id] for job_id in args.job_id}
    clips = read_clip_map(args.clip)
    missing = sorted(set(metadata) - set(clips))
    extra = sorted(set(clips) - set(metadata))
    if missing or extra:
        raise ValueError(f"clip mappings differ from metadata; missing={missing}, extra={extra}")

    try:
        import whisper
    except ImportError as error:
        raise RuntimeError("audit requires openai-whisper") from error

    whisper_model = whisper.load_model(args.asr_model)
    encoder = VoiceEncoder()
    results: list[dict] = []
    fail_count = 0

    for job_id, row in metadata.items():
        path = clips[job_id]
        audio, metrics = load_wav(path)
        structure_ok = (
            metrics.sample_rate == EXPECTED_SAMPLE_RATE
            and metrics.channels == 1
            and metrics.sample_width_bytes == 2
        )
        duration_delta_ms = abs(round(metrics.duration_seconds * 1000) - row.audio_duration_ms)
        clipping_ok = metrics.clipping_ratio <= 0.001
        discontinuity_ok = metrics.large_jump_count == 0

        transcript = str(whisper_model.transcribe(
            str(path),
            language="th",
            verbose=False,
            condition_on_previous_text=False,
            temperature=0,
            fp16=False,
        ).get("text", "")).strip()
        raw_cer = character_error_rate(
            row.script,
            transcript,
            canonicalize_asr_equivalents=False,
        )
        cer = character_error_rate(row.script, transcript)

        reference_path = VOICE_ROOT / f"{row.voice_id}.wav"
        preview_path = PREVIEW_ROOT / f"{row.voice_id}.wav"
        generated_embedding = encoder.embed_utterance(preprocess_wav(path))
        reference_similarity = float(
            generated_embedding @ encoder.embed_utterance(preprocess_wav(reference_path))
        )
        preview_similarity = float(
            generated_embedding @ encoder.embed_utterance(preprocess_wav(preview_path))
        )
        speaker_similarity = max(reference_similarity, preview_similarity)

        findings: list[str] = []
        if not structure_ok:
            findings.append("FAIL structure")
        if duration_delta_ms > 5 and not args.allow_duration_change:
            findings.append(f"FAIL duration-metadata delta={duration_delta_ms}ms")
        if not clipping_ok:
            findings.append(f"FAIL clipping={metrics.clipping_ratio:.4%}")
        if not discontinuity_ok:
            findings.append(f"FAIL discontinuity jumps={metrics.large_jump_count}")
        if cer > ASR_FAIL_CER:
            findings.append(f"FAIL thai-asr CER={cer:.2%}")
        if speaker_similarity < SPEAKER_FAIL_SIMILARITY:
            findings.append(f"FAIL speaker identity={speaker_similarity:.4f}")
        elif speaker_similarity < SPEAKER_REVIEW_SIMILARITY:
            findings.append(f"REVIEW speaker identity={speaker_similarity:.4f}")

        has_failure = any(finding.startswith("FAIL") for finding in findings)
        fail_count += int(has_failure)
        result = {
            "job_id": job_id,
            "email": row.email,
            "voice_id": row.voice_id,
            "script_chars": len(row.script),
            "metrics": asdict(metrics),
            "duration_metadata_delta_ms": duration_delta_ms,
            "thai_asr_raw_cer": round(raw_cer, 6),
            "thai_asr_cer": round(cer, 6),
            "speaker_reference_similarity": round(reference_similarity, 6),
            "speaker_preview_similarity": round(preview_similarity, 6),
            "findings": findings,
            # Kept in private JSON output for diagnosis; never printed to stdout.
            "transcript": transcript,
        }
        results.append(result)
        print(
            f"{'FAIL' if has_failure else 'PASS'}"
            f"\t{job_id}\t{row.email}\t{row.voice_id}"
            f"\tchars={len(row.script)}\tduration={metrics.duration_seconds:.2f}s"
            f"\tCER={cer:.2%}\traw_CER={raw_cer:.2%}\tspeaker={speaker_similarity:.4f}"
            f"\tclip={metrics.clipping_ratio:.4%}\tjumps={metrics.large_jump_count}"
            f"\t{'; '.join(findings) if findings else 'no findings'}"
        )

    report = {
        "summary": {
            "clips": len(results),
            "failures": fail_count,
            "asr_model": args.asr_model,
            "asr_fail_cer": ASR_FAIL_CER,
            "speaker_fail_similarity": SPEAKER_FAIL_SIMILARITY,
            "duration_change_allowed": args.allow_duration_change,
        },
        "clips": results,
    }
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False))
    return 1 if args.enforce and fail_count else 0


if __name__ == "__main__":
    raise SystemExit(main())

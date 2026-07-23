#!/usr/bin/env python3
"""Deterministic quality/diversity gate for the 48 Hero AI Voice references.

Fast gate (structure, pitch/profile, two-model speaker diversity, clone consistency):
  uv run --with resemblyzer --with librosa --with soundfile \
    --with speechbrain --with torchaudio \
    --with 'setuptools<81' python scripts/audit-hero-voice-catalog.py --enforce

Full Thai ASR gate adds OpenAI Whisper and is intentionally slower:
  uv run --with resemblyzer --with librosa --with soundfile \
    --with speechbrain --with torchaudio --with openai-whisper --with 'setuptools<81' \
    python scripts/audit-hero-voice-catalog.py --asr --enforce

ASR is a pronunciation screening signal. Subjective labels such as warmth and
trustworthiness still require the product owner's listening approval.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import wave

import librosa
import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav


ROOT = Path(__file__).resolve().parents[1]
VOICE_ROOT = ROOT / "services" / "omnivoice-runpod" / "assets" / "voices"
PREVIEW_ROOT = ROOT / "assets" / "hero-voice-previews"
MANIFEST_PATH = VOICE_ROOT / "voices.json"

EXPECTED_VOICE_IDS = [f"voice_{index:02d}" for index in range(1, 49)]
EXPECTED_SAMPLE_RATE = 24_000
MIN_DURATION_SECONDS = 2.0
MAX_DURATION_SECONDS = 10.0
ASR_FAIL_CER = 0.10
ASR_REVIEW_CER = 0.05
SPEAKER_DUPLICATE_THRESHOLD = 0.90
SPEAKER_REVIEW_THRESHOLD = 0.86
ECAPA_DUPLICATE_THRESHOLD = 0.75
ECAPA_REVIEW_THRESHOLD = 0.70
CLONE_CONSISTENCY_THRESHOLD = 0.85


@dataclass(frozen=True)
class AudioMetrics:
    duration_seconds: float
    sample_rate: int
    channels: int
    sample_width_bytes: int
    peak_dbfs: float
    rms_dbfs: float
    clipping_ratio: float
    voiced_ratio: float
    median_f0_hz: float | None
    spectral_flatness: float
    sha256: str


@dataclass(frozen=True)
class Finding:
    severity: str
    gate: str
    voices: tuple[str, ...]
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asr", action="store_true", help="run Thai Whisper screening for references and previews")
    parser.add_argument("--asr-model", default="large-v3-turbo")
    parser.add_argument("--enforce", action="store_true", help="exit non-zero when a FAIL finding exists")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--markdown-out", type=Path)
    return parser.parse_args()


def load_wav(path: Path) -> tuple[np.ndarray, AudioMetrics]:
    raw = path.read_bytes()
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

    duration = frame_count / sample_rate if sample_rate else 0.0
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
    clipping_ratio = float(np.mean(np.abs(audio) >= 0.999)) if audio.size else 0.0

    median_f0: float | None = None
    voiced_ratio = 0.0
    flatness = 0.0
    if audio.size and sample_rate:
        f0, _, _ = librosa.pyin(
            audio,
            fmin=60,
            fmax=600,
            sr=sample_rate,
            frame_length=2048,
        )
        finite_f0 = f0[np.isfinite(f0)]
        voiced_ratio = float(np.mean(np.isfinite(f0)))
        if finite_f0.size:
            median_f0 = float(np.median(finite_f0))
        spectral = librosa.feature.spectral_flatness(y=audio, n_fft=1024, hop_length=256)[0]
        flatness = float(np.median(spectral)) if spectral.size else 0.0

    def dbfs(value: float) -> float:
        return 20 * math.log10(max(value, 1e-12))

    return audio, AudioMetrics(
        duration_seconds=round(duration, 4),
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bytes=sample_width,
        peak_dbfs=round(dbfs(peak), 3),
        rms_dbfs=round(dbfs(rms), 3),
        clipping_ratio=round(clipping_ratio, 8),
        voiced_ratio=round(voiced_ratio, 4),
        median_f0_hz=round(median_f0, 2) if median_f0 is not None else None,
        spectral_flatness=round(flatness, 7),
        sha256=hashlib.sha256(raw).hexdigest(),
    )


def normalized_text(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum())


def character_error_rate(expected: str, actual: str) -> float:
    left = normalized_text(expected)
    right = normalized_text(actual)
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


def expected_pitch_problem(instruct: str, metrics: AudioMetrics) -> str | None:
    """Check only explicit pitch claims using deliberately broad Thai ranges."""
    f0 = metrics.median_f0_hz
    if f0 is None or metrics.voiced_ratio < 0.05:
        return "ไม่มีช่วง voiced เพียงพอสำหรับยืนยัน pitch"

    attributes = {item.strip().lower() for item in instruct.split(",")}
    is_female = "female" in attributes
    is_male = "male" in attributes

    if "very low pitch" in attributes:
        ceiling = 195 if is_female else 130
        if f0 > ceiling:
            return f"ระบุ very low pitch แต่ median F0={f0:.1f}Hz สูงกว่าเพดาน {ceiling}Hz"
    elif "low pitch" in attributes:
        ceiling = 220 if is_female else 155
        if f0 > ceiling:
            return f"ระบุ low pitch แต่ median F0={f0:.1f}Hz สูงกว่าเพดาน {ceiling}Hz"
    elif "moderate pitch" in attributes:
        lower, upper = ((180, 285) if is_female else (125, 200))
        if not lower <= f0 <= upper:
            return f"ระบุ moderate pitch แต่ median F0={f0:.1f}Hz อยู่นอกช่วง {lower}-{upper}Hz"
    elif "very high pitch" in attributes:
        floor = 330 if is_female else 280
        if f0 < floor:
            return f"ระบุ very high pitch แต่ median F0={f0:.1f}Hz ต่ำกว่าพื้น {floor}Hz"
    elif "high pitch" in attributes:
        floor = 265 if is_female else 180
        if f0 < floor:
            return f"ระบุ high pitch แต่ median F0={f0:.1f}Hz ต่ำกว่าพื้น {floor}Hz"

    if "whisper" in attributes:
        if metrics.voiced_ratio > 0.50 or metrics.spectral_flatness < 0.002:
            return (
                "ระบุ whisper แต่สัญญาณยังมี voiced/harmonic มากเกิน gate "
                f"(voiced={metrics.voiced_ratio:.2f}, flatness={metrics.spectral_flatness:.5f})"
            )
    return None


def add_audio_findings(
    findings: list[Finding],
    voice_id: str,
    label: str,
    metrics: AudioMetrics,
    instruct: str,
) -> None:
    if metrics.sample_rate != EXPECTED_SAMPLE_RATE or metrics.channels != 1 or metrics.sample_width_bytes != 2:
        findings.append(Finding("FAIL", "structure", (voice_id,), (
            f"{label} ต้องเป็น mono PCM16 24kHz แต่ได้ channels={metrics.channels}, "
            f"width={metrics.sample_width_bytes}, rate={metrics.sample_rate}"
        )))
    if not MIN_DURATION_SECONDS <= metrics.duration_seconds <= MAX_DURATION_SECONDS:
        findings.append(Finding("FAIL", "duration", (voice_id,), (
            f"{label} duration={metrics.duration_seconds:.2f}s อยู่นอกช่วง "
            f"{MIN_DURATION_SECONDS:.0f}-{MAX_DURATION_SECONDS:.0f}s"
        )))
    if metrics.clipping_ratio > 0.001:
        findings.append(Finding("FAIL", "clipping", (voice_id,), (
            f"{label} clipping ratio={metrics.clipping_ratio:.4%}"
        )))
    if label == "reference":
        pitch_problem = expected_pitch_problem(instruct, metrics)
        if pitch_problem:
            findings.append(Finding("FAIL", "profile", (voice_id,), pitch_problem))


def transcribe_all(paths: list[Path], model_name: str) -> dict[Path, str]:
    try:
        import whisper
    except ImportError as error:
        raise RuntimeError("--asr requires openai-whisper") from error

    model = whisper.load_model(model_name)
    results: dict[Path, str] = {}
    for index, path in enumerate(paths, start=1):
        output = model.transcribe(
            str(path),
            language="th",
            verbose=False,
            condition_on_previous_text=False,
            temperature=0,
            fp16=False,
        )
        results[path] = str(output.get("text", "")).strip()
        print(f"asr={index}/{len(paths)} file={path.name}", file=sys.stderr, flush=True)
    return results


def embed_ecapa(paths: list[Path]) -> np.ndarray:
    """Return normalized ECAPA embeddings as an independent speaker signal."""
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except ImportError as error:
        raise RuntimeError("speaker consensus gate requires speechbrain and torchaudio") from error

    model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="/tmp/hero-voice-ecapa",
    )
    embeddings = []
    for path in paths:
        signal = model.load_audio(str(path))
        embedding = model.encode_batch(signal.unsqueeze(0)).squeeze().detach()
        embedding = embedding / embedding.norm()
        embeddings.append(embedding.cpu().numpy())
    return np.stack(embeddings)


def markdown_report(report: dict) -> str:
    lines = [
        "# Hero AI Voice catalog quality audit",
        "",
        f"- Voices: {report['summary']['voices']}",
        f"- FAIL findings: {report['summary']['fail_findings']}",
        f"- REVIEW findings: {report['summary']['review_findings']}",
        f"- Thai ASR enabled: {'yes' if report['summary']['asr_enabled'] else 'no'}",
        "",
        "## Findings",
        "",
        "| Severity | Gate | Voice(s) | Evidence |",
        "| --- | --- | --- | --- |",
    ]
    for finding in report["findings"]:
        message = finding["message"].replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {finding['severity']} | {finding['gate']} | {', '.join(finding['voices'])} | {message} |"
        )
    lines.extend([
        "",
        "## Per-voice measurements",
        "",
        "| Voice | Reference CER | Preview CER | F0 | Voiced | Closest reference | Similarity |",
        "| --- | ---: | ---: | ---: | ---: | --- | ---: |",
    ])
    for voice in report["voices"]:
        reference_cer = "—" if voice["reference_cer"] is None else f"{voice['reference_cer']:.2%}"
        preview_cer = "—" if voice["preview_cer"] is None else f"{voice['preview_cer']:.2%}"
        f0 = voice["reference_metrics"]["median_f0_hz"]
        lines.append(
            f"| {voice['id']} | {reference_cer} | {preview_cer} | "
            f"{'—' if f0 is None else f'{f0:.1f}Hz'} | "
            f"{voice['reference_metrics']['voiced_ratio']:.2f} | "
            f"{voice['closest_reference_voice']} | {voice['closest_reference_similarity']:.4f} |"
        )
    lines.extend([
        "",
        "> ASR, pitch and speaker embeddings are screening gates. Subjective persona labels require human listening approval.",
        "",
    ])
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ids = [voice.get("id") for voice in manifest]
    findings: list[Finding] = []
    if ids != EXPECTED_VOICE_IDS:
        findings.append(Finding("FAIL", "catalog", tuple(), "catalog ต้องเรียง voice_01 ถึง voice_48 ครบถ้วน"))

    reference_paths = [VOICE_ROOT / voice["ref_audio"] for voice in manifest]
    preview_paths = [PREVIEW_ROOT / voice["ref_audio"] for voice in manifest]
    for path in reference_paths + preview_paths:
        if not path.is_file():
            findings.append(Finding("FAIL", "missing", (path.stem,), f"ไม่พบไฟล์ {path.relative_to(ROOT)}"))
    if any(finding.gate == "missing" for finding in findings):
        for finding in findings:
            print(f"{finding.severity} {finding.gate} {finding.message}")
        return 1

    reference_metrics: dict[str, AudioMetrics] = {}
    preview_metrics: dict[str, AudioMetrics] = {}
    for voice, reference_path, preview_path in zip(manifest, reference_paths, preview_paths):
        _, ref_metrics = load_wav(reference_path)
        _, prev_metrics = load_wav(preview_path)
        reference_metrics[voice["id"]] = ref_metrics
        preview_metrics[voice["id"]] = prev_metrics
        add_audio_findings(findings, voice["id"], "reference", ref_metrics, voice["instruct"])
        add_audio_findings(findings, voice["id"], "preview", prev_metrics, voice["instruct"])

    encoder = VoiceEncoder()
    reference_embeddings = np.stack([
        encoder.embed_utterance(preprocess_wav(path)) for path in reference_paths
    ])
    preview_embeddings = np.stack([
        encoder.embed_utterance(preprocess_wav(path)) for path in preview_paths
    ])
    reference_similarity = reference_embeddings @ reference_embeddings.T
    preview_similarity = preview_embeddings @ preview_embeddings.T
    reference_ecapa_embeddings = embed_ecapa(reference_paths)
    preview_ecapa_embeddings = embed_ecapa(preview_paths)
    reference_ecapa_similarity = reference_ecapa_embeddings @ reference_ecapa_embeddings.T
    preview_ecapa_similarity = preview_ecapa_embeddings @ preview_ecapa_embeddings.T

    for left in range(len(manifest)):
        clone_similarity = float(reference_embeddings[left] @ preview_embeddings[left])
        if clone_similarity < CLONE_CONSISTENCY_THRESHOLD:
            voice_id = manifest[left]["id"]
            findings.append(Finding("FAIL", "clone", (voice_id,), (
                f"reference/preview speaker similarity={clone_similarity:.4f} ต่ำกว่า "
                f"{CLONE_CONSISTENCY_THRESHOLD:.2f}"
            )))
        for right in range(left + 1, len(manifest)):
            ref_score = float(reference_similarity[left, right])
            preview_score = float(preview_similarity[left, right])
            score = max(ref_score, preview_score)
            ecapa_ref_score = float(reference_ecapa_similarity[left, right])
            ecapa_preview_score = float(preview_ecapa_similarity[left, right])
            ecapa_score = max(ecapa_ref_score, ecapa_preview_score)
            if score < SPEAKER_REVIEW_THRESHOLD and ecapa_score < ECAPA_REVIEW_THRESHOLD:
                continue
            severity = (
                "FAIL"
                if score >= SPEAKER_DUPLICATE_THRESHOLD and ecapa_score >= ECAPA_DUPLICATE_THRESHOLD
                else "REVIEW"
            )
            findings.append(Finding(severity, "duplicate", (
                manifest[left]["id"], manifest[right]["id"]
            ), (
                f"Resemblyzer max={score:.4f} (reference={ref_score:.4f}, preview={preview_score:.4f}); "
                f"ECAPA max={ecapa_score:.4f} (reference={ecapa_ref_score:.4f}, "
                f"preview={ecapa_preview_score:.4f})"
            )))

    asr_results: dict[Path, str] = {}
    if args.asr:
        asr_results = transcribe_all(reference_paths + preview_paths, args.asr_model)

    voice_rows: list[dict] = []
    for index, (voice, reference_path, preview_path) in enumerate(zip(manifest, reference_paths, preview_paths)):
        reference_cer: float | None = None
        preview_cer: float | None = None
        if args.asr:
            reference_cer = character_error_rate(voice["ref_text"], asr_results[reference_path])
            preview_cer = character_error_rate(voice["preview_text"], asr_results[preview_path])
            for label, score, transcript in (
                ("reference", reference_cer, asr_results[reference_path]),
                ("preview", preview_cer, asr_results[preview_path]),
            ):
                if score > ASR_FAIL_CER:
                    findings.append(Finding("FAIL", "thai-asr", (voice["id"],), (
                        f"{label} CER={score:.2%}; transcript={transcript}"
                    )))
                elif score > ASR_REVIEW_CER:
                    findings.append(Finding("REVIEW", "thai-asr", (voice["id"],), (
                        f"{label} CER={score:.2%}; transcript={transcript}"
                    )))

        other_scores = reference_similarity[index].copy()
        other_scores[index] = -1
        closest_index = int(np.argmax(other_scores))
        voice_rows.append({
            "id": voice["id"],
            "desc": voice["desc"],
            "instruct": voice["instruct"],
            "reference_metrics": asdict(reference_metrics[voice["id"]]),
            "preview_metrics": asdict(preview_metrics[voice["id"]]),
            "reference_cer": reference_cer,
            "preview_cer": preview_cer,
            "reference_transcript": asr_results.get(reference_path),
            "preview_transcript": asr_results.get(preview_path),
            "clone_similarity": round(float(reference_embeddings[index] @ preview_embeddings[index]), 6),
            "closest_reference_voice": manifest[closest_index]["id"],
            "closest_reference_similarity": round(float(other_scores[closest_index]), 6),
        })

    findings.sort(key=lambda finding: (
        0 if finding.severity == "FAIL" else 1,
        finding.gate,
        finding.voices,
    ))
    report = {
        "summary": {
            "voices": len(manifest),
            "asr_enabled": args.asr,
            "fail_findings": sum(finding.severity == "FAIL" for finding in findings),
            "review_findings": sum(finding.severity == "REVIEW" for finding in findings),
            "speaker_duplicate_threshold": SPEAKER_DUPLICATE_THRESHOLD,
            "speaker_review_threshold": SPEAKER_REVIEW_THRESHOLD,
            "ecapa_duplicate_threshold": ECAPA_DUPLICATE_THRESHOLD,
            "ecapa_review_threshold": ECAPA_REVIEW_THRESHOLD,
            "asr_fail_cer": ASR_FAIL_CER,
        },
        "findings": [asdict(finding) for finding in findings],
        "voices": voice_rows,
    }

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.markdown_out:
        args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_out.write_text(markdown_report(report), encoding="utf-8")

    print(json.dumps(report["summary"], ensure_ascii=False))
    for finding in findings:
        print(f"{finding.severity}\t{finding.gate}\t{','.join(finding.voices)}\t{finding.message}")
    return 1 if args.enforce and report["summary"]["fail_findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

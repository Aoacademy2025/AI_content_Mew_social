from __future__ import annotations

import hashlib
import io
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from contextlib import redirect_stdout
from pathlib import Path
from typing import Callable, Sequence

from canonical import dumps_jcs, loads_exact_jcs
from verify_lock import lock_is_complete

MODEL_SHA256 = "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a"
MODEL_NAME = "large-v3-turbo.pt"
WHISPER_VERSION = "20250625"
FFMPEG_ARGV = (
    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
    "-i", "INPUT", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", "-f", "s16le", "-fflags", "+bitexact", "-flags:a",
    "+bitexact", "-map_metadata", "-1", "OUTPUT.pcm",
)
DECODER = {
    "beam_size": 5,
    "condition_on_previous_text": False,
    "fp16": False,
    "language": "th",
    "task": "transcribe",
    "temperature": 0,
}
THREAD_ENV = ("OMP_NUM_THREADS", "MKL_NUM_THREADS")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SLOT_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{3,119}$")
RUNTIME_FINGERPRINT_KEYS = (
    "containerPlatform", "containerRuntimeVersion", "cpuBrand", "cpuFlagsSha256",
    "dependencyLockSha256", "determinism", "emulationDisabled", "evaluatorImageDigest",
    "ffmpegBinarySha256", "ffmpegVersion", "hostArchitecture", "libcVersion",
    "modelSha256", "numpyBlasConfigSha256", "platformMachine", "pythonVersion",
    "pytorchBuildConfigSha256", "threadEnvironment", "unameMachine", "version",
)


class EvaluatorContractError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_cer_text(value: str) -> str:
    if not isinstance(value, str):
        raise EvaluatorContractError("text must be a string")
    folded = unicodedata.normalize("NFC", value).casefold()
    return "".join(character for character in folded if unicodedata.category(character)[0] in {"L", "M", "N"})


def levenshtein_codepoints(expected: str, actual: str) -> int:
    previous = list(range(len(actual) + 1))
    for row, expected_character in enumerate(expected, 1):
        current = [row]
        for column, actual_character in enumerate(actual, 1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (expected_character != actual_character),
            ))
        previous = current
    return previous[-1]


def cer_counts(expected_text: str, actual_text: str) -> tuple[int, int]:
    expected = normalize_cer_text(expected_text)
    actual = normalize_cer_text(actual_text)
    if not expected:
        raise EvaluatorContractError("normalized expected text is empty")
    return levenshtein_codepoints(expected, actual), len(expected)


def pcm16le_to_float32(pcm: bytes):
    if len(pcm) == 0 or len(pcm) % 2:
        raise EvaluatorContractError("PCM must contain complete little-endian int16 samples")
    try:
        import numpy as np
    except ImportError as exc:
        raise EvaluatorContractError("canonical NumPy runtime unavailable") from exc
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    return samples / np.float32(32768.0)


def ffmpeg_argv(source: Path, destination: Path) -> list[str]:
    if not source.is_absolute() or not destination.is_absolute() or source == destination:
        raise EvaluatorContractError("absolute distinct FFmpeg paths required")
    return [str(source) if item == "INPUT" else str(destination) if item == "OUTPUT.pcm" else item for item in FFMPEG_ARGV]


def convert_wav(source: Path, destination: Path) -> bytes:
    subprocess.run(ffmpeg_argv(source, destination), check=True, stdin=subprocess.DEVNULL, capture_output=True)
    return destination.read_bytes()


def assert_canonical_runtime(model_path: Path, network_marker: Path) -> None:
    if sys.platform != "linux" or platform.machine() not in {"aarch64", "arm64"}:
        raise EvaluatorContractError("canonical evaluator requires non-emulated linux/arm64")
    if os.environ.get("HERO_VOICE_EVALUATOR_EMULATION_DISABLED") != "1":
        raise EvaluatorContractError("emulation-disabled readback missing")
    if os.environ.get("HERO_VOICE_EVALUATOR_NETWORK_DISABLED") != "1" or not network_marker.is_file():
        raise EvaluatorContractError("network-disabled attestation missing")
    if any(os.environ.get(name) != "1" for name in THREAD_ENV):
        raise EvaluatorContractError("thread environment mismatch")
    if not model_path.is_file() or model_path.name != MODEL_NAME or sha256_file(model_path) != MODEL_SHA256:
        raise EvaluatorContractError("Whisper model identity mismatch")


def configure_torch() -> None:
    import numpy as np
    import torch

    np.random.seed(0)
    torch.manual_seed(0)
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    if torch.cuda.is_available() or getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        raise EvaluatorContractError("GPU/MPS must be unavailable")


def transcribe_pcm(pcm: bytes, model_path: Path) -> str:
    assert_canonical_runtime(model_path, Path("/run/hero-voice-evaluator/network-disabled"))
    configure_torch()
    import whisper

    if getattr(whisper, "__version__", None) != WHISPER_VERSION:
        raise EvaluatorContractError("Whisper package identity mismatch")
    model = whisper.load_model(str(model_path), device="cpu", download_root="/nonexistent")
    result = model.transcribe(pcm16le_to_float32(pcm), **DECODER)
    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str):
        raise EvaluatorContractError("Whisper result schema mismatch")
    return text


def load_canonical_transcriber(model_path: Path) -> Callable[[bytes], str]:
    assert_canonical_runtime(model_path, Path("/run/hero-voice-evaluator/network-disabled"))
    configure_torch()
    import whisper
    if getattr(whisper, "__version__", None) != WHISPER_VERSION:
        raise EvaluatorContractError("Whisper package identity mismatch")
    model = whisper.load_model(str(model_path), device="cpu", download_root="/nonexistent")

    def transcribe(pcm: bytes) -> str:
        result = model.transcribe(pcm16le_to_float32(pcm), **DECODER)
        text = result.get("text") if isinstance(result, dict) else None
        if not isinstance(text, str):
            raise EvaluatorContractError("Whisper result schema mismatch")
        return text
    return transcribe


def score_pcm(
    pcm: bytes,
    expected_text: str,
    transcriber: Callable[[bytes], str],
) -> dict[str, object]:
    actual_text = transcriber(pcm)
    numerator, denominator = cer_counts(expected_text, actual_text)
    return {
        "version": 1,
        "actualTextSha256": sha256_bytes(actual_text.encode("utf-8")),
        "cerDenominator": denominator,
        "cerNumerator": numerator,
        "expectedTextSha256": sha256_bytes(expected_text.encode("utf-8")),
        "passed": numerator * 10 <= denominator,
    }


def validate_batch_inventory(value: object, batch_kind: str) -> list[dict[str, str]]:
    expected_count = 8 if batch_kind == "ablation-8" else 36 if batch_kind == "final-36" else 0
    if not isinstance(value, dict) or sorted(value) != ["batchKind", "items", "version"] \
            or value.get("version") != 1 or value.get("batchKind") != batch_kind:
        raise EvaluatorContractError("batch inventory schema mismatch")
    items = value.get("items")
    if not isinstance(items, list) or len(items) != expected_count:
        raise EvaluatorContractError("batch inventory count mismatch")
    output: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict) or sorted(item) != ["audioSha256", "expectedText", "slotId", "storageBasename"]:
            raise EvaluatorContractError("batch item schema mismatch")
        if not all(isinstance(item[key], str) and item[key] for key in item):
            raise EvaluatorContractError("batch item value mismatch")
        if not item["storageBasename"].endswith(".wav") or "/" in item["storageBasename"] or "\\" in item["storageBasename"]:
            raise EvaluatorContractError("batch storage basename mismatch")
        if not HEX64.fullmatch(item["audioSha256"]) or not SLOT_ID.fullmatch(item["slotId"]) \
                or len(item["expectedText"].encode("utf-8")) > 3_200:
            raise EvaluatorContractError("batch audio hash mismatch")
        output.append(item)
    if len({item["slotId"] for item in output}) != expected_count or len({item["storageBasename"] for item in output}) != expected_count:
        raise EvaluatorContractError("batch inventory duplicate")
    return output


def validate_fixture_hashes(pre: Sequence[str], post: Sequence[str], runtime_fingerprint_sha256: str) -> None:
    if len(pre) != 3 or len(post) != 3 or len(set(pre)) != 1 or len(set(post)) != 1 or pre[0] != post[0]:
        raise EvaluatorContractError("three-process fixture stability failed")
    if len(runtime_fingerprint_sha256) != 64:
        raise EvaluatorContractError("runtime fingerprint missing")


def build_runtime_fingerprint(observation: object) -> tuple[bytes, str]:
    if not isinstance(observation, dict) or tuple(sorted(observation)) != RUNTIME_FINGERPRINT_KEYS:
        raise EvaluatorContractError("runtime fingerprint schema mismatch")
    if observation.get("version") != 1 or observation.get("containerPlatform") != "linux/arm64" \
            or observation.get("emulationDisabled") is not True:
        raise EvaluatorContractError("runtime fingerprint platform mismatch")
    bytes_value = dumps_jcs(observation)
    return bytes_value, sha256_bytes(bytes_value)


def capture_runtime_fingerprint(model_path: Path, root: Path) -> tuple[bytes, str]:
    """Captures the exact canonical fingerprint; it cannot run while Task 6's
    image/FFmpeg/transitive locks and non-emulated runtime evidence are absent."""
    assert_canonical_runtime(model_path, Path("/run/hero-voice-evaluator/network-disabled"))
    lock = loads_exact_jcs((root / "RUNTIME_LOCK.json").read_bytes())
    requirements = root / "requirements.lock"
    ffmpeg = shutil.which("ffmpeg")
    if not isinstance(lock, dict) or not ffmpeg or not requirements.is_file():
        raise EvaluatorContractError("runtime lock is incomplete")
    ffmpeg_hash = sha256_file(Path(ffmpeg))
    if lock.get("ffmpegBinarySha256") != ffmpeg_hash:
        raise EvaluatorContractError("FFmpeg binary identity mismatch")
    image_digest = os.environ.get("HERO_VOICE_EVALUATOR_IMAGE_DIGEST", "")
    runtime_version = os.environ.get("HERO_VOICE_EVALUATOR_CONTAINER_RUNTIME_VERSION", "")
    if not image_digest.startswith("sha256:") or len(image_digest) != 71 or not runtime_version:
        raise EvaluatorContractError("container identity readback missing")
    import numpy as np
    import torch

    cpu_info = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="strict")
    cpu_brand = next((line.split(":", 1)[1].strip() for line in cpu_info.splitlines()
                      if line.lower().startswith(("model name", "hardware")) and ":" in line), "")
    flags = "\n".join(sorted(line.strip() for line in cpu_info.splitlines()
                              if line.lower().startswith(("flags", "features"))))
    if not cpu_brand or not flags:
        raise EvaluatorContractError("CPU identity readback missing")
    numpy_config = io.StringIO()
    with redirect_stdout(numpy_config):
        np.show_config()
    ffmpeg_version = subprocess.run(
        [ffmpeg, "-version"], check=True, capture_output=True, text=True,
    ).stdout.splitlines()[0]
    observation = {
        "containerPlatform": "linux/arm64",
        "containerRuntimeVersion": runtime_version,
        "cpuBrand": cpu_brand,
        "cpuFlagsSha256": sha256_bytes(flags.encode("utf-8")),
        "dependencyLockSha256": sha256_file(requirements),
        "determinism": {
            "cudaAvailable": bool(torch.cuda.is_available()), "interopThreads": 1,
            "intraopThreads": 1, "mpsAvailable": False, "seed": 0,
            "useDeterministicAlgorithms": True,
        },
        "emulationDisabled": True,
        "evaluatorImageDigest": image_digest,
        "ffmpegBinarySha256": ffmpeg_hash,
        "ffmpegVersion": ffmpeg_version,
        "hostArchitecture": platform.architecture()[0],
        "libcVersion": "/".join(platform.libc_ver()),
        "modelSha256": sha256_file(model_path),
        "numpyBlasConfigSha256": sha256_bytes(numpy_config.getvalue().encode("utf-8")),
        "platformMachine": platform.machine(),
        "pythonVersion": sys.version,
        "pytorchBuildConfigSha256": sha256_bytes(torch.__config__.show().encode("utf-8")),
        "threadEnvironment": {name: os.environ.get(name) for name in THREAD_ENV},
        "unameMachine": subprocess.run(["uname", "-m"], check=True, capture_output=True, text=True).stdout.strip(),
        "version": 1,
    }
    return build_runtime_fingerprint(observation)


def canonical_fixture(fixture_wav: Path, expected_file: Path, model_path: Path) -> bytes:
    expected = expected_file.read_text(encoding="utf-8", errors="strict")
    with tempfile.TemporaryDirectory() as directory:
        pcm = convert_wav(fixture_wav, Path(directory) / "fixture.pcm")
    return dumps_jcs(score_pcm(pcm, expected, load_canonical_transcriber(model_path)))


def run_fixture_processes(fixture_wav: Path, expected_file: Path, model_path: Path) -> list[str]:
    command = [
        sys.executable, str(Path(__file__).resolve()), "--canonical-fixture",
        str(fixture_wav), str(expected_file), str(model_path),
    ]
    outputs = [subprocess.run(command, check=True, capture_output=True).stdout for _ in range(3)]
    if len(set(outputs)) != 1:
        raise EvaluatorContractError("canonical fixture fresh-process outputs differ")
    return [sha256_bytes(output) for output in outputs]


def score_canonical_batch(
    batch_kind: str,
    inventory_path: Path,
    output_path: Path,
    model_path: Path,
    fixture_wav: Path,
    fixture_expected: Path,
) -> None:
    root = Path(__file__).resolve().parent
    complete, blockers = lock_is_complete(root)
    if not complete or blockers:
        raise EvaluatorContractError("canonical evaluator lock is incomplete; Task 6 evidence required")
    for filename in (inventory_path, model_path, fixture_wav, fixture_expected, output_path.parent):
        if not filename.is_absolute():
            raise EvaluatorContractError("canonical batch paths must be absolute")
    assert_canonical_runtime(model_path, Path("/run/hero-voice-evaluator/network-disabled"))
    fingerprint_bytes_before, fingerprint_sha_before = capture_runtime_fingerprint(model_path, root)
    pre = run_fixture_processes(fixture_wav, fixture_expected, model_path)
    inventory_bytes = inventory_path.read_bytes()
    inventory = loads_exact_jcs(inventory_bytes)
    items = validate_batch_inventory(inventory, batch_kind)
    transcriber = load_canonical_transcriber(model_path)
    results: list[dict[str, object]] = []
    inventory_root = inventory_path.parent.resolve(strict=True)
    with tempfile.TemporaryDirectory() as directory:
        pcm_root = Path(directory)
        for index, item in enumerate(items):
            source = (inventory_root / item["storageBasename"]).resolve(strict=True)
            if source.parent != inventory_root or source.name != item["storageBasename"] \
                    or sha256_file(source) != item["audioSha256"]:
                raise EvaluatorContractError("batch audio identity mismatch")
            score = score_pcm(convert_wav(source, pcm_root / f"{index}.pcm"), item["expectedText"], transcriber)
            results.append({
                "cerDenominator": score["cerDenominator"],
                "cerNumerator": score["cerNumerator"],
                "expectedTextSha256": score["expectedTextSha256"],
                "inputAudioSha256": item["audioSha256"],
                "slotId": item["slotId"],
            })
    post = run_fixture_processes(fixture_wav, fixture_expected, model_path)
    fingerprint_bytes_after, fingerprint_sha_after = capture_runtime_fingerprint(model_path, root)
    if fingerprint_bytes_before != fingerprint_bytes_after or fingerprint_sha_before != fingerprint_sha_after:
        raise EvaluatorContractError("runtime fingerprint changed during batch")
    validate_fixture_hashes(pre, post, fingerprint_sha_before)
    runtime_fingerprint = loads_exact_jcs(fingerprint_bytes_before)
    fixture_sha = pre[0]
    evidence = {
        "batchKind": batch_kind,
        "dependencyLockSha256": sha256_file(root / "requirements.lock"),
        "emulated": False,
        "evaluatorBatchId": f"evaluator-{sha256_bytes(inventory_bytes)[:24]}",
        "evaluatorImageDigest": runtime_fingerprint["evaluatorImageDigest"],
        "ffmpegBinarySha256": runtime_fingerprint["ffmpegBinarySha256"],
        "fixtureTranscriptCerSha256": fixture_sha,
        "inventoryCount": len(items),
        "inventorySha256": sha256_bytes(inventory_bytes),
        "modelSha256": MODEL_SHA256,
        "networkDisabled": True,
        "platform": "linux/arm64",
        "postFixtureProcessHashes": post,
        "preFixtureProcessHashes": pre,
        "runtimeFingerprintSha256": fingerprint_sha_before,
        "version": 1,
    }
    output_bytes = dumps_jcs({"evidence": evidence, "results": results, "version": 1})
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        remaining = memoryview(output_bytes)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise EvaluatorContractError("canonical result write failed")
            remaining = remaining[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(output_path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        request = loads_exact_jcs(Path(sys.argv[2]).read_bytes())
        if not isinstance(request, dict) or sorted(request) != ["actual", "expected", "pcmHex", "version"] or request["version"] != 1:
            raise EvaluatorContractError("fixture schema mismatch")
        pcm = bytes.fromhex(request["pcmHex"])
        result = score_pcm(pcm, request["expected"], lambda _pcm: request["actual"])
        sys.stdout.buffer.write(dumps_jcs(result))
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "--canonical-fixture":
        sys.stdout.buffer.write(canonical_fixture(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])))
        return 0
    if len(sys.argv) == 8 and sys.argv[1] == "--batch" and sys.argv[2] in {"ablation-8", "final-36"}:
        score_canonical_batch(
            sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4]), Path(sys.argv[5]),
            Path(sys.argv[6]), Path(sys.argv[7]),
        )
        return 0
    raise EvaluatorContractError(
        "usage: --fixture FILE | --canonical-fixture WAV EXPECTED MODEL | "
        "--batch {ablation-8,final-36} INVENTORY OUTPUT MODEL FIXTURE_WAV FIXTURE_EXPECTED"
    )


if __name__ == "__main__":
    raise SystemExit(main())

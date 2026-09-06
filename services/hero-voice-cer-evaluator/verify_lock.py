from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

from canonical import CanonicalJsonError, dumps_jcs, loads_strict

LOCK_KEYS = [
    "baseImageDigest", "canonicalExecutionEnabled", "dependencyLockSha256", "ffmpegBinarySha256",
    "ffmpegPackageVersion", "model", "platform", "pythonLockComplete",
    "schemaVersion", "task6Blockers",
]
HEX64 = re.compile(r"^[0-9a-f]{64}$")
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.!+_-]*)$")


def locked_distributions(requirements: str) -> dict[str, str]:
    """Accept only exact pins and SHA-256 hashes, with optional continuations.

    No includes, indexes, URLs, markers, extras or pip options can change the
    environment after review. This lock describes one concrete target runtime.
    """
    pins: dict[str, str] = {}
    pending = ""
    for raw in requirements.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            if pending:
                raise ValueError("interrupted requirement continuation")
            continue
        continued = line.endswith("\\")
        pending += (line[:-1].rstrip() if continued else line) + " "
        if continued:
            continue
        tokens = pending.split()
        pending = ""
        match = PIN.fullmatch(tokens[0])
        if not match or len(tokens) < 2 or any(
            not token.startswith("--hash=sha256:") or not HEX64.fullmatch(token[14:])
            for token in tokens[1:]
        ):
            raise ValueError("each exact distribution pin requires SHA-256 hashes only")
        name = re.sub(r"[-_.]+", "-", match[1]).lower()
        if name in pins:
            raise ValueError("duplicate distribution pin")
        pins[name] = match[2]
    if pending or not pins:
        raise ValueError("empty or unfinished requirements lock")
    if pins.get("openai-whisper") != "20250625" or not {"numpy", "torch"}.issubset(pins):
        raise ValueError("required evaluator direct dependency missing")
    return pins


def lock_is_complete(root: Path, *, for_preparation: bool = False) -> tuple[bool, list[str]]:
    try:
        raw_manifest = (root / "RUNTIME_LOCK.json").read_bytes()
        manifest = loads_strict(raw_manifest)
        requirements_bytes = (root / "requirements.lock").read_bytes()
        requirements = requirements_bytes.decode("utf-8", errors="strict")
        canonical_manifest = dumps_jcs(manifest)
    except (OSError, UnicodeError, CanonicalJsonError):
        return False, ["runtime_lock_unreadable_or_invalid"]
    if not isinstance(manifest, dict) or sorted(manifest) != LOCK_KEYS \
            or raw_manifest not in {canonical_manifest, canonical_manifest + b"\n"}:
        return False, ["runtime_lock_schema_or_canonical_bytes_invalid"]
    if not isinstance(manifest["task6Blockers"], list) or any(
        not isinstance(item, str) or not item for item in manifest["task6Blockers"]
    ):
        return False, ["runtime_lock_blockers_invalid"]
    blockers = list(manifest["task6Blockers"])
    if for_preparation:
        blockers = [item for item in blockers if item != "non_emulated_linux_arm64_runtime_attestation_missing"]
    model = manifest.get("model")
    try:
        locked_distributions(requirements)
    except ValueError:
        blockers.append("python_lock_pins_or_hashes_invalid")
    if manifest["dependencyLockSha256"] != hashlib.sha256(requirements_bytes).hexdigest():
        blockers.append("python_lock_digest_mismatch")
    complete = (
        type(manifest.get("schemaVersion")) is int and manifest.get("schemaVersion") == 2
        and manifest.get("platform") == "linux/arm64"
        and type(manifest.get("canonicalExecutionEnabled")) is bool
        and (for_preparation or manifest.get("canonicalExecutionEnabled") is True)
        and manifest.get("pythonLockComplete") is True
        and isinstance(manifest.get("baseImageDigest"), str) and OCI_DIGEST.fullmatch(manifest["baseImageDigest"])
        and isinstance(manifest.get("ffmpegBinarySha256"), str) and HEX64.fullmatch(manifest["ffmpegBinarySha256"])
        and isinstance(manifest.get("ffmpegPackageVersion"), str) and bool(manifest["ffmpegPackageVersion"])
        and model == {"filename": "large-v3-turbo.pt", "sha256": "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a"}
        and not blockers
    )
    return bool(complete), blockers or ([] if complete else ["runtime_lock_identity_or_qualification_missing"])


def verify_installed_runtime(root: Path) -> None:
    """Read actual packages/FFmpeg; this does not attest the host or enable CER."""
    if sys.platform != "linux" or platform.machine() not in {"aarch64", "arm64"}:
        raise ValueError("installed runtime requires linux/arm64")
    complete, _ = lock_is_complete(root, for_preparation=True)
    if not complete:
        raise ValueError("installed runtime lock is incomplete")
    manifest = loads_strict((root / "RUNTIME_LOCK.json").read_bytes())
    pins = locked_distributions((root / "requirements.lock").read_text(encoding="utf-8"))
    installed: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        raw_name = distribution.metadata.get("Name")
        if not isinstance(raw_name, str) or not raw_name:
            raise ValueError("installed distribution name missing")
        name = re.sub(r"[-_.]+", "-", raw_name).lower()
        if name in installed:
            raise ValueError("duplicate installed distribution")
        installed[name] = distribution.version
    # pip is the installer supplied by the digest-pinned base, not a model
    # dependency. All other installed distributions must belong to the lock.
    if "pip" not in pins:
        installed.pop("pip", None)
    if installed != pins:
        raise ValueError("installed distribution closure/version mismatch")
    subprocess.run([sys.executable, "-m", "pip", "check"], check=True, capture_output=True, text=True)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ValueError("FFmpeg binary unavailable")
    with Path(ffmpeg).open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != manifest["ffmpegBinarySha256"]:
        raise ValueError("FFmpeg binary identity mismatch")
    package_version = subprocess.run(
        ["dpkg-query", "--show", "--showformat=${Version}", "ffmpeg"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if package_version != manifest["ffmpegPackageVersion"]:
        raise ValueError("FFmpeg package identity mismatch")


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--expect-blocked", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--prepare", action="store_true")
    parser.add_argument("--base-image")
    parser.add_argument("--installed", action="store_true")
    options = parser.parse_args()
    if options.base_image and not options.prepare:
        parser.error("--base-image requires --prepare")
    root = Path(__file__).parent
    complete, blockers = lock_is_complete(root, for_preparation=options.prepare)
    if options.expect_blocked:
        if options.installed or options.base_image:
            parser.error("--expect-blocked cannot verify installation or a base image")
        if complete or not blockers:
            raise SystemExit("expected Task 5 evaluator lock to remain blocked")
        print(json.dumps({"status": "blocked", "blockers": blockers}, separators=(",", ":")))
        return 0
    if not complete:
        raise SystemExit("canonical evaluator lock is incomplete; Task 6 evidence required")
    if options.prepare:
        manifest = loads_strict((root / "RUNTIME_LOCK.json").read_bytes())
        image = options.base_image or ""
        if image.count("@") != 1 or not image.split("@", 1)[0] or image.split("@", 1)[1] != manifest["baseImageDigest"]:
            raise SystemExit("base image must match the locked immutable digest")
    if options.installed:
        try:
            verify_installed_runtime(root)
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            raise SystemExit("installed evaluator runtime verification failed") from exc
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Immutable worker identity and model-manifest verification."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any

from contract import ErrorCode
from pipeline import PipelineError


ROOT = Path(__file__).resolve().parent
MODEL_MANIFEST_PATH = ROOT / "MODEL_MANIFEST.json"
SOURCE_MANIFEST_PATH = ROOT / "SOURCE_MANIFEST.json"
RUNTIME_MANIFEST_PATH = ROOT / "RUNTIME_MANIFEST.json"
BUILD_ATTESTATION_PATH = ROOT / "BUILD_ATTESTATION.json"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SOURCE_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
APPROVED_SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb"
WORKER_VERSION = "hero-voice-clone-contract-v3-internal-eval-2"
WORKER_KIND = "clone-only"
ATTESTATION_FIELDS = frozenset(
    {
        "schema_version",
        "worker_version",
        "worker_kind",
        "source_revision",
        "source_manifest_sha256",
        "model_manifest_sha256",
        "base_image",
    }
)
FORBIDDEN_IDENTITY_OVERRIDES = frozenset(
    {
        "HERO_VOICE_CLONE_SOURCE_REVISION",
        "HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256",
        "HERO_VOICE_CLONE_WORKER_VERSION",
        "HERO_VOICE_CLONE_WORKER_KIND",
        "HERO_VOICE_CLONE_BASE_IMAGE",
        "SOURCE_REVISION",
    }
)
RUNTIME_SOURCE_FILES = frozenset(
    {"contract.py", "handler.py", "identity.py", "language.py", "pipeline.py", "runtime.py"}
)


@dataclass(frozen=True)
class WorkerIdentity:
    worker_version: str
    worker_kind: str
    image_digest: str
    source_revision: str
    model_manifest_sha256: str


def model_manifest_bytes() -> bytes:
    return MODEL_MANIFEST_PATH.read_bytes()


def model_manifest_sha256() -> str:
    return hashlib.sha256(model_manifest_bytes()).hexdigest()


def _load_exact_json(path: Path, *, fields: frozenset[str]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE) from error
    if not isinstance(value, dict) or set(value) != fields:
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)
    return value


def source_manifest_bytes() -> bytes:
    return SOURCE_MANIFEST_PATH.read_bytes()


def source_manifest_sha256() -> str:
    return hashlib.sha256(source_manifest_bytes()).hexdigest()


def verify_runtime_sources(source_manifest: dict[str, Any]) -> None:
    try:
        raw = RUNTIME_MANIFEST_PATH.read_bytes()
        manifest = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE) from error
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schema_version", "purpose", "files"}
        or manifest.get("schema_version") != 1
        or manifest.get("purpose") != "runtime-source-attestation"
        or source_manifest.get("runtime_manifest_sha256") != hashlib.sha256(raw).hexdigest()
        or not isinstance(manifest.get("files"), dict)
        or set(manifest["files"]) != RUNTIME_SOURCE_FILES
    ):
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)
    for relative, expected in manifest["files"].items():
        path = ROOT / relative
        if (
            not isinstance(expected, str)
            or not SHA256_RE.fullmatch(expected)
            or not path.is_file()
            or path.is_symlink()
            or hashlib.sha256(path.read_bytes()).hexdigest() != expected
        ):
            raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)


def load_worker_identity(
    environment: dict[str, str] | None = None,
    *,
    attestation_path: Path = BUILD_ATTESTATION_PATH,
) -> WorkerIdentity:
    env = os.environ if environment is None else environment
    image_digest = env.get("HERO_VOICE_CLONE_IMAGE_DIGEST", "")
    if any(key in env for key in FORBIDDEN_IDENTITY_OVERRIDES):
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)
    attestation = _load_exact_json(attestation_path, fields=ATTESTATION_FIELDS)
    source_revision = attestation.get("source_revision", "")
    actual_manifest = model_manifest_sha256()
    actual_source_manifest = source_manifest_sha256()
    try:
        source_manifest = json.loads(source_manifest_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE) from error
    if not image_digest.startswith("sha256:") or not SHA256_RE.fullmatch(image_digest[7:]):
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)
    if (
        attestation.get("schema_version") != 1
        or attestation.get("worker_version") != WORKER_VERSION
        or attestation.get("worker_kind") != WORKER_KIND
        or not SOURCE_REVISION_RE.fullmatch(source_revision)
        or source_revision != APPROVED_SOURCE_REVISION
        or source_manifest.get("source_revision") != APPROVED_SOURCE_REVISION
        or attestation.get("source_manifest_sha256") != actual_source_manifest
        or attestation.get("base_image") != source_manifest.get("base_image")
    ):
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)
    if attestation.get("model_manifest_sha256") != actual_manifest:
        raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)
    verify_runtime_sources(source_manifest)
    return WorkerIdentity(
        worker_version=WORKER_VERSION,
        worker_kind=WORKER_KIND,
        image_digest=image_digest,
        source_revision=source_revision,
        model_manifest_sha256=actual_manifest,
    )


def verify_worker_identity(identity: WorkerIdentity) -> None:
    """Reject dependency-injected or reconstructed identities that drift from the build."""
    if (
        type(identity) is not WorkerIdentity
        or set(vars(identity)) != {"worker_version", "worker_kind", "image_digest", "source_revision", "model_manifest_sha256"}
        or identity.worker_version != WORKER_VERSION
        or identity.worker_kind != WORKER_KIND
        or identity.source_revision != APPROVED_SOURCE_REVISION
        or not identity.image_digest.startswith("sha256:")
        or not SHA256_RE.fullmatch(identity.image_digest[7:])
        or identity.model_manifest_sha256 != model_manifest_sha256()
    ):
        raise PipelineError(ErrorCode.WORKER_IDENTITY_UNAVAILABLE)


def load_model_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(model_manifest_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID) from error
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)
    return manifest


def verify_model_artifacts(model_root: Path = Path("/opt/models")) -> None:
    manifest = load_model_manifest()
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)
        relative_path = artifact.get("path")
        expected_hash = artifact.get("sha256")
        expected_size = artifact.get("size")
        if (
            not isinstance(relative_path, str)
            or relative_path.startswith("/")
            or ".." in Path(relative_path).parts
            or not isinstance(expected_hash, str)
            or not SHA256_RE.fullmatch(expected_hash)
            or not isinstance(expected_size, int)
            or expected_size <= 0
        ):
            raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)
        path = (model_root / relative_path).resolve()
        try:
            path.relative_to(model_root.resolve())
        except ValueError:
            raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID) from None
        if not path.is_file() or path.is_symlink() or path.stat().st_size != expected_size:
            raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected_hash:
            raise PipelineError(ErrorCode.MODEL_MANIFEST_INVALID)

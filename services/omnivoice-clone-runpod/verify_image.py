"""Offline source, OCI-layer, merged-rootfs, and cold-import verifier."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import socket
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent
EXPECTED_MODEL_MANIFEST_SHA256 = "ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb"
EXPECTED_SOURCE_MANIFEST_SHA256 = "79713c18e53261ec917c73076d123b673972b873266578f1af40857833ee100e"
EXPECTED_RUNTIME_MANIFEST_SHA256 = "3c86267fb6df07f4030562cbe2331d0fedb790a4fc2a166abb8a1438cdcb6020"
APPROVED_SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb"
PINNED_BASE = (
    "pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime@"
    "sha256:ac7c098a81512e719afa5d2d497f812d7db3498f340a4b819c69cb7b3b257126"
)
ALLOWED_APP_FILES = {
    "BUILD_ATTESTATION.json",
    "contract.py",
    "handler.py",
    "identity.py",
    "language.py",
    "pipeline.py",
    "runtime.py",
    "MODEL_MANIFEST.json",
    "SOURCE_MANIFEST.json",
    "THIRD_PARTY_NOTICES.md",
    "UPSTREAM.md",
    "build-requirements.lock",
    "requirements.lock",
    "RUNTIME_MANIFEST.json",
    "SBOM.spdx.json",
    "verify_image.py",
}
AUDIO_SUFFIXES = {".wav", ".wave", ".mp3", ".m4a", ".flac", ".aac", ".ogg", ".opus", ".wma"}
MODEL_SUFFIXES = {".pt", ".pth", ".th", ".ckpt", ".onnx", ".safetensors"}
CREDENTIAL_NAMES = {
    ".env", ".netrc", ".npmrc", ".pypirc", "id_rsa", "id_ed25519",
    "credentials", "credentials.json", "docker-config.json", "config.json.gpg",
}
PRIVATE_KEY_MARKERS = (b"-----BEGIN PRIVATE KEY-----", b"-----BEGIN OPENSSH PRIVATE KEY-----")
PRIVATE_KEY_PEM = re.compile(
    rb"-----BEGIN ((?:(?:RSA|DSA|EC|OPENSSH) )?PRIVATE KEY)-----\r?\n"
    rb"(?:[A-Za-z0-9+/=]{4,128}\r?\n){2,}"
    rb"-----END \1-----"
)
KNOWN_PUBLIC_TEST_KEY_CONTAINERS_SHA256 = {
    "usr/lib/x86_64-linux-gnu/libgnutls.so.30.31.0": "79be57f85922e4f839de9a3ebc21993f57c39f94a2e95b7805feabe446c7cb2f",
}
KNOWN_PUBLIC_SECRET_FIXTURE_CONTAINERS_SHA256 = {
    "opt/conda/lib/python3.11/distutils/tests/__pycache__/test_upload.cpython-311.pyc": "517cd51965556674c6d2f9ed752851bf8e3ca79257e6e94e6f7f1ead665f95dc",
    "opt/conda/lib/python3.11/distutils/tests/test_upload.py": "d094eeda8954fb1b99189996312733f7b4a1142c7dbac60b8e9d4700adcca157",
    "opt/conda/lib/python3.11/site-packages/setuptools/_distutils/tests/__pycache__/test_upload.cpython-311.pyc": "afb66bb085fb52e4ecc940ce6bfadac53c5b33c2112a031ae2f4c3d31c801494",
    "opt/conda/lib/python3.11/site-packages/setuptools/_distutils/tests/test_upload.py": "3ac320a895fe528b083fb7907c0cb156d1811fb7a5d873580403fbab3b29d107",
    "opt/venv/lib/python3.11/site-packages/runpod-1.10.0.dist-info/METADATA": "9a4fdc594b37ad414736ffa12652fd8b01c64f1e5c36db8c8f3b572c84d0bbca",
}
KNOWN_NONVOICE_AUDIO_FIXTURES_SHA256 = {
    "opt/conda/lib/python3.11/site-packages/IPython/lib/tests/test.wav": "cba3bce8287c39fcc17d789c3bcc86df50f26227c6a5830f2609fe3538f5392e",
    "opt/conda/pkgs/ipython-8.27.0-pyh707e725_0/site-packages/IPython/lib/tests/test.wav": "cba3bce8287c39fcc17d789c3bcc86df50f26227c6a5830f2609fe3538f5392e",
}
KNOWN_NONVOICE_AUDIO_HARDLINKS = {
    "opt/conda/pkgs/ipython-8.27.0-pyh707e725_0/site-packages/IPython/lib/tests/test.wav":
        "opt/conda/lib/python3.11/site-packages/IPython/lib/tests/test.wav",
}
KNOWN_PYTHON_PATH_CONFIG_HARDLINKS = {
    "opt/conda/pkgs/setuptools-73.0.1-pyhd8ed1ab_0/site-packages/distutils-precedence.pth":
        "opt/conda/lib/python3.11/site-packages/distutils-precedence.pth",
}
SECRET_ASSIGNMENT = re.compile(
    rb"(?i)(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)"
    rb"\s*[:=]\s*(?P<quote>['\"]?)(?P<secret_value>[A-Za-z0-9_+./=-]{20,})"
)
PYTHON_REFERENCE = re.compile(rb"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
KNOWN_NON_SECRET_IDENTIFIER_LITERALS = {b"AWS_CONTAINER_AUTHORIZATION_TOKEN"}
KNOWN_DOCUMENTATION_PLACEHOLDER_LITERALS = {b"your-replicate-api-key"}
STOCK_OR_LAO_PATH = re.compile(
    r"(?:^|/)(?:" + "voices" + r"_lao|stock[_-]?voices?|voice[_-]?catalog|voices\.json)(?:/|$)|"
    r"(?:^|/)voice_0[1-9](?:\.|/|$)|"
    r"(?:^|/)(?:[^/]*(?:lao|stock)[^/]*voice[^/]*|[^/]*voice[^/]*(?:lao|stock)[^/]*)(?:/|$)|"
    r"(?:^|/)lao(?:[_-]|/|$)",
    re.IGNORECASE,
)
SENSITIVE_PATH = re.compile(
    r"(?:^|/)(?:\.aws/credentials|\.docker/config\.json|\.git-credentials|"
    r"\.config/huggingface/token|\.huggingface/token|\.ssh/id_(?:rsa|dsa|ecdsa|ed25519)|"
    r"kubeconfig|service[_-]?account\.json|secrets?\.json)$",
    re.IGNORECASE,
)
CONTENT_SCAN_BLOCK = 1024 * 1024
CONTENT_SCAN_OVERLAP = 65_536
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
OCI_INDEX_MEDIA_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
OCI_MANIFEST_MEDIA_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
OCI_LAYER_MEDIA_TYPES = {
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.docker.image.rootfs.diff.tar.gzip",
}
OCI_CONFIG_MEDIA_TYPES = {
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
}
FORBIDDEN_CONFIG_MARKERS = (
    "runpod_api_key", "authorization: bearer", "ghcr_pat", "ref_audio_b64",
    "aws_secret_access_key", "hugging_face_hub_token", "hf_token",
    "private key", "client_secret", "client-secret", "access_token",
    "access-token", "auth_token", "auth-token", "password=", "password:",
    ":latest",
)


@dataclass(frozen=True)
class OciImageEvidence:
    index_sha256: str
    manifest_digest: str
    config_digest: str
    layer_digests: tuple[str, ...]
    layer_media_types: tuple[str, ...]
    layer_diff_ids: tuple[str, ...]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_stream(handle) -> str:
    digest = hashlib.sha256()
    for block in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def _contains_audio_signature(content: bytes) -> bool:
    offset = content.find(b"RIFF")
    while offset >= 0:
        if len(content) >= offset + 12 and content[offset + 8 : offset + 12] == b"WAVE":
            return True
        offset = content.find(b"RIFF", offset + 1)
    offset = content.find(b"ID3")
    while offset >= 0:
        header = content[offset : offset + 10]
        if (
            len(header) == 10
            and header[3] in {2, 3, 4}
            and header[4] < 0x10
            and all(value < 0x80 for value in header[6:10])
        ):
            return True
        offset = content.find(b"ID3", offset + 1)
    offset = content.find(b"fLaC")
    while offset >= 0:
        if len(content) >= offset + 42:
            block_header = content[offset + 4 : offset + 8]
            if block_header[0] & 0x7F == 0 and int.from_bytes(block_header[1:4], "big") == 34:
                return True
        offset = content.find(b"fLaC", offset + 1)
    offset = content.find(b"OggS")
    while offset >= 0:
        if len(content) >= offset + 27 and content[offset + 4] == 0 and content[offset + 5] <= 7:
            return True
        offset = content.find(b"OggS", offset + 1)
    return _contains_mpeg_audio_frames(content)


def _mpeg_frame_length(content: bytes, offset: int) -> int | None:
    if offset < 0 or len(content) < offset + 4:
        return None
    first, second, third, fourth = content[offset : offset + 4]
    if first != 0xFF or second & 0xE0 != 0xE0:
        return None
    version_bits = (second >> 3) & 0x03
    layer_bits = (second >> 1) & 0x03
    bitrate_index = (third >> 4) & 0x0F
    sample_rate_index = (third >> 2) & 0x03
    if (
        version_bits == 1
        or layer_bits != 1
        or bitrate_index in {0, 15}
        or sample_rate_index == 3
        or fourth & 0x03 == 2
    ):
        return None
    mpeg1_bitrates = {
        3: (0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
        2: (0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
        1: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
    }
    mpeg2_bitrates = {
        3: (0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256),
        2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
        1: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
    }
    bitrate = (mpeg1_bitrates if version_bits == 3 else mpeg2_bitrates)[layer_bits][bitrate_index] * 1000
    sample_rate = (44_100, 48_000, 32_000)[sample_rate_index]
    if version_bits == 2:
        sample_rate //= 2
    elif version_bits == 0:
        sample_rate //= 4
    padding = (third >> 1) & 0x01
    if layer_bits == 3:
        return ((12 * bitrate // sample_rate) + padding) * 4
    coefficient = 144 if layer_bits == 2 or version_bits == 3 else 72
    return coefficient * bitrate // sample_rate + padding


def _contains_mpeg_audio_frames(content: bytes) -> bool:
    offset = content.find(b"\xff")
    while offset >= 0:
        first_length = _mpeg_frame_length(content, offset)
        if first_length is not None:
            second = content[offset + 1]
            third = content[offset + 2]
            version_bits = (second >> 3) & 0x03
            layer_bits = (second >> 1) & 0x03
            sample_rate_index = (third >> 2) & 0x03
            signature = (version_bits, layer_bits, sample_rate_index)
            sample_rate = (44_100, 48_000, 32_000)[sample_rate_index]
            if version_bits == 2:
                sample_rate //= 2
            elif version_bits == 0:
                sample_rate //= 4
            samples_per_frame = 384 if layer_bits == 3 else (1_152 if layer_bits == 2 or version_bits == 3 else 576)
            required_frames = (sample_rate + samples_per_frame - 1) // samples_per_frame
            current = offset
            consecutive = 0
            while consecutive < required_frames:
                frame_length = _mpeg_frame_length(content, current)
                if frame_length is None:
                    break
                frame_second = content[current + 1]
                frame_third = content[current + 2]
                frame_signature = (
                    (frame_second >> 3) & 0x03,
                    (frame_second >> 1) & 0x03,
                    (frame_third >> 2) & 0x03,
                )
                if frame_signature != signature:
                    break
                consecutive += 1
                current += frame_length
            if consecutive == required_frames:
                return True
        offset = content.find(b"\xff", offset + 1)
    return False


def _contains_secret_assignment(content: bytes, *, allow_python_reference: bool = False) -> bool:
    for match in SECRET_ASSIGNMENT.finditer(content):
        value = match.group("secret_value")
        if value in KNOWN_NON_SECRET_IDENTIFIER_LITERALS or value in KNOWN_DOCUMENTATION_PLACEHOLDER_LITERALS:
            continue
        if allow_python_reference and not match.group("quote") and PYTHON_REFERENCE.fullmatch(value) is not None:
            continue
        return True
    return False


def _contains_catalog_identifier(content: bytes) -> bool:
    lowered = content.lower()
    catalog_id = re.compile(rb"(?<![a-z0-9_])(?:voice|lao)_(?!00)[0-9]{2}(?![0-9])")
    catalog_name = re.compile(rb"(?<![a-z0-9_])voices" + b"_lao" + rb"(?![a-z0-9_])")
    return catalog_id.search(lowered) is not None or catalog_name.search(lowered) is not None


def _verified_oci_blob(
    layout: Path,
    descriptor: dict,
    *,
    media_types: set[str],
    label: str,
    read_content: bool = True,
) -> bytes:
    require(isinstance(descriptor, dict), f"invalid OCI {label} descriptor")
    digest = descriptor.get("digest")
    size = descriptor.get("size")
    media_type = descriptor.get("mediaType")
    require(
        isinstance(digest, str)
        and OCI_DIGEST.fullmatch(digest) is not None
        and type(size) is int
        and size > 0
        and media_type in media_types,
        f"invalid OCI {label} descriptor",
    )
    blob = layout / "blobs" / "sha256" / digest[7:]
    require(blob.is_file() and not blob.is_symlink(), f"missing OCI {label} blob: {digest}")
    require(blob.stat().st_size == size, f"OCI {label} blob size mismatch: {digest}")
    require(_sha256(blob) == digest[7:], f"OCI {label} blob digest mismatch: {digest}")
    return blob.read_bytes() if read_content else b""


def _layer_diff_id(blob: Path, media_type: str) -> str:
    digest = hashlib.sha256()
    try:
        with blob.open("rb") as probe:
            header = probe.read(6)
        is_gzip = media_type.endswith("+gzip") or media_type == "application/vnd.docker.image.rootfs.diff.tar.gzip"
        recognized_compression = header.startswith((b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd"))
        require(
            (is_gzip and header.startswith(b"\x1f\x8b")) or (not is_gzip and not recognized_compression),
            f"OCI layer compression/media type mismatch: {blob.name}",
        )
        if is_gzip:
            handle = gzip.open(blob, "rb")
        else:
            handle = blob.open("rb")
        with handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
    except (OSError, EOFError, gzip.BadGzipFile) as error:
        raise SystemExit(f"cannot decompress verified OCI layer: {blob.name}") from error
    return "sha256:" + digest.hexdigest()


def _validate_oci_tar_stream(blob: Path, media_type: str, *, label: str) -> None:
    is_gzip = media_type.endswith("+gzip") or media_type == "application/vnd.docker.image.rootfs.diff.tar.gzip"
    try:
        handle = gzip.open(blob, "rb") if is_gzip else blob.open("rb")
        with handle:
            with tarfile.open(fileobj=handle, mode="r:") as archive:
                archive.getmembers()
                logical_end = archive.offset
            handle.seek(logical_end)
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                require(not block.strip(b"\x00"), f"non-zero data follows OCI tar end marker: {label}")
    except (OSError, EOFError, gzip.BadGzipFile, tarfile.TarError) as error:
        raise SystemExit(f"invalid verified OCI layer tar stream: {label}") from error


def _scan_authenticated_config_text(value: str, *, label: str) -> None:
    require(isinstance(value, str), f"invalid OCI config {label}")
    lowered = value.lower()
    encoded = value.encode("utf-8", errors="strict")
    require(
        not any(marker in lowered for marker in FORBIDDEN_CONFIG_MARKERS),
        f"secret/payload marker in authenticated OCI config {label}",
    )
    require(not _contains_secret_assignment(encoded), f"credential value in authenticated OCI config {label}")
    require(not any(marker in encoded for marker in PRIVATE_KEY_MARKERS), f"private key in authenticated OCI config {label}")
    require(not _contains_audio_signature(encoded), f"audio payload in authenticated OCI config {label}")
    require(not _contains_catalog_identifier(encoded), f"stock/Lao catalog in authenticated OCI config {label}")
    require(not STOCK_OR_LAO_PATH.search(lowered), f"stock/Lao path in authenticated OCI config {label}")
    require(
        not re.search(r"(?:^|[/=,:;\s])(?:ref(?:erence)?|source)[_-]?audio(?:[/=,:;\s]|$)", lowered),
        f"source audio marker in authenticated OCI config {label}",
    )
    require(
        not any(re.search(re.escape(suffix) + r"(?:[/=,:;\s]|$)", lowered) for suffix in AUDIO_SUFFIXES),
        f"audio path in authenticated OCI config {label}",
    )


def _verify_oci_config(config_bytes: bytes, *, expected_diff_ids: tuple[str, ...]) -> None:
    try:
        config = json.loads(config_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("cannot parse OCI config") from error
    require(isinstance(config, dict), "invalid OCI config")
    require(
        config.get("os") == "linux" and config.get("architecture") == "amd64",
        "authenticated OCI config platform must be linux/amd64",
    )
    rootfs = config.get("rootfs")
    require(
        isinstance(rootfs, dict)
        and rootfs.get("type") == "layers"
        and isinstance(rootfs.get("diff_ids"), list)
        and all(isinstance(item, str) and OCI_DIGEST.fullmatch(item) is not None for item in rootfs["diff_ids"]),
        "invalid OCI config rootfs diff_ids",
    )
    require(tuple(rootfs["diff_ids"]) == expected_diff_ids, "OCI config rootfs diff_ids do not match ordered layer blobs")

    runtime_config = config.get("config")
    history = config.get("history")
    require(isinstance(runtime_config, dict), "invalid OCI runtime config")
    environment = runtime_config.get("Env", [])
    require(isinstance(environment, list), "invalid OCI config Env")
    for index, value in enumerate(environment):
        _scan_authenticated_config_text(value, label=f"Env[{index}]")
    require(isinstance(history, list), "authenticated OCI config history is required")
    nonempty_history = 0
    for index, entry in enumerate(history):
        require(isinstance(entry, dict), f"invalid OCI config history[{index}]")
        if "empty_layer" in entry:
            require(type(entry["empty_layer"]) is bool, f"invalid OCI config history[{index}].empty_layer")
        if not entry.get("empty_layer", False):
            nonempty_history += 1
        for field in ("created", "created_by", "author", "comment"):
            if field in entry:
                _scan_authenticated_config_text(entry[field], label=f"history[{index}].{field}")
    require(nonempty_history == len(expected_diff_ids), "OCI config history/layer count mismatch")


def load_oci_image_evidence(layout: Path) -> OciImageEvidence:
    """Derive the final linux/amd64 layer set only from verified OCI descriptors."""
    require(layout.is_dir(), "OCI layout directory missing")
    layout_path = layout / "oci-layout"
    index_path = layout / "index.json"
    require(layout_path.is_file() and not layout_path.is_symlink(), "OCI layout marker missing")
    require(index_path.is_file() and not index_path.is_symlink(), "OCI index missing")
    try:
        layout_marker = json.loads(layout_path.read_text(encoding="utf-8"))
        index_bytes = index_path.read_bytes()
        index = json.loads(index_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("cannot parse OCI layout/index") from error
    require(layout_marker == {"imageLayoutVersion": "1.0.0"}, "invalid OCI layout marker")
    require(
        isinstance(index, dict)
        and index.get("schemaVersion") == 2
        and isinstance(index.get("manifests"), list),
        "invalid OCI index",
    )
    candidates = []
    for descriptor in index["manifests"]:
        if not isinstance(descriptor, dict):
            continue
        platform = descriptor.get("platform")
        if isinstance(platform, dict) and platform.get("os") == "linux" and platform.get("architecture") == "amd64":
            candidates.append(descriptor)
    require(len(candidates) == 1, "OCI index must identify exactly one linux/amd64 manifest")
    manifest_descriptor = candidates[0]
    manifest_bytes = _verified_oci_blob(
        layout,
        manifest_descriptor,
        media_types=OCI_MANIFEST_MEDIA_TYPES,
        label="manifest",
    )
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("cannot parse OCI manifest") from error
    require(
        isinstance(manifest, dict)
        and manifest.get("schemaVersion") == 2
        and isinstance(manifest.get("config"), dict)
        and isinstance(manifest.get("layers"), list)
        and manifest["layers"],
        "invalid OCI manifest",
    )
    config_bytes = _verified_oci_blob(
        layout,
        manifest["config"],
        media_types=OCI_CONFIG_MEDIA_TYPES,
        label="config",
    )
    layer_digests = []
    layer_media_types = []
    layer_diff_ids = []
    for index_value, layer_descriptor in enumerate(manifest["layers"]):
        _verified_oci_blob(
            layout,
            layer_descriptor,
            media_types=OCI_LAYER_MEDIA_TYPES,
            label=f"layer[{index_value}]",
            read_content=False,
        )
        layer_digests.append(layer_descriptor["digest"])
        layer_media_types.append(layer_descriptor["mediaType"])
        layer_diff_ids.append(
            _layer_diff_id(
                layout / "blobs" / "sha256" / layer_descriptor["digest"][7:],
                layer_descriptor["mediaType"],
            )
        )
        _validate_oci_tar_stream(
            layout / "blobs" / "sha256" / layer_descriptor["digest"][7:],
            layer_descriptor["mediaType"],
            label=f"layer[{index_value}]",
        )
    _verify_oci_config(config_bytes, expected_diff_ids=tuple(layer_diff_ids))
    return OciImageEvidence(
        index_sha256=hashlib.sha256(index_bytes).hexdigest(),
        manifest_digest=manifest_descriptor["digest"],
        config_digest=manifest["config"]["digest"],
        layer_digests=tuple(layer_digests),
        layer_media_types=tuple(layer_media_types),
        layer_diff_ids=tuple(layer_diff_ids),
    )


def _manifest_artifacts(manifest_path: Path) -> dict[str, dict]:
    parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = parsed.get("artifacts")
    require(isinstance(artifacts, list) and len(artifacts) == 12, "unexpected model artifact inventory")
    result = {}
    for artifact in artifacts:
        relative = artifact.get("path")
        require(isinstance(relative, str) and relative not in result, "invalid/duplicate model artifact path")
        result[relative] = artifact
    return result


def verify_static(root: Path = ROOT) -> None:
    model_manifest = root / "MODEL_MANIFEST.json"
    source_manifest_path = root / "SOURCE_MANIFEST.json"
    require(_sha256(model_manifest) == EXPECTED_MODEL_MANIFEST_SHA256, "model manifest digest drift")
    require(_sha256(source_manifest_path) == EXPECTED_SOURCE_MANIFEST_SHA256, "source manifest digest drift")
    _manifest_artifacts(model_manifest)
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    require(source_manifest.get("schema_version") == 3, "source manifest schema drift")
    require(source_manifest.get("source_revision") == APPROVED_SOURCE_REVISION, "source revision manifest drift")
    require(source_manifest.get("application_base_revision") == APPROVED_SOURCE_REVISION, "application base revision drift")
    team_source = source_manifest.get("team_voice_source", {})
    require(
        team_source.get("repository") == "https://github.com/Aoacademy2025/Hero-Voice-Ai"
        and team_source.get("branch") == "main"
        and team_source.get("revision") == "f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37"
        and team_source.get("control_revision") == "565d0e62e1d4269099a4c3fba8a2ecef9167eeea"
        and team_source.get("integration_policy") == "selective-hardened-clone-only-port"
        and team_source.get("selected_files")
        == ["core/audio_enhance.py", "core/server.py", "core/text_utils.py", "core/watermark.py"],
        "team voice source drift",
    )
    require(source_manifest.get("base_image") == PINNED_BASE, "base image manifest drift")
    require(
        source_manifest.get("requirements_lock_sha256") == _sha256(root / "requirements.lock"),
        "requirements lock digest drift",
    )
    require(
        source_manifest.get("build_requirements_lock_sha256") == _sha256(root / "build-requirements.lock")
        and source_manifest.get("build_requirements_lock_package_count") == 9,
        "build requirements lock drift",
    )
    require(source_manifest.get("model_manifest_sha256") == EXPECTED_MODEL_MANIFEST_SHA256, "source/model manifest mismatch")
    runtime_manifest_path = root / "RUNTIME_MANIFEST.json"
    require(_sha256(runtime_manifest_path) == EXPECTED_RUNTIME_MANIFEST_SHA256, "runtime manifest digest drift")
    require(
        source_manifest.get("runtime_manifest_sha256") == EXPECTED_RUNTIME_MANIFEST_SHA256,
        "source/runtime manifest mismatch",
    )
    runtime_manifest = json.loads(runtime_manifest_path.read_text(encoding="utf-8"))
    require(
        runtime_manifest.get("schema_version") == 1
        and runtime_manifest.get("purpose") == "runtime-source-attestation"
        and set(runtime_manifest.get("files", {}))
        == {"contract.py", "handler.py", "identity.py", "language.py", "pipeline.py", "runtime.py"},
        "runtime source inventory drift",
    )
    for relative, expected in runtime_manifest["files"].items():
        require(_sha256(root / relative) == expected, f"runtime source hash drift: {relative}")
    compatibility = source_manifest.get("demucs_runtime_compatibility", {})
    require(
        compatibility.get("status") == "metadata-patched-pending-gpu-runtime"
        and compatibility.get("declared_requirement") == "torchaudio>=0.8,<2.1"
        and compatibility.get("patched_requirement") == "torchaudio>=0.8"
        and compatibility.get("base_requirement") == "torchaudio==2.4.1",
        "Demucs compatibility resolution drift",
    )
    compatibility_patch = root / str(compatibility.get("patch_path", ""))
    require(
        compatibility_patch.name == "demucs-torchaudio-2.4-compat.patch"
        and compatibility_patch.parent == root
        and compatibility.get("patch_sha256") == _sha256(compatibility_patch),
        "Demucs compatibility patch drift",
    )
    resemblyzer_compatibility = source_manifest.get("resemblyzer_runtime_compatibility", {})
    require(
        resemblyzer_compatibility.get("status") == "metadata-patched"
        and resemblyzer_compatibility.get("version") == "0.1.4"
        and resemblyzer_compatibility.get("wheel_sha256")
        == "8f12eb2f1a9982d32e8db7856de754709b59c93a77bcf0ff536584b619a9dd1f"
        and resemblyzer_compatibility.get("obsolete_requirement") == "typing"
        and resemblyzer_compatibility.get("original_metadata_sha256")
        == "a8dca4f91c66d1594216af85080202fc6475f09f8a0e4c5822ce0b60bf401eb2"
        and resemblyzer_compatibility.get("patched_metadata_sha256")
        == "9171b44fb93d82cfd945f403d890c4d0f77cb241a483996133b95eb1fe2ea146",
        "Resemblyzer compatibility resolution drift",
    )
    omnivoice_compatibility = source_manifest.get("omnivoice_runtime_compatibility", {})
    require(
        omnivoice_compatibility.get("status") == "metadata-patched"
        and omnivoice_compatibility.get("version") == "0.1.5"
        and omnivoice_compatibility.get("removed_requirement") == "gradio"
        and omnivoice_compatibility.get("original_metadata_sha256")
        == "c26956459797f59a2ba40f015d991aaefd07d7e7fa6f864ce29f707927502ad6"
        and omnivoice_compatibility.get("patched_metadata_sha256")
        == "f72051fb59f8967c0dd7dc6dd1cf2ca02c038dd6b1293fa5e5cb82481793d660",
        "OmniVoice compatibility resolution drift",
    )
    scanner_exceptions = source_manifest.get("base_image_scanner_exceptions", {})
    require(
        scanner_exceptions.get("status") == "exact-public-fixtures-only"
        and scanner_exceptions.get("raw_mpeg_content_minimum_milliseconds") == 1000
        and scanner_exceptions.get("known_documentation_placeholder_literals")
        == [value.decode("ascii") for value in sorted(KNOWN_DOCUMENTATION_PLACEHOLDER_LITERALS)]
        and scanner_exceptions.get("known_non_secret_identifier_literals")
        == [value.decode("ascii") for value in sorted(KNOWN_NON_SECRET_IDENTIFIER_LITERALS)]
        and scanner_exceptions.get("known_public_test_key_containers_sha256")
        == KNOWN_PUBLIC_TEST_KEY_CONTAINERS_SHA256
        and scanner_exceptions.get("known_public_secret_fixture_containers_sha256")
        == KNOWN_PUBLIC_SECRET_FIXTURE_CONTAINERS_SHA256
        and scanner_exceptions.get("known_nonvoice_audio_fixtures_sha256")
        == KNOWN_NONVOICE_AUDIO_FIXTURES_SHA256
        and scanner_exceptions.get("known_nonvoice_audio_hardlinks") == KNOWN_NONVOICE_AUDIO_HARDLINKS
        and scanner_exceptions.get("known_python_path_config_hardlinks") == KNOWN_PYTHON_PATH_CONFIG_HARDLINKS,
        "base-image scanner exception attestation drift",
    )

    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    require(dockerfile.count(f"FROM {PINNED_BASE}") == 2, "both stages must hard-code the pinned base")
    for forbidden_arg in (
        "ARG BASE_IMAGE", "ARG OMNIVOICE_SOURCE_COMMIT", "ARG OMNIVOICE_MODEL_REVISION",
        "ARG DEMUCS_SOURCE_COMMIT", "ARG AUDIOSEAL_MODEL_REVISION", "ARG MODEL_MANIFEST_SHA256",
        "ARG SOURCE_REVISION",
    ):
        require(forbidden_arg not in dockerfile, f"pin remains overrideable: {forbidden_arg}")
    require("${SOURCE_REVISION}" not in dockerfile, "source revision environment expansion found")
    require(dockerfile.count(APPROVED_SOURCE_REVISION) >= 2, "approved source revision is not hard-coded")
    require(":latest" not in dockerfile, "mutable image tag found")
    require("--no-build-isolation" in dockerfile, "source install can fetch build dependencies")
    require("pip install --require-hashes --no-deps --no-build-isolation" in dockerfile, "runtime lock install is not dependency-closed")
    for metadata_hash in (
        "c26956459797f59a2ba40f015d991aaefd07d7e7fa6f864ce29f707927502ad6",
        "f72051fb59f8967c0dd7dc6dd1cf2ca02c038dd6b1293fa5e5cb82481793d660",
        "a8dca4f91c66d1594216af85080202fc6475f09f8a0e4c5822ce0b60bf401eb2",
        "9171b44fb93d82cfd945f403d890c4d0f77cb241a483996133b95eb1fe2ea146",
    ):
        require(metadata_hash in dockerfile, f"Resemblyzer metadata hash missing from build: {metadata_hash}")
    require(dockerfile.count("pip check") >= 2, "builder/runtime pip-check assertions missing")
    require("importlib.import_module" in dockerfile and '"pydub"' in dockerfile, "runtime import smoke missing")
    require("HF_HUB_OFFLINE=1" in dockerfile and "TRANSFORMERS_OFFLINE=1" in dockerfile, "offline runtime flags missing")
    require('CMD ["python", "-u", "/app/handler.py"]' in dockerfile, "release command is not the v3 handler")
    require("assets/" not in dockerfile and "voices/" not in dockerfile, "voice assets copied into image")
    for immutable_pin in (
        "346bb75330980a236540d61a0808d00767c0973b",
        "c5fdb5ccb189668d56333f77ba2629f4cd7535f4",
        "e976d93ecc3865e5757426930257e200846a520a",
        "e63a8a0e5cdf7bb797159c92ba15961557fe9bd2",
        "3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba",
    ):
        require(immutable_pin in dockerfile, f"source/model pin missing from build: {immutable_pin}")

    lock = (root / "requirements.lock").read_text(encoding="utf-8")
    package_lines = [line for line in lock.splitlines() if re.match(r"^[a-zA-Z0-9_.-]+==", line)]
    require(len(package_lines) == source_manifest.get("requirements_lock_package_count") == 136, "Python runtime lock is unexpectedly incomplete")
    require("--hash=sha256:" in lock, "Python hashes missing")
    require(not any(line.startswith("typing==") for line in lock.splitlines()), "obsolete Python typing backport is locked")
    require(
        not any(line.startswith(("gradio==", "gradio-client==")) for line in lock.splitlines()),
        "excluded Gradio demo dependency remains locked",
    )
    for direct in ("pydub==0.25.1", "einops==0.8.2", "omegaconf==2.3.0"):
        require(direct in lock, f"required runtime pin missing: {direct}")
    build_lock = (root / "build-requirements.lock").read_text(encoding="utf-8")
    for direct in (
        "flit-core==3.9.0", "hatchling==1.22.5", "packaging==23.2",
        "pip==24.2", "setuptools==67.8.0", "wheel==0.40.0",
    ):
        require(direct in build_lock, f"required build-backend pin missing: {direct}")
    for inherited in ("torch==", "torchaudio==", "triton==", "nvidia-cuda-runtime-cu12=="):
        require(not any(line.startswith(inherited) for line in lock.splitlines()), f"base package would be overwritten: {inherited}")
    requirements_input = (root / "requirements.in").read_text(encoding="utf-8")
    for constraint in ("torch==2.4.1", "torchaudio==2.4.1", "triton==3.0.0", "pydub==0.25.1"):
        require(constraint in requirements_input, f"base/runtime constraint missing: {constraint}")

    runtime_names = ("contract.py", "handler.py", "identity.py", "language.py", "pipeline.py", "runtime.py")
    python_sources = "\n".join((root / name).read_text(encoding="utf-8") for name in runtime_names)
    for forbidden in ("from fastapi", "import fastapi", "gemini", "voice_library", "credits.py", "studio.html"):
        require(forbidden not in python_sources.lower(), f"forbidden worker surface found: {forbidden}")
    require(
        'from demucs.api import Separator' in python_sources
        and 'model="955717e8"' in python_sources
        and 'repo=self.model_root / "demucs"' in python_sources
        and "shifts=0" in python_sources
        and "overlap=0.25" in python_sources
        and "segment=7" in python_sources,
        "Demucs runtime pin/configuration missing",
    )

    sbom = json.loads((root / "SBOM.spdx.json").read_text(encoding="utf-8"))
    require(sbom.get("spdxVersion") == "SPDX-2.3", "invalid SPDX document")
    packages = sbom.get("packages")
    relationships = sbom.get("relationships")
    require(isinstance(packages, list) and isinstance(relationships, list), "incomplete SPDX document")
    package_ids = [package.get("SPDXID") for package in packages if isinstance(package, dict)]
    require(len(package_ids) == len(packages) == len(set(package_ids)), "invalid/duplicate SPDX package IDs")
    by_id = {package["SPDXID"]: package for package in packages}

    def lock_entry(line: str) -> tuple[str, str]:
        match = re.match(r"^([a-zA-Z0-9_.-]+)==([^\s\\]+)", line)
        require(match is not None, "invalid requirement lock line")
        return match.group(1), match.group(2)

    runtime_entries = [lock_entry(line) for line in package_lines]
    build_lines = [line for line in build_lock.splitlines() if re.match(r"^[a-zA-Z0-9_.-]+==", line)]
    build_entries = [lock_entry(line) for line in build_lines]
    require(len(build_entries) == 9, "SPDX build-lock source is incomplete")

    def spdx_suffix(name: str) -> str:
        return re.sub(r"[^a-z0-9.-]+", "-", name.lower().replace("_", "-")).strip("-")

    for prefix, entries in (("SPDXRef-Python-", runtime_entries), ("SPDXRef-BuildPython-", build_entries)):
        for name, version in entries:
            package = by_id.get(prefix + spdx_suffix(name))
            require(
                package is not None and package.get("name") == name and package.get("versionInfo") == version,
                f"SPDX omits or misstates locked package: {prefix}{name}",
            )
    required_ids = {
        "SPDXRef-Package-Worker", "SPDXRef-Package-BaseImage",
        "SPDXRef-Package-OmniVoice-Source", "SPDXRef-Package-AudioSeal-Source",
        "SPDXRef-Package-Demucs-Source", "SPDXRef-Package-AuditedV13",
        *(f"SPDXRef-Model-{index:02d}" for index in range(1, 13)),
        *(f"SPDXRef-System-{spdx_suffix(name)}" for name in source_manifest["system_packages"]),
    }
    require(required_ids <= set(by_id), "SPDX omits source/model/system components")
    for index, artifact in enumerate(_manifest_artifacts(model_manifest).values(), 1):
        model_package = by_id[f"SPDXRef-Model-{index:02d}"]
        checksums = model_package.get("checksums", [])
        require(
            {entry.get("checksumValue") for entry in checksums if isinstance(entry, dict)} == {artifact["sha256"]},
            f"SPDX model checksum mismatch: {artifact['path']}",
        )
    known_ids = set(by_id) | {"SPDXRef-DOCUMENT"}
    relationship_set = set()
    for relationship in relationships:
        require(isinstance(relationship, dict), "invalid SPDX relationship")
        source_id = relationship.get("spdxElementId")
        target_id = relationship.get("relatedSpdxElement")
        relationship_type = relationship.get("relationshipType")
        require(source_id in known_ids and target_id in known_ids, "SPDX relationship references an unknown package")
        relationship_set.add((source_id, relationship_type, target_id))
    for name, _version in runtime_entries:
        require(
            ("SPDXRef-Package-Worker", "DEPENDS_ON", "SPDXRef-Python-" + spdx_suffix(name))
            in relationship_set,
            f"SPDX runtime relationship missing: {name}",
        )
    for name, _version in build_entries:
        build_id = "SPDXRef-BuildPython-" + spdx_suffix(name)
        for source_id in ("SPDXRef-Package-OmniVoice-Source", "SPDXRef-Package-AudioSeal-Source"):
            require((build_id, "BUILD_DEPENDENCY_OF", source_id) in relationship_set, f"SPDX build relationship missing: {name}")


def _relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _looks_like_audio(header: bytes) -> bool:
    return (
        header.startswith((b"RIFF", b"ID3", b"fLaC", b"OggS"))
        or _contains_mpeg_audio_frames(header)
    )


def _is_python_path_configuration(path: Path) -> bool:
    """Distinguish small text ``.pth`` import/path files from model weights."""
    try:
        if path.stat().st_size > 65_536:
            return False
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("import "):
            continue
        if not (line.startswith(("/", "./", "../")) or "/" in line or line.endswith((".egg", ".zip"))):
            return False
    return True


def _is_python_path_configuration_content(content: bytes) -> bool:
    if len(content) > 65_536:
        return False
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("import "):
            continue
        if not (line.startswith(("/", "./", "../")) or "/" in line or line.endswith((".egg", ".zip"))):
            return False
    return True


def _scan_content(handle, *, label: str, relative: str, capture_limit: int = 0) -> bytes:
    captured = b""
    content_digest = hashlib.sha256()
    private_key_found = False
    secret_assignment_found = False
    try:
        header = handle.read(4096)
        require(not _looks_like_audio(header), f"audio magic found in {label}: {relative}")
        previous = b""
        block = header
        while block:
            content_digest.update(block)
            if capture_limit and len(captured) <= capture_limit:
                captured += block[: capture_limit + 1 - len(captured)]
            searchable = previous + block
            require(not _contains_audio_signature(searchable), f"embedded audio magic found in {label}: {relative}")
            require(not _contains_catalog_identifier(searchable), f"stock/Lao catalog content found in {label}: {relative}")
            private_key_found = private_key_found or PRIVATE_KEY_PEM.search(searchable) is not None
            secret_assignment_found = secret_assignment_found or _contains_secret_assignment(
                searchable,
                allow_python_reference=relative.endswith((".py", ".pyi")),
            )
            previous = searchable[-CONTENT_SCAN_OVERLAP:]
            block = handle.read(CONTENT_SCAN_BLOCK)
    except OSError as error:
        raise SystemExit(f"cannot inspect {label}:{relative}") from error
    if private_key_found:
        require(
            KNOWN_PUBLIC_TEST_KEY_CONTAINERS_SHA256.get(relative) == content_digest.hexdigest(),
            f"private key found in {label}: {relative}",
        )
    if secret_assignment_found:
        require(
            KNOWN_PUBLIC_SECRET_FIXTURE_CONTAINERS_SHA256.get(relative) == content_digest.hexdigest(),
            f"credential value found in {label}: {relative}",
        )
    return captured


def _scan_link_target(target: str, *, label: str, relative: str) -> None:
    lowered = target.lower()
    pure = PurePosixPath(target)
    parts = {part.lower() for part in pure.parts}
    name = pure.name.lower()
    require(".git" not in parts and ".gitconfig" not in parts, f"Git link target found in {label}: {relative}")
    require(not STOCK_OR_LAO_PATH.search(lowered), f"stock/Lao link target found in {label}: {relative}")
    require(name not in CREDENTIAL_NAMES and not name.startswith(".env."), f"credential link target in {label}: {relative}")
    require(not SENSITIVE_PATH.search(lowered), f"sensitive link target in {label}: {relative}")
    require(pure.suffix.lower() not in AUDIO_SUFFIXES, f"linked source/voice audio in {label}: {relative}")
    require(pure.suffix.lower() not in MODEL_SUFFIXES, f"linked model artifact in {label}: {relative}")


def scan_filesystem(rootfs: Path, *, label: str, model_artifacts: dict[str, dict]) -> None:
    require(rootfs.is_dir(), f"filesystem missing: {label}")
    expected_model_paths = {f"opt/models/{relative}" for relative in model_artifacts}
    for path in rootfs.rglob("*"):
        relative = _relative(rootfs, path)
        lowered = relative.lower()
        parts = {part.lower() for part in path.relative_to(rootfs).parts}
        require(".git" not in parts and ".gitconfig" not in parts, f"Git metadata found in {label}: {relative}")
        require(not STOCK_OR_LAO_PATH.search(lowered), f"stock/Lao asset or catalog found in {label}: {relative}")
        require(path.name.lower() not in CREDENTIAL_NAMES and not path.name.lower().startswith(".env."), f"credential-like path in {label}: {relative}")
        require(not SENSITIVE_PATH.search(lowered), f"sensitive credential path in {label}: {relative}")
        if path.is_symlink():
            _scan_link_target(path.readlink().as_posix(), label=label, relative=relative)
            require(path.suffix.lower() not in AUDIO_SUFFIXES, f"linked source/voice audio in {label}: {relative}")
            require(path.suffix.lower() not in MODEL_SUFFIXES, f"linked model artifact in {label}: {relative}")
            continue
        if not path.is_file():
            continue
        if path.suffix.lower() in AUDIO_SUFFIXES:
            require(
                KNOWN_NONVOICE_AUDIO_FIXTURES_SHA256.get(relative) == _sha256(path),
                f"source/voice audio found in {label}: {relative}",
            )
            continue
        if path.suffix.lower() in MODEL_SUFFIXES:
            is_path_config = path.suffix.lower() == ".pth" and _is_python_path_configuration(path)
            require(
                relative in expected_model_paths or is_path_config,
                f"unmanifested model artifact in {label}: {relative}",
            )
        with path.open("rb") as handle:
            _scan_content(handle, label=label, relative=relative)


def scan_oci_layer_blob(blob: Path, *, label: str, model_artifacts: dict[str, dict]) -> None:
    """Scan the authenticated archive itself before the verifier extracts it."""
    expected_model_paths = {f"opt/models/{relative}" for relative in model_artifacts}
    try:
        archive = tarfile.open(blob, mode="r:*")
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f"cannot open verified OCI layer archive: {label}") from error
    with archive:
        for member in archive:
            pure = PurePosixPath(member.name)
            require(not pure.is_absolute() and ".." not in pure.parts, f"unsafe archive path in {label}: {member.name}")
            relative = pure.as_posix()
            require(relative not in {"", "."}, f"invalid archive path in {label}: {member.name}")
            parts = {part.lower() for part in PurePosixPath(relative).parts}
            lowered = relative.lower()
            require(".git" not in parts and ".gitconfig" not in parts, f"Git metadata found in {label}: {relative}")
            require(not STOCK_OR_LAO_PATH.search(lowered), f"stock/Lao asset or catalog found in {label}: {relative}")
            name = PurePosixPath(relative).name.lower()
            require(name not in CREDENTIAL_NAMES and not name.startswith(".env."), f"credential-like path in {label}: {relative}")
            require(not SENSITIVE_PATH.search(lowered), f"sensitive credential path in {label}: {relative}")
            suffix = PurePosixPath(relative).suffix.lower()
            if member.issym() or member.islnk():
                if suffix in AUDIO_SUFFIXES:
                    require(
                        member.islnk() and KNOWN_NONVOICE_AUDIO_HARDLINKS.get(relative) == member.linkname,
                        f"linked source/voice audio in {label}: {relative}",
                    )
                    continue
                if suffix == ".pth":
                    require(
                        member.islnk() and KNOWN_PYTHON_PATH_CONFIG_HARDLINKS.get(relative) == member.linkname,
                        f"linked model artifact in {label}: {relative}",
                    )
                    continue
                _scan_link_target(member.linkname, label=label, relative=relative)
                require(suffix not in AUDIO_SUFFIXES, f"linked source/voice audio in {label}: {relative}")
                require(suffix not in MODEL_SUFFIXES, f"linked model artifact in {label}: {relative}")
                continue
            if not member.isfile():
                continue
            if suffix in AUDIO_SUFFIXES:
                handle = archive.extractfile(member)
                require(handle is not None, f"cannot inspect {label}:{relative}")
                require(
                    KNOWN_NONVOICE_AUDIO_FIXTURES_SHA256.get(relative) == _sha256_stream(handle),
                    f"source/voice audio found in {label}: {relative}",
                )
                continue
            handle = archive.extractfile(member)
            require(handle is not None, f"cannot inspect {label}:{relative}")
            captured = _scan_content(
                handle,
                label=label,
                relative=relative,
                capture_limit=65_536 if suffix == ".pth" else 0,
            )
            if suffix in MODEL_SUFFIXES:
                is_path_config = suffix == ".pth" and _is_python_path_configuration_content(captured)
                require(
                    relative in expected_model_paths or is_path_config,
                    f"unmanifested model artifact in {label}: {relative}",
                )


def _archive_relative(raw_name: str, *, label: str) -> PurePosixPath:
    require(isinstance(raw_name, str) and "\x00" not in raw_name, f"invalid archive path in {label}")
    pure = PurePosixPath(raw_name)
    require(not pure.is_absolute() and ".." not in pure.parts, f"unsafe archive path in {label}: {raw_name}")
    normalized = PurePosixPath(*("." if part == "" else part for part in pure.parts))
    require(normalized.as_posix() not in {"", "."}, f"invalid archive path in {label}: {raw_name}")
    return normalized


def _path_mode(path: Path) -> int | None:
    try:
        return path.lstat().st_mode
    except FileNotFoundError:
        return None
    except OSError as error:
        raise SystemExit(f"cannot inspect extracted rootfs path: {path}") from error


def _remove_without_following(path: Path) -> None:
    mode = _path_mode(path)
    if mode is None:
        return
    if stat.S_ISDIR(mode):
        try:
            children = list(path.iterdir())
        except OSError as error:
            raise SystemExit(f"cannot enumerate whiteout target: {path}") from error
        for child in children:
            _remove_without_following(child)
        try:
            path.rmdir()
        except OSError as error:
            raise SystemExit(f"cannot remove whiteout directory: {path}") from error
    else:
        try:
            path.unlink()
        except OSError as error:
            raise SystemExit(f"cannot remove whiteout target: {path}") from error


def _ensure_safe_directories(rootfs: Path, relative: PurePosixPath, *, label: str) -> Path:
    current = rootfs
    for part in relative.parts:
        require(part not in {"", ".", ".."}, f"unsafe extraction parent in {label}: {relative}")
        current = current / part
        mode = _path_mode(current)
        if mode is None:
            try:
                current.mkdir()
            except OSError as error:
                raise SystemExit(f"cannot create extraction directory in {label}: {relative}") from error
        else:
            require(stat.S_ISDIR(mode), f"archive parent is not a real directory in {label}: {relative}")
    return current


def _prepare_destination(rootfs: Path, relative: PurePosixPath, *, label: str) -> Path:
    parent = _ensure_safe_directories(rootfs, relative.parent, label=label)
    return parent / relative.name


def _apply_whiteout(rootfs: Path, member: tarfile.TarInfo, relative: PurePosixPath, *, label: str) -> None:
    require(member.isfile() and member.size == 0, f"invalid whiteout entry in {label}: {relative}")
    parent = _ensure_safe_directories(rootfs, relative.parent, label=label)
    if relative.name == ".wh..wh..opq":
        for child in list(parent.iterdir()):
            _remove_without_following(child)
        return
    target_name = relative.name.removeprefix(".wh.")
    require(target_name not in {"", ".", ".."}, f"invalid whiteout target in {label}: {relative}")
    _remove_without_following(parent / target_name)


def _extract_regular(archive: tarfile.TarFile, member: tarfile.TarInfo, destination: Path, *, label: str) -> None:
    _remove_without_following(destination)
    source = archive.extractfile(member)
    require(source is not None, f"cannot read archive file in {label}: {member.name}")
    written = 0
    try:
        with source, destination.open("xb") as output:
            while block := source.read(1024 * 1024):
                output.write(block)
                written += len(block)
    except OSError as error:
        raise SystemExit(f"cannot extract archive file in {label}: {member.name}") from error
    require(written == member.size, f"archive file size mismatch in {label}: {member.name}")


def _extract_authenticated_layer(blob: Path, rootfs: Path, *, label: str) -> None:
    """Apply one authenticated OCI changeset without following archive-controlled links."""
    try:
        archive = tarfile.open(blob, mode="r:*")
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f"cannot open verified OCI layer archive: {label}") from error
    with archive:
        members = archive.getmembers()
        prepared: list[tuple[tarfile.TarInfo, PurePosixPath]] = []
        for member in members:
            relative = _archive_relative(member.name, label=label)
            require(
                member.isfile() or member.isdir() or member.issym() or member.islnk(),
                f"device/FIFO/unsupported archive entry in {label}: {relative}",
            )
            if member.issym() or member.islnk():
                require(isinstance(member.linkname, str) and "\x00" not in member.linkname, f"invalid link in {label}: {relative}")
            prepared.append((member, relative))

        # OCI whiteouts describe removals from lower layers. Applying them before
        # materializing this layer prevents archive order from deleting a file
        # that the same changeset intentionally adds.
        for member, relative in prepared:
            if relative.name.startswith(".wh."):
                _apply_whiteout(rootfs, member, relative, label=label)

        for member, relative in prepared:
            if relative.name.startswith(".wh."):
                continue
            destination = _prepare_destination(rootfs, relative, label=label)
            if member.isdir():
                mode = _path_mode(destination)
                if mode is not None and not stat.S_ISDIR(mode):
                    _remove_without_following(destination)
                    mode = None
                if mode is None:
                    try:
                        destination.mkdir()
                    except OSError as error:
                        raise SystemExit(f"cannot extract directory in {label}: {relative}") from error
            elif member.isfile():
                _extract_regular(archive, member, destination, label=label)
            elif member.issym():
                _remove_without_following(destination)
                try:
                    destination.symlink_to(member.linkname)
                except OSError as error:
                    raise SystemExit(f"cannot extract symlink in {label}: {relative}") from error
            else:
                link_relative = _archive_relative(member.linkname, label=f"{label} hardlink")
                source_parent = _ensure_safe_directories(rootfs, link_relative.parent, label=f"{label} hardlink")
                source = source_parent / link_relative.name
                source_mode = _path_mode(source)
                require(source_mode is not None and stat.S_ISREG(source_mode), f"unsafe/missing hardlink target in {label}: {relative}")
                _remove_without_following(destination)
                try:
                    os.link(source, destination, follow_symlinks=False)
                except OSError as error:
                    raise SystemExit(f"cannot extract hardlink in {label}: {relative}") from error


def _verify_attestation(app: Path) -> None:
    attestation = json.loads((app / "BUILD_ATTESTATION.json").read_text(encoding="utf-8"))
    require(
        set(attestation)
        == {
            "schema_version", "worker_version", "worker_kind", "source_revision",
            "source_manifest_sha256", "model_manifest_sha256", "base_image",
        },
        "build attestation has unexpected fields",
    )
    require(attestation["schema_version"] == 1, "build attestation schema drift")
    require(attestation["worker_version"] == "hero-voice-clone-contract-v3-internal-eval-2", "worker version drift")
    require(attestation["worker_kind"] == "clone-only", "worker kind drift")
    require(attestation["source_revision"] == APPROVED_SOURCE_REVISION, "invalid attested source revision")
    require(attestation["source_manifest_sha256"] == EXPECTED_SOURCE_MANIFEST_SHA256, "attested source manifest mismatch")
    require(attestation["model_manifest_sha256"] == EXPECTED_MODEL_MANIFEST_SHA256, "attested model manifest mismatch")
    require(attestation["base_image"] == PINNED_BASE, "attested base image mismatch")


def _require_checked_in_file(image_path: Path, checked_in_path: Path, *, label: str) -> None:
    mode = _path_mode(image_path)
    require(mode is not None and stat.S_ISREG(mode), f"{label} is missing, linked, or not regular")
    try:
        actual = image_path.read_bytes()
        expected = checked_in_path.read_bytes()
    except OSError as error:
        raise SystemExit(f"cannot read anchored {label}") from error
    require(actual == expected, f"{label} bytes differ from checked-in expectation")


def _verify_extracted_rootfs(rootfs: Path) -> None:
    app = rootfs / "app"
    app_mode = _path_mode(app)
    require(app_mode is not None and stat.S_ISDIR(app_mode), "/app missing or linked in authenticated merged rootfs")
    artifacts = _manifest_artifacts(ROOT / "MODEL_MANIFEST.json")
    scan_filesystem(rootfs, label="merged-rootfs", model_artifacts=artifacts)

    present = {path.name for path in app.iterdir()}
    require(present == ALLOWED_APP_FILES, f"unexpected /app files: {sorted(present ^ ALLOWED_APP_FILES)}")
    for name in ALLOWED_APP_FILES:
        mode = _path_mode(app / name)
        require(mode is not None and stat.S_ISREG(mode), f"/app file is linked or not regular: {name}")
    for name in ("MODEL_MANIFEST.json", "SOURCE_MANIFEST.json", "RUNTIME_MANIFEST.json"):
        _require_checked_in_file(app / name, ROOT / name, label=f"/app/{name}")

    expected_runtime_manifest = json.loads((ROOT / "RUNTIME_MANIFEST.json").read_text(encoding="utf-8"))
    for relative, expected_sha256 in expected_runtime_manifest["files"].items():
        require(_sha256(app / relative) == expected_sha256, f"runtime source differs from checked-in manifest: {relative}")

    resemblyzer_metadata = rootfs / "opt" / "venv" / "lib" / "python3.11" / "site-packages" / "Resemblyzer-0.1.4.dist-info" / "METADATA"
    metadata_mode = _path_mode(resemblyzer_metadata)
    require(metadata_mode is not None and stat.S_ISREG(metadata_mode), "Resemblyzer METADATA missing or linked")
    require(
        _sha256(resemblyzer_metadata) == "9171b44fb93d82cfd945f403d890c4d0f77cb241a483996133b95eb1fe2ea146",
        "Resemblyzer METADATA compatibility patch drift",
    )
    require(
        b"Requires-Dist: typing\r\n" not in resemblyzer_metadata.read_bytes(),
        "obsolete Resemblyzer typing dependency remains installed",
    )

    omnivoice_metadata = rootfs / "opt" / "venv" / "lib" / "python3.11" / "site-packages" / "omnivoice-0.1.5.dist-info" / "METADATA"
    omnivoice_metadata_mode = _path_mode(omnivoice_metadata)
    require(omnivoice_metadata_mode is not None and stat.S_ISREG(omnivoice_metadata_mode), "OmniVoice METADATA missing or linked")
    require(
        _sha256(omnivoice_metadata) == "f72051fb59f8967c0dd7dc6dd1cf2ca02c038dd6b1293fa5e5cb82481793d660",
        "OmniVoice METADATA compatibility patch drift",
    )
    require(
        b"Requires-Dist: gradio\n" not in omnivoice_metadata.read_bytes(),
        "excluded OmniVoice Gradio dependency remains installed",
    )

    model_root = rootfs / "opt" / "models"
    model_root_mode = _path_mode(model_root)
    require(model_root_mode is not None and stat.S_ISDIR(model_root_mode), "/opt/models missing or linked")
    for path in model_root.rglob("*"):
        require(not stat.S_ISLNK(path.lstat().st_mode), f"link found below /opt/models: {path.relative_to(model_root)}")
    present_models = {
        str(path.relative_to(model_root))
        for path in model_root.rglob("*")
        if stat.S_ISREG(path.lstat().st_mode)
    }
    require(present_models == set(artifacts), f"unmanifested/missing model files: {sorted(present_models ^ set(artifacts))}")
    for relative, artifact in artifacts.items():
        path = model_root / relative
        require(stat.S_ISREG(path.lstat().st_mode), f"model artifact is linked or not regular: {relative}")
        require(path.stat().st_size == artifact["size"], f"model size mismatch: {relative}")
        require(_sha256(path) == artifact["sha256"], f"model hash mismatch: {relative}")
    for candidate in (rootfs / "root" / ".cache", rootfs / "home" / "worker" / ".cache"):
        mode = _path_mode(candidate)
        require(
            mode is None or (stat.S_ISDIR(mode) and not any(candidate.iterdir())),
            f"undeclared or linked cache found: {candidate}",
        )
    _verify_attestation(app)


def verify_rootfs(oci_layout: Path, *, expected_manifest_digest: str | None = None) -> None:
    """Verify and extract one authenticated OCI image without caller-supplied trees."""
    verify_static()
    require(
        isinstance(expected_manifest_digest, str) and OCI_DIGEST.fullmatch(expected_manifest_digest) is not None,
        "immutable OCI manifest digest is required",
    )
    evidence = load_oci_image_evidence(oci_layout)
    require(evidence.manifest_digest == expected_manifest_digest, "verified OCI manifest digest mismatch")
    artifacts = _manifest_artifacts(ROOT / "MODEL_MANIFEST.json")
    with tempfile.TemporaryDirectory(prefix="omnivoice-verified-rootfs-") as temp_dir:
        rootfs = Path(temp_dir) / "rootfs"
        rootfs.mkdir()
        for index, digest in enumerate(evidence.layer_digests):
            blob = oci_layout / "blobs" / "sha256" / digest[7:]
            label = f"oci-layer[{index}]/{digest}"
            scan_oci_layer_blob(blob, label=label, model_artifacts=artifacts)
            _extract_authenticated_layer(blob, rootfs, label=label)
        _verify_extracted_rootfs(rootfs)


def verify_network_blocked_cold_import() -> None:
    original_connect = socket.socket.connect
    original_create_connection = socket.create_connection

    def blocked(*_args, **_kwargs):
        raise RuntimeError("network disabled by cold-import verifier")

    socket.socket.connect = blocked
    socket.create_connection = blocked
    try:
        from runtime import CloneRuntime

        runtime = CloneRuntime()
        separator = runtime._get_demucs()
        require(separator is runtime._get_demucs(), "Demucs separator was not cached")
        runtime._get_audioseal()
        runtime._get_speaker_encoder()
    finally:
        socket.socket.connect = original_connect
        socket.create_connection = original_create_connection


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--oci-layout", type=Path, help="verified OCI image-layout directory containing index.json and blobs")
    parser.add_argument("--expected-manifest-digest", help="immutable linux/amd64 manifest digest from Task 6 registry readback")
    parser.add_argument("--cold-import", action="store_true")
    args = parser.parse_args()
    require(any((args.static, args.oci_layout, args.cold_import)), "choose a verification mode")
    if args.static:
        verify_static()
    if args.oci_layout:
        verify_rootfs(args.oci_layout, expected_manifest_digest=args.expected_manifest_digest)
    else:
        require(args.expected_manifest_digest is None, "manifest digest requires --oci-layout")
    if args.cold_import:
        verify_network_blocked_cold_import()


if __name__ == "__main__":
    main()

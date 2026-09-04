from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from canonical import dumps_jcs, loads_strict

LOCK_KEYS = [
    "baseImageDigest", "canonicalExecutionEnabled", "ffmpegBinarySha256",
    "ffmpegPackageVersion", "model", "platform", "pythonLockComplete",
    "schemaVersion", "task6Blockers",
]
HEX64 = re.compile(r"^[0-9a-f]{64}$")
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def lock_is_complete(root: Path) -> tuple[bool, list[str]]:
    raw_manifest = (root / "RUNTIME_LOCK.json").read_bytes()
    manifest = loads_strict(raw_manifest)
    if not isinstance(manifest, dict) or sorted(manifest) != LOCK_KEYS \
            or raw_manifest not in {dumps_jcs(manifest), dumps_jcs(manifest) + b"\n"}:
        return False, ["runtime_lock_schema_or_canonical_bytes_invalid"]
    blockers = list(manifest.get("task6Blockers", []))
    model = manifest.get("model")
    requirements = (root / "requirements.lock").read_text(encoding="utf-8")
    locked_requirements = [line for line in requirements.splitlines()
                           if line.strip() and not line.lstrip().startswith("#")]
    complete = (
        manifest.get("schemaVersion") == 1
        and manifest.get("platform") == "linux/arm64"
        and manifest.get("canonicalExecutionEnabled") is True
        and manifest.get("pythonLockComplete") is True
        and isinstance(manifest.get("baseImageDigest"), str) and OCI_DIGEST.fullmatch(manifest["baseImageDigest"])
        and isinstance(manifest.get("ffmpegBinarySha256"), str) and HEX64.fullmatch(manifest["ffmpegBinarySha256"])
        and isinstance(manifest.get("ffmpegPackageVersion"), str) and bool(manifest["ffmpegPackageVersion"])
        and model == {"filename": "large-v3-turbo.pt", "sha256": "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a"}
        and bool(locked_requirements) and "--hash=sha256:" in requirements
        and all("==" in line or line.rstrip().endswith("\\") or line.lstrip().startswith("--hash=sha256:")
                for line in locked_requirements)
        and not blockers
    )
    return complete, blockers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-blocked", action="store_true")
    parser.add_argument("--apply", action="store_true")
    options = parser.parse_args()
    complete, blockers = lock_is_complete(Path(__file__).parent)
    if options.expect_blocked:
        if complete or not blockers:
            raise SystemExit("expected Task 5 evaluator lock to remain blocked")
        print(json.dumps({"status": "blocked", "blockers": blockers}, separators=(",", ":")))
        return 0
    if not options.apply or not complete:
        raise SystemExit("canonical evaluator lock is incomplete; Task 6 evidence required")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

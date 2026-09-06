"""Inventory supplied wheels offline; never resolve, download or qualify them."""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import zipfile
from email.parser import BytesParser
from pathlib import Path

from verify_lock import locked_distributions


def prepare_wheel_lock(wheelhouse: Path) -> bytes:
    if not wheelhouse.is_absolute() or wheelhouse.is_symlink() or not wheelhouse.is_dir():
        raise ValueError("absolute non-symlink wheelhouse required")
    pins: dict[str, tuple[str, str]] = {}
    for wheel in sorted(wheelhouse.iterdir()):
        if wheel.is_symlink() or not wheel.is_file() or wheel.suffix != ".whl":
            raise ValueError("wheelhouse must contain only regular wheel files")
        filename_parts = wheel.stem.split("-")
        if len(filename_parts) not in {5, 6}:
            raise ValueError("invalid wheel filename")
        with wheel.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
            source.seek(0)
            with zipfile.ZipFile(source) as archive:
                metadata_files = [entry for entry in archive.infolist() if entry.filename.endswith(".dist-info/METADATA")]
                if len(metadata_files) != 1 or metadata_files[0].file_size > 1024 * 1024:
                    raise ValueError("wheel metadata missing, ambiguous or oversized")
                expected_path = f"{filename_parts[0]}-{filename_parts[1]}.dist-info/METADATA"
                if metadata_files[0].filename != expected_path:
                    raise ValueError("wheel metadata path mismatch")
                metadata = BytesParser().parsebytes(archive.read(metadata_files[0]), headersonly=True)
        if len(metadata.get_all("Name", [])) != 1 or len(metadata.get_all("Version", [])) != 1:
            raise ValueError("wheel name/version metadata invalid")
        name = re.sub(r"[-_.]+", "-", metadata["Name"]).lower()
        version = metadata["Version"]
        if name != re.sub(r"[-_.]+", "-", filename_parts[0]).lower() or version != filename_parts[1]:
            raise ValueError("wheel filename and metadata identity mismatch")
        if name in pins:
            raise ValueError("one target wheel per distribution required")
        pins[name] = (version, digest)
    text = "".join(f"{name}=={version} --hash=sha256:{digest}\n" for name, (version, digest) in sorted(pins.items()))
    locked_distributions(text)
    return text.encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheelhouse", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    options = parser.parse_args()
    if not options.output.is_absolute():
        parser.error("absolute output path required")
    content = prepare_wheel_lock(options.wheelhouse)
    descriptor = os.open(options.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    print("Prepared dependencyLockSha256=" + hashlib.sha256(content).hexdigest())
    print("Preparation only; native wheel compatibility, closure, build provenance and runtime qualification remain required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

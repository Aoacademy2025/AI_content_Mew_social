from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import zipfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from canonical import dumps_jcs, loads_strict
import verify_lock
from verify_lock import lock_is_complete

ROOT = Path(__file__).parent


class LockTests(unittest.TestCase):
    def write_prepared_lock(self, root: Path) -> dict:
        requirements = "".join(f"{name}=={version} --hash=sha256:{'a' * 64}\n" for name, version in (
            ("openai-whisper", "20250625"), ("numpy", "2.0.0"), ("torch", "2.5.0"),
        ))
        manifest = loads_strict((ROOT / "RUNTIME_LOCK.json").read_bytes())
        manifest.update({
            "baseImageDigest": "sha256:" + "b" * 64,
            "dependencyLockSha256": hashlib.sha256(requirements.encode()).hexdigest(),
            "ffmpegBinarySha256": "c" * 64,
            "ffmpegPackageVersion": "7:5.1.6-0+deb12u1",
            "pythonLockComplete": True,
            "task6Blockers": ["non_emulated_linux_arm64_runtime_attestation_missing"],
        })
        (root / "RUNTIME_LOCK.json").write_bytes(dumps_jcs(manifest))
        (root / "requirements.lock").write_text(requirements)
        return manifest

    def test_qualified_lock_rejects_corrupt_schema_and_pip_directives(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.write_prepared_lock(root)
            manifest.update({"canonicalExecutionEnabled": True, "task6Blockers": []})
            (root / "RUNTIME_LOCK.json").write_bytes(dumps_jcs(manifest))
            self.assertTrue(lock_is_complete(root)[0])
            valid = (root / "requirements.lock").read_text()
            for extra in ("--extra-index-url https://example.invalid\n", "torch==2.5.0 --hash=sha256:bad\n", "-r other.lock\n", "torch>=2.0\n", "numpy==2.0.0 ; sys_platform == 'darwin'\n"):
                with self.subTest(extra=extra):
                    modified = (valid + extra).encode()
                    manifest["dependencyLockSha256"] = hashlib.sha256(modified).hexdigest()
                    (root / "requirements.lock").write_bytes(modified)
                    (root / "RUNTIME_LOCK.json").write_bytes(dumps_jcs(manifest))
                    self.assertFalse(lock_is_complete(root)[0])
            for raw in (b'{"schemaVersion":2,"schemaVersion":2}', b'{"version":1.5}', b'[]', b'not JSON'):
                (root / "RUNTIME_LOCK.json").write_bytes(raw)
                self.assertFalse(lock_is_complete(root)[0])

    def test_preparation_does_not_enable_canonical_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.write_prepared_lock(root)
            for filename in ("canonical.py", "verify_lock.py"):
                shutil.copyfile(ROOT / filename, root / filename)
            command = [sys.executable, str(root / "verify_lock.py")]
            prepared = subprocess.run(command + ["--prepare", "--base-image", "python@" + manifest["baseImageDigest"]], capture_output=True)
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            self.assertFalse(lock_is_complete(root)[0])
            self.assertNotEqual(subprocess.run(command + ["--apply"], capture_output=True).returncode, 0)
            wrong_base = subprocess.run(command + ["--prepare", "--base-image", "python:latest"], capture_output=True)
            self.assertNotEqual(wrong_base.returncode, 0)
            with (root / "requirements.lock").open("a") as output:
                output.write("# changed bytes\n")
            changed = subprocess.run(command + ["--prepare", "--base-image", "python@" + manifest["baseImageDigest"]], capture_output=True)
            self.assertNotEqual(changed.returncode, 0)

    def test_installed_runtime_rejects_dependency_and_ffmpeg_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.write_prepared_lock(root)
            ffmpeg = root / "ffmpeg"
            ffmpeg.write_bytes(b"synthetic FFmpeg binary")
            manifest["ffmpegBinarySha256"] = hashlib.sha256(ffmpeg.read_bytes()).hexdigest()
            (root / "RUNTIME_LOCK.json").write_bytes(dumps_jcs(manifest))
            distributions = [SimpleNamespace(metadata={"Name": name}, version=version) for name, version in (
                ("openai-whisper", "20250625"), ("numpy", "2.0.0"), ("torch", "2.5.0"), ("pip", "25.0"),
            )]
            def external_command(command, **_kwargs):
                if command[0] == "dpkg-query":
                    return SimpleNamespace(stdout=manifest["ffmpegPackageVersion"])
                return SimpleNamespace(stdout="No broken requirements found.")

            with patch("sys.platform", "linux"), patch("platform.machine", return_value="aarch64"), \
                    patch("importlib.metadata.distributions", return_value=distributions), \
                    patch("shutil.which", return_value=str(ffmpeg)), \
                    patch("subprocess.run", side_effect=external_command):
                verify_lock.verify_installed_runtime(root)
                distributions[1].version = "2.1.0"
                with self.assertRaisesRegex(ValueError, "distribution"):
                    verify_lock.verify_installed_runtime(root)
                distributions[1].version = "2.0.0"
                distributions.append(SimpleNamespace(metadata={"Name": "unlocked-dependency"}, version="1.0"))
                with self.assertRaisesRegex(ValueError, "distribution"):
                    verify_lock.verify_installed_runtime(root)
                distributions.pop()
                ffmpeg.write_bytes(b"changed binary")
                with self.assertRaisesRegex(ValueError, "FFmpeg"):
                    verify_lock.verify_installed_runtime(root)

    def test_wheel_preparation_hashes_actual_artifacts_without_qualifying(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wheelhouse = root / "wheels"
            wheelhouse.mkdir()
            for name, version in (("openai_whisper", "20250625"), ("numpy", "2.0.0"), ("torch", "2.5.0")):
                with zipfile.ZipFile(wheelhouse / f"{name}-{version}-py3-none-any.whl", "w") as archive:
                    archive.writestr(f"{name}-{version}.dist-info/METADATA", f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n")
            command = [sys.executable, str(ROOT / "prepare_wheel_lock.py"), "--wheelhouse", str(wheelhouse)]
            first = root / "first.lock"
            result = subprocess.run(command + ["--output", str(first)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            second = root / "second.lock"
            self.assertEqual(subprocess.run(command + ["--output", str(second)], capture_output=True).returncode, 0)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertNotEqual(subprocess.run(command + ["--output", str(first)], capture_output=True).returncode, 0)
            numpy_wheel = wheelhouse / "numpy-2.0.0-py3-none-any.whl"
            expected_hash = hashlib.sha256(numpy_wheel.read_bytes()).hexdigest()
            self.assertIn(f"numpy==2.0.0 --hash=sha256:{expected_hash}", first.read_text())
            self.assertFalse(lock_is_complete(ROOT)[0])
            (wheelhouse / "unexpected.tar.gz").write_bytes(b"source archives forbidden")
            self.assertNotEqual(subprocess.run(command + ["--output", str(root / "third.lock")], capture_output=True).returncode, 0)

    def test_every_distribution_needs_its_own_hash(self) -> None:
        # Synthetic identity values exercise validation, never qualification.
        manifest = loads_strict((ROOT / "RUNTIME_LOCK.json").read_bytes())
        requirements = ("openai-whisper==20250625 --hash=sha256:" + "a" * 64 + "\n"
                        "numpy==2.0.0\ntorch==2.5.0\n")
        manifest.update({
            "baseImageDigest": "sha256:" + "b" * 64,
            "canonicalExecutionEnabled": True,
            "ffmpegBinarySha256": "c" * 64,
            "ffmpegPackageVersion": "7:5.1.6-0+deb12u1",
            "pythonLockComplete": True,
            "task6Blockers": [],
        })
        if "dependencyLockSha256" in manifest:
            manifest["dependencyLockSha256"] = hashlib.sha256(requirements.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "RUNTIME_LOCK.json").write_bytes(dumps_jcs(manifest))
            (root / "requirements.lock").write_text(requirements)
            self.assertFalse(lock_is_complete(root)[0])


if __name__ == "__main__":
    unittest.main()

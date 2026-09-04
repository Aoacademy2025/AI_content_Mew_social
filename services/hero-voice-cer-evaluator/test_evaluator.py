from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from canonical import CanonicalJsonError, dumps_jcs, loads_exact_jcs
from evaluator import (
    EvaluatorContractError,
    FFMPEG_ARGV,
    RUNTIME_FINGERPRINT_KEYS,
    build_runtime_fingerprint,
    cer_counts,
    ffmpeg_argv,
    normalize_cer_text,
    score_pcm,
    validate_batch_inventory,
    validate_fixture_hashes,
)

ROOT = Path(__file__).parent


class CanonicalTests(unittest.TestCase):
    def test_duplicate_and_noncanonical_rejected(self) -> None:
        with self.assertRaises(CanonicalJsonError):
            loads_exact_jcs(b'{"a":1,"a":2}')
        with self.assertRaises(CanonicalJsonError):
            loads_exact_jcs(b'{"b":1, "a":2}')
        value = {"version": 1, "ข้อความ": "ไทย", "items": [True, None, 3]}
        self.assertEqual(loads_exact_jcs(dumps_jcs(value)), value)


class CerTests(unittest.TestCase):
    def test_unicode_normalizer_golden(self) -> None:
        self.assertEqual(normalize_cer_text(" กำลัง—TEST ๑๒3! "), "กำลังtest๑๒3")
        self.assertEqual(normalize_cer_text("e\u0301"), normalize_cer_text("É"))
        self.assertEqual(normalize_cer_text("1,249 บาท"), "1249บาท")

    def test_cer_codepoints_and_empty(self) -> None:
        self.assertEqual(cer_counts("แมว", "แมว"), (0, 3))
        self.assertEqual(cer_counts("abc", "adc"), (1, 3))
        self.assertEqual(cer_counts("abc", ""), (3, 3))
        with self.assertRaises(EvaluatorContractError):
            cer_counts("!?", "")

    def test_local_transcriber_double(self) -> None:
        result = score_pcm(b"\x00\x00", "ทดสอบ", lambda _pcm: "ทดสอบ")
        self.assertEqual(result["cerNumerator"], 0)
        self.assertTrue(result["passed"])


class ContractTests(unittest.TestCase):
    def test_exact_ffmpeg_contract(self) -> None:
        source = Path("/private/in.wav")
        destination = Path("/private/out.pcm")
        argv = ffmpeg_argv(source, destination)
        self.assertEqual(tuple("INPUT" if item == str(source) else "OUTPUT.pcm" if item == str(destination) else item for item in argv), FFMPEG_ARGV)

    def test_inventory_counts(self) -> None:
        inventory = {
            "version": 1,
            "batchKind": "ablation-8",
            "items": [
                {"slotId": f"slot-{index}", "storageBasename": f"audio-{index}.wav", "audioSha256": "a" * 64, "expectedText": "ไทย"}
                for index in range(8)
            ],
        }
        self.assertEqual(len(validate_batch_inventory(inventory, "ablation-8")), 8)
        with self.assertRaises(EvaluatorContractError):
            validate_batch_inventory({**inventory, "items": inventory["items"][:-1]}, "ablation-8")
        invalid_hash = {**inventory, "items": [{**inventory["items"][0], "audioSha256": "G" * 64}, *inventory["items"][1:]]}
        with self.assertRaises(EvaluatorContractError):
            validate_batch_inventory(invalid_hash, "ablation-8")

    def test_fixture_three_process_contract(self) -> None:
        validate_fixture_hashes(["a" * 64] * 3, ["a" * 64] * 3, "b" * 64)
        with self.assertRaises(EvaluatorContractError):
            validate_fixture_hashes(["a" * 64, "b" * 64, "a" * 64], ["a" * 64] * 3, "b" * 64)

    def test_runtime_fingerprint_exact_schema_is_deterministic(self) -> None:
        observation = {key: f"synthetic-{key}" for key in RUNTIME_FINGERPRINT_KEYS}
        observation.update({"version": 1, "containerPlatform": "linux/arm64", "emulationDisabled": True})
        first = build_runtime_fingerprint(observation)
        second = build_runtime_fingerprint(dict(reversed(list(observation.items()))))
        self.assertEqual(first, second)
        self.assertEqual(len(first[1]), 64)
        with self.assertRaises(EvaluatorContractError):
            build_runtime_fingerprint({**observation, "unexpected": True})

    def test_fixture_cli_is_deterministic_across_three_processes(self) -> None:
        request = dumps_jcs({"version": 1, "expected": "สวัสดี", "actual": "สวัสดี", "pcmHex": "0000"})
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "fixture.json"
            filename.write_bytes(request)
            outputs = [subprocess.check_output([sys.executable, str(ROOT / "evaluator.py"), "--fixture", str(filename)]) for _ in range(3)]
        self.assertEqual(len(set(outputs)), 1)
        self.assertEqual(loads_exact_jcs(outputs[0])["cerNumerator"], 0)

    def test_lock_verifier_fails_apply_and_reports_blocked(self) -> None:
        blocked = subprocess.run([sys.executable, str(ROOT / "verify_lock.py"), "--expect-blocked"], check=False, capture_output=True, text=True)
        self.assertEqual(blocked.returncode, 0)
        self.assertEqual(json.loads(blocked.stdout)["status"], "blocked")
        apply = subprocess.run([sys.executable, str(ROOT / "verify_lock.py"), "--apply"], check=False, capture_output=True, text=True)
        self.assertNotEqual(apply.returncode, 0)

    def test_real_batch_cli_is_present_and_fails_closed_before_scoring(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            placeholders = [root / name for name in ("inventory.json", "model.pt", "fixture.wav", "fixture.txt")]
            for filename in placeholders:
                filename.write_bytes(b"synthetic")
            result = subprocess.run([
                sys.executable, str(ROOT / "evaluator.py"), "--batch", "ablation-8",
                str(placeholders[0]), str(root / "output.json"), str(placeholders[1]),
                str(placeholders[2]), str(placeholders[3]),
            ], check=False, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "output.json").exists())
            self.assertIn("Task 6 evidence required", result.stderr)


if __name__ == "__main__":
    unittest.main()

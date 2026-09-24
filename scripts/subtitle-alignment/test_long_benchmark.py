import copy
import json
import tempfile
import textwrap
import unittest
from pathlib import Path

from long_benchmark import is_aligned_result, runtime_executable, run_case, validate_result


class LongBenchmarkTests(unittest.TestCase):
    @staticmethod
    def complete_case():
        return {
            "id": "short-known",
            "audioPath": "/private/synthetic.wav",
            "text": "แมว แมว",
            "expectedDurationMs": 2000,
            "boundaries": [
                {"startChar": 0, "referenceMs": 100},
                {"startChar": 4, "referenceMs": 1100},
            ],
        }

    @staticmethod
    def complete_result():
        return {
            "version": "thai-ctc-v1",
            "modelRevision": "3155938c549b23eee16b1d4b55dcb161b7fe4bcf",
            "audioDurationMs": 2000,
            "characters": [
                {"startChar": 0, "endChar": 1, "startMs": 120, "endMs": 180, "confidence": .9},
                {"startChar": 1, "endChar": 2, "startMs": 180, "endMs": 240, "confidence": .9},
                {"startChar": 2, "endChar": 3, "startMs": 240, "endMs": 300, "confidence": .9},
                {"startChar": 4, "endChar": 5, "startMs": 1140, "endMs": 1200, "confidence": .9},
                {"startChar": 5, "endChar": 6, "startMs": 1200, "endMs": 1260, "confidence": .9},
                {"startChar": 6, "endChar": 7, "startMs": 1260, "endMs": 1320, "confidence": .9},
            ],
        }

    def test_runtime_executable_preserves_virtualenv_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "python"
            link.symlink_to(sys_executable())

            self.assertEqual(runtime_executable(link), link.absolute())

    def test_result_reports_monotonic_coverage_and_boundary_drift(self):
        case = self.complete_case()
        result = self.complete_result()

        summary = validate_result(case, result)

        self.assertTrue(summary["monotonic"])
        self.assertEqual(summary["coveragePermille"], 1000)
        self.assertTrue(summary["durationWithinTolerance"])
        self.assertEqual(summary["durationDeltaMs"], 0)
        self.assertEqual(summary["boundaryCount"], 2)
        self.assertTrue(summary["boundariesComplete"])
        self.assertEqual(summary["boundaryDriftMaxMs"], 20)
        self.assertTrue(summary["eligibleSpansComplete"])
        self.assertTrue(is_aligned_result(summary))

    def test_missing_eligible_span_is_not_aligned(self):
        result = self.complete_result()
        result["characters"].pop()

        summary = validate_result(self.complete_case(), result)

        self.assertEqual(summary["emittedEligibleSpanCount"], 5)
        self.assertEqual(summary["eligibleCharacterCount"], 6)
        self.assertEqual(summary["missingEligibleSpanCount"], 1)
        self.assertEqual(summary["coveragePermille"], 833)
        self.assertFalse(summary["eligibleSpansComplete"])
        self.assertFalse(is_aligned_result(summary))

    def test_duplicate_eligible_span_is_not_aligned(self):
        result = self.complete_result()
        result["characters"].insert(1, copy.deepcopy(result["characters"][0]))

        summary = validate_result(self.complete_case(), result)

        self.assertEqual(summary["emittedEligibleSpanCount"], 7)
        self.assertEqual(summary["uniqueEmittedEligibleSpanCount"], 6)
        self.assertEqual(summary["duplicateEligibleSpanCount"], 1)
        self.assertEqual(summary["coveragePermille"], 1000)
        self.assertFalse(summary["eligibleSpansComplete"])
        self.assertFalse(is_aligned_result(summary))

    def test_result_without_known_boundaries_is_not_aligned(self):
        case = self.complete_case()
        case["boundaries"] = []

        summary = validate_result(case, self.complete_result())

        self.assertTrue(summary["eligibleSpansComplete"])
        self.assertEqual(summary["boundaryExpectedCount"], 0)
        self.assertFalse(summary["boundariesComplete"])
        self.assertFalse(is_aligned_result(summary))

    def test_real_child_incomplete_timing_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "fixture.wav"
            audio.write_bytes(b"RIFF" + b"0" * 100)
            engine = root / "engine.py"
            engine.write_text(textwrap.dedent("""
                import hashlib, json, sys
                request = json.loads(sys.stdin.read())
                print(json.dumps({
                    "version": "thai-ctc-v1",
                    "modelRevision": "3155938c549b23eee16b1d4b55dcb161b7fe4bcf",
                    "audioHash": request["audioHash"],
                    "textHash": hashlib.sha256(request["text"].encode()).hexdigest(),
                    "audioDurationMs": 2000,
                    "characters": [
                        {"startChar": 0, "endChar": 1, "startMs": 120, "endMs": 180, "confidence": .9}
                    ]
                }))
            """))

            row = run_case(self.complete_case() | {"id": "incomplete", "audioPath": str(audio)},
                           sys_executable(), engine, 2000, 1, root / "cache")

            self.assertEqual(row["status"], "invalid")
            self.assertEqual(row["emittedEligibleSpanCount"], 1)
            self.assertEqual(row["eligibleCharacterCount"], 6)
            self.assertEqual(row["boundaryCount"], 1)
            self.assertFalse(row["eligibleSpansComplete"])
            self.assertFalse(row["boundariesComplete"])

    def test_real_child_timeout_records_last_phase_without_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "fixture.wav"
            audio.write_bytes(b"RIFF" + b"0" * 100)
            engine = root / "engine.py"
            engine.write_text(textwrap.dedent("""
                import sys, time
                sys.stdin.read()
                print("HERO_ACOUSTIC_PHASE=emissions", file=sys.stderr, flush=True)
                print("PRIVATE_TRANSCRIPT", file=sys.stderr, flush=True)
                time.sleep(10)
            """))
            case = {"id": "timeout", "audioPath": str(audio), "text": "ข้อความสังเคราะห์", "boundaries": []}

            row = run_case(case, sys_executable(), engine, 100, 1, root / "cache")

            self.assertEqual(row["status"], "timeout")
            self.assertEqual(row["timeoutPhase"], "emissions")
            self.assertLess(row["durationMs"], 3000)
            self.assertNotIn("PRIVATE", json.dumps(row))


def sys_executable():
    import sys
    return Path(sys.executable)


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import textwrap
import unittest
from pathlib import Path

from long_benchmark import runtime_executable, run_case, validate_result


class LongBenchmarkTests(unittest.TestCase):
    def test_runtime_executable_preserves_virtualenv_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "python"
            link.symlink_to(sys_executable())

            self.assertEqual(runtime_executable(link), link.absolute())

    def test_result_reports_monotonic_coverage_and_boundary_drift(self):
        case = {
            "id": "short-known",
            "audioPath": "/private/synthetic.wav",
            "text": "แมว แมว",
            "expectedDurationMs": 2000,
            "boundaries": [
                {"startChar": 0, "referenceMs": 100},
                {"startChar": 4, "referenceMs": 1100},
            ],
        }
        result = {
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

        summary = validate_result(case, result)

        self.assertTrue(summary["monotonic"])
        self.assertEqual(summary["coveragePermille"], 1000)
        self.assertTrue(summary["durationWithinTolerance"])
        self.assertEqual(summary["durationDeltaMs"], 0)
        self.assertEqual(summary["boundaryCount"], 2)
        self.assertTrue(summary["boundariesComplete"])
        self.assertEqual(summary["boundaryDriftMaxMs"], 20)

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

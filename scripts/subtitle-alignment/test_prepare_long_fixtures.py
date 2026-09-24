import tempfile
import unittest
import wave
from pathlib import Path

from prepare_long_fixtures import repeat_wave


class PrepareLongFixturesTests(unittest.TestCase):
    def test_repeat_wave_keeps_whole_phrases_and_known_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.wav"
            with wave.open(str(source), "wb") as output:
                output.setparams((1, 2, 16_000, 0, "NONE", "not compressed"))
                output.writeframes(b"\0\0" * 16_000)

            row = repeat_wave(source, root / "long.wav", "แมว", 2.6, "long-test")

            self.assertEqual(row["text"], "แมว แมว แมว")
            self.assertEqual(row["expectedDurationMs"], 3000)
            self.assertEqual(row["boundaries"], [
                {"startChar": 0, "referenceMs": 0},
                {"startChar": 4, "referenceMs": 1000},
                {"startChar": 8, "referenceMs": 2000},
            ])


if __name__ == "__main__":
    unittest.main()

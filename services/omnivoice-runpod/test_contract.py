import unittest

from contract import InputError, parse_tts_input


class ContractTest(unittest.TestCase):
    def test_valid_request(self):
        result = parse_tts_input(
            {"operation": "tts", "voice_id": "voice_01", "text": " สวัสดีครับ ", "num_step": 4, "speed": 1.0},
            max_text_length=800,
            default_num_step=4,
        )
        self.assertEqual(result.voice_id, "voice_01")
        self.assertEqual(result.text, "สวัสดีครับ")
        self.assertEqual(result.num_step, 4)

    def test_defaults(self):
        result = parse_tts_input({"voice_id": "voice_02", "text": "hello"}, 800, 6)
        self.assertEqual(result.num_step, 6)
        self.assertEqual(result.speed, 1.0)

    def test_rejects_bad_inputs(self):
        bad = [
            ({}, "INVALID_VOICE_ID"),
            ({"voice_id": "../secret", "text": "x"}, "INVALID_VOICE_ID"),
            ({"voice_id": "voice_01", "text": " "}, "INVALID_TEXT"),
            ({"voice_id": "voice_01", "text": "x" * 801}, "TEXT_TOO_LONG"),
            ({"voice_id": "voice_01", "text": "x", "num_step": 3}, "INVALID_NUM_STEP"),
            ({"voice_id": "voice_01", "text": "x", "speed": 3.1}, "INVALID_SPEED"),
            ({"operation": "shell", "voice_id": "voice_01", "text": "x"}, "INVALID_OPERATION"),
        ]
        for payload, code in bad:
            with self.subTest(code=code), self.assertRaises(InputError) as raised:
                parse_tts_input(payload, 800, 4)
            self.assertEqual(raised.exception.code, code)


if __name__ == "__main__":
    unittest.main()

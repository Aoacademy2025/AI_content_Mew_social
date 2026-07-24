import json
import hashlib
from pathlib import Path
import threading
import time
import unittest

from contract import InputError, parse_design_input, parse_tts_input
from prompt_cache import VoicePromptCache


ROOT = Path(__file__).resolve().parent


class ContractTest(unittest.TestCase):
    def test_valid_request(self):
        result = parse_tts_input(
            {"operation": "tts", "voice_id": "voice_01", "text": " สวัสดีครับ ", "num_step": 32, "speed": 1.0},
            max_text_length=800,
        )
        self.assertEqual(result.voice_id, "voice_01")
        self.assertEqual(result.text, "สวัสดีครับ")
        self.assertEqual(result.num_step, 32)

    def test_defaults(self):
        result = parse_tts_input({"voice_id": "voice_02", "text": "hello"}, 800)
        self.assertEqual(result.num_step, 32)
        self.assertEqual(result.speed, 1.0)
        self.assertEqual(result.class_temperature, 0.0)

    def test_class_temperature_absent_matches_explicit_zero(self):
        # T2 requirement: absent/0.0 must be the identical v11 code path.
        absent = parse_tts_input({"voice_id": "voice_01", "text": "hello"}, 800)
        explicit_zero = parse_tts_input(
            {"voice_id": "voice_01", "text": "hello", "class_temperature": 0.0}, 800
        )
        self.assertEqual(absent.class_temperature, explicit_zero.class_temperature)
        self.assertEqual(absent.class_temperature, 0.0)

    def test_class_temperature_accepts_documented_range(self):
        for value in (0.0, 0.1, 2.5, 5.0):
            with self.subTest(value=value):
                result = parse_tts_input(
                    {"voice_id": "voice_01", "text": "hello", "class_temperature": value},
                    800,
                )
                self.assertEqual(result.class_temperature, float(value))

    def test_class_temperature_accepts_int_input(self):
        result = parse_tts_input(
            {"voice_id": "voice_01", "text": "hello", "class_temperature": 1}, 800
        )
        self.assertEqual(result.class_temperature, 1.0)

    def test_class_temperature_rejects_out_of_range(self):
        bad = [-0.1, -1.0, 5.1, 100.0]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(InputError) as raised:
                parse_tts_input(
                    {"voice_id": "voice_01", "text": "hello", "class_temperature": value},
                    800,
                )
            self.assertEqual(raised.exception.code, "INVALID_CLASS_TEMPERATURE")

    def test_class_temperature_rejects_non_numeric_and_bool(self):
        bad = ["0.5", None, True, False, [0.5], {}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(InputError) as raised:
                parse_tts_input(
                    {"voice_id": "voice_01", "text": "hello", "class_temperature": value},
                    800,
                )
            self.assertEqual(raised.exception.code, "INVALID_CLASS_TEMPERATURE")

    def test_nonverbal_tags_pass_through_verbatim(self):
        # Upstream ships 13 fixed non-verbal tags (README.md#L249-L259, pinned
        # commit 346bb75...) that must reach the model unmodified.
        tagged_text = "[laughter] สวัสดีครับ [sigh] วันนี้อากาศดีมาก"
        result = parse_tts_input(
            {"voice_id": "voice_01", "text": tagged_text, "class_temperature": 1.0},
            800,
        )
        self.assertEqual(result.text, tagged_text)
        self.assertIn("[laughter]", result.text)
        self.assertIn("[sigh]", result.text)

    def test_quality_contract_accepts_upstream_default_steps(self):
        result = parse_tts_input(
            {"voice_id": "voice_02", "text": "hello", "num_step": 32},
            800,
        )
        self.assertEqual(result.num_step, 32)

    def test_quality_contract_rejects_lower_steps_for_every_voice(self):
        for voice_id in ("voice_01", "voice_06", "voice_25", "voice_46", "voice_48"):
            with self.subTest(voice_id=voice_id), self.assertRaises(InputError) as raised:
                parse_tts_input({"voice_id": voice_id, "text": "hello", "num_step": 16}, 800)
            self.assertEqual(raised.exception.code, "INVALID_NUM_STEP")

    def test_voice_design_recovery_contract(self):
        result = parse_design_input(
            {
                "operation": "design",
                "text": " สวัสดีครับ วันนี้อากาศดีมาก ",
                "instruct": "male, young adult, very high pitch",
                "num_step": 32,
                "seed": 44,
            },
            max_text_length=160,
        )
        self.assertEqual(result.text, "สวัสดีครับ วันนี้อากาศดีมาก")
        self.assertEqual(result.instruct, "male, young adult, very high pitch")
        self.assertEqual(result.num_step, 32)
        self.assertEqual(result.seed, 44)

    def test_voice_design_recovery_rejects_unbounded_inputs(self):
        bad = [
            ({"operation": "tts", "text": "x", "instruct": "male"}, "INVALID_OPERATION"),
            ({"operation": "design", "text": " ", "instruct": "male"}, "INVALID_TEXT"),
            ({"operation": "design", "text": "x" * 161, "instruct": "male"}, "TEXT_TOO_LONG"),
            ({"operation": "design", "text": "x", "instruct": "male, excited"}, "INVALID_INSTRUCT"),
            ({"operation": "design", "text": "x", "instruct": "male", "num_step": 8}, "INVALID_NUM_STEP"),
            ({"operation": "design", "text": "x", "instruct": "male", "seed": -1}, "INVALID_SEED"),
        ]
        for payload, code in bad:
            with self.subTest(code=code), self.assertRaises(InputError) as raised:
                parse_design_input(payload, max_text_length=160)
            self.assertEqual(raised.exception.code, code)

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
                parse_tts_input(payload, 800)
            self.assertEqual(raised.exception.code, code)

    def test_v2_manifest_contains_all_original_voices(self):
        manifest = json.loads((ROOT / "assets" / "voices" / "voices.json").read_text(encoding="utf-8"))
        self.assertEqual(
            [item["id"] for item in manifest],
            [f"voice_{index:02d}" for index in range(1, 49)],
        )
        for item in manifest:
            self.assertTrue(item["desc"].strip())
            self.assertTrue(item["instruct"].strip())
            self.assertEqual(item["ref_audio"], f'{item["id"]}.wav')
            self.assertTrue(item["ref_text"].strip())
            self.assertTrue(item["preview_text"].strip())

    def test_v2_worker_pins_thai_language(self):
        source = (ROOT / "handler.py").read_text(encoding="utf-8")
        self.assertIn('DEFAULT_LANGUAGE = os.environ.get("TTS_LANGUAGE", "th")', source)
        self.assertIn("language=DEFAULT_LANGUAGE", source)

    def test_recovered_voice_44_reference_is_pinned(self):
        manifest = json.loads((ROOT / "assets" / "voices" / "voices.json").read_text(encoding="utf-8"))
        voice = next(item for item in manifest if item["id"] == "voice_44")
        self.assertEqual(voice["instruct"], "male, very high pitch")
        self.assertEqual(
            voice["ref_text"],
            "สวัสดีครับ วันนี้อากาศดีและเหมาะกับการสร้างวิดีโอภาษาไทย",
        )
        reference = (ROOT / "assets" / "voices" / voice["ref_audio"]).read_bytes()
        self.assertEqual(
            hashlib.sha256(reference).hexdigest(),
            "ac84a04cd2b7fc34cb573c2231c4453f8983659fc67449def41e37c365e3d72b",
        )

    def test_redesigned_references_are_pinned(self):
        manifest = json.loads((ROOT / "assets" / "voices" / "voices.json").read_text(encoding="utf-8"))
        manifest_by_id = {item["id"]: item for item in manifest}
        selection = json.loads(
            (ROOT / "assets" / "voices" / "redesign-selection.json").read_text(encoding="utf-8")
        )
        self.assertLess(selection["speaker_gates"]["selected_global_resemblyzer_max"], 0.9)
        self.assertLess(selection["speaker_gates"]["selected_global_ecapa_max"], 0.75)
        self.assertEqual(len(selection["voices"]), 15)
        for selected in selection["voices"]:
            with self.subTest(voice_id=selected["id"]):
                voice = manifest_by_id[selected["id"]]
                self.assertEqual(voice["instruct"], selected["instruct"])
                reference = ROOT / "assets" / "voices" / voice["ref_audio"]
                self.assertEqual(hashlib.sha256(reference.read_bytes()).hexdigest(), selected["sha256"])

    def test_v2_release_image_pins_audited_parent_digest(self):
        source = (ROOT / "Dockerfile.v2").read_text(encoding="utf-8")
        self.assertIn(
            "@sha256:decd00cc9ade9bc34b09eec3a6036e80b416f3f2c3a9530d4cfeca7e0ab7b1e2",
            source,
        )
        self.assertIn('TTS_VOICE_IDS=""', source)
        self.assertIn("TTS_LANGUAGE=th", source)
        self.assertIn("TTS_DEFAULT_NUM_STEP=8", source)

    def test_v3_slim_image_downloads_model_as_the_runtime_user(self):
        source = (ROOT / "Dockerfile.v3").read_text(encoding="utf-8")
        self.assertIn(
            "pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime@sha256:"
            "ac7c098a81512e719afa5d2d497f812d7db3498f340a4b819c69cb7b3b257126",
            source,
        )
        self.assertLess(source.index("USER worker"), source.index("snapshot_download"))
        self.assertNotIn("chown -R worker:worker /app", source)
        self.assertIn("TTS_DEFAULT_NUM_STEP=32", source)
        self.assertIn("COPY --chown=worker:worker contract.py prompt_cache.py handler.py /app/", source)
        self.assertIn("COPY --chown=worker:worker assets/voices/ /app/voices/", source)

    def test_worker_fixes_every_tts_voice_at_32_steps(self):
        source = (ROOT / "handler.py").read_text(encoding="utf-8")
        self.assertIn('VERSION = "heroai-omnivoice-runpod-v7-all-voices-32-temp"', source)
        self.assertIn("DEFAULT_NUM_STEP = 32", source)
        self.assertIn("effective_num_step = DEFAULT_NUM_STEP", source)
        self.assertNotIn("QUALITY_NUM_STEP_FLOORS", source)

    def test_worker_echoes_effective_class_temperature(self):
        # T2 requirement: echo class_temperature in the response payload like
        # num_step is already echoed, and forward it into MODEL.generate().
        source = (ROOT / "handler.py").read_text(encoding="utf-8")
        self.assertIn('"class_temperature": request.class_temperature,', source)
        self.assertIn("class_temperature=request.class_temperature,", source)


class VoicePromptCacheTest(unittest.TestCase):
    def test_boot_does_not_prepare_any_voice_prompt(self):
        prepared = []
        cache = VoicePromptCache(
            {"voice_01": {"ref_audio": "voice_01.wav", "ref_text": "หนึ่ง"}},
            lambda voice_id, metadata: prepared.append((voice_id, metadata)) or object(),
        )

        self.assertEqual(prepared, [])

    def test_first_request_prepares_only_the_selected_voice_and_reuses_it(self):
        prepared = []
        manifest = {
            "voice_01": {"ref_audio": "voice_01.wav", "ref_text": "หนึ่ง"},
            "voice_02": {"ref_audio": "voice_02.wav", "ref_text": "สอง"},
        }
        cache = VoicePromptCache(
            manifest,
            lambda voice_id, metadata: prepared.append((voice_id, metadata["ref_audio"])) or object(),
        )

        first = cache.get("voice_02")
        second = cache.get("voice_02")

        self.assertIs(first, second)
        self.assertEqual(prepared, [("voice_02", "voice_02.wav")])

    def test_unknown_voice_fails_without_calling_the_factory(self):
        prepared = []
        cache = VoicePromptCache(
            {"voice_01": {"ref_audio": "voice_01.wav", "ref_text": "หนึ่ง"}},
            lambda voice_id, metadata: prepared.append(voice_id) or object(),
        )

        with self.assertRaises(KeyError):
            cache.get("voice_48")

        self.assertEqual(prepared, [])

    def test_concurrent_first_requests_prepare_one_prompt(self):
        prepared = []
        prompt = object()
        start = threading.Barrier(3)

        def factory(voice_id, metadata):
            prepared.append(voice_id)
            time.sleep(0.02)
            return prompt

        cache = VoicePromptCache(
            {"voice_01": {"ref_audio": "voice_01.wav", "ref_text": "หนึ่ง"}},
            factory,
        )
        results = []

        def load():
            start.wait()
            results.append(cache.get("voice_01"))

        threads = [threading.Thread(target=load) for _ in range(2)]
        for thread in threads:
            thread.start()
        start.wait()
        for thread in threads:
            thread.join()

        self.assertEqual(prepared, ["voice_01"])
        self.assertEqual(results, [prompt, prompt])



if __name__ == "__main__":
    unittest.main()

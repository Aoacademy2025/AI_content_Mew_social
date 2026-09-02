import base64
import json
from pathlib import Path
import sys
import unittest
import wave


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
sys.path.insert(0, str(ROOT))

from contract import (  # noqa: E402
    CONTRACT_VERSION,
    InputError,
    MAX_REF_AUDIO_BASE64_CHARS,
    parse_clone_input,
    parse_tts_input,
    parse_worker_input,
)
from text_utils import chunk_text, split_by_language  # noqa: E402


def stock_payload(**overrides):
    payload = {
        "contract_version": CONTRACT_VERSION,
        "mode": "tts",
        "voice_id": "voice_01",
        "text": "สวัสดีครับ Hero AI Voice",
        "speed": 1.0,
        "num_step": 32,
        "mixed_language": True,
    }
    payload.update(overrides)
    return payload


class ContractTest(unittest.TestCase):
    def assert_code(self, code, fn):
        with self.assertRaises(InputError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)

    def test_stock_tts_contract(self):
        request = parse_tts_input(stock_payload(), 800)
        self.assertEqual(request.voice_id, "voice_01")
        self.assertEqual(request.num_step, 32)
        self.assertTrue(request.mixed_language)

    def test_voice_design_contract(self):
        request = parse_tts_input(
            stock_payload(voice_id=None, instruct="female, high pitch"),
            800,
        )
        self.assertIsNone(request.voice_id)
        self.assertEqual(request.instruct, "female, high pitch")

    def test_contract_version_is_required(self):
        self.assert_code(
            "INVALID_CONTRACT_VERSION",
            lambda: parse_tts_input(stock_payload(contract_version=None), 800),
        )

    def test_exactly_one_voice_selection_is_required(self):
        self.assert_code(
            "INVALID_VOICE_SELECTION",
            lambda: parse_tts_input(stock_payload(voice_id=None), 800),
        )
        self.assert_code(
            "INVALID_VOICE_SELECTION",
            lambda: parse_tts_input(stock_payload(instruct="female"), 800),
        )

    def test_voice_id_fails_closed(self):
        self.assert_code(
            "INVALID_VOICE_ID",
            lambda: parse_tts_input(stock_payload(voice_id="../voice_01"), 800),
        )

    def test_text_speed_steps_and_mixed_language_are_bounded(self):
        self.assert_code("TEXT_TOO_LONG", lambda: parse_tts_input(stock_payload(text="ก" * 801), 800))
        self.assert_code("INVALID_SPEED", lambda: parse_tts_input(stock_payload(speed=3.1), 800))
        self.assert_code("INVALID_NUM_STEP", lambda: parse_tts_input(stock_payload(num_step=65), 800))
        self.assert_code(
            "INVALID_MIXED_LANGUAGE",
            lambda: parse_tts_input(stock_payload(mixed_language="yes"), 800),
        )

    def test_clone_contract(self):
        payload = {
            "contract_version": CONTRACT_VERSION,
            "mode": "clone",
            "ref_audio_b64": base64.b64encode(b"fake-audio-for-contract-only").decode("ascii"),
            "ref_text": "ข้อความในเสียงอ้างอิง",
            "text": "ข้อความที่ต้องการสร้าง",
        }
        request = parse_clone_input(payload, 800)
        self.assertEqual(request.num_step, 32)
        self.assertEqual(request.guidance_scale, 2.5)
        self.assertEqual(parse_worker_input(payload, 800), request)

    def test_clone_payload_is_bounded(self):
        self.assert_code(
            "REF_AUDIO_TOO_LARGE",
            lambda: parse_clone_input(
                {
                    "contract_version": CONTRACT_VERSION,
                    "mode": "clone",
                    "ref_audio_b64": "A" * (MAX_REF_AUDIO_BASE64_CHARS + 1),
                    "ref_text": "reference",
                    "text": "output",
                },
                800,
            ),
        )

    def test_unknown_mode_is_rejected(self):
        self.assert_code(
            "INVALID_MODE",
            lambda: parse_worker_input({"contract_version": 2, "mode": "unknown"}, 800),
        )


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ROOT / "assets/voices/voices.json").read_text(encoding="utf-8"))

    # upstream 10649b5 ตัดเสียงสำเนียงต่างชาติ + เสียงกระซิบออกจาก manifest —
    # ต้องตรงกับ _FOREIGN_ACCENT_IDS ใน server.py และ validation ใน Dockerfile
    REMOVED_VOICE_NUMBERS = {16, 27, 28, 29, 30, 31, 32, 33, 38, 39, 40, 41, 42, 43, 48}

    def test_catalog_has_exactly_33_ordered_voices(self):
        self.assertEqual(
            [voice["id"] for voice in self.manifest],
            [f"voice_{index:02d}" for index in range(1, 49) if index not in self.REMOVED_VOICE_NUMBERS],
        )

    def test_catalog_metadata_and_audio_are_complete(self):
        for voice in self.manifest:
            # preview_text ถูกถอดออกใน upstream 10649b5 — พรีวิวสตรีมไฟล์ ref โดยตรง
            for field in ("desc", "instruct", "ref_audio", "ref_text"):
                self.assertIsInstance(voice[field], str)
                self.assertTrue(voice[field].strip(), f"{voice['id']} missing {field}")

            worker_audio = ROOT / "assets/voices" / voice["ref_audio"]
            app_preview = REPO_ROOT / "assets/hero-voice-previews" / voice["ref_audio"]
            self.assertTrue(worker_audio.is_file(), f"missing worker asset {worker_audio}")
            self.assertTrue(app_preview.is_file(), f"missing app preview {app_preview}")
            self.assertEqual(worker_audio.read_bytes(), app_preview.read_bytes())

            with wave.open(str(worker_audio), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 24_000)
                duration = wav.getnframes() / wav.getframerate()
                self.assertGreaterEqual(duration, 1.5)
                self.assertLessEqual(duration, 10)

    def test_voice_44_uses_the_new_completed_profile(self):
        voice = next(v for v in self.manifest if v["id"] == "voice_44")
        self.assertEqual(voice["instruct"], "young adult, male, very high pitch")
        self.assertEqual(voice["ref_text"], "โอ้โห เยี่ยมไปเลยครับ ดีใจด้วยจริงๆ")


class LanguageTest(unittest.TestCase):
    def test_mixed_thai_english_script_is_segmented_without_losing_text(self):
        text = "วันนี้ใช้ Hero Voice สร้างเสียง"
        segments = split_by_language(text)
        self.assertEqual("".join(segment for segment, _language in segments), text)
        self.assertEqual([language for _segment, language in segments], ["Thai", "English", "Thai"])

    def test_streaming_chunks_remain_bounded(self):
        chunks = chunk_text("ประโยคหนึ่งสั้นๆ ครับ。" * 30, min_chars=20, max_chars=80)
        self.assertTrue(chunks)
        self.assertTrue(all(len(chunk) <= 80 for chunk in chunks))


class ImageTest(unittest.TestCase):
    def test_runpod_and_fastapi_pins_are_dependency_compatible(self):
        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("runpod==1.10.1", requirements)
        self.assertIn("fastapi==0.138.1", requirements)

        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("apt-get install -y --no-install-recommends build-essential", dockerfile)
        self.assertIn("apt-get purge -y --auto-remove build-essential", dockerfile)

    def test_release_image_is_pinned_and_runs_v2_handler(self):
        source = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime@sha256:", source)
        self.assertIn("OMNIVOICE_SOURCE_COMMIT=346bb75330980a236540d61a0808d00767c0973b", source)
        self.assertIn("OMNIVOICE_MODEL_REVISION=c5fdb5ccb189668d56333f77ba2629f4cd7535f4", source)
        self.assertIn('CMD ["python", "-u", "/app/handler.py"]', source)
        self.assertNotIn(":latest", source)

    def test_empty_voice_allowlist_serves_the_complete_catalog(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertIn('os.environ.get("TTS_VOICE_IDS", "").strip() or _DEFAULT_VOICE_IDS', source)

    def test_handler_raises_errors_instead_of_completing_with_error_payload(self):
        source = (ROOT / "handler.py").read_text(encoding="utf-8")
        self.assertNotIn('return {"error"', source)
        self.assertIn("parse_worker_input", source)
        self.assertIn("worker_version", source)
        self.assertNotIn("request.text}", source)

    def test_upstream_commit_is_recorded(self):
        source = (ROOT / "UPSTREAM.md").read_text(encoding="utf-8")
        self.assertIn("565d0e62e1d4269099a4c3fba8a2ecef9167eeea", source)


if __name__ == "__main__":
    unittest.main()

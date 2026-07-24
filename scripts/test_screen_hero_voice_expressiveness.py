#!/usr/bin/env python3
"""Unit tests for scripts/screen-hero-voice-expressiveness.py.

Only pure functions are exercised here. No Whisper import, no network, no
file I/O against real WAVs — CER is tested at the string level and the
acoustic metrics are tested against synthetic numpy fixtures built in-test
(sine tones, amplitude/frequency modulation, inserted silence, white noise).

Run:
  uv run --python 3.11 --with librosa --with numpy --with 'setuptools<81' \
    python3 -m unittest scripts/test_screen_hero_voice_expressiveness.py -v
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

import numpy as np

MODULE_PATH = Path(__file__).resolve().parent / "screen-hero-voice-expressiveness.py"
SPEC = importlib.util.spec_from_file_location("screen_hero_voice_expressiveness", MODULE_PATH)
harness = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = harness
SPEC.loader.exec_module(harness)  # type: ignore[union-attr]


SR = 16000


def make_sine(duration_s: float, freq_hz: float, amplitude: float = 0.5, sr: int = SR) -> np.ndarray:
    t = np.arange(0, duration_s, 1.0 / sr)
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float64)


def make_vibrato_sine(duration_s: float, base_freq_hz: float, depth_hz: float, vib_rate_hz: float,
                       amplitude: float = 0.5, sr: int = SR) -> np.ndarray:
    t = np.arange(0, duration_s, 1.0 / sr)
    instantaneous_freq = base_freq_hz + depth_hz * np.sin(2 * np.pi * vib_rate_hz * t)
    phase = 2 * np.pi * np.cumsum(instantaneous_freq) / sr
    return (amplitude * np.sin(phase)).astype(np.float64)


def make_silence(duration_s: float, sr: int = SR) -> np.ndarray:
    return np.zeros(int(duration_s * sr), dtype=np.float64)


class CharacterErrorRateTests(unittest.TestCase):
    def test_exact_match_is_zero(self):
        self.assertEqual(harness.character_error_rate("สวัสดีครับ", "สวัสดีครับ"), 0.0)

    def test_empty_expected_denominator_floor(self):
        # max(1, len(left)) only guards divide-by-zero; it does not clamp the
        # ratio to 1.0, so an empty expected string against N actual
        # characters yields N/1 = N (matches audit-hero-voice-catalog.py's
        # character_error_rate exactly, incl. this quirk).
        self.assertEqual(harness.character_error_rate("", "anything"), 8.0)
        self.assertEqual(harness.character_error_rate("", ""), 0.0)

    def test_whitespace_and_punctuation_ignored(self):
        expected = "สวัสดี ครับ!"
        actual = "สวัสดีครับ"
        self.assertEqual(harness.character_error_rate(expected, actual), 0.0)

    def test_single_substitution_counted(self):
        # "abc" vs "abd" -> normalized "abc" vs "abd": 1 edit / 3 chars.
        self.assertAlmostEqual(harness.character_error_rate("abc", "abd"), 1 / 3)

    def test_case_insensitive_for_latin(self):
        self.assertEqual(harness.character_error_rate("Hero AI", "hero ai"), 0.0)

    def test_deletion_counted(self):
        # "abcd" vs "abc" -> 1 deletion / 4 chars.
        self.assertAlmostEqual(harness.character_error_rate("abcd", "abc"), 1 / 4)


class F0Tests(unittest.TestCase):
    def test_flat_pitch_has_low_iqr(self):
        audio = make_sine(1.0, freq_hz=150.0)
        median_f0, f0_iqr, voiced_fraction = harness.median_f0_and_iqr(audio, SR)
        self.assertIsNotNone(median_f0)
        self.assertAlmostEqual(median_f0, 150.0, delta=5.0)
        self.assertLess(f0_iqr, 3.0)
        self.assertGreater(voiced_fraction, 0.5)

    def test_modulated_pitch_has_higher_iqr_than_flat(self):
        flat = make_sine(1.0, freq_hz=150.0)
        modulated = make_vibrato_sine(1.0, base_freq_hz=150.0, depth_hz=50.0, vib_rate_hz=2.0)

        _, flat_iqr, _ = harness.median_f0_and_iqr(flat, SR)
        _, modulated_iqr, _ = harness.median_f0_and_iqr(modulated, SR)

        self.assertGreater(modulated_iqr, flat_iqr)
        self.assertGreater(modulated_iqr, 10.0)

    def test_empty_audio_returns_zero_iqr_and_no_median(self):
        median_f0, f0_iqr, voiced_fraction = harness.median_f0_and_iqr(np.zeros(0), SR)
        self.assertIsNone(median_f0)
        self.assertEqual(f0_iqr, 0.0)
        self.assertEqual(voiced_fraction, 0.0)

    def test_white_noise_has_lower_voiced_fraction_than_sine(self):
        rng = np.random.default_rng(seed=42)
        noise = (rng.standard_normal(SR) * 0.3).astype(np.float64)
        sine = make_sine(1.0, freq_hz=180.0)

        _, _, noise_voiced = harness.median_f0_and_iqr(noise, SR)
        _, _, sine_voiced = harness.median_f0_and_iqr(sine, SR)

        self.assertLess(noise_voiced, sine_voiced)


class EnergyDynamicRangeTests(unittest.TestCase):
    def test_constant_amplitude_has_small_dynamic_range(self):
        audio = make_sine(1.0, freq_hz=200.0, amplitude=0.5)
        frame_rms_db = harness.frame_rms_dbfs(audio)
        dynamic_range = harness.energy_dynamic_range_db(frame_rms_db)
        self.assertLess(dynamic_range, 1.0)

    def test_varying_amplitude_has_larger_dynamic_range_than_constant(self):
        constant = make_sine(1.0, freq_hz=200.0, amplitude=0.5)

        loud = make_sine(0.5, freq_hz=200.0, amplitude=0.9)
        quiet = make_sine(0.5, freq_hz=200.0, amplitude=0.02)
        varying = np.concatenate([loud, quiet])

        constant_range = harness.energy_dynamic_range_db(harness.frame_rms_dbfs(constant))
        varying_range = harness.energy_dynamic_range_db(harness.frame_rms_dbfs(varying))

        self.assertGreater(varying_range, constant_range)
        self.assertGreater(varying_range, 20.0)

    def test_empty_audio_has_zero_dynamic_range(self):
        self.assertEqual(harness.energy_dynamic_range_db(harness.frame_rms_dbfs(np.zeros(0))), 0.0)


class PauseStructureTests(unittest.TestCase):
    def test_silence_mask_flags_low_relative_energy_frames(self):
        frame_rms_db = np.array([-10.0, -10.0, -45.0, -46.0, -10.0])
        mask = harness.frame_silence_mask(frame_rms_db, relative_drop_db=30.0)
        np.testing.assert_array_equal(mask, [False, False, True, True, False])

    def test_detect_pause_runs_excludes_leading_and_trailing(self):
        # Frames: [silent, silent, loud, loud, silent, silent, silent, loud, silent]
        mask = np.array([True, True, False, False, True, True, True, False, True])
        hop_seconds = 0.1
        runs = harness.detect_pause_runs(mask, hop_seconds, min_duration_seconds=0.25)
        # Only the middle 3-frame run (index 4-6, 0.3s) qualifies; leading (0-1)
        # and trailing (index 8) runs are excluded regardless of duration.
        self.assertEqual(len(runs), 1)
        self.assertAlmostEqual(runs[0].duration_seconds, 0.3)
        self.assertAlmostEqual(runs[0].start_seconds, 0.4)

    def test_detect_pause_runs_drops_short_runs(self):
        mask = np.array([False, True, True, False, False])
        # 2-frame run at hop=0.1s -> 0.2s, below the 0.25s minimum.
        runs = harness.detect_pause_runs(mask, hop_seconds=0.1, min_duration_seconds=0.25)
        self.assertEqual(runs, [])

    def test_detect_pause_runs_empty_mask(self):
        self.assertEqual(harness.detect_pause_runs(np.zeros(0, dtype=bool), hop_seconds=0.1), [])

    def test_compute_pause_structure_on_synthetic_audio(self):
        lead_silence = make_silence(0.15)
        tone1 = make_sine(0.3, freq_hz=180.0, amplitude=0.6)
        gap_silence = make_silence(0.4)
        tone2 = make_sine(0.3, freq_hz=180.0, amplitude=0.6)
        trail_silence = make_silence(0.2)
        audio = np.concatenate([lead_silence, tone1, gap_silence, tone2, trail_silence])

        pause_count, pause_total_duration = harness.compute_pause_structure(audio, SR)

        self.assertEqual(pause_count, 1)
        # Frame-hop quantization means we can't hit 0.4s exactly; allow slack.
        self.assertAlmostEqual(pause_total_duration, 0.4, delta=0.1)

    def test_compute_pause_structure_no_pauses_in_continuous_tone(self):
        audio = make_sine(1.0, freq_hz=180.0, amplitude=0.6)
        pause_count, pause_total_duration = harness.compute_pause_structure(audio, SR)
        self.assertEqual(pause_count, 0)
        self.assertEqual(pause_total_duration, 0.0)


class ExpressivenessScoreTests(unittest.TestCase):
    def setUp(self):
        self.bounds = {
            "f0_iqr_hz": (0.0, 100.0),
            "energy_dynamic_range_db": (0.0, 40.0),
            "pause_count": (0.0, 4.0),
        }

    def test_all_at_maximum_scores_one(self):
        score = harness.expressiveness_score(100.0, 40.0, 4, self.bounds)
        self.assertEqual(score, 1.0)

    def test_all_at_minimum_scores_zero(self):
        score = harness.expressiveness_score(0.0, 0.0, 0, self.bounds)
        self.assertEqual(score, 0.0)

    def test_midpoint_matches_hand_computed_weights(self):
        score = harness.expressiveness_score(50.0, 20.0, 2, self.bounds)
        # norm_f0=0.5, norm_energy=0.5, norm_pause=0.5 -> 0.4*.5+0.4*.5+0.2*.5 = 0.5
        self.assertAlmostEqual(score, 0.5)

    def test_degenerate_bounds_return_one(self):
        bounds = {
            "f0_iqr_hz": (10.0, 10.0),
            "energy_dynamic_range_db": (5.0, 5.0),
            "pause_count": (1.0, 1.0),
        }
        score = harness.expressiveness_score(10.0, 5.0, 1, bounds)
        self.assertEqual(score, 1.0)

    def test_is_deterministic_across_repeated_calls(self):
        scores = {harness.expressiveness_score(37.5, 18.2, 3, self.bounds) for _ in range(10)}
        self.assertEqual(len(scores), 1)


class RankGroupTests(unittest.TestCase):
    def make_entry(self, file: str, cer: float, f0_iqr_hz: float, energy_dynamic_range_db: float,
                    pause_count: int) -> dict:
        return {
            "file": file,
            "cer": cer,
            "f0_iqr_hz": f0_iqr_hz,
            "energy_dynamic_range_db": energy_dynamic_range_db,
            "pause_count": pause_count,
        }

    def test_guard_disqualifies_high_cer(self):
        entries = [
            self.make_entry("good.wav", cer=0.02, f0_iqr_hz=40.0, energy_dynamic_range_db=20.0, pause_count=2),
            self.make_entry("bad.wav", cer=0.20, f0_iqr_hz=90.0, energy_dynamic_range_db=35.0, pause_count=3),
        ]
        ranked = harness.rank_group(entries)
        by_file = {row["file"]: row for row in ranked}

        self.assertFalse(by_file["good.wav"]["disqualified"])
        self.assertEqual(by_file["good.wav"]["rank"], 1)
        self.assertIsNone(by_file["good.wav"]["disqualification_reason"])

        self.assertTrue(by_file["bad.wav"]["disqualified"])
        self.assertIsNone(by_file["bad.wav"]["rank"])
        self.assertIn("20.00%", by_file["bad.wav"]["disqualification_reason"])

    def test_guard_boundary_is_inclusive_at_five_percent(self):
        entries = [self.make_entry("edge.wav", cer=0.05, f0_iqr_hz=10.0, energy_dynamic_range_db=10.0, pause_count=1)]
        ranked = harness.rank_group(entries)
        self.assertFalse(ranked[0]["disqualified"])
        self.assertEqual(ranked[0]["rank"], 1)

    def test_disqualified_outlier_does_not_skew_survivor_normalization(self):
        # The disqualified entry has an extreme f0_iqr; it must not become the
        # normalization ceiling for the two survivors.
        entries = [
            self.make_entry("low.wav", cer=0.01, f0_iqr_hz=10.0, energy_dynamic_range_db=10.0, pause_count=1),
            self.make_entry("high.wav", cer=0.01, f0_iqr_hz=50.0, energy_dynamic_range_db=10.0, pause_count=1),
            self.make_entry("outlier.wav", cer=0.50, f0_iqr_hz=500.0, energy_dynamic_range_db=10.0, pause_count=1),
        ]
        ranked = harness.rank_group(entries)
        by_file = {row["file"]: row for row in ranked}
        # If the outlier's f0_iqr=500 leaked into normalization bounds, high.wav's
        # f0 component would be ~0.08 instead of 1.0 (it's the survivor max).
        self.assertEqual(by_file["high.wav"]["rank"], 1)
        self.assertGreater(by_file["high.wav"]["score"], by_file["low.wav"]["score"])

    def test_ranking_is_deterministic_across_repeated_calls(self):
        entries = [
            self.make_entry("a.wav", cer=0.01, f0_iqr_hz=30.0, energy_dynamic_range_db=15.0, pause_count=2),
            self.make_entry("b.wav", cer=0.01, f0_iqr_hz=60.0, energy_dynamic_range_db=25.0, pause_count=1),
            self.make_entry("c.wav", cer=0.01, f0_iqr_hz=45.0, energy_dynamic_range_db=10.0, pause_count=3),
        ]
        first = harness.rank_group(entries)
        second = harness.rank_group(entries)
        self.assertEqual([row["file"] for row in first], [row["file"] for row in second])
        self.assertEqual([row["rank"] for row in first], [row["rank"] for row in second])

    def test_tie_break_by_filename_ascending(self):
        entries = [
            self.make_entry("z.wav", cer=0.0, f0_iqr_hz=20.0, energy_dynamic_range_db=10.0, pause_count=1),
            self.make_entry("a.wav", cer=0.0, f0_iqr_hz=20.0, energy_dynamic_range_db=10.0, pause_count=1),
        ]
        ranked = harness.rank_group(entries)
        by_file = {row["file"]: row for row in ranked}
        self.assertEqual(by_file["a.wav"]["score"], by_file["z.wav"]["score"])
        self.assertEqual(by_file["a.wav"]["rank"], 1)
        self.assertEqual(by_file["z.wav"]["rank"], 2)

    def test_empty_group_survivor_set_all_disqualified(self):
        entries = [
            self.make_entry("x.wav", cer=0.5, f0_iqr_hz=10.0, energy_dynamic_range_db=10.0, pause_count=1),
            self.make_entry("y.wav", cer=0.9, f0_iqr_hz=20.0, energy_dynamic_range_db=20.0, pause_count=2),
        ]
        ranked = harness.rank_group(entries)
        self.assertTrue(all(row["disqualified"] for row in ranked))
        self.assertTrue(all(row["rank"] is None for row in ranked))

    def test_does_not_mutate_input_entries(self):
        entries = [self.make_entry("a.wav", cer=0.0, f0_iqr_hz=20.0, energy_dynamic_range_db=10.0, pause_count=1)]
        harness.rank_group(entries)
        self.assertNotIn("score", entries[0])
        self.assertNotIn("rank", entries[0])


if __name__ == "__main__":
    unittest.main()

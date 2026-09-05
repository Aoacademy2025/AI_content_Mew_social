import unittest
import numpy as np
from engine import source_tokens, viterbi

class CtcPathTests(unittest.TestCase):
    def test_repeated_labels_need_blank(self):
        log = np.log(np.array([[.99, .005, .005], [.005, .005, .99], [.99, .005, .005]]))
        frames = viterbi(log, [0, 0], blank=2, delimiter=1)
        self.assertEqual(frames, [[0], [2]])

    def test_audio_frames_not_character_proportions(self):
        probs = np.full((12, 4), .001)
        probs[:, 3] = .997
        probs[2] = [.997, .001, .001, .001]
        probs[9] = [.001, .997, .001, .001]
        frames = viterbi(np.log(probs), [0, 1], blank=3, delimiter=2)
        self.assertEqual(frames, [[2], [9]])

    def test_utf16_offsets_and_unsupported_text(self):
        tokens, spans = source_tokens('🐈แมว AI', {'แ': 0, 'ม': 1, 'ว': 2})
        self.assertEqual(tokens, [0, 1, 2])
        self.assertEqual(spans, [(2, 3), (3, 4), (4, 5)])

    def test_impossible_path_is_not_timing(self):
        with self.assertRaises(ValueError):
            viterbi(np.log(np.array([[.9, .05, .05]])), [0, 0], blank=2, delimiter=1)

if __name__ == '__main__':
    unittest.main()
